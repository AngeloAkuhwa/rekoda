/**
 * OD-37, security re-review of PR #432 at 5772e92, finding B3 (migration 0206): a paid plan charge
 * buys the cycle it was priced for, bound in the database to the charge's frozen period, not to the
 * business columns the application credential can write.
 *
 *   * An upgrade applies only while the paid-to date is still the `period_end` it was opened for,
 *     and sets exactly that date: an upgrade priced for the last days of one cycle, paid after a
 *     renewal, cannot buy the new cycle even when the stale-charge markers have been reset.
 *   * A renewal applies only while the paid-to date is still its `period_start`.
 *   * The cycle and pricing inputs (`billing_interval`, `cycle_started_at`, `subscription_origin`,
 *     `renewal_anchor_day`, `plan_version_id`, `ever_paid_at`) change only as settlement, the
 *     billing operator, the plan writer or the table owner.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness } from '../client.js';
import { identity } from '../index.js';
import { applyFixtureCycle } from '../testing.js';
import {
  appDb,
  outcome,
  ownerDb,
  planOf,
  seedBusiness,
  settlementDb,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

const DAY = 86_400_000;
let seq = 0;

/** A business on a paid Chat cycle that ends at `end`, written by the test fixture writer. */
async function onPaidCycle(end: Date): Promise<string> {
  const businessId = await seedBusiness();
  await withBusiness(appDb, businessId, (tx) =>
    applyFixtureCycle(tx, businessId, {
      plan: 'chat',
      cycleStartedAt: new Date(end.getTime() - 30 * DAY),
      renewsAt: end,
      anchorDay: end.getUTCDate(),
    }),
  );
  return businessId;
}

/** A paid, unapplied plan charge for the period given, written as the table owner (a fixture: no
 * runtime role inserts a charge that already carries a payment). */
async function paidCharge(
  businessId: string,
  kind: 'upgrade' | 'renewal',
  plan: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<string> {
  seq += 1;
  const reference = `RKD-SUB-B3-${String(seq).padStart(6, '0')}`;
  await ownerDb.execute(sql`
      INSERT INTO subscription_charges
        (business_id, kind, plan, amount_k, status, reference, period_start, period_end, paid_at,
         billing_interval)
      VALUES (${businessId}::uuid, ${kind}, ${plan}, 1000, 'paid', ${reference},
        ${periodStart.toISOString()}::timestamptz, ${periodEnd.toISOString()}::timestamptz, now(),
        'monthly')`);
  return reference;
}

const apply = (businessId: string, reference: string, expires: Date) =>
  outcome(
    withBusiness(settlementDb, businessId, (tx) =>
      tx.execute(
        sql`SELECT subscription_apply_paid_charge(${businessId}::uuid, ${reference}, ${expires.toISOString()}::timestamptz)`,
      ),
    ),
  );

describe('B3: a paid plan charge buys the cycle it was priced for (0206)', () => {
  it('an upgrade priced for the cycle that has since been renewed is refused, whatever the markers say', async () => {
    const firstEnd = new Date(Date.now() + 2 * DAY);
    const businessId = await onPaidCycle(firstEnd);
    // Priced for the last two days of the first cycle.
    const upgrade = await paidCharge(
      businessId,
      'upgrade',
      'complete',
      new Date(firstEnd.getTime() - 30 * DAY),
      firstEnd,
    );
    // The renewal is paid and applied: the paid-to date moves a month on.
    const renewedEnd = new Date(firstEnd.getTime() + 30 * DAY);
    const renewal = await paidCharge(businessId, 'renewal', 'chat', firstEnd, renewedEnd);
    expect(await apply(businessId, renewal, renewedEnd)).toBe('allowed');
    // A holder of the application credential resets the stale-charge markers.
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`UPDATE businesses SET plan_decided_at = NULL WHERE id = ${businessId}::uuid`),
    );

    expect(await apply(businessId, upgrade, renewedEnd)).toMatch(/^42501 .*another cycle/);
    expect(await apply(businessId, upgrade, firstEnd)).toMatch(/^42501 .*another cycle/);
    const after = await planOf(businessId);
    expect(after?.plan).toBe('chat');
    expect(new Date(after!.plan_expires_at!).getTime()).toBe(renewedEnd.getTime());
  });

  it('an upgrade for the current cycle applies, and only to the end it was priced for', async () => {
    const end = new Date(Date.now() + 10 * DAY);
    const businessId = await onPaidCycle(end);
    const upgrade = await paidCharge(
      businessId,
      'upgrade',
      'complete',
      new Date(end.getTime() - 30 * DAY),
      end,
    );
    expect(await apply(businessId, upgrade, new Date(end.getTime() + DAY))).toMatch(
      /^42501 .*another cycle/,
    );
    expect(await apply(businessId, upgrade, end)).toBe('allowed');
    expect((await planOf(businessId))?.plan).toBe('complete');
  });

  it('a renewal applies only while the paid-to date is still the start of the cycle it renews', async () => {
    const end = new Date(Date.now() + 2 * DAY);
    const businessId = await onPaidCycle(end);
    const next = new Date(end.getTime() + 30 * DAY);
    const elsewhere = await paidCharge(
      businessId,
      'renewal',
      'chat',
      new Date(end.getTime() - DAY),
      next,
    );
    expect(await apply(businessId, elsewhere, next)).toMatch(/^42501 .*another cycle/);
    const renewal = await paidCharge(businessId, 'renewal', 'chat', end, next);
    expect(await apply(businessId, renewal, next)).toBe('allowed');
    // The paid-to date has moved past the stale charge's start for good.
    expect(await apply(businessId, elsewhere, next)).toMatch(/^42501 /);
  });
});

/** As `role`, in an owner transaction with the harness's fixture writer dropped (as in a deployed
 * database), always rolled back. */
async function asRoleWithoutFixture(businessId: string, role: string, statement: string) {
  return outcome(
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
}

describe('B3: the cycle and pricing inputs belong to settlement and the writers (0206, 0221)', () => {
  it.each([
    ['billing_interval', "billing_interval = 'annual'"],
    ['cycle_started_at', "cycle_started_at = now() - interval '1 hour'"],
    [
      'subscription_origin',
      "subscription_origin = CASE WHEN subscription_origin = 'provider' THEN 'operator' ELSE 'provider' END",
    ],
    ['renewal_anchor_day', 'renewal_anchor_day = 1'],
    ['plan_version_id', 'plan_version_id = NULL'],
    ['ever_paid_at', 'ever_paid_at = now()'],
    // Cleared, the grace clock stops the grace sweep and a paid plan runs on unpaid.
    ['payment_failed_at', 'payment_failed_at = NULL'],
  ])('the application and the operator cannot write %s; settlement can', async (_c, set) => {
    const businessId = await onPaidCycle(new Date(Date.now() + 10 * DAY));
    await ownerDb.execute(
      sql`UPDATE businesses SET plan_version_id = (SELECT id FROM plan_versions WHERE plan_id = 'chat' ORDER BY version LIMIT 1), renewal_anchor_day = 15, ever_paid_at = NULL, payment_failed_at = now() WHERE id = ${businessId}::uuid`,
    );
    const statement = `UPDATE businesses SET ${set} WHERE id = $B`;
    expect(await asRoleWithoutFixture(businessId, 'rekoda_app', statement)).toMatch(
      /^42501 .*cycle and pricing inputs/,
    );
    // The worker writes no business row at all since 0210: refused before the guard is reached.
    expect(await asRoleWithoutFixture(businessId, 'rekoda_worker', statement)).toMatch(
      /^42501 .*permission denied for table businesses/,
    );
    expect(await asRoleWithoutFixture(businessId, 'rekoda_settlement', statement)).toBe('OK ');
    // Since 0221 the operator writes the cycle only through subscription_operator_set_plan.
    expect(await asRoleWithoutFixture(businessId, 'rekoda_billing_operator', statement)).toMatch(
      /^42501 .*permission denied for table businesses/,
    );
    // Columns the merchant's own scheduling writes stay with the application.
    expect(
      await asRoleWithoutFixture(
        businessId,
        'rekoda_app',
        "UPDATE businesses SET pending_plan = 'expired', pending_billing_interval = 'annual', plan_decided_at = clock_timestamp() WHERE id = $B",
      ),
    ).toBe('OK ');
  });

  it('the guard is installed and enabled', async () => {
    const [row] = await ownerDb.execute<{ enabled: string | null }>(sql`
      SELECT tgenabled::text AS enabled FROM pg_trigger
      WHERE tgname = 'businesses_cycle_fields_guard' AND tgrelid = 'public.businesses'::regclass`);
    expect(row?.enabled).toBe('O');
  });

  it.each([
    [
      'a plan version pin',
      "plan_version_id = (SELECT id FROM plan_versions WHERE plan_id = 'complete' ORDER BY version LIMIT 1)",
    ],
    ['a cycle start', 'cycle_started_at = now()'],
    ['an annual interval', "billing_interval = 'annual'"],
    ['an origin', "subscription_origin = 'provider'"],
    ['an anchor day', 'renewal_anchor_day = 1'],
    ['a paid history', 'ever_paid_at = now()'],
    ['a grace clock', 'payment_failed_at = now()'],
  ])('a business the application inserts cannot start with %s', async (_label, column) => {
    const [name, value] = column.split(/ = (.*)/s) as [string, string];
    const id = '7a1d0c4e-0000-4000-8000-000000000206';
    const owner = await identity.upsertUserByPhone(appDb, '+2348069990206');
    const insert = (extra: string) =>
      `INSERT INTO businesses (id, name, owner_user_id, plan, plan_expires_at${extra ? `, ${name}` : ''})
       VALUES ($B, 'Ada', '${owner.id}'::uuid, 'trial', now() + interval '336 hours'${extra ? `, ${value}` : ''})`;
    expect(await asRoleWithoutFixture(id, 'rekoda_app', insert(column))).toMatch(
      /^42501 .*starts with no cycle/,
    );
    expect(await asRoleWithoutFixture(id, 'rekoda_app', insert(''))).toBe('OK ');
  });
});
