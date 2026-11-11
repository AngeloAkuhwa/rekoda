/**
 * The PR #432 remediation brief §5.3 and §5.4 (migration 0209), proved on live connections AS each
 * principal: the stolen-credential scenarios are run directly against the database, not through the
 * application's own validation.
 *
 *   metering   `usage_counters` is written only through usage_reserve / usage_release /
 *              usage_credit_bonus; consumption is journalled; a release gives back only a recorded
 *              consumption, once, for at most what it took
 *   refunds    only the billing operator records one, bounded by what was paid, audited
 *   schedule   the merchant's scheduled plan and interval change only through validated functions
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness, type Db } from '../client.js';
import { subscriptionsRepo, usageRepo } from '../index.js';
import {
  appDb,
  operatorDb,
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

const PERIOD = '2026-11';
const meter = usageRepo.monthMeter(PERIOD);

const counter = async (businessId: string) =>
  [
    ...(await ownerDb.execute<{ used: number; bonus: number }>(sql`
      SELECT used, bonus FROM usage_counters
      WHERE business_id = ${businessId}::uuid AND period = ${PERIOD} AND unit = 'AI_ACTIONS'`)),
  ][0];

const asRole = (db: Db, businessId: string, statement: ReturnType<typeof sql>) =>
  outcome(withBusiness(db, businessId, (tx) => tx.execute(statement)));

/** A paid business (the meter row is the calendar month), set as the owner. */
async function paidBusiness(): Promise<string> {
  const businessId = await seedBusiness();
  await ownerDb.execute(sql`UPDATE businesses SET plan = 'complete', billing_interval = 'monthly',
    cycle_started_at = now(), plan_expires_at = now() + interval '1 month'
    WHERE id = ${businessId}::uuid`);
  return businessId;
}

const reserve = (db: Db, businessId: string, n: number, allowance = 100) =>
  withBusiness(db, businessId, (tx) =>
    usageRepo.reserveUnit(tx, businessId, PERIOD, 'AI_ACTIONS', allowance, n),
  );
const release = (db: Db, businessId: string, n: number) =>
  withBusiness(db, businessId, (tx) =>
    usageRepo.refundUnit(tx, businessId, meter, 'AI_ACTIONS', n),
  );

describe('metering: consumption only goes down by releasing what was recorded (0209)', () => {
  it.each(['app', 'worker', 'settlement', 'operator'] as const)(
    '%s cannot write a counter row directly: no insert, no lowering used, no raising bonus, no delete',
    async (who) => {
      const businessId = await paidBusiness();
      await reserve(appDb, businessId, 5);
      const db = PRINCIPALS[who]();
      for (const statement of [
        sql`UPDATE usage_counters SET used = 0 WHERE business_id = ${businessId}::uuid`,
        sql`UPDATE usage_counters SET bonus = bonus + 500 WHERE business_id = ${businessId}::uuid`,
        sql`DELETE FROM usage_counters WHERE business_id = ${businessId}::uuid`,
        sql`INSERT INTO usage_counters (business_id, period, unit, used)
            VALUES (${businessId}::uuid, '2026-12', 'AI_ACTIONS', 0)`,
        sql`INSERT INTO usage_reservations (business_id, period, unit, n)
            VALUES (${businessId}::uuid, ${PERIOD}, 'AI_ACTIONS', 50)`,
        sql`UPDATE usage_reservations SET released_n = 0 WHERE business_id = ${businessId}::uuid`,
      ]) {
        expect(await asRole(db, businessId, statement)).toMatch(/^42501 permission denied/);
      }
      expect(await counter(businessId)).toEqual({ used: 5, bonus: 0 });
    },
  );

  it('a release gives back only a recorded consumption, once, for at most what it took', async () => {
    const businessId = await paidBusiness();
    expect((await reserve(appDb, businessId, 3)).granted).toBe(true);
    expect((await reserve(workerDb, businessId, 2)).granted).toBe(true);
    expect(await counter(businessId)).toEqual({ used: 5, bonus: 0 });

    // More than any one reservation took: refused, nothing changes.
    expect(await release(appDb, businessId, 4)).toBe(false);
    expect(await counter(businessId)).toEqual({ used: 5, bonus: 0 });
    // The two recorded consumptions, each once.
    expect(await release(appDb, businessId, 2)).toBe(true);
    expect(await release(workerDb, businessId, 3)).toBe(true);
    expect(await counter(businessId)).toEqual({ used: 0, bonus: 0 });
    // Replaying either release finds nothing left to give back.
    expect(await release(appDb, businessId, 2)).toBe(false);
    expect(await release(appDb, businessId, 1)).toBe(false);
    expect(await counter(businessId)).toEqual({ used: 0, bonus: 0 });
  });

  it('a release is journalled with who asked, and a reservation older than 35 days cannot be released', async () => {
    const businessId = await paidBusiness();
    await reserve(appDb, businessId, 2);
    await ownerDb.execute(sql`UPDATE usage_reservations SET reserved_at = now() - interval '36 days'
      WHERE business_id = ${businessId}::uuid`);
    expect(await release(appDb, businessId, 2)).toBe(false);
    await reserve(appDb, businessId, 1);
    expect(await release(workerDb, businessId, 1)).toBe(true);
    const journal = [
      ...(await ownerDb.execute<{
        n: number;
        released_n: number;
        reserved_by: string;
        released_by: string | null;
      }>(
        sql`SELECT n, released_n, reserved_by, released_by FROM usage_reservations
            WHERE business_id = ${businessId}::uuid ORDER BY reserved_at`,
      )),
    ];
    expect(journal).toEqual([
      { n: 2, released_n: 0, reserved_by: 'rekoda_app', released_by: null },
      { n: 1, released_n: 1, reserved_by: 'rekoda_app', released_by: 'rekoda_worker' },
    ]);
  });

  it('a release cannot reach another business: the pin is checked and RLS holds', async () => {
    const a = await paidBusiness();
    const b = await paidBusiness();
    await reserve(appDb, b, 4);
    expect(
      await asRole(appDb, a, sql`SELECT usage_release(${b}::uuid, ${PERIOD}, 'AI_ACTIONS', 4)`),
    ).toMatch(/42501.*not the pinned tenant/);
    expect(await counter(b)).toEqual({ used: 4, bonus: 0 });
  });

  it('only settlement credits pack units, and only through its function', async () => {
    const businessId = await paidBusiness();
    for (const who of ['app', 'worker', 'operator'] as const) {
      expect(
        await outcome(
          withBusiness(PRINCIPALS[who](), businessId, (tx) =>
            usageRepo.creditBonus(tx, businessId, PERIOD, 'AI_ACTIONS', 100),
          ),
        ),
      ).toMatch(/42501.*permission denied for function usage_credit_bonus/);
    }
    await withBusiness(settlementDb, businessId, (tx) =>
      usageRepo.creditBonus(tx, businessId, PERIOD, 'AI_ACTIONS', 100),
    );
    expect((await counter(businessId))?.bonus).toBe(100);
  });
});

describe('refunds: only the billing operator records one, bounded and audited (0209)', () => {
  const BY = { actor: 'operator:refund-test', reason: 'duplicate charge, ticket 12' };

  it.each(['app', 'worker', 'settlement'] as const)(
    '%s cannot record a refund, directly or through the writer',
    async (who) => {
      const businessId = await seedBusiness();
      const reference = await seedCharge(businessId);
      const db = PRINCIPALS[who]();
      expect(
        await asRole(
          db,
          businessId,
          sql`SELECT * FROM subscription_record_refund(${businessId}::uuid,
          ${reference}, 1000, ${BY.actor}, ${BY.reason})`,
        ),
      ).toMatch(/42501.*permission denied for function subscription_record_refund/);
      for (const statement of [
        sql`UPDATE subscription_charges SET refunded_amount_k = 990000 WHERE reference = ${reference}`,
        sql`UPDATE subscription_charges SET status = 'refunded' WHERE reference = ${reference}`,
        sql`UPDATE subscription_charges SET refunded_at = now() WHERE reference = ${reference}`,
      ]) {
        expect(await asRole(db, businessId, statement)).toMatch(/^42501/);
      }
    },
  );

  it('the application cannot rewrite the provider fields on a charge', async () => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId);
    for (const statement of [
      sql`UPDATE subscription_charges SET provider_reference = 'forged' WHERE reference = ${reference}`,
      sql`UPDATE subscription_charges SET failure_reason = 'x' WHERE reference = ${reference}`,
    ]) {
      expect(await asRole(appDb, businessId, statement)).toMatch(/^42501 .*settlement/);
    }
  });

  it('the operator refunds at most what was paid, with an actor and a reason, audited', async () => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId); // chat, 990000 paid
    const refund = (amount: number, by = BY) =>
      withBusiness(operatorDb, businessId, (tx) =>
        subscriptionsRepo.refundCharge(tx, businessId, reference, amount, by),
      );
    expect(await refund(990_001)).toBeNull();
    expect((await refund(400_000))?.status).toBe('paid');
    expect(await refund(590_001)).toBeNull();
    expect((await refund(590_000))?.status).toBe('refunded');
    expect(await refund(1)).toBeNull();
    // A refund with no verified operator actor or no reason is refused (and not audited).
    expect(await refund(1, { actor: 'system', reason: 'x' })).toBeNull();
    expect(await refund(1, { actor: BY.actor, reason: '  ' })).toBeNull();
    const trail = [
      ...(await ownerDb.execute<{ actor: string; reason: string }>(sql`
        SELECT actor, reason FROM audit_events WHERE business_id = ${businessId}::uuid
          AND action = 'refunded' ORDER BY created_at`)),
    ];
    expect(trail).toEqual([
      { actor: BY.actor, reason: BY.reason },
      { actor: BY.actor, reason: BY.reason },
    ]);
  });
});

describe("the merchant's scheduled change: validated writers only (0209)", () => {
  /* As the role, in a rolled-back owner transaction that first drops the harness's fixture writer
   * (never in a deployed database; the guard exempts it so suites can build cycles directly). */
  const asRoleWithoutFixture = (businessId: string, role: string, statement: string) =>
    outcome(
      ownerDb.transaction(async (tx) => {
        await tx.execute(
          sql.raw('DROP FUNCTION public.test_fixture_set_plan(uuid, text, timestamptz)'),
        );
        await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
        await tx.execute(sql`SELECT set_config('app.business_id', ${businessId}, true)`);
        await tx.execute(sql.raw(statement.replace('$B', `'${businessId}'::uuid`)));
        throw Object.assign(new Error('rolled back'), { cause: { code: 'OK', message: '' } });
      }),
    );

  it.each(['rekoda_app', 'rekoda_worker'])(
    '%s cannot write the scheduling columns directly',
    async (role) => {
      const businessId = await paidBusiness();
      for (const set of [
        "pending_plan = 'chat'",
        "pending_billing_interval = 'annual'",
        "plan_decided_at = now() - interval '1 year'",
        'plan_decided_before_pending = now()',
      ]) {
        expect(
          await asRoleWithoutFixture(
            businessId,
            role,
            `UPDATE businesses SET ${set} WHERE id = $B`,
          ),
        ).toMatch(/^42501 .*subscription_schedule_plan/);
      }
      // Settlement and the billing operator write a whole new subscription state, so they may.
      for (const allowed of ['rekoda_settlement', 'rekoda_billing_operator']) {
        expect(
          await asRoleWithoutFixture(
            businessId,
            allowed,
            "UPDATE businesses SET pending_plan = 'chat' WHERE id = $B",
          ),
        ).toBe('OK ');
      }
    },
  );

  it('only a cheaper plan or a cancellation waits for the renewal, on a paid business', async () => {
    const businessId = await paidBusiness(); // complete
    const schedule = (plan: string | null) =>
      outcome(
        withBusiness(appDb, businessId, (tx) =>
          subscriptionsRepo.schedulePlanChange(tx, businessId, plan),
        ),
      );
    expect(await schedule('complete')).toMatch(/22023.*only a cheaper plan/);
    expect(await schedule('trial')).toMatch(/22023.*invalid input/);
    expect(await schedule('chat')).toBe('allowed');
    expect(await schedule('expired')).toBe('allowed');
    expect(await schedule(null)).toBe('allowed');
    await ownerDb.execute(sql`UPDATE businesses SET plan = 'chat' WHERE id = ${businessId}::uuid`);
    expect(await schedule('integrate')).toMatch(/22023.*only a cheaper plan/);
    const trial = await seedBusiness();
    expect(
      await outcome(
        withBusiness(appDb, trial, (tx) => subscriptionsRepo.schedulePlanChange(tx, trial, 'chat')),
      ),
    ).toMatch(/22023.*only a paid plan/);
  });

  it('an interval switch is monthly, annual or the undo, on a paid business; the worker cannot run it', async () => {
    const businessId = await paidBusiness();
    const sw = (db: Db, interval: string | null) =>
      asRole(
        db,
        businessId,
        sql`SELECT subscription_schedule_interval(${businessId}::uuid, ${interval})`,
      );
    expect(await sw(appDb, 'weekly')).toMatch(/22023/);
    expect(await sw(appDb, 'annual')).toBe('allowed');
    expect(await sw(appDb, null)).toBe('allowed');
    expect(await sw(workerDb, 'annual')).toMatch(/42501.*permission denied/);
  });

  it('a scheduling function cannot reach another business', async () => {
    const a = await paidBusiness();
    const b = await paidBusiness();
    expect(
      await asRole(appDb, a, sql`SELECT subscription_schedule_plan(${b}::uuid, 'chat')`),
    ).toMatch(/42501.*not the pinned tenant/);
    const [row] = await ownerDb.execute<{ pending_plan: string | null }>(
      sql`SELECT pending_plan FROM businesses WHERE id = ${b}::uuid`,
    );
    expect(row?.pending_plan).toBeNull();
  });
});
