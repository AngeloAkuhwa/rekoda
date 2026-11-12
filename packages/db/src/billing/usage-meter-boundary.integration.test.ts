/**
 * OD-51.4 (migration 0216): the usage meter is written only through database functions that check
 * each change; no runtime role writes `usage_counters` directly.
 *
 *   * consumption, reservation and refund keep working through `usage_reserve` / `usage_refund`;
 *   * a refund returns at most what ONE reservation spent, once, to the row it was spent on, and
 *     only for the business and unit that reservation belongs to;
 *   * no runtime role can reset, lower, raise or delete a counter, or touch the reservation ledger;
 *   * a ceiling (`bonus`) is raised only by `usage_credit_pack`, for one paid pack charge, once.
 *
 * Every assertion runs on a live connection as that principal.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness, type Db } from '../client.js';
import { usageRepo } from '../index.js';
import {
  appDb,
  outcome,
  ownerDb,
  PRINCIPALS,
  seedBusiness,
  seedCharge,
  settlementDb,
  usePlanWriterHarness,
  workerDb,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

const RUNTIME = ['app', 'worker', 'settlement', 'operator'] as const;
const PERIOD = '2026-11';
const UNIT: usageRepo.UsageUnit = 'AI_ACTIONS';

/** The trial meters one fixed row; these tests name the row a paid month would use. */
const row = async (businessId: string, unit: string = UNIT) =>
  [
    ...(await ownerDb.execute<{ period: string; used: number; bonus: number }>(
      sql`SELECT period, used, bonus FROM usage_counters WHERE business_id = ${businessId}::uuid AND unit = ${unit}`,
    )),
  ][0];
const used = async (businessId: string, unit: string = UNIT) =>
  (await row(businessId, unit))?.used ?? 0;

const reserve = (
  db: Db,
  businessId: string,
  allowance = 10,
  n = 1,
  unit: usageRepo.UsageUnit = UNIT,
) =>
  withBusiness(db, businessId, (tx) =>
    usageRepo.reserveUnit(tx, businessId, PERIOD, unit, allowance, n),
  );
const refund = (
  db: Db,
  businessId: string,
  meter: usageRepo.MeterRow,
  n = 1,
  unit: usageRepo.UsageUnit = UNIT,
) => withBusiness(db, businessId, (tx) => usageRepo.refundUnit(tx, businessId, meter, unit, n));

describe('OD-51.4: legitimate metering still works through the functions (0216)', () => {
  it('consumes up to the allowance and refuses the unit past it', async () => {
    const businessId = await seedBusiness();
    const consume = () =>
      withBusiness(appDb, businessId, (tx) =>
        usageRepo.consumeUnit(tx, businessId, PERIOD, UNIT, 2),
      );
    expect(await consume()).toBe(true);
    expect(await consume()).toBe(true);
    expect(await consume()).toBe(false);
    expect(await used(businessId)).toBe(2);
    /* An allowance of zero refuses the very first unit and leaves no row. */
    const other = await seedBusiness();
    expect(
      await withBusiness(appDb, other, (tx) =>
        usageRepo.consumeUnit(tx, other, PERIOD, 'CATALOGUE_ORDERS', 0),
      ),
    ).toBe(false);
    expect(await row(other, 'CATALOGUE_ORDERS')).toBeUndefined();
  });

  it('numbers are compared as numbers: nine seconds fit a six-hundred-second allowance', async () => {
    const businessId = await seedBusiness();
    expect((await reserve(appDb, businessId, 600, 9, 'VOICE_MINUTES')).granted).toBe(true);
    expect(await used(businessId, 'VOICE_MINUTES')).toBe(9);
  });

  it('two simultaneous spenders cannot both take the last unit', async () => {
    const businessId = await seedBusiness();
    await reserve(appDb, businessId, 3);
    await reserve(appDb, businessId, 3);
    const race = await Promise.all([reserve(appDb, businessId, 3), reserve(appDb, businessId, 3)]);
    expect(race.filter((r) => r.granted)).toHaveLength(1);
    expect(await used(businessId)).toBe(3);
  });

  it('a reservation is returned to the row it was spent on, in the same or a later transaction', async () => {
    const businessId = await seedBusiness();
    const spent = await reserve(appDb, businessId);
    expect(spent.granted).toBe(true);
    expect(usageRepo.reservationOf(spent.meter)).toMatch(/^[0-9a-f-]{36}$/);
    expect(usageRepo.meterRowOf(spent.meter)).toBe('TRIAL00'); // a trial's one row
    expect(await used(businessId)).toBe(1);

    expect(await refund(appDb, businessId, spent.meter)).toBe(1);
    expect(await used(businessId)).toBe(0);

    /* Reserve and give back inside one transaction, as a job that fails after metering does. */
    await withBusiness(appDb, businessId, async (tx) => {
      const again = await usageRepo.reserveUnit(tx, businessId, PERIOD, UNIT, 10);
      expect(await usageRepo.refundUnit(tx, businessId, again.meter, UNIT)).toBe(1);
    });
    expect(await used(businessId)).toBe(0);
  });

  it('the worker meters and returns a webhook delivery the same way', async () => {
    const businessId = await seedBusiness();
    const spent = await reserve(workerDb, businessId, 5, 1, 'WEBHOOK_DELIVERIES');
    expect(spent.granted).toBe(true);
    expect(await used(businessId, 'WEBHOOK_DELIVERIES')).toBe(1);
    expect(await refund(workerDb, businessId, spent.meter, 1, 'WEBHOOK_DELIVERIES')).toBe(1);
    expect(await used(businessId, 'WEBHOOK_DELIVERIES')).toBe(0);
  });

  it('a spend that is never given back records no reservation', async () => {
    const businessId = await seedBusiness();
    await withBusiness(appDb, businessId, (tx) =>
      usageRepo.consumeUnit(tx, businessId, PERIOD, 'REPORT_EXPORTS', 5),
    );
    const [ledger] = await ownerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM usage_reservations WHERE business_id = ${businessId}::uuid`,
    );
    expect(ledger!.n).toBe(0);
  });
});

describe('OD-51.4: a refund is bound to one reservation', () => {
  it('returns each reservation once, however often it is asked', async () => {
    const businessId = await seedBusiness();
    const first = await reserve(appDb, businessId);
    await reserve(appDb, businessId);
    await reserve(appDb, businessId);
    expect(await used(businessId)).toBe(3);

    expect(await refund(appDb, businessId, first.meter)).toBe(1);
    for (let i = 0; i < 5; i += 1) expect(await refund(appDb, businessId, first.meter)).toBe(0);
    /* Two units other reservations spent are still spent: one handle cannot reset the meter. */
    expect(await used(businessId)).toBe(2);
  });

  it('never returns more than the reservation spent', async () => {
    const businessId = await seedBusiness();
    const voice = await reserve(appDb, businessId, 600, 30, 'VOICE_MINUTES');
    await reserve(appDb, businessId, 600, 40, 'VOICE_MINUTES');
    expect(await refund(appDb, businessId, voice.meter, 1_000, 'VOICE_MINUTES')).toBe(30);
    expect(await used(businessId, 'VOICE_MINUTES')).toBe(40);
    /* A part given back, then the rest, never past the whole. */
    const part = await reserve(appDb, businessId, 600, 10, 'VOICE_MINUTES');
    expect(await refund(appDb, businessId, part.meter, 4, 'VOICE_MINUTES')).toBe(4);
    expect(await refund(appDb, businessId, part.meter, 9, 'VOICE_MINUTES')).toBe(6);
    expect(await refund(appDb, businessId, part.meter, 9, 'VOICE_MINUTES')).toBe(0);
    expect(await used(businessId, 'VOICE_MINUTES')).toBe(40);
  });

  it('a row name with no reservation returns nothing', async () => {
    const businessId = await seedBusiness();
    await reserve(appDb, businessId);
    await reserve(appDb, businessId);
    expect(await refund(appDb, businessId, usageRepo.TRIAL_METER, 5)).toBe(0);
    expect(await refund(appDb, businessId, usageRepo.monthMeter(PERIOD), 5)).toBe(0);
    expect(await refund(appDb, businessId, usageRepo.storedMeter(null, PERIOD), 5)).toBe(0);
    expect(await used(businessId)).toBe(2);
  });

  it('a reservation cannot be returned for another unit, or by another business', async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();
    const spent = await reserve(appDb, theirs);
    await reserve(appDb, mine);

    expect(await outcome(refund(appDb, theirs, spent.meter, 1, 'VOICE_MINUTES'))).toMatch(
      /^22023 .*the reservation is for another unit/,
    );
    /* Pinned to my business, their reservation does not exist. */
    expect(await refund(appDb, mine, spent.meter)).toBe(0);
    /* And naming their business while pinned to mine is refused outright. */
    expect(
      await outcome(
        withBusiness(appDb, mine, (tx) =>
          tx.execute(
            sql`SELECT usage_refund(${theirs}::uuid, ${usageRepo.reservationOf(spent.meter)}::uuid, 'AI_ACTIONS', 1)`,
          ),
        ),
      ),
    ).toMatch(/^42501 .*not the pinned tenant/);
    expect(await used(theirs)).toBe(1);
    expect(await used(mine)).toBe(1);
  });

  it('a spend whose transaction rolled back leaves nothing to return', async () => {
    const businessId = await seedBusiness();
    let handle: usageRepo.MeterRow | null = null;
    await withBusiness(appDb, businessId, async (tx) => {
      handle = (await usageRepo.reserveUnit(tx, businessId, PERIOD, UNIT, 10)).meter;
      throw new Error('the job failed after metering');
    }).catch(() => undefined);
    await reserve(appDb, businessId);
    expect(await used(businessId)).toBe(1);
    /* The old repository would have lowered the counter here, returning a unit never spent. */
    expect(await refund(appDb, businessId, handle!)).toBe(0);
    expect(await used(businessId)).toBe(1);
  });

  it('a reservation older than 45 days is no longer returnable', async () => {
    const businessId = await seedBusiness();
    const spent = await reserve(appDb, businessId);
    await ownerDb.execute(
      sql`UPDATE usage_reservations SET created_at = now() - interval '46 days' WHERE business_id = ${businessId}::uuid`,
    );
    expect(await refund(appDb, businessId, spent.meter)).toBe(0);
    expect(await used(businessId)).toBe(1);
  });
});

describe('OD-51.4: no runtime role rewrites a counter or the reservation ledger', () => {
  it.each(RUNTIME)(
    '%s cannot insert, reset, lower, raise or delete a usage counter',
    async (who) => {
      const businessId = await seedBusiness();
      await reserve(appDb, businessId);
      await reserve(appDb, businessId);
      const db = PRINCIPALS[who]();
      for (const statement of [
        sql`UPDATE usage_counters SET used = 0 WHERE business_id = ${businessId}::uuid`,
        sql`UPDATE usage_counters SET used = used - 1 WHERE business_id = ${businessId}::uuid`,
        sql`UPDATE usage_counters SET used = 1000000 WHERE business_id = ${businessId}::uuid`,
        sql`UPDATE usage_counters SET bonus = 500 WHERE business_id = ${businessId}::uuid`,
        sql`DELETE FROM usage_counters WHERE business_id = ${businessId}::uuid`,
        sql`INSERT INTO usage_counters (business_id, period, unit, used) VALUES (${businessId}::uuid, '2026-12', 'AI_ACTIONS', 0)`,
        sql`INSERT INTO usage_counters (business_id, period, unit, bonus) VALUES (${businessId}::uuid, '2026-12', 'VOICE_MINUTES', 900)`,
      ]) {
        expect(await outcome(withBusiness(db, businessId, (tx) => tx.execute(statement)))).toMatch(
          /^42501 permission denied for table usage_counters/,
        );
      }
      expect(await row(businessId)).toMatchObject({ used: 2, bonus: 0 });
    },
  );

  it.each(RUNTIME)('%s cannot read or write the reservation ledger', async (who) => {
    const businessId = await seedBusiness();
    const spent = await reserve(appDb, businessId);
    const id = usageRepo.reservationOf(spent.meter)!;
    const db = PRINCIPALS[who]();
    for (const statement of [
      sql`SELECT id FROM usage_reservations WHERE business_id = ${businessId}::uuid`,
      sql`UPDATE usage_reservations SET quantity = 1000, refunded = 0 WHERE id = ${id}::uuid`,
      sql`INSERT INTO usage_reservations (business_id, period, unit, quantity) VALUES (${businessId}::uuid, '2026-11', 'AI_ACTIONS', 1000)`,
      sql`DELETE FROM usage_reservations WHERE id = ${id}::uuid`,
    ]) {
      expect(await outcome(withBusiness(db, businessId, (tx) => tx.execute(statement)))).toMatch(
        /^42501 permission denied for table usage_reservations/,
      );
    }
  });

  it('only the application and the worker meter; only settlement credits', async () => {
    const businessId = await seedBusiness();
    const call = (db: Db, statement: ReturnType<typeof sql>) =>
      outcome(withBusiness(db, businessId, (tx) => tx.execute(statement)));
    const reserveSql = sql`SELECT * FROM usage_reserve(${businessId}::uuid, '2026-11', 'AI_ACTIONS', 10, 1, true)`;
    const refundSql = sql`SELECT usage_refund(${businessId}::uuid, gen_random_uuid(), 'AI_ACTIONS', 1)`;
    for (const who of ['operator'] as const) {
      expect(await call(PRINCIPALS[who](), reserveSql)).toMatch(
        /^42501 permission denied for function usage_reserve/,
      );
      expect(await call(PRINCIPALS[who](), refundSql)).toMatch(
        /^42501 permission denied for function usage_refund/,
      );
    }
    for (const who of ['app', 'worker'] as const) {
      expect(await call(PRINCIPALS[who](), reserveSql)).toBe('allowed');
      expect(await call(PRINCIPALS[who](), refundSql)).toBe('allowed');
    }
    /* No login role can become the writer the functions run as. */
    for (const who of RUNTIME) {
      expect(await outcome(PRINCIPALS[who]().execute(sql`SET ROLE rekoda_usage_writer`))).toMatch(
        /^42501 /,
      );
    }
  });

  it('the functions refuse nonsense and a business that is not the pinned tenant', async () => {
    const businessId = await seedBusiness();
    const other = await seedBusiness();
    const call = (statement: ReturnType<typeof sql>) =>
      outcome(withBusiness(appDb, businessId, (tx) => tx.execute(statement)));
    for (const statement of [
      sql`SELECT * FROM usage_reserve(${businessId}::uuid, '2026-11', 'AI_ACTIONS', 10, 0, true)`,
      sql`SELECT * FROM usage_reserve(${businessId}::uuid, '2026-11', 'AI_ACTIONS', 10, -5, true)`,
      sql`SELECT * FROM usage_reserve(${businessId}::uuid, '2026-11', 'AI_ACTIONS', -1, 1, true)`,
      sql`SELECT * FROM usage_reserve(${businessId}::uuid, '2026-13', 'AI_ACTIONS', 10, 1, true)`,
      sql`SELECT * FROM usage_reserve(${businessId}::uuid, 'whatever', 'AI_ACTIONS', 10, 1, true)`,
      sql`SELECT usage_refund(${businessId}::uuid, gen_random_uuid(), 'AI_ACTIONS', 0)`,
      sql`SELECT usage_refund(${businessId}::uuid, gen_random_uuid(), 'AI_ACTIONS', -3)`,
    ]) {
      expect(await call(statement)).toMatch(/^22023 /);
    }
    expect(
      await call(
        sql`SELECT * FROM usage_reserve(${other}::uuid, '2026-11', 'AI_ACTIONS', 10, 1, true)`,
      ),
    ).toMatch(/^42501 .*not the pinned tenant/);
    expect(
      await call(
        sql`SELECT * FROM usage_reserve(${businessId}::uuid, '2026-11', 'NOT_A_UNIT', 10, 1, true)`,
      ),
    ).toMatch(/^23514 /);
    expect(await row(other)).toBeUndefined();
  });
});

describe('OD-51.4: a ceiling is raised once, for one paid pack charge', () => {
  const credit = (db: Db, businessId: string, reference: string, n = 100) =>
    withBusiness(db, businessId, (tx) =>
      usageRepo.creditPack(tx, businessId, reference, PERIOD, UNIT, n),
    );
  const creditedAt = async (reference: string) =>
    [
      ...(await ownerDb.execute<{ at: string | null }>(
        sql`SELECT units_credited_at::text AS at FROM subscription_charges WHERE reference = ${reference}`,
      )),
    ][0]!.at;

  it('credits a paid pack charge once and stamps it in the same call', async () => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId, { kind: 'add_on', plan: null });
    expect(await credit(settlementDb, businessId, reference)).toBe(true);
    const stamped = await creditedAt(reference);
    expect(stamped).not.toBeNull();
    for (let i = 0; i < 3; i += 1)
      expect(await credit(settlementDb, businessId, reference)).toBe(false);
    expect((await row(businessId))?.bonus).toBe(100);
    expect(await creditedAt(reference)).toBe(stamped);
  });

  it('refuses a charge that is pending, set aside, not a pack, or of another business', async () => {
    const businessId = await seedBusiness();
    const other = await seedBusiness();
    const refused = /^42501 .*not a paid pack charge that may be credited/;
    const pending = await seedCharge(businessId, { kind: 'add_on', plan: null, status: 'pending' });
    const setAside = await seedCharge(businessId, { kind: 'add_on', plan: null, unapplied: true });
    const plan = await seedCharge(businessId, { kind: 'first_purchase' });
    const theirs = await seedCharge(other, { kind: 'add_on', plan: null });
    for (const reference of [pending, setAside, plan, theirs, 'RKD-PACK-NO-SUCH']) {
      expect(await outcome(credit(settlementDb, businessId, reference))).toMatch(refused);
    }
    expect(await row(businessId)).toBeUndefined();
  });

  it('settlement itself can no longer raise a ceiling or stamp a charge directly', async () => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId, { kind: 'add_on', plan: null });
    expect(
      await outcome(
        withBusiness(settlementDb, businessId, (tx) =>
          tx.execute(
            sql`INSERT INTO usage_counters (business_id, period, unit, bonus) VALUES (${businessId}::uuid, '2026-11', 'AI_ACTIONS', 500)`,
          ),
        ),
      ),
    ).toMatch(/^42501 permission denied for table usage_counters/);
    expect(
      await outcome(
        withBusiness(settlementDb, businessId, (tx) =>
          tx.execute(
            sql`UPDATE subscription_charges SET units_credited_at = now() WHERE reference = ${reference}`,
          ),
        ),
      ),
    ).toMatch(/^42501 .*credited only through usage_credit_pack/);
    expect(await creditedAt(reference)).toBeNull();
  });
});
