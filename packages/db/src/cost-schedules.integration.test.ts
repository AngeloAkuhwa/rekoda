/**
 * ProviderCostSchedule over real rows (spec §17, §19.1, §24, §29; P3,
 * PR-072). The slice's own claims: a rate is an effective-dated
 * observation the runtime READS and derives from — never writes, never
 * guesses, and never lets drift apart from the in-code card the margin
 * model already uses.
 */
import { META_COST_SCHEDULE, MESSAGE_CATEGORIES } from '@rekoda/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, paymentsHub, sql, type Db } from './index.js';
import { migrate, requireUrls, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let owner: Db;
let close: () => Promise<void>;
let closeOwner: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 2 }));
  ({ db: owner, close: closeOwner } = createDb(urls.owner, { max: 2 }));
});

afterAll(async () => {
  await close?.();
  await closeOwner?.();
});

describe('the seeded observations (§24, §29)', () => {
  it("carries Paystack's collection pricing as PERCENT_PLUS_FLAT observations", async () => {
    const card = await paymentsHub.costScheduleInForce(
      db,
      'paystack',
      'collection_local_card',
      '2026-08-27',
    );
    expect(card).toMatchObject({
      version: 'paystack-ng-2026-08',
      basis: 'PERCENT_PLUS_FLAT',
      percentPpm: 15_000,
      flatMinor: 10_000,
      capMinor: 200_000,
      waiveFlatUnderMinor: 250_000,
      currency: 'NGN',
    });
    const transfer = await paymentsHub.costScheduleInForce(
      db,
      'paystack',
      'collection_transfer_dva',
      '2026-08-27',
    );
    expect(transfer).toMatchObject({ percentPpm: 10_000, flatMinor: 0, capMinor: 30_000 });
  });

  it('agrees with the in-code Meta card, category by category — the two cannot drift apart', async () => {
    for (const category of MESSAGE_CATEGORIES) {
      const row = await paymentsHub.costScheduleInForce(db, 'meta', category, '2026-08-27');
      expect(row, category).toMatchObject({
        version: META_COST_SCHEDULE.version,
        effectiveFrom: META_COST_SCHEDULE.effectiveFrom,
        basis: 'PER_UNIT',
        unitPriceMicros: META_COST_SCHEDULE.micros[category],
        currency: 'USD',
      });
    }
  });
});

describe('what the table refuses (§24: observations, not application state)', () => {
  it('is read-only to the runtime: a new card arrives by migration, never an application write', async () => {
    await expect(
      db.execute(
        sql`UPDATE provider_cost_schedules SET percent_ppm = 0 WHERE provider_type = 'paystack'`,
      ),
    ).rejects.toThrow();
  });

  it('a row that mixes the bases, or omits its own, is unrepresentable', async () => {
    /* PER_UNIT without a unit price. */
    await expect(
      owner.execute(sql`
        INSERT INTO provider_cost_schedules
          (provider_type, cost_type, provider_product, version, effective_from, basis, currency)
        VALUES ('meta', 'MESSAGING', 'BROKEN_A', 'x', '2026-08-27', 'PER_UNIT', 'USD')
      `),
    ).rejects.toThrow(/provider_cost_schedules/);
    /* PERCENT_PLUS_FLAT carrying a unit price. */
    await expect(
      owner.execute(sql`
        INSERT INTO provider_cost_schedules
          (provider_type, cost_type, provider_product, version, effective_from, basis,
           percent_ppm, flat_minor, unit_price_micros, currency)
        VALUES ('paystack', 'PAYMENT_FEE', 'BROKEN_B', 'x', '2026-08-27', 'PERCENT_PLUS_FLAT',
                10000, 0, 500, 'NGN')
      `),
    ).rejects.toThrow(/provider_cost_schedules/);
  });

  it('an estimate can only cite a schedule that exists (the FK 0083 promised)', async () => {
    const rows = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE conname = 'payment_charges_cost_schedule_fk' AND contype = 'f'
    `);
    expect([...rows][0]!.n).toBe(1);
  });
});

describe('the observation in force (§24: derived at a date, never stored)', () => {
  it('answers null before the first observation — no card is backdated', async () => {
    expect(
      await paymentsHub.costScheduleInForce(db, 'paystack', 'collection_local_card', '2026-08-01'),
    ).toBeNull();
    expect(
      await paymentsHub.costScheduleInForce(db, 'meta', 'UTILITY_TEMPLATE', '2026-08-20'),
    ).toBeNull();
  });

  it('a repricing is a NEW row, and each date reads the card in force on it', async () => {
    await owner.execute(sql`
      INSERT INTO provider_cost_schedules
        (provider_type, cost_type, provider_product, version, effective_from, basis,
         percent_ppm, flat_minor, cap_minor, currency, note)
      VALUES ('paystack', 'PAYMENT_FEE', 'collection_local_card', 'paystack-ng-2026-10',
              '2026-10-01', 'PERCENT_PLUS_FLAT', 20000, 10000, 250000, 'NGN', 'test repricing')
    `);
    try {
      const before = await paymentsHub.costScheduleInForce(
        db,
        'paystack',
        'collection_local_card',
        '2026-09-15',
      );
      expect(before).toMatchObject({ version: 'paystack-ng-2026-08', percentPpm: 15_000 });
      const after = await paymentsHub.costScheduleInForce(
        db,
        'paystack',
        'collection_local_card',
        '2026-10-02',
      );
      expect(after).toMatchObject({ version: 'paystack-ng-2026-10', percentPpm: 20_000 });
    } finally {
      await owner.execute(
        sql`DELETE FROM provider_cost_schedules WHERE version = 'paystack-ng-2026-10'`,
      );
    }
  });
});
