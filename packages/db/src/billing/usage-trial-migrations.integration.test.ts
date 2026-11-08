/**
 * The usage meter (docs/metering-v1.md), against real PostgreSQL.
 *
 * The claim that matters is the race: N concurrent consumers against an
 * allowance of K get exactly K grants, decided by the database. Everything
 * else — zero allowances refusing the first unit, bonus raising the ceiling
 * the way a billing top-up will, refunds flooring at zero — exists so the
 * commercial rules in the doc are enforced shapes, not intentions.
 */
// The usage metering suite. Split by concern; the rest of this suite is in
// usage.integration.test.ts, usage-trial.integration.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { events, identity, usageRepo } from '../index.js';
import { MIGRATIONS_DIR } from '../migrate.js';
import { migrate, requireUrls, truncateAll, type Urls, setPlanAsOwner } from '../testing.js';

let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 10 }));
});

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(): Promise<string> {
  const user = await identity.upsertUserByPhone(db, '+2348140000001');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function seedBusiness2(): Promise<string> {
  const user = await identity.upsertUserByPhone(db, '+2348140000002');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Bola Stores',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** Put a business on a plan directly, as a settled charge would. */
async function setPlanOnRow(businessId: string, plan: string) {
  await setPlanAsOwner(urls, businessId, { plan });
}

describe('trials already running when the trial meter moved (migrations 0177 and 0178)', () => {
  /** The migrations' own SQL (the usage copy, then the reservations), run again against rows shaped as the old release left them. */
  async function backfill(): Promise<void> {
    const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
    try {
      for (const file of ['0177_trial_meter_backfill.sql', '0178_trial_reservations_meter.sql']) {
        await owner.unsafe(await readFile(join(MIGRATIONS_DIR, file), 'utf8')).simple();
      }
    } finally {
      await owner.end();
    }
  }
  const ownerRun = async (statement: ReturnType<typeof sql>) => {
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      return [...(await ownerDb.execute<Record<string, unknown>>(statement))];
    } finally {
      await close();
    }
  };
  const rows = (businessId: string) =>
    ownerRun(sql`
      SELECT period, unit, used, bonus FROM usage_counters
       WHERE business_id = ${businessId}::uuid ORDER BY unit, period`);

  const reserveIn = (businessId: string, allowance: number) =>
    withBusiness(db, businessId, (tx) =>
      usageRepo.reserveUnit(tx, businessId, '2026-11', 'AI_ACTIONS', allowance),
    );

  it("copies a running trial's month usage onto the trial row, deletes nothing, and leaves everyone else alone", async () => {
    const trial = await seedBusiness();
    const paid = await seedBusiness2();
    await setPlanOnRow(paid, 'chat');
    await ownerRun(sql`
      INSERT INTO usage_counters (business_id, period, unit, used, bonus) VALUES
        (${trial}::uuid, '2026-09', 'AI_ACTIONS', 2, 1),
        (${trial}::uuid, '2026-10', 'AI_ACTIONS', 3, 0),
        (${trial}::uuid, '2026-10', 'API_REQUEST_UNITS', 4, 0),
        (${paid}::uuid, '2026-10', 'AI_ACTIONS', 9, 0)`);

    await backfill();

    // Expand-only: the month rows the previous release reads are still there.
    const after = await rows(trial);
    expect(after).toHaveLength(4);
    expect(after).toEqual(
      expect.arrayContaining([
        { period: '2026-09', unit: 'AI_ACTIONS', used: 2, bonus: 1 },
        { period: '2026-10', unit: 'AI_ACTIONS', used: 3, bonus: 0 },
        { period: 'TRIAL00', unit: 'AI_ACTIONS', used: 5, bonus: 1 },
        { period: '2026-10', unit: 'API_REQUEST_UNITS', used: 4, bonus: 0 }, // its own monthly cycle
      ]),
    );
    expect(await rows(paid)).toEqual([
      { period: '2026-10', unit: 'AI_ACTIONS', used: 9, bonus: 0 },
    ]);

    // A second run changes nothing, even once the trial row has moved on.
    await ownerRun(sql`
      UPDATE usage_counters SET used = 6
       WHERE business_id = ${trial}::uuid AND period = 'TRIAL00' AND unit = 'AI_ACTIONS'`);
    await backfill();
    expect((await rows(trial)).find((r) => r.period === 'TRIAL00')).toMatchObject({
      used: 6,
      bonus: 1,
    });
  });

  it('the new release spends against the copied trial usage, not the month rows it ignores', async () => {
    const trial = await seedBusiness();
    await ownerRun(sql`
      INSERT INTO usage_counters (business_id, period, unit, used) VALUES
        (${trial}::uuid, '2026-10', 'AI_ACTIONS', 3)`);
    await backfill();
    const read = await withBusiness(db, trial, (tx) => usageRepo.usageFor(tx, trial, '2026-11'));
    expect(read.find((r) => r.unit === 'AI_ACTIONS')?.used).toBe(3);
    // 5 allowed, 3 already used: two more are granted, the third is refused.
    expect((await reserveIn(trial, 5)).granted).toBe(true);
    expect((await reserveIn(trial, 5)).granted).toBe(true);
    expect((await reserveIn(trial, 5)).granted).toBe(false);
  });

  it('a write the previous release makes after the copy is ignored by the trial meter and discarded when the trial ends', async () => {
    const trial = await seedBusiness();
    await ownerRun(sql`
      INSERT INTO usage_counters (business_id, period, unit, used) VALUES
        (${trial}::uuid, '2026-10', 'AI_ACTIONS', 3)`);
    await backfill();

    // The previous release, still running during the deploy, spends two more on the month row.
    await ownerRun(sql`
      UPDATE usage_counters SET used = used + 2
       WHERE business_id = ${trial}::uuid AND period = '2026-10' AND unit = 'AI_ACTIONS'`);

    // The new release's trial meter reads the copied total: the two late units are not counted
    // against the trial (the accepted, bounded window), and nothing double-counts.
    const during = await withBusiness(db, trial, (tx) => usageRepo.usageFor(tx, trial, '2026-10'));
    expect(during.find((r) => r.unit === 'AI_ACTIONS')?.used).toBe(3);

    // When the trial ends the stale month row is discarded, so the first paid month starts fresh.
    await setPlanOnRow(trial, 'chat');
    const after = await withBusiness(db, trial, (tx) => usageRepo.usageFor(tx, trial, '2026-10'));
    expect(after.find((r) => r.unit === 'AI_ACTIONS')?.used ?? 0).toBe(0);
  });

  it('a first paid plan then starts fresh: the trigger clears the old trial month the copy left behind', async () => {
    const trial = await seedBusiness();
    await ownerRun(sql`
      INSERT INTO usage_counters (business_id, period, unit, used) VALUES
        (${trial}::uuid, '2026-10', 'AI_ACTIONS', 3)`);
    await backfill();
    await setPlanOnRow(trial, 'chat');
    const read = await withBusiness(db, trial, (tx) => usageRepo.usageFor(tx, trial, '2026-10'));
    expect(read.find((r) => r.unit === 'AI_ACTIONS')?.used ?? 0).toBe(0);
  });

  it("points a running trial's recorded reservations at the trial row, so their refunds land there", async () => {
    const trial = await seedBusiness();
    const recorded = await withBusiness(db, trial, (tx) =>
      events.recordEvent(tx, {
        provider: 'meta',
        eventType: 'messages',
        externalId: `g109-backfill-${Math.random()}`,
        payload: {},
        businessId: trial,
      }),
    );
    if (!recorded.isNew) throw new Error('event not recorded');
    await ownerRun(sql`
      UPDATE external_events SET reserved_units = ARRAY['AI_ACTIONS', 'VOICE_MINUTES:7', 'API_REQUEST_UNITS']
       WHERE id = ${recorded.id}::uuid`);
    await backfill();
    const [event] = await ownerRun(sql`
      SELECT reserved_meters AS meters FROM external_events WHERE id = ${recorded.id}::uuid`);
    expect(event?.meters).toEqual({ AI_ACTIONS: 'TRIAL00', VOICE_MINUTES: 'TRIAL00' });
  });
});

describe('the trial migrations leave row-level security as they found it', () => {
  it('keeps it enabled and forced on usage_counters and external_events', async () => {
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      const rls = [
        ...(await ownerDb.execute<{ relname: string; on: boolean; forced: boolean }>(sql`
          SELECT relname, relrowsecurity AS "on", relforcerowsecurity AS forced
            FROM pg_class WHERE relname IN ('usage_counters', 'external_events') ORDER BY relname`)),
      ];
      expect(rls).toEqual([
        { relname: 'external_events', on: true, forced: true },
        { relname: 'usage_counters', on: true, forced: true },
      ]);
    } finally {
      await close();
    }
  });
});

describe('a business leaving the trial leaves no trial usage on a month row (migration 0176)', () => {
  const ownerRun = async (statement: ReturnType<typeof sql>) => {
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      return [...(await ownerDb.execute<Record<string, unknown>>(statement))];
    } finally {
      await close();
    }
  };
  const monthRows = (businessId: string) =>
    ownerRun(sql`
      SELECT period, unit, used FROM usage_counters
       WHERE business_id = ${businessId}::uuid AND period <> 'TRIAL00' ORDER BY unit, period`);
  /** What an old process, still running during a deploy, writes for a trial business. */
  const strayOldProcessWrites = (businessId: string) =>
    ownerRun(sql`
      INSERT INTO usage_counters (business_id, period, unit, used) VALUES
        (${businessId}::uuid, '2026-09', 'AI_ACTIONS', 2),
        (${businessId}::uuid, '2026-10', 'AI_ACTIONS', 4),
        (${businessId}::uuid, '2026-09', 'API_REQUEST_UNITS', 5),
        (${businessId}::uuid, '2026-10', 'API_REQUEST_UNITS', 6)`);

  it('discards stray month rows for base-plan units when the first paid plan lands, and keeps API units', async () => {
    const businessId = await seedBusiness();
    await strayOldProcessWrites(businessId);

    await setPlanOnRow(businessId, 'chat');

    // Both months of base-plan usage go; both months of API usage stay.
    expect(await monthRows(businessId)).toEqual([
      { period: '2026-09', unit: 'API_REQUEST_UNITS', used: 5 },
      { period: '2026-10', unit: 'API_REQUEST_UNITS', used: 6 },
    ]);
    const read = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, '2026-10'),
    );
    expect(read.find((r) => r.unit === 'AI_ACTIONS')?.used ?? 0).toBe(0); // a fresh paid meter
  });

  it('does not touch month rows while the business stays on trial, or moves between paid plans', async () => {
    const stays = await seedBusiness();
    await strayOldProcessWrites(stays);
    await setPlanAsOwner(urls, stays, { plan: 'trial' });
    expect(await monthRows(stays)).toHaveLength(4);

    const paid = await seedBusiness2();
    await setPlanOnRow(paid, 'chat');
    await ownerRun(sql`
      INSERT INTO usage_counters (business_id, period, unit, used)
      VALUES (${paid}::uuid, '2026-10', 'AI_ACTIONS', 7)`);
    await setPlanOnRow(paid, 'complete');
    expect(await monthRows(paid)).toEqual([{ period: '2026-10', unit: 'AI_ACTIONS', used: 7 }]);
  });

  it('keeps paid counters and bonus capacity when an operator returns a once-paid business to its paid plan', async () => {
    const businessId = await seedBusiness();
    await setPlanOnRow(businessId, 'chat');
    // The subscription writer stamps this on any paid plan, and never clears it (G-103).
    await ownerRun(sql`UPDATE businesses SET ever_paid_at = now() WHERE id = ${businessId}::uuid`);
    await ownerRun(sql`
      INSERT INTO usage_counters (business_id, period, unit, used, bonus)
      VALUES (${businessId}::uuid, '2026-10', 'AI_ACTIONS', 7, 25)`);
    await setPlanAsOwner(urls, businessId, { plan: 'trial' });
    await setPlanOnRow(businessId, 'chat'); // operator restores the paid plan in the same month

    // Paid history is not trial usage: it survives the move out of trial.
    expect(await monthRows(businessId)).toEqual([
      { period: '2026-10', unit: 'AI_ACTIONS', used: 7 },
    ]);
    expect(
      await ownerRun(sql`
        SELECT bonus FROM usage_counters
         WHERE business_id = ${businessId}::uuid AND period = '2026-10' AND unit = 'AI_ACTIONS'`),
    ).toEqual([{ bonus: 25 }]);
  });

  it('names the trial row on a reservation the previous release recorded, so its refund cannot debit a paid counter', async () => {
    const businessId = await seedBusiness();
    const recorded = await withBusiness(db, businessId, (tx) =>
      events.recordEvent(tx, {
        provider: 'meta',
        eventType: 'messages',
        externalId: `g109-0177-${Math.random()}`,
        payload: {},
        businessId,
      }),
    );
    if (!recorded.isNew) throw new Error('event not recorded');
    // The previous release writes reserved_units only: no meter row.
    await ownerRun(sql`
      UPDATE external_events SET reserved_units = ARRAY['AI_ACTIONS', 'API_REQUEST_UNITS']
       WHERE id = ${recorded.id}::uuid`);

    await setPlanOnRow(businessId, 'chat');
    // Paid usage in the month the old reservation names.
    await withBusiness(db, businessId, (tx) =>
      usageRepo.reserveUnit(tx, businessId, '2026-10', 'AI_ACTIONS', 5),
    );

    const taken = await withBusiness(db, businessId, (tx) =>
      events.takeReservedUnit(tx, businessId, recorded.id, 'AI_ACTIONS'),
    );
    expect(taken).toEqual({ meter: 'TRIAL00' });
    await withBusiness(db, businessId, (tx) =>
      usageRepo.refundUnit(
        tx,
        businessId,
        usageRepo.storedMeter(taken!.meter, '2026-10'),
        'AI_ACTIONS',
      ),
    );
    const paid = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, '2026-10'),
    );
    expect(paid.find((r) => r.unit === 'AI_ACTIONS')?.used).toBe(1); // the paid unit is untouched
    // The API unit keeps its own monthly cycle, so it names no trial row.
    const [event] = await ownerRun(sql`
      SELECT reserved_meters AS meters FROM external_events WHERE id = ${recorded.id}::uuid`);
    expect(event?.meters).toEqual({});
  });

  it('also discards them when a trial lapses to expired', async () => {
    const businessId = await seedBusiness();
    await strayOldProcessWrites(businessId);
    await setPlanOnRow(businessId, 'expired');
    expect((await monthRows(businessId)).map((r) => r.unit)).toEqual([
      'API_REQUEST_UNITS',
      'API_REQUEST_UNITS',
    ]);
  });
});
