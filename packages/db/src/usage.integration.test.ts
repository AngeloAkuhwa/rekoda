/**
 * The usage meter (docs/metering-v1.md), against real PostgreSQL.
 *
 * The claim that matters is the race: N concurrent consumers against an
 * allowance of K get exactly K grants, decided by the database. Everything
 * else — zero allowances refusing the first unit, bonus raising the ceiling
 * the way a billing top-up will, refunds flooring at zero — exists so the
 * commercial rules in the doc are enforced shapes, not intentions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { billingRepo, events, identity, usageRepo } from './index.js';
import { MIGRATIONS_DIR } from './migrate.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';
import { USAGE_UNITS, allowanceFor } from '@rekoda/core';

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

const PERIOD = '2026-08';

/** Put a business on a plan directly, as a settled charge would. */
async function setPlanOnRow(businessId: string, plan: string) {
  await withBusiness(db, businessId, (tx) =>
    tx.execute(sql`UPDATE businesses SET plan = ${plan} WHERE id = ${businessId}::uuid`),
  );
}

const consume = (businessId: string, allowance: number, n = 1) =>
  withBusiness(db, businessId, (tx) =>
    usageRepo.consumeUnit(tx, businessId, PERIOD, 'AI_ACTIONS', allowance, n),
  );

describe('the atomic gate', () => {
  it('grants exactly K of N concurrent consumes against an allowance of K', async () => {
    const businessId = await seedBusiness();

    // Eight messages arrive together against the last five units. A
    // read-then-write meter grants all eight; this one cannot.
    const results = await Promise.all(Array.from({ length: 8 }, () => consume(businessId, 5)));

    expect(results.filter(Boolean)).toHaveLength(5);
    const [row] = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    expect(row?.used).toBe(5);
  });

  it('refuses the FIRST unit of a zero allowance — orders on Chat is not "one free"', async () => {
    const businessId = await seedBusiness();
    expect(await consume(businessId, 0)).toBe(false);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    expect(rows).toHaveLength(0); // refused consumes leave no residue
  });

  it('lets a billing top-up raise the ceiling through bonus, and only through bonus', async () => {
    const businessId = await seedBusiness();
    await setPlanOnRow(businessId, 'chat'); // paid: meters by calendar month
    expect(await consume(businessId, 2)).toBe(true);
    expect(await consume(businessId, 2)).toBe(true);
    expect(await consume(businessId, 2)).toBe(false); // exhausted at plan allowance

    // What the M4 billing event will do after a VERIFIED top-up payment.
    await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        UPDATE usage_counters SET bonus = 3
        WHERE business_id = ${businessId}::uuid AND period = ${PERIOD} AND unit = 'AI_ACTIONS'
      `),
    );

    expect(await consume(businessId, 2)).toBe(true); // doorway reopened
    expect(await consume(businessId, 2)).toBe(true);
    expect(await consume(businessId, 2)).toBe(true);
    expect(await consume(businessId, 2)).toBe(false); // and closes again at plan+bonus
  });

  it('refunds floor at zero and give back exactly what was taken', async () => {
    const businessId = await seedBusiness();
    await setPlanOnRow(businessId, 'chat');
    await consume(businessId, 5);
    await consume(businessId, 5);

    await withBusiness(db, businessId, (tx) =>
      usageRepo.refundUnit(tx, businessId, usageRepo.monthMeter(PERIOD), 'AI_ACTIONS'),
    );
    const [row] = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    expect(row?.used).toBe(1);

    // Refunding more than was ever taken cannot mint credit.
    await withBusiness(db, businessId, (tx) =>
      usageRepo.refundUnit(tx, businessId, usageRepo.monthMeter(PERIOD), 'AI_ACTIONS', 99),
    );
    const [floored] = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    expect(floored?.used).toBe(0);
  });

  it('keeps months separate — a new period is a fresh meter', async () => {
    const businessId = await seedBusiness();
    await setPlanOnRow(businessId, 'chat');
    expect(await consume(businessId, 1)).toBe(true);
    expect(await consume(businessId, 1)).toBe(false);

    const nextMonth = await withBusiness(db, businessId, (tx) =>
      usageRepo.consumeUnit(tx, businessId, '2026-09', 'AI_ACTIONS', 1),
    );
    expect(nextMonth).toBe(true);
  });
});

describe('one budget per trial (G-109, OWN-27, OD-26)', () => {
  const { TRIAL_METER, monthMeter } = usageRepo;
  const reserve = (
    businessId: string,
    period: string,
    allowance: number,
    n = 1,
    unit = 'AI_ACTIONS',
  ) =>
    withBusiness(db, businessId, (tx) =>
      usageRepo.reserveUnit(tx, businessId, period, unit as 'AI_ACTIONS', allowance, n),
    );
  const spend = async (businessId: string, period: string, allowance: number) =>
    (await reserve(businessId, period, allowance)).granted;
  const refund = (
    businessId: string,
    meter: ReturnType<typeof monthMeter>,
    n = 1,
    unit = 'AI_ACTIONS',
  ) =>
    withBusiness(db, businessId, (tx) =>
      usageRepo.refundUnit(tx, businessId, meter, unit as 'AI_ACTIONS', n),
    );
  /** The counter on one exact row, whatever plan the business is on. */
  const rowUsed = async (businessId: string, meter: string, unit = 'AI_ACTIONS') => {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ used: number }>(sql`
        SELECT used FROM usage_counters
        WHERE business_id = ${businessId}::uuid AND period = ${meter} AND unit = ${unit}`),
    );
    return [...rows][0]?.used ?? 0;
  };
  const readUsed = async (businessId: string, period: string, unit = 'AI_ACTIONS') => {
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, period),
    );
    return rows.find((r) => r.unit === unit)?.used ?? 0;
  };

  it('a trial that crosses a month boundary does not get a second allowance', async () => {
    const businessId = await seedBusiness();
    const first = await reserve(businessId, '2026-08', 1);
    expect(first).toEqual({ granted: true, meter: TRIAL_METER });
    // The calendar month rolled over mid-trial: the unit is still spent.
    expect(await spend(businessId, '2026-09', 1)).toBe(false);
    expect(await readUsed(businessId, '2026-09')).toBe(1);
    expect(await readUsed(businessId, '2026-08')).toBe(1);
  });

  it('a first paid plan starts a fresh meter: trial usage does not carry into the paid month', async () => {
    const businessId = await seedBusiness();
    expect(await spend(businessId, '2026-08', 3)).toBe(true);
    expect(await spend(businessId, '2026-08', 1)).toBe(false); // trial budget gone

    await setPlanOnRow(businessId, 'chat');
    // Bought in the same month the trial used its budget in.
    expect(await readUsed(businessId, '2026-08')).toBe(0);
    const paid = await reserve(businessId, '2026-08', 1);
    expect(paid).toEqual({ granted: true, meter: monthMeter('2026-08') });
  });

  describe('a delayed refund goes to the exact row the unit was spent on', () => {
    it('after an upgrade, a trial unit goes back to the trial row, not to paid usage', async () => {
      const businessId = await seedBusiness();
      const trial = await reserve(businessId, '2026-08', 5);
      expect(trial.meter).toBe(TRIAL_METER);

      await setPlanOnRow(businessId, 'chat');
      const paid = await reserve(businessId, '2026-08', 5);
      expect(paid.meter).toBe(monthMeter('2026-08'));
      expect(await rowUsed(businessId, '2026-08')).toBe(1);

      // The trial reservation is released late, with the row it recorded.
      await refund(businessId, trial.meter);
      expect(await rowUsed(businessId, usageRepo.TRIAL_PERIOD)).toBe(0);
      expect(await rowUsed(businessId, '2026-08')).toBe(1); // paid usage untouched
    });

    it('a paid unit refunded after the upgrade leaves the trial row alone', async () => {
      const businessId = await seedBusiness();
      await reserve(businessId, '2026-08', 5); // trial: 1 used
      await setPlanOnRow(businessId, 'chat');
      const paid = await reserve(businessId, '2026-08', 5);

      await refund(businessId, paid.meter);
      expect(await rowUsed(businessId, '2026-08')).toBe(0);
      expect(await rowUsed(businessId, usageRepo.TRIAL_PERIOD)).toBe(1);
    });

    it('a quantity goes back in full to its own row and never drains another', async () => {
      const businessId = await seedBusiness();
      const trial = await reserve(businessId, '2026-08', 600, 5, 'VOICE_MINUTES');
      await setPlanOnRow(businessId, 'chat');
      await reserve(businessId, '2026-08', 600, 2, 'VOICE_MINUTES'); // paid has only 2 to give

      await refund(businessId, trial.meter, 5, 'VOICE_MINUTES');
      expect(await rowUsed(businessId, usageRepo.TRIAL_PERIOD, 'VOICE_MINUTES')).toBe(0);
      expect(await rowUsed(businessId, '2026-08', 'VOICE_MINUTES')).toBe(2);
    });

    it('a partial refund, then the rest, comes to exactly what was spent, and no more', async () => {
      const businessId = await seedBusiness();
      const spent = await reserve(businessId, '2026-08', 600, 5, 'VOICE_MINUTES');
      await refund(businessId, spent.meter, 2, 'VOICE_MINUTES');
      expect(await rowUsed(businessId, usageRepo.TRIAL_PERIOD, 'VOICE_MINUTES')).toBe(3);
      await refund(businessId, spent.meter, 3, 'VOICE_MINUTES');
      await refund(businessId, spent.meter, 3, 'VOICE_MINUTES'); // a retry cannot mint credit
      expect(await rowUsed(businessId, usageRepo.TRIAL_PERIOD, 'VOICE_MINUTES')).toBe(0);
    });

    it('concurrent consumes grant exactly the allowance and all name the trial row', async () => {
      const businessId = await seedBusiness();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => reserve(businessId, '2026-08', 5)),
      );
      expect(results.filter((r) => r.granted)).toHaveLength(5);
      expect(new Set(results.map((r) => r.meter))).toEqual(new Set([TRIAL_METER]));

      // Concurrent refunds of three of the five leave exactly two spent: a stray
      // extra refund would show, where flooring at zero would hide it.
      await Promise.all(
        results
          .filter((r) => r.granted)
          .slice(0, 3)
          .map((r) => refund(businessId, r.meter)),
      );
      expect(await rowUsed(businessId, usageRepo.TRIAL_PERIOD)).toBe(2);
    });

    it('a refund names its row and never moves another, whatever the plan or the balances', async () => {
      const businessId = await seedBusiness();
      await setPlanOnRow(businessId, 'chat');
      await reserve(businessId, '2026-08', 5);
      // Nothing was spent on the trial row, so a refund naming it changes nothing.
      await refund(businessId, TRIAL_METER);
      expect(await rowUsed(businessId, '2026-08')).toBe(1);
      expect(await rowUsed(businessId, usageRepo.TRIAL_PERIOD)).toBe(0);
    });
  });

  describe('a reservation on a message keeps its row (migration 0175)', () => {
    async function seedEvent(businessId: string): Promise<string> {
      const recorded = await withBusiness(db, businessId, (tx) =>
        events.recordEvent(tx, {
          provider: 'meta',
          eventType: 'messages',
          externalId: `g109-${Math.random()}`,
          payload: {},
          businessId,
        }),
      );
      if (!recorded.isNew) throw new Error('event not recorded');
      return recorded.id;
    }

    it('a trial reservation released after an upgrade refunds the trial row, once', async () => {
      const businessId = await seedBusiness();
      const eventId = await seedEvent(businessId);
      await withBusiness(db, businessId, (tx) =>
        events.reserveUnitForEvent(tx, businessId, eventId, 'AI_ACTIONS', () =>
          usageRepo.reserveUnit(tx, businessId, '2026-08', 'AI_ACTIONS', 5),
        ),
      );
      // Another message spent a second trial unit, so a double refund would show
      // as 0 left rather than being hidden by the floor at zero.
      await reserve(businessId, '2026-08', 5);
      await setPlanOnRow(businessId, 'chat');
      await reserve(businessId, '2026-08', 5); // a paid unit spent meanwhile

      const giveBack = () =>
        withBusiness(db, businessId, async (tx) => {
          const taken = await events.takeReservedUnit(tx, businessId, eventId, 'AI_ACTIONS');
          if (taken) {
            await usageRepo.refundUnit(
              tx,
              businessId,
              usageRepo.storedMeter(taken.meter, '2026-08'),
              'AI_ACTIONS',
            );
          }
        });
      // Two concurrent releases (a retry racing a reclaim): one refund.
      await Promise.all([giveBack(), giveBack()]);
      expect(await rowUsed(businessId, usageRepo.TRIAL_PERIOD)).toBe(1);
      expect(await rowUsed(businessId, '2026-08')).toBe(1);
    });

    it('two overlapping releases of a quantity reservation return its seconds once', async () => {
      const businessId = await seedBusiness();
      const eventId = await seedEvent(businessId);
      await withBusiness(db, businessId, async (tx) => {
        const spent = await usageRepo.reserveUnit(
          tx,
          businessId,
          '2026-08',
          'VOICE_MINUTES',
          600,
          7,
        );
        await events.noteReservedUnit(tx, businessId, eventId, 'VOICE_MINUTES:7', spent.meter);
      });
      await reserve(businessId, '2026-08', 600, 20, 'VOICE_MINUTES'); // other voice notes: 20 more

      const giveBack = async (beforeCommit?: () => Promise<void>) =>
        withBusiness(db, businessId, async (tx) => {
          const taken = await events.takeRecordedUnit(tx, businessId, eventId, 'VOICE_MINUTES');
          await beforeCommit?.();
          if (taken) {
            await usageRepo.refundUnit(
              tx,
              businessId,
              usageRepo.storedMeter(taken.meter, '2026-08'),
              'VOICE_MINUTES',
              Number(taken.held.split(':')[1]),
            );
          }
        });

      // A has taken the reservation and not committed when B starts: B must wait
      // for A, then find nothing, rather than read the same reservation beside it.
      let aTook!: () => void;
      const aHasTaken = new Promise<void>((r) => (aTook = r));
      let releaseA!: () => void;
      const aMayCommit = new Promise<void>((r) => (releaseA = r));
      const a = giveBack(async () => {
        aTook();
        await aMayCommit;
      });
      await aHasTaken;
      const b = giveBack();
      await new Promise((r) => setTimeout(r, 300)); // B is now waiting on A's lock (or has read the same row)
      releaseA();
      await Promise.all([a, b]);
      expect(await rowUsed(businessId, usageRepo.TRIAL_PERIOD, 'VOICE_MINUTES')).toBe(20);
    });

    it('a quantity reservation returns its quantity and its row together', async () => {
      const businessId = await seedBusiness();
      const eventId = await seedEvent(businessId);
      await withBusiness(db, businessId, async (tx) => {
        const spent = await usageRepo.reserveUnit(
          tx,
          businessId,
          '2026-08',
          'VOICE_MINUTES',
          600,
          7,
        );
        await events.noteReservedUnit(tx, businessId, eventId, 'VOICE_MINUTES:7', spent.meter);
      });
      await setPlanOnRow(businessId, 'chat');
      const taken = await withBusiness(db, businessId, (tx) =>
        events.takeRecordedUnit(tx, businessId, eventId, 'VOICE_MINUTES'),
      );
      expect(taken).toEqual({ held: 'VOICE_MINUTES:7', meter: TRIAL_METER });
    });

    it('a reservation recorded before the column existed is refunded to its month', async () => {
      const businessId = await seedBusiness();
      await setPlanOnRow(businessId, 'chat');
      const eventId = await seedEvent(businessId);
      await withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          UPDATE external_events SET reserved_units = ARRAY['AI_ACTIONS']
           WHERE id = ${eventId}::uuid`),
      );
      const taken = await withBusiness(db, businessId, (tx) =>
        events.takeReservedUnit(tx, businessId, eventId, 'AI_ACTIONS'),
      );
      expect(taken).toEqual({ meter: null });
      expect(usageRepo.storedMeter(taken!.meter, '2026-08')).toBe(monthMeter('2026-08'));
    });

    it('takeReservedUnitsOf and takeReservedUnits carry each unit with its row', async () => {
      const businessId = await seedBusiness();
      const eventId = await seedEvent(businessId);
      await withBusiness(db, businessId, async (tx) => {
        const doc = await usageRepo.reserveUnit(
          tx,
          businessId,
          '2026-08',
          'DOCUMENT_GENERATION',
          5,
        );
        await events.noteReservedUnit(tx, businessId, eventId, 'DOCUMENT_GENERATION', doc.meter);
        const order = await usageRepo.reserveUnit(tx, businessId, '2026-08', 'CATALOGUE_ORDERS', 5);
        await events.noteReservedUnit(tx, businessId, eventId, 'CATALOGUE_ORDERS', order.meter);
      });
      const taken = await withBusiness(db, businessId, (tx) =>
        events.takeReservedUnitsOf(tx, businessId, eventId, ['DOCUMENT_GENERATION']),
      );
      expect(taken).toEqual([{ unit: 'DOCUMENT_GENERATION', meter: TRIAL_METER }]);
      const rest = await withBusiness(db, businessId, (tx) =>
        events.takeReservedUnits(tx, businessId, eventId),
      );
      expect(rest).toEqual([{ unit: 'CATALOGUE_ORDERS', meter: TRIAL_METER }]);
    });
  });

  describe('separately purchased API units keep their own monthly cycle (Finding 2)', () => {
    const API = 'API_REQUEST_UNITS';

    it('meters the API product by calendar month while the base plan is trial', async () => {
      const businessId = await seedBusiness();
      const august = await reserve(businessId, '2026-08', 2, 1, API);
      expect(august).toEqual({ granted: true, meter: monthMeter('2026-08') });
      expect((await reserve(businessId, '2026-08', 2, 1, API)).granted).toBe(true);
      expect((await reserve(businessId, '2026-08', 2, 1, API)).granted).toBe(false); // August spent

      // September is a fresh month for the holding, with the trial still running.
      expect((await reserve(businessId, '2026-09', 2, 1, API)).granted).toBe(true);
      expect(await rowUsed(businessId, '2026-09', API)).toBe(1);
      expect(await rowUsed(businessId, usageRepo.TRIAL_PERIOD, API)).toBe(0);
    });

    it('webhook deliveries follow the month too, and a refund returns to that month', async () => {
      const businessId = await seedBusiness();
      const sent = await reserve(businessId, '2026-08', 3, 1, 'WEBHOOK_DELIVERIES');
      expect(sent.meter).toBe(monthMeter('2026-08'));
      await refund(businessId, sent.meter, 1, 'WEBHOOK_DELIVERIES');
      expect(await rowUsed(businessId, '2026-08', 'WEBHOOK_DELIVERIES')).toBe(0);
    });

    it('a trial business holds both: base units on the trial row, API units by month', async () => {
      const businessId = await seedBusiness();
      await reserve(businessId, '2026-08', 5); // base-plan unit: the trial row
      await reserve(businessId, '2026-08', 5, 1, API); // API unit: the month
      await reserve(businessId, '2026-09', 5, 1, API);

      expect(await readUsed(businessId, '2026-09')).toBe(1); // the trial budget, in any month
      expect(await readUsed(businessId, '2026-09', API)).toBe(1); // September's API units only
      expect(await readUsed(businessId, '2026-08', API)).toBe(1); // August's
      expect(await readUsed(businessId, '2026-10', API)).toBe(0);
    });

    it('a pack for a base unit lands on the trial row; one for an API unit never does', async () => {
      const businessId = await seedBusiness();
      await withBusiness(db, businessId, async (tx) => {
        await usageRepo.creditBonus(tx, businessId, '2026-08', 'AI_ACTIONS', 7);
        await usageRepo.creditBonus(tx, businessId, '2026-08', API, 9);
      });
      const bonus = async (meter: string, unit: string) => {
        const rows = await withBusiness(db, businessId, (tx) =>
          tx.execute<{ bonus: number }>(sql`
            SELECT bonus FROM usage_counters
            WHERE business_id = ${businessId}::uuid AND period = ${meter} AND unit = ${unit}`),
        );
        return [...rows][0]?.bonus ?? 0;
      };
      expect(await bonus(usageRepo.TRIAL_PERIOD, 'AI_ACTIONS')).toBe(7);
      expect(await bonus('2026-08', API)).toBe(9);
      expect(await bonus(usageRepo.TRIAL_PERIOD, API)).toBe(0);
    });

    it('a paid business meters every unit by month, API units included', async () => {
      const businessId = await seedBusiness();
      await setPlanOnRow(businessId, 'complete');
      expect((await reserve(businessId, '2026-08', 5, 1, API)).meter).toBe(monthMeter('2026-08'));
      expect((await reserve(businessId, '2026-08', 5)).meter).toBe(monthMeter('2026-08'));
    });
  });
});

describe('trials already running when the trial meter moved (migrations 0176 and 0177)', () => {
  /** The migrations' own SQL (the usage copy, then the reservations), run again against rows shaped as the old release left them. */
  async function backfill(): Promise<void> {
    const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
    try {
      for (const file of ['0176_trial_meter_backfill.sql', '0177_trial_reservations_meter.sql']) {
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

describe('a business leaving the trial leaves no trial usage on a month row (migration 0178)', () => {
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
    await withBusiness(db, stays, (tx) =>
      tx.execute(
        sql`UPDATE businesses SET plan = 'trial', updated_at = now() WHERE id = ${stays}::uuid`,
      ),
    );
    expect(await monthRows(stays)).toHaveLength(4);

    const paid = await seedBusiness2();
    await setPlanOnRow(paid, 'chat');
    await ownerRun(sql`
      INSERT INTO usage_counters (business_id, period, unit, used)
      VALUES (${paid}::uuid, '2026-10', 'AI_ACTIONS', 7)`);
    await setPlanOnRow(paid, 'complete');
    expect(await monthRows(paid)).toEqual([{ period: '2026-10', unit: 'AI_ACTIONS', used: 7 }]);
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

describe('the trial clock (docs/pricing-model.md)', () => {
  /** Move a business's plan and expiry directly, as an operator or time would. */
  async function setPlanRow(businessId: string, plan: string, expiresAt: Date | null) {
    await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        UPDATE businesses
        SET plan = ${plan}, plan_expires_at = ${expiresAt ? expiresAt.toISOString() : null}::timestamptz
        WHERE id = ${businessId}::uuid
      `),
    );
  }

  const planOf = (businessId: string, now?: Date) =>
    withBusiness(db, businessId, (tx) => usageRepo.planFor(tx, businessId, now));

  it('gives a new business a 14-day trial, dated at creation', async () => {
    const businessId = await seedBusiness();
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ plan: string; plan_expires_at: string | null }>(
        sql`SELECT plan, plan_expires_at FROM businesses WHERE id = ${businessId}::uuid`,
      ),
    );
    const row = [...rows][0];
    expect(row?.plan).toBe('trial');
    expect(row?.plan_expires_at).not.toBeNull();

    const days = (new Date(row!.plan_expires_at!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
  });

  it('answers "expired" once the trial date passes, and "trial" before it', async () => {
    const businessId = await seedBusiness();
    expect(await planOf(businessId)).toBe('trial');

    // A minute before the date, still a trial; a minute after, expired.
    const expiry = new Date(Date.now() + 60_000);
    await setPlanRow(businessId, 'trial', expiry);
    expect(await planOf(businessId)).toBe('trial');
    expect(await planOf(businessId, new Date(expiry.getTime() + 1_000))).toBe('expired');
  });

  it('NEVER expires a paid plan, even with a date in the past', async () => {
    const businessId = await seedBusiness();
    // A late billing job must not cut off a merchant who is paying us.
    await setPlanRow(businessId, 'chat', new Date(Date.now() - 86_400_000));
    expect(await planOf(businessId)).toBe('chat');
  });

  it('refuses the first message once expired — zero allowance, not a special case', async () => {
    const businessId = await seedBusiness();
    await setPlanRow(businessId, 'trial', new Date(Date.now() - 1_000));
    expect(await planOf(businessId)).toBe('expired');
    // allowanceFor('expired', 'AI_ACTIONS') is 0, and a zero allowance refuses.
    expect(await consume(businessId, 0)).toBe(false);
  });
});

describe('plan changes and upgrade requests', () => {
  it('moves a business onto a plan and records who did it', async () => {
    const businessId = await seedBusiness();
    const expiresAt = new Date(Date.now() + 365 * 86_400_000);

    const changed = await billingRepo.setPlan(db, {
      businessId,
      plan: 'chat',
      expiresAt,
      actor: 'operator:angelo',
    });
    expect(changed).toBe(true);
    expect(await withBusiness(db, businessId, (tx) => usageRepo.planFor(tx, businessId))).toBe(
      'chat',
    );

    const audit = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ actor: string; action: string; old_value: { plan: string } }>(sql`
        SELECT actor, action, old_value FROM audit_events WHERE action = 'plan_changed'
      `),
    );
    const row = [...audit][0];
    expect(row?.actor).toBe('operator:angelo');
    // The previous plan is kept: "what were they on before" is the question
    // a billing dispute actually asks.
    expect(row?.old_value.plan).toBe('trial');
  });

  it('answers false for a business that does not exist, changing nothing', async () => {
    const changed = await billingRepo.setPlan(db, {
      businessId: '2b0f9b6a-0000-4000-8000-000000000000',
      plan: 'complete',
      expiresAt: null,
      actor: 'operator:typo',
    });
    expect(changed).toBe(false);
  });

  it('records every upgrade request with the plan it came from', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      billingRepo.recordUpgradeRequest(tx, businessId, 'expired'),
    );
    await withBusiness(db, businessId, (tx) =>
      billingRepo.recordUpgradeRequest(tx, businessId, 'expired'),
    );

    const requests = await withBusiness(db, businessId, (tx) =>
      billingRepo.upgradeRequestsFor(tx, businessId),
    );
    // Two asks are two rows: a merchant who repeats themselves is information.
    expect(requests).toHaveLength(2);
    expect(requests[0]?.fromPlan).toBe('expired');
  });
});

/**
 * The consume compares NUMBERS, and had to be told so.
 *
 * `SELECT $1, $2 WHERE $3 <= $4` gives PostgreSQL no type context, so it
 * resolved the parameters as text and compared them as text. Text says
 * `'9' <= '600'` is false, because it reads the nine first. A merchant
 * sending a nine-second voice note against a six-hundred-second allowance was
 * refused and told they had used all six hundred of them.
 *
 * It survived because almost every consume spends one unit and `'1' <= '600'`
 * is true by luck of the alphabet. These cases are the ones that are not
 * lucky: an amount whose first digit sorts above the ceiling's.
 */
describe('spending an amount, not a tally', () => {
  let businessId: string;

  beforeEach(async () => {
    businessId = await seedBusiness();
  });

  const spend = (allowance: number, n: number) =>
    withBusiness(db, businessId, (tx) =>
      usageRepo.consumeUnit(tx, businessId, PERIOD, 'VOICE_MINUTES', allowance, n),
    );

  const used = async () => {
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    return rows.find((row) => row.unit === 'VOICE_MINUTES')?.used ?? 0;
  };

  /* Every one of these is comfortably inside the allowance and every one of
   * them was refused when the comparison was textual. */
  it.each([
    [600, 9],
    [600, 7],
    [600, 8],
    [600, 95],
    [3_600, 900],
    [3_600, 40],
    [120, 9],
  ])('grants %i-allowance a spend of %i', async (allowance, n) => {
    expect(await spend(allowance, n)).toBe(true);
    expect(await used()).toBe(n);
  });

  it('still refuses a spend that genuinely exceeds the allowance', async () => {
    expect(await spend(600, 601)).toBe(false);
    expect(await used()).toBe(0);
  });

  /* And the ceiling still holds across several spends, which is the property
   * the whole meter exists for. */
  it('holds the ceiling across a sequence of amounts', async () => {
    expect(await spend(100, 9)).toBe(true);
    expect(await spend(100, 80)).toBe(true);
    expect(await spend(100, 20)).toBe(false);
    expect(await spend(100, 11)).toBe(true);
    expect(await used()).toBe(100);
  });
});

/**
 * The vocabulary, enforced by the column rather than by the type system.
 *
 * `usage_counters.unit` is text with a CHECK, so TypeScript's UsageUnit is
 * only half the guard: a job written in SQL, a fixture, or a hand-run
 * correction can put anything in this column. The CHECK is what makes the
 * canonical seventeen the whole set the meter can hold, and the retired five
 * unwritable, so a half-applied deployment cannot leave a business metered
 * under two names for the same thing.
 */
describe('the metered vocabulary (spec 4.2)', () => {
  let businessId: string;

  beforeEach(async () => {
    businessId = await seedBusiness();
  });

  const write = (unit: string) =>
    withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO usage_counters (business_id, period, unit, used)
        VALUES (${businessId}::uuid, ${PERIOD}, ${unit}, 1)
      `),
    );

  it('holds every one of the canonical seventeen', async () => {
    expect(USAGE_UNITS).toHaveLength(17);
    for (const unit of USAGE_UNITS) {
      await expect(write(unit), `${unit} is writable`).resolves.toBeDefined();
    }
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM usage_counters WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...rows][0]?.n).toBe(17);
  });

  it.each(['messages', 'voice_seconds', 'documents', 'documents_understood', 'orders'])(
    'refuses the retired name %s',
    async (retired) => {
      await expect(write(retired)).rejects.toThrow();
    },
  );

  it('refuses a name nobody has ever metered', async () => {
    await expect(write('TOKENS')).rejects.toThrow();
  });

  /**
   * The vocabulary migration switches row-level security off for the length
   * of its backfill, because `usage_counters` is FORCE ROW LEVEL SECURITY
   * and a migration has no `app.business_id` to pin: without that the UPDATE
   * matches zero rows and reports success. Switching it off is safe. Leaving
   * it off would put every business's meter in front of every other tenant,
   * and a migration that forgot the last line would look exactly like one
   * that did not. So the state is asserted rather than assumed.
   */
  it('still has row-level security enabled and forced after the backfill', async () => {
    const rows = await db.execute<{ enabled: boolean; forced: boolean }>(sql`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE relname = 'usage_counters'
    `);
    expect([...rows][0]).toEqual({ enabled: true, forced: true });
  });

  /**
   * Voice is counted in seconds under a name that says minutes, so the two
   * halves have to be checked together: the plan sells sixty minutes, the
   * meter is handed three thousand six hundred, and a one hundred and
   * thirty-seven second voice note spends one hundred and thirty-seven of
   * them. Dividing at any point in that chain would either give a merchant
   * sixty times the voice they bought or a sixtieth of it.
   */
  it('spends voice a second at a time against a minute allowance', async () => {
    const allowance = allowanceFor('chat', 'VOICE_MINUTES');
    expect(allowance).toBe(3_600);

    const granted = await withBusiness(db, businessId, (tx) =>
      usageRepo.consumeUnit(tx, businessId, PERIOD, 'VOICE_MINUTES', allowance, 137),
    );
    expect(granted).toBe(true);

    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    expect(rows.find((row) => row.unit === 'VOICE_MINUTES')?.used).toBe(137);
  });
});

/**
 * Codex on #271: two attempts of one event (a stalled job reclaimed while its
 * first worker still runs) reserve the same unit at once. One charge, one
 * record, one refund.
 */
describe('a unit reserved for an event, by two attempts at once', () => {
  async function seedEvent(businessId: string): Promise<string> {
    const recorded = await withBusiness(db, businessId, (tx) =>
      events.recordEvent(tx, {
        provider: 'meta',
        eventType: 'messages',
        externalId: `g60-race-${Math.random()}`,
        payload: {},
        businessId,
      }),
    );
    if (!recorded.isNew) throw new Error('event not recorded');
    return recorded.id;
  }

  const usedOf = async (businessId: string, unit: 'CATALOGUE_ORDERS' | 'DOCUMENT_GENERATION') =>
    (await withBusiness(db, businessId, (tx) => usageRepo.usageFor(tx, businessId, PERIOD))).find(
      (r) => r.unit === unit,
    )?.used ?? 0;

  const heldOf = async (businessId: string, eventId: string) => {
    const [row] = await withBusiness(db, businessId, async (tx) => [
      ...(await tx.execute<{ units: string[] }>(
        sql`SELECT reserved_units AS units FROM external_events WHERE id = ${eventId}::uuid`,
      )),
    ]);
    return row!.units;
  };

  it.each(['CATALOGUE_ORDERS', 'DOCUMENT_GENERATION'] as const)(
    'charges and records %s once, and gives it back once',
    async (unit) => {
      const businessId = await seedBusiness();
      const eventId = await seedEvent(businessId);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const inside = new Promise<void>((r) => (entered = r));

      /* Attempt A is inside its reservation, before it meters, when B starts. */
      const a = withBusiness(db, businessId, (tx) =>
        events.reserveUnitForEvent(tx, businessId, eventId, unit, async () => {
          entered();
          await gate;
          return usageRepo.reserveUnit(tx, businessId, PERIOD, unit, 10);
        }),
      );
      await inside;
      const b = withBusiness(db, businessId, (tx) =>
        events.reserveUnitForEvent(tx, businessId, eventId, unit, () =>
          usageRepo.reserveUnit(tx, businessId, PERIOD, unit, 10),
        ),
      );
      await new Promise((r) => setTimeout(r, 200));
      release();
      expect(await a).toBe(true);
      expect(await b).toBe(true);

      expect(await usedOf(businessId, unit)).toBe(1);
      expect(await heldOf(businessId, eventId)).toEqual([unit]);

      const giveBack = () =>
        withBusiness(db, businessId, async (tx) => {
          const taken = await events.takeReservedUnit(tx, businessId, eventId, unit);
          if (taken) {
            await usageRepo.refundUnit(
              tx,
              businessId,
              usageRepo.storedMeter(taken.meter, PERIOD),
              unit,
            );
          }
        });
      await giveBack();
      await giveBack();
      expect(await usedOf(businessId, unit)).toBe(0);
      expect(await heldOf(businessId, eventId)).toEqual([]);
    },
  );
});
