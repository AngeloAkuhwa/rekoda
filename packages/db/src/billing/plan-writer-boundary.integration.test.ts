/**
 * OD-37 (migrations 0200, 0202, 0203; owner review of PR #432, 11 Nov 2026): who may record a payment,
 * apply a paid plan or make an operator plan change, and what each writer accepts.
 *
 *   rekoda_settlement        the only non-owner role that records a payment on a charge, credits
 *                            pack units, holds an add-on, or runs `subscription_apply_paid_charge`;
 *   rekoda_billing_operator  the only role that runs `subscription_operator_set_plan`;
 *   rekoda_app, rekoda_worker neither: a holder of the general credentials cannot forge a paid
 *                            charge, credit units, or make an operator plan change.
 *
 * Every assertion is made on a live connection AS that principal (the CI database authenticates by
 * trust, so each URL is its own role), never through the owner. The writers enforce Rekoda's real
 * durations: a monthly plan ends within one calendar month, an annual plan within twelve, a trial
 * within 14 days of the business's own trial start, `expired` at or before now; the database's copy
 * of the length rule is pinned to `@rekoda/core` here. The plan-field role boundary itself is pinned
 * in plan-fields-guard.integration.test.ts.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TransactionRollbackError } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness } from '../client.js';
import { addInterval, TRIAL_DAYS } from '@rekoda/core';
import { billingRepo, identity, subscriptionsRepo } from '../index.js';
import {
  appDb,
  dbBound,
  FUTURE,
  operatorDb,
  outcome,
  ownerDb,
  planOf,
  PRINCIPALS,
  seedBusiness,
  seedCharge,
  settlementDb,
  urls,
  usePlanWriterHarness,
  type ChargeSpec,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

describe('OD-37: the provider writer applies one paid, unapplied charge, for one interval (0200, 0203)', () => {
  const apply = (
    businessId: string,
    reference: string,
    expires: Date | null = FUTURE,
    db = settlementDb,
  ) =>
    outcome(
      withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`SELECT subscription_apply_paid_charge(${businessId}::uuid, ${reference}, ${expires?.toISOString() ?? null}::timestamptz)`,
        ),
      ),
    );

  it.each(['app', 'worker', 'operator'] as const)('%s cannot run it at all', async (who) => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId, { plan: 'complete' });
    expect(await apply(businessId, reference, FUTURE, PRINCIPALS[who]())).toMatch(
      /42501.*permission denied for function subscription_apply_paid_charge/,
    );
    expect((await planOf(businessId))?.plan).toBe('trial');
  });

  it('takes the plan from the charge, not from the caller', async () => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId, { plan: 'integrate' });
    expect(await apply(businessId, reference)).toBe('allowed');
    expect((await planOf(businessId))?.plan).toBe('integrate');
    const other = await seedBusiness();
    const chat = await seedCharge(other, { plan: 'chat' });
    await expect(
      withBusiness(settlementDb, other, (tx) =>
        subscriptionsRepo.applyCycle(tx, other, {
          chargeReference: chat,
          plan: 'complete',
          cycleStartedAt: new Date(),
          renewsAt: FUTURE,
          anchorDay: 1,
        }),
      ),
    ).rejects.toThrow(/different plan/);
    expect((await planOf(other))?.plan).toBe('trial');
  });

  it.each([
    ['no such charge', { exists: false }],
    ['a pending charge', { status: 'pending' }],
    ['a failed charge', { status: 'failed' }],
    ['an add-on charge', { kind: 'add_on', plan: null }],
    ['a charge already applied', { applied: true }],
    ['a charge marked unapplied', { unapplied: true }],
  ] as const)('refuses %s', async (_label, spec) => {
    const businessId = await seedBusiness();
    const reference =
      'exists' in spec ? 'RKD-SUB-NOPE-000001' : await seedCharge(businessId, spec as ChargeSpec);
    expect(await apply(businessId, reference)).toMatch(
      /^42501 subscription_apply_paid_charge: (no such charge for this business|the charge is not a paid, unapplied plan charge)/,
    );
    expect((await planOf(businessId))?.plan).toBe('trial');
  });

  it("refuses another business's paid charge, even with the pin repointed", async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    const reference = await seedCharge(a, { plan: 'complete' });
    expect(await apply(b, reference)).toMatch(
      /^42501 subscription_apply_paid_charge: no such charge for this business/,
    );
    expect((await planOf(b))?.plan).toBe('trial');
  });

  it('applies a paid charge that was superseded as the payable link (it still buys its cycle, G-104)', async () => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId, { plan: 'chat', superseded: true });
    expect(await apply(businessId, reference)).toBe('allowed');
    expect((await planOf(businessId))?.plan).toBe('chat');
  });

  it('applies one paid charge at most once: the writer claims the charge itself', async () => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId, { plan: 'chat' });
    expect(await apply(businessId, reference)).toBe('allowed');
    expect(await apply(businessId, reference, new Date(Date.now() + 20 * 86_400_000))).toMatch(
      /42501.*not a paid, unapplied plan charge/,
    );
    const [row] = await ownerDb.execute<{ end: string | null }>(
      sql`SELECT applied_period_end AS end FROM subscription_charges WHERE reference = ${reference}`,
    );
    expect(new Date(row!.end!).toISOString()).toBe(FUTURE.toISOString());
  });

  it('an applied charge cannot be un-applied by the application to buy a second cycle', async () => {
    const businessId = await seedBusiness();
    const reference = await seedCharge(businessId, { plan: 'chat' });
    expect(await apply(businessId, reference)).toBe('allowed');
    for (const column of ['applied_period_end', 'applied_period_start']) {
      expect(
        await outcome(
          withBusiness(appDb, businessId, (tx) =>
            tx.execute(
              sql`UPDATE subscription_charges SET ${sql.raw(column)} = NULL WHERE reference = ${reference}`,
            ),
          ),
        ),
      ).toMatch(/^42501 a charge's applied period cannot be cleared/);
    }
    expect(await apply(businessId, reference)).toMatch(/42501.*not a paid, unapplied plan charge/);
  });

  it('a monthly charge buys at most one month (plus the three days a month-end anchor restores); an annual one twelve', async () => {
    const businessId = await seedBusiness();
    const monthly = await seedCharge(businessId, { plan: 'chat' });
    // The business's current end is its 14-day trial, so the base is the payment time (now).
    const monthBound = await dbBound('monthly');
    expect(
      await apply(businessId, monthly, new Date(monthBound.getTime() + 4 * 86_400_000)),
    ).toMatch(
      /^22023 subscription_apply_paid_charge: the renewal date is outside the charge's monthly period/,
    );
    expect(await apply(businessId, monthly, new Date('2099-01-01T00:00:00Z'))).toMatch(/^22023/);
    expect(await apply(businessId, monthly, new Date(Date.now() - 86_400_000))).toMatch(/^22023/);
    expect(await apply(businessId, monthly, null)).toMatch(/^22023/);
    expect((await planOf(businessId))?.plan).toBe('trial');
    expect(await apply(businessId, monthly, new Date(monthBound.getTime() + 2 * 86_400_000))).toBe(
      'allowed',
    );

    const yearly = await seedBusiness();
    const annual = await seedCharge(yearly, { plan: 'complete', interval: 'annual' });
    const yearBound = await dbBound('annual');
    expect(await apply(yearly, annual, new Date(yearBound.getTime() + 4 * 86_400_000))).toMatch(
      /outside the charge's annual period/,
    );
    expect(await apply(yearly, annual, addInterval(new Date(), 'annual'))).toBe('allowed');
  });
});

describe("OD-37: the operator writer runs only as the billing operator, inside Rekoda's durations (0203)", () => {
  const set = (
    businessId: string,
    plan: string,
    expires: Date | null,
    interval: string | null,
    actor = 'operator:alice',
    db = operatorDb,
  ) =>
    outcome(
      withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`SELECT subscription_operator_set_plan(${businessId}::uuid, ${plan}, ${expires?.toISOString() ?? null}::timestamptz, ${interval}, ${actor})`,
        ),
      ),
    );

  it.each(['app', 'worker', 'settlement'] as const)(
    '%s cannot run it, so an ordinary credential cannot bypass the API authorisation',
    async (who) => {
      const businessId = await seedBusiness();
      expect(
        await set(businessId, 'complete', FUTURE, 'monthly', 'operator:x', PRINCIPALS[who]()),
      ).toMatch(/42501.*permission denied for function subscription_operator_set_plan/);
      expect((await planOf(businessId))?.plan).toBe('trial');
      const [audit] = await ownerDb.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'plan_changed'`,
      );
      expect(audit!.n).toBe(0);
    },
  );

  /* The writer's own answer: the cycle start and end it wrote, and whether it changed anything. */
  const setRow = async (businessId: string, plan: string, interval: string | null) => {
    const rows = await withBusiness(operatorDb, businessId, (tx) =>
      tx.execute<{ cycle_start: string | null; expires_at: string; changed: boolean }>(
        sql`SELECT cycle_start, expires_at, changed FROM subscription_operator_set_plan(${businessId}::uuid, ${plan}, NULL, ${interval}, 'operator:alice')`,
      ),
    );
    return [...rows][0]!;
  };
  const dbAddInterval = async (from: string, interval: string) => {
    const [row] = await ownerDb.execute<{ at: string }>(
      sql`SELECT rekoda_private.add_billing_interval(${from}::timestamptz, ${interval})::text AS at`,
    );
    return new Date(row!.at).getTime();
  };
  const planChangedCount = async (businessId: string) => {
    const [row] = await ownerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE business_id = ${businessId}::uuid AND action = 'plan_changed'`,
    );
    return row!.n;
  };

  it('a paid plan runs its standard period: the caller gives no end, longer or shorter (OD-50, 0207)', async () => {
    const businessId = await seedBusiness();
    const bound = await dbBound('monthly');
    for (const end of [
      new Date(bound.getTime() + 1_000), // longer than a month
      new Date(Date.now() + 20 * 86_400_000), // shorter than a month
      bound, // even the exact bound computed a moment earlier
      new Date(Date.now() - 60_000), // in the past
      new Date('2099-01-01T00:00:00Z'),
    ]) {
      expect(await set(businessId, 'chat', end, 'monthly')).toMatch(
        /^22023 .*runs its standard period; give no end date/,
      );
    }
    expect((await planOf(businessId))?.plan).toBe('trial');
    expect(await planChangedCount(businessId)).toBe(0);
  });

  it('a monthly plan ends exactly one Lagos calendar month after the cycle start the writer used', async () => {
    const businessId = await seedBusiness();
    const before = Date.now();
    const row = await setRow(businessId, 'chat', 'monthly');
    expect(row.changed).toBe(true);
    const start = new Date(row.cycle_start!).getTime();
    expect(start).toBeGreaterThanOrEqual(before - 5_000);
    expect(start).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(new Date(row.expires_at).getTime()).toBe(
      await dbAddInterval(row.cycle_start!, 'monthly'),
    );
    const after = await planOf(businessId);
    expect(after?.plan).toBe('chat');
    expect(new Date(after!.plan_expires_at!).getTime()).toBe(new Date(row.expires_at).getTime());
  });

  it('an annual plan ends exactly twelve Lagos calendar months after its cycle start', async () => {
    const businessId = await seedBusiness();
    const row = await setRow(businessId, 'complete', 'annual');
    expect(row.changed).toBe(true);
    expect(new Date(row.expires_at).getTime()).toBe(
      await dbAddInterval(row.cycle_start!, 'annual'),
    );
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now() + 360 * 86_400_000);
  });

  it('re-posting the plan and interval already in force changes nothing; another interval is a new period', async () => {
    const businessId = await seedBusiness();
    const first = await setRow(businessId, 'chat', 'monthly');
    const again = await setRow(businessId, 'chat', 'monthly');
    expect(again.changed).toBe(false);
    expect(again.expires_at).toBe(first.expires_at);
    expect(await planChangedCount(businessId)).toBe(1);
    const annual = await setRow(businessId, 'chat', 'annual');
    expect(annual.changed).toBe(true);
    expect(new Date(annual.expires_at).getTime()).toBe(
      await dbAddInterval(annual.cycle_start!, 'annual'),
    );
    expect(await planChangedCount(businessId)).toBe(2);
  });

  it('a plan that has ended can be given a fresh period by re-posting it', async () => {
    const businessId = await seedBusiness();
    await setRow(businessId, 'chat', 'monthly');
    await ownerDb.execute(
      sql`UPDATE businesses SET plan_expires_at = now() - interval '1 day' WHERE id = ${businessId}::uuid`,
    );
    const fresh = await setRow(businessId, 'chat', 'monthly');
    expect(fresh.changed).toBe(true);
    expect(new Date(fresh.expires_at).getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000);
  });

  it('a paid plan names its interval; trial and expired do not', async () => {
    const businessId = await seedBusiness();
    expect(await set(businessId, 'chat', FUTURE, null)).toMatch(/^22023 .*names its interval/);
    expect(await set(businessId, 'chat', FUTURE, 'weekly')).toMatch(/^22023/);
    expect(await set(businessId, 'trial', FUTURE, 'monthly')).toMatch(
      /^22023 .*names its interval/,
    );
    expect(await set(businessId, 'expired', new Date(), 'annual')).toMatch(/^22023/);
  });

  it("a trial runs exactly to the business's own trial start plus 14 days; no end may be given", async () => {
    const businessId = await seedBusiness();
    const started = new Date((await planOf(businessId))!.trial_started_at);
    const last = new Date(started.getTime() + TRIAL_DAYS * 86_400_000);
    for (const end of [
      new Date(last.getTime() + 1),
      last,
      new Date(started.getTime() + 86_400_000), // ending a trial early is `expired`, not a short trial
    ]) {
      expect(await set(businessId, 'trial', end, null)).toMatch(
        /^22023 .*runs its standard period; give no end date/,
      );
    }
    const row = await setRow(businessId, 'trial', null);
    expect(row.cycle_start).toBeNull();
    expect(new Date(row.expires_at).getTime()).toBe(last.getTime());
  });

  it('a business whose trial is over cannot be given another one', async () => {
    const businessId = await seedBusiness();
    await ownerDb.execute(sql`
      UPDATE businesses SET trial_started_at = now() - interval '15 days',
        plan = 'expired', plan_expires_at = now() - interval '1 day'
      WHERE id = ${businessId}::uuid`);
    expect(await set(businessId, 'trial', null, null)).toMatch(/^22023 .*trial is already over/);
    expect((await planOf(businessId))?.plan).toBe('expired');
  });

  it.each(['app', 'worker', 'settlement', 'operator'] as const)(
    '%s cannot move the trial start, so no credential can stretch the 14 days (OD-50, 0207)',
    async (who) => {
      const businessId = await seedBusiness();
      const before = (await planOf(businessId))!.trial_started_at;
      const moved = await outcome(
        withBusiness(PRINCIPALS[who](), businessId, (tx) =>
          tx.execute(
            sql`UPDATE businesses SET trial_started_at = now() + interval '30 days' WHERE id = ${businessId}::uuid`,
          ),
        ),
      );
      expect(moved).toMatch(/42501.*trial start is fixed at signup/);
      expect((await planOf(businessId))!.trial_started_at).toBe(before);
    },
  );

  it('expired never carries a future end', async () => {
    const businessId = await seedBusiness();
    expect(await set(businessId, 'expired', new Date(Date.now() + 60_000), null)).toMatch(
      /^22023 .*cannot end in the future/,
    );
    expect(await set(businessId, 'expired', new Date(Date.now() - 1_000), null)).toBe('allowed');
    expect((await planOf(businessId))?.plan).toBe('expired');
  });

  it('expired with no date is stamped on the database clock, not a host clock that runs ahead', async () => {
    // Before the fix the host's `now` (a minute ahead here) was written and the writer refused it.
    const businessId = await seedBusiness();
    const ahead = new Date(Date.now() + 60_000);
    const change = { businessId, plan: 'expired', expiresAt: null, actor: 'operator:ada' };
    expect(await outcome(billingRepo.setPlan(operatorDb, change))).toBe('allowed');
    const after = await planOf(businessId);
    expect(after?.plan).toBe('expired');
    expect(new Date(after!.plan_expires_at!).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('signup ends the trial exactly 336 hours on, across a DST change in the session time zone', async () => {
    // A POSIX zone whose clocks change in three days: 14 calendar days there are 335 hours.
    const [today] = await ownerDb.execute<{ doy: number }>(sql`
      SELECT extract(doy FROM now())::int AS doy`);
    const doy = today!.doy;
    const zone = `XST0XDT,J${((doy + 2) % 365) + 1},J${((doy + 59) % 365) + 1}`;
    const { db, close } = createDb(urls.app, { max: 1 });
    try {
      await db.execute(sql`SELECT set_config('TimeZone', ${zone}, false)`);
      const user = await identity.upsertUserByPhone(db, '+2348069990001');
      const business = await identity.createBusinessWithOwner(db, {
        name: 'Ada Fashion',
        businessType: null,
        ownerUserId: user.id,
      });
      const [row] = await ownerDb.execute<{ hours: number }>(sql`
        SELECT extract(epoch FROM plan_expires_at - trial_started_at)::int / 3600 AS hours
        FROM businesses WHERE id = ${business.id}::uuid`);
      expect(row?.hours).toBe(TRIAL_DAYS * 24);
    } finally {
      await close();
    }
  });

  it('refuses an unknown plan and a missing or system actor', async () => {
    const businessId = await seedBusiness();
    expect(await set(businessId, 'platinum', null, 'monthly')).toMatch(/22023/);
    for (const actor of [
      '',
      'system:grace-sweep',
      'user:ada',
      'operator:',
      'operator:a b',
      'ops',
    ]) {
      expect(await set(businessId, 'chat', null, 'monthly', actor)).toMatch(
        /^22023 .*invalid input/,
      );
    }
    expect(await set(businessId, 'chat', null, 'monthly', `operator:${'s'.repeat(255)}`)).toBe(
      'allowed',
    );
    expect(await set(businessId, 'chat', null, 'monthly', `operator:${'s'.repeat(256)}`)).toMatch(
      /^22023/,
    );
  });

  it('records its own audit row, interval included, in the same transaction', async () => {
    const businessId = await seedBusiness();
    const before = await planOf(businessId);
    expect(await set(businessId, 'complete', null, 'monthly', 'operator:alice')).toBe('allowed');
    const written = new Date((await planOf(businessId))!.plan_expires_at!).toISOString();
    const rows = await ownerDb.execute<{
      actor: string;
      source_type: string;
      old_value: { plan: string; expiresAt: string | null };
      new_value: { plan: string; expiresAt: string | null; billingInterval: string | null };
    }>(sql`
      SELECT actor, source_type, old_value, new_value FROM audit_events
      WHERE business_id = ${businessId}::uuid AND entity = 'business' AND action = 'plan_changed'`);
    expect([...rows]).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: 'operator:alice',
      source_type: 'operator',
      old_value: { plan: 'trial', expiresAt: new Date(before!.plan_expires_at!).toISOString() },
      new_value: { plan: 'complete', expiresAt: written, billingInterval: 'monthly' },
    });
    expect(await set(businessId, 'platinum', null, 'monthly')).toMatch(/22023/);
    const [count] = await ownerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_events WHERE business_id = ${businessId}::uuid AND action = 'plan_changed'`,
    );
    expect(count!.n).toBe(1);
  });

  it('setPlan applies the same rules with the operator principal and refuses them as a typed 400 cause', async () => {
    const businessId = await seedBusiness();
    await expect(
      billingRepo.setPlan(operatorDb, {
        businessId,
        plan: 'chat',
        expiresAt: new Date(Date.now() + 45 * 86_400_000),
        actor: 'operator:alice',
      }),
    ).rejects.toBeInstanceOf(billingRepo.PlanDateRefused);
    await expect(
      billingRepo.setPlan(operatorDb, {
        businessId,
        plan: 'trial',
        expiresAt: null,
        billingInterval: 'monthly',
        actor: 'operator:alice',
      }),
    ).rejects.toThrow(/has no billing interval/);
    // The general credential cannot make the change at all, whatever the input.
    await expect(
      billingRepo.setPlan(appDb, {
        businessId,
        plan: 'chat',
        expiresAt: null,
        actor: 'operator:alice',
      }),
    ).rejects.toThrow();
    expect((await planOf(businessId))?.plan).toBe('trial');
    expect(
      await billingRepo.setPlan(operatorDb, {
        businessId,
        plan: 'chat',
        expiresAt: null,
        billingInterval: 'annual',
        actor: 'operator:alice',
      }),
    ).toBe(true);
    // A shorter paid period is refused as well (OD-50): ending early is `expired`.
    await expect(
      billingRepo.setPlan(operatorDb, {
        businessId,
        plan: 'integrate',
        expiresAt: new Date(Date.now() + 5 * 86_400_000),
        billingInterval: 'monthly',
        actor: 'operator:alice',
      }),
    ).rejects.toThrow(/runs exactly one billing period from now; give no end date/);
  });

  it('the expiry writer refuses an unknown previous plan and brings a future end back to now', async () => {
    const businessId = await seedBusiness();
    expect(
      await outcome(
        withBusiness(appDb, businessId, (tx) =>
          tx.execute(
            sql`SELECT subscription_expire_plan(${businessId}::uuid, 'platinum', 'grace')`,
          ),
        ),
      ),
    ).toMatch(/22023/);
    await billingRepo.setPlan(operatorDb, {
      businessId,
      plan: 'chat',
      expiresAt: null,
      actor: 'operator:alice',
    });
    await withBusiness(appDb, businessId, (tx) =>
      subscriptionsRepo.schedulePlanChange(tx, businessId, 'expired'),
    );
    expect(
      await withBusiness(appDb, businessId, (tx) =>
        subscriptionsRepo.expireSubscription(tx, businessId, 'system:test', 'cancelled'),
      ),
    ).toBe('chat');
    const after = await planOf(businessId);
    expect(after?.plan).toBe('expired');
    expect(new Date(after!.plan_expires_at!).getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });
});

describe('the database length rule is the core rule (0203)', () => {
  it.each([
    '2026-01-31T10:15:42.123Z',
    '2026-01-30T23:30:05.000Z', // 00:30 on 31 January in Lagos
    '2027-02-28T09:00:59.999Z',
    '2028-02-29T12:00:00.000Z', // a leap day: next year ends on 28 February
    '2026-12-31T23:59:30.000Z', // a year end in Lagos
    '2026-03-31T00:00:00.000Z',
    '2026-11-11T08:44:00.000Z',
  ])('from %s, one month and twelve months land where core addInterval does', async (iso) => {
    const from = new Date(iso);
    for (const interval of ['monthly', 'annual'] as const) {
      const [row] = await ownerDb.execute<{ at: string }>(
        sql`SELECT rekoda_private.add_billing_interval(${iso}::timestamptz, ${interval})::text AS at`,
      );
      const db = new Date(row!.at).getTime();
      const core = addInterval(from, interval).getTime();
      // Core drops the seconds; the database keeps them, so it is never earlier and at most a
      // minute later: the bound never refuses a date core computed.
      expect(db - core).toBeGreaterThanOrEqual(0);
      expect(db - core).toBeLessThan(60_000);
      expect(db - core).toBe(from.getTime() % 60_000);
    }
  });

  it('the trial length is TRIAL_DAYS, and the insert guard uses it', async () => {
    const [row] = await ownerDb.execute<{ days: number; guard: string }>(sql`
      SELECT extract(epoch FROM rekoda_private.trial_length())::int / 86400 AS days,
             pg_get_functiondef('rekoda_private.businesses_plan_fields_insert_guard()'::regprocedure) AS guard`);
    expect(row!.days).toBe(TRIAL_DAYS);
    expect(row!.guard).toContain(`interval '${TRIAL_DAYS * 24} hours'`);
  });
});

describe('OD-37: no other path writes the plan fields (0200, 0203)', () => {
  it('the application cannot insert a business on a paid plan, a trial longer than 14 days, an ended one, or a moved start', async () => {
    const user = await identity.upsertUserByPhone(appDb, '+2348060009901');
    const insertAs = (plan: string, days: number | null, startedAt = sql`now()`) => {
      const id = randomUUID();
      return withBusiness(appDb, id, (tx) =>
        tx.execute(sql`
          INSERT INTO businesses (id, name, owner_user_id, plan, plan_expires_at, trial_started_at)
          VALUES (${id}::uuid, 'Forged', ${user.id}::uuid, ${plan},
                  ${days === null ? sql`NULL` : sql`now() + make_interval(days => ${days})`},
                  ${startedAt})`),
      );
    };
    for (const [plan, days] of [
      ['complete', 30],
      ['trial', 90],
      ['trial', 15],
      ['trial', null],
      ['trial', -1],
      ['trial', 0],
    ] as const) {
      expect(await outcome(insertAs(plan, days))).toMatch(
        /^42501 a new business starts on its 14-day trial/,
      );
    }
    // A trial start in the future would stretch every later trial bound: refused.
    expect(await outcome(insertAs('trial', 14, sql`now() + interval '30 days'`))).toMatch(
      /^42501 a new business starts on its 14-day trial/,
    );
    expect(await outcome(insertAs('trial', 14))).toBe('allowed');
    // Signup itself: exactly 14 days after the trial start, on the database clock.
    const businessId = await seedBusiness();
    const row = await planOf(businessId);
    expect(row?.plan).toBe('trial');
    expect(
      new Date(row!.plan_expires_at!).getTime() - new Date(row!.trial_started_at).getTime(),
    ).toBe(TRIAL_DAYS * 86_400_000);
  });

  /* 0203 is not in the list: 0207 replaced its operator writer with one that returns the period it
   * wrote, and PostgreSQL cannot CREATE OR REPLACE a function into another return type. The runner
   * re-runs only a migration whose ledger row is missing, which for 0203 can only be before 0207. */
  it('migrations 0200, 0202 and 0205 to 0207 re-run cleanly as the owner (the repair path)', async () => {
    for (const file of [
      '0200_plan_writer_boundary.sql',
      '0202_settlement_and_operator_principals.sql',
      '0205_charge_terms_belong_to_settlement.sql',
      '0206_paid_charge_bound_to_its_cycle.sql',
      '0207_operator_standard_periods.sql',
    ]) {
      const text = readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');
      await ownerDb
        .transaction(async (tx) => {
          await tx.execute(sql.raw(text));
          tx.rollback();
        })
        .catch((error: unknown) => {
          if (!(error instanceof TransactionRollbackError)) throw error;
        });
    }
    const [fn] = await ownerDb.execute<{ fn: string | null }>(
      sql`SELECT to_regprocedure('public.subscription_operator_set_plan(uuid,text,timestamptz,text,text)')::text AS fn`,
    );
    expect(fn!.fn).not.toBeNull();
  });
});
