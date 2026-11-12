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
// usage.integration.test.ts, usage-trial-migrations.integration.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { events, identity, usageRepo } from '../index.js';
import {
  migrate,
  requireUrls,
  truncateAll,
  type Urls,
  setPlanAsOwner,
  creditBonusForTest,
} from '../testing.js';
import { settlementDb } from '../testing.js';

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

/** Put a business on a plan directly, as a settled charge would. */
async function setPlanOnRow(businessId: string, plan: string) {
  await setPlanAsOwner(urls, businessId, { plan });
}

describe('one budget per trial (G-109, OWN-27, OD-26)', () => {
  const { TRIAL_METER, monthMeter } = usageRepo;
  /* A handle is `<row>` or `<row>#<reservation>` (OD-51.4, 0216); these tests ask which row. */
  const rowOf = (meter: usageRepo.MeterRow): string => usageRepo.meterRowOf(meter);
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
    expect(first.granted).toBe(true);
    expect(rowOf(first.meter)).toBe(TRIAL_METER);
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
    expect(paid.granted).toBe(true);
    expect(rowOf(paid.meter)).toBe(monthMeter('2026-08'));
  });

  describe('a delayed refund goes to the exact row the unit was spent on', () => {
    it('after an upgrade, a trial unit goes back to the trial row, not to paid usage', async () => {
      const businessId = await seedBusiness();
      const trial = await reserve(businessId, '2026-08', 5);
      expect(rowOf(trial.meter)).toBe(TRIAL_METER);

      await setPlanOnRow(businessId, 'chat');
      const paid = await reserve(businessId, '2026-08', 5);
      expect(rowOf(paid.meter)).toBe(monthMeter('2026-08'));
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
      expect(new Set(results.map((r) => rowOf(r.meter)))).toEqual(new Set([TRIAL_METER]));
      /* Each granted spend is its own reservation: five handles, all different. */
      expect(
        new Set(results.filter((r) => r.granted).map((r) => usageRepo.reservationOf(r.meter))).size,
      ).toBe(5);

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
      expect(taken?.held).toBe('VOICE_MINUTES:7');
      /* The stored handle names the trial row and carries the reservation that spent the seconds. */
      expect(rowOf(usageRepo.storedMeter(taken!.meter, '2026-08'))).toBe(TRIAL_METER);
      expect(usageRepo.reservationOf(usageRepo.storedMeter(taken!.meter, '2026-08'))).toMatch(
        /^[0-9a-f-]{36}$/,
      );
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

    it('a quantity-suffixed unit is taken with the row recorded under its kind', async () => {
      const businessId = await seedBusiness();
      const eventId = await seedEvent(businessId);
      await withBusiness(db, businessId, (tx) =>
        events.noteReservedUnit(tx, businessId, eventId, 'VOICE_MINUTES:5', TRIAL_METER),
      );
      const taken = await withBusiness(db, businessId, (tx) =>
        events.takeReservedUnit(tx, businessId, eventId, 'VOICE_MINUTES:5'),
      );
      expect(taken).toEqual({ meter: TRIAL_METER });
      const left = await withBusiness(db, businessId, (tx) =>
        tx.execute<{ m: Record<string, string> }>(sql`
          SELECT reserved_meters AS m FROM external_events WHERE id = ${eventId}::uuid`),
      );
      expect([...left][0]?.m).toEqual({});
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
      expect(taken.map((t) => [t.unit, rowOf(usageRepo.storedMeter(t.meter, '2026-08'))])).toEqual([
        ['DOCUMENT_GENERATION', TRIAL_METER],
      ]);
      const rest = await withBusiness(db, businessId, (tx) =>
        events.takeReservedUnits(tx, businessId, eventId),
      );
      expect(rest.map((t) => [t.unit, rowOf(usageRepo.storedMeter(t.meter, '2026-08'))])).toEqual([
        ['CATALOGUE_ORDERS', TRIAL_METER],
      ]);
    });
  });

  describe('separately purchased API units keep their own monthly cycle (Finding 2)', () => {
    const API = 'API_REQUEST_UNITS';

    it('meters the API product by calendar month while the base plan is trial', async () => {
      const businessId = await seedBusiness();
      const august = await reserve(businessId, '2026-08', 2, 1, API);
      expect(august.granted).toBe(true);
      expect(rowOf(august.meter)).toBe(monthMeter('2026-08'));
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
      expect(rowOf(sent.meter)).toBe(monthMeter('2026-08'));
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
      await withBusiness(settlementDb(), businessId, async (tx) => {
        await creditBonusForTest(tx, businessId, '2026-08', 'AI_ACTIONS', 7);
        await creditBonusForTest(tx, businessId, '2026-08', API, 9);
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
      expect(rowOf((await reserve(businessId, '2026-08', 5, 1, API)).meter)).toBe(
        monthMeter('2026-08'),
      );
      expect(rowOf((await reserve(businessId, '2026-08', 5)).meter)).toBe(monthMeter('2026-08'));
    });
  });
});
