/**
 * OD-50 (owner instruction, 12 Nov 2026; migration 0213): a support-reviewed upgrade keeps the
 * merchant's existing paid-through date, through its own narrow, audited operation.
 *
 *   * the merchant's refused upgrade is recorded by `subscription_request_plan_review`, which
 *     checks the facts itself; no runtime role can write `plan_change_reviews` directly;
 *   * `subscription_operator_resolve_review` takes no date, runs for the billing operator only,
 *     and moves the plan while leaving `plan_expires_at` exactly as it is;
 *   * a trial, an expired plan, a lapsed cycle and a subscription that changed after the request
 *     are refused; a repeat changes nothing; each change writes one audit row.
 *
 * Every assertion runs on a live connection as that principal.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness, type Db } from '../client.js';
import {
  appDb,
  operatorDb,
  outcome,
  ownerDb,
  PRINCIPALS,
  seedBusiness,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

interface Sub extends Record<string, unknown> {
  plan: string;
  plan_expires_at: string | null;
  cycle_started_at: string | null;
  billing_interval: string;
  renewal_anchor_day: number | null;
  subscription_origin: string | null;
  trial_started_at: string;
  pending_plan: string | null;
  pin_plan: string | null;
}

const subscriptionOf = async (businessId: string): Promise<Sub> =>
  [
    ...(await ownerDb.execute<Sub>(sql`
      SELECT b.plan, b.plan_expires_at::text, b.cycle_started_at::text, b.billing_interval,
             b.renewal_anchor_day, b.subscription_origin, b.trial_started_at::text, b.pending_plan,
             v.plan_id AS pin_plan
      FROM businesses b LEFT JOIN plan_versions v ON v.id = b.plan_version_id
      WHERE b.id = ${businessId}::uuid`)),
  ][0]!;

/** An operator-assigned paid plan: the custom cycle whose upgrade the product sends to review. */
async function onPaidPlan(plan = 'chat', interval = 'monthly'): Promise<string> {
  const businessId = await seedBusiness();
  await withBusiness(operatorDb, businessId, async (tx) => {
    await tx.execute(
      sql`SELECT subscription_operator_set_plan(${businessId}::uuid, ${plan}, NULL, ${interval}, 'operator:alice')`,
    );
    await tx.execute(sql`
      UPDATE businesses SET cycle_started_at = now(), subscription_origin = 'operator',
        billing_interval = ${interval},
        plan_version_id = (SELECT id FROM plan_versions WHERE plan_id = ${plan} ORDER BY version LIMIT 1)
      WHERE id = ${businessId}::uuid`);
  });
  return businessId;
}

const request = (db: Db, businessId: string, plan: string) =>
  withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(
      sql`SELECT subscription_request_plan_review(${businessId}::uuid, ${plan}) AS id`,
    );
    return [...rows][0]!.id;
  });

const resolve = (
  db: Db,
  businessId: string,
  plan: string,
  reason = 'paid the difference by transfer',
) =>
  withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{
      review_id: string;
      previous_plan: string;
      expires_at: string;
      changed: boolean;
    }>(
      sql`SELECT review_id, previous_plan, expires_at::text, changed
          FROM subscription_operator_resolve_review(${businessId}::uuid, ${plan}, 'operator:alice', ${reason})`,
    );
    return [...rows][0]!;
  });

const planChanged = async (businessId: string) => [
  ...(await ownerDb.execute<{
    actor: string;
    old_value: Record<string, unknown>;
    new_value: Record<string, unknown>;
    reason: string | null;
    source_type: string;
  }>(
    sql`SELECT actor, old_value, new_value, reason, source_type FROM audit_events
        WHERE business_id = ${businessId}::uuid AND action = 'plan_changed' ORDER BY created_at`,
  )),
];

describe('OD-50: a support-reviewed upgrade keeps the paid-through date (0213)', () => {
  it('moves the plan and leaves the paid-through date, the cycle and the trial start exactly as they were', async () => {
    const businessId = await onPaidPlan('chat');
    await ownerDb.execute(
      sql`UPDATE businesses SET pending_plan = 'expired' WHERE id = ${businessId}::uuid`,
    );
    const before = await subscriptionOf(businessId);
    const reviewId = await request(appDb, businessId, 'complete');

    const answer = await resolve(operatorDb, businessId, 'complete');

    expect(answer).toMatchObject({ review_id: reviewId, previous_plan: 'chat', changed: true });
    const after = await subscriptionOf(businessId);
    expect(after.plan).toBe('complete');
    expect(after.plan_expires_at).toBe(before.plan_expires_at);
    expect(new Date(answer.expires_at).getTime()).toBe(new Date(before.plan_expires_at!).getTime());
    expect(after.cycle_started_at).toBe(before.cycle_started_at);
    expect(after.billing_interval).toBe(before.billing_interval);
    expect(after.renewal_anchor_day).toBe(before.renewal_anchor_day);
    expect(after.subscription_origin).toBe(before.subscription_origin);
    expect(after.trial_started_at).toBe(before.trial_started_at);
    /* The old plan's pin and the downgrade scheduled against it go with the old plan. */
    expect(after.pin_plan).toBe('complete');
    expect(after.pending_plan).toBeNull();
  });

  it('takes no date: the only signature is (business, plan, actor, reason)', async () => {
    const rows = await ownerDb.execute<{ args: string }>(sql`
      SELECT pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'subscription_operator_resolve_review'`);
    expect([...rows].map((r) => r.args)).toEqual([
      'p_business uuid, p_plan text, p_actor text, p_reason text',
    ]);
    /* A fifth argument (a date) resolves to no function at all. */
    const businessId = await onPaidPlan('chat');
    await request(appDb, businessId, 'complete');
    expect(
      await outcome(
        withBusiness(operatorDb, businessId, (tx) =>
          tx.execute(
            sql`SELECT subscription_operator_resolve_review(${businessId}::uuid, 'complete', 'operator:alice', 'r', now() + interval '5 years')`,
          ),
        ),
      ),
    ).toMatch(/^42883 /);
    expect((await subscriptionOf(businessId)).plan).toBe('chat');
  });

  it('never extends: a subscription that moved after the request is refused, not re-dated', async () => {
    const businessId = await onPaidPlan('chat', 'monthly');
    await request(appDb, businessId, 'complete');
    /* The operator starts a NEW annual period in between: a different paid-through date. */
    await withBusiness(operatorDb, businessId, (tx) =>
      tx.execute(
        sql`SELECT subscription_operator_set_plan(${businessId}::uuid, 'chat', NULL, 'annual', 'operator:alice')`,
      ),
    );
    const moved = await subscriptionOf(businessId);
    expect(await outcome(resolve(operatorDb, businessId, 'complete'))).toMatch(
      /^22023 .*changed after the review was requested/,
    );
    const after = await subscriptionOf(businessId);
    expect(after.plan).toBe('chat');
    expect(after.plan_expires_at).toBe(moved.plan_expires_at);
  });

  it('refuses an expired plan and a paid period that has ended', async () => {
    const expired = await onPaidPlan('chat');
    await request(appDb, expired, 'complete');
    await withBusiness(operatorDb, expired, (tx) =>
      tx.execute(
        sql`SELECT subscription_operator_set_plan(${expired}::uuid, 'expired', NULL, NULL, 'operator:alice')`,
      ),
    );
    expect(await outcome(resolve(operatorDb, expired, 'complete'))).toMatch(
      /^22023 .*expired plan has no paid-through date to keep/,
    );
    expect((await subscriptionOf(expired)).plan).toBe('expired');
    /* An expired business cannot ask for a review either. */
    expect(await outcome(request(appDb, expired, 'complete'))).toMatch(
      /^22023 .*only an active paid plan/,
    );

    /* Still labelled chat, but the period it paid for ended yesterday (grace). */
    const lapsed = await onPaidPlan('chat');
    await request(appDb, lapsed, 'complete');
    await ownerDb.execute(sql`
      UPDATE businesses SET plan_expires_at = now() - interval '1 day' WHERE id = ${lapsed}::uuid`);
    await ownerDb.execute(sql`
      UPDATE plan_change_reviews SET paid_through = (SELECT plan_expires_at FROM businesses WHERE id = ${lapsed}::uuid)
      WHERE business_id = ${lapsed}::uuid`);
    expect(await outcome(resolve(operatorDb, lapsed, 'complete'))).toMatch(
      /^22023 .*the paid period has ended/,
    );
    expect((await subscriptionOf(lapsed)).plan).toBe('chat');
    expect(await outcome(request(appDb, lapsed, 'complete'))).toMatch(
      /^22023 .*only an active paid plan/,
    );
  });

  it('refuses a trial, even with a review row forged by the table owner, and never moves the trial start', async () => {
    const businessId = await seedBusiness();
    const before = await subscriptionOf(businessId);
    expect(before.plan).toBe('trial');
    expect(await outcome(request(appDb, businessId, 'complete'))).toMatch(
      /^22023 .*only an active paid plan/,
    );
    expect(await outcome(resolve(operatorDb, businessId, 'complete'))).toMatch(
      /^22023 .*no open support review asks for this plan/,
    );
    await ownerDb.execute(sql`
      INSERT INTO plan_change_reviews (business_id, from_plan, to_plan, paid_through)
      VALUES (${businessId}::uuid, 'chat', 'complete', ${before.plan_expires_at}::timestamptz)`);
    expect(await outcome(resolve(operatorDb, businessId, 'complete'))).toMatch(
      /^22023 .*trial plan has no paid-through date to keep/,
    );
    const after = await subscriptionOf(businessId);
    expect(after.plan).toBe('trial');
    expect(after.plan_expires_at).toBe(before.plan_expires_at);
    expect(after.trial_started_at).toBe(before.trial_started_at);
  });

  it('needs the open review for exactly that plan; an ordinary assignment is not a review', async () => {
    const businessId = await onPaidPlan('chat');
    /* No review at all. */
    expect(await outcome(resolve(operatorDb, businessId, 'complete'))).toMatch(
      /^22023 .*no open support review asks for this plan/,
    );
    /* The merchant asked for Integrate; the operator cannot resolve it as Complete. */
    await request(appDb, businessId, 'integrate');
    expect(await outcome(resolve(operatorDb, businessId, 'complete'))).toMatch(
      /^22023 .*no open support review asks for this plan/,
    );
    expect((await subscriptionOf(businessId)).plan).toBe('chat');
    expect(await planChanged(businessId)).toHaveLength(1); // the original assignment only
  });

  it('only the billing operator can resolve; no runtime role can write a review directly', async () => {
    const businessId = await onPaidPlan('chat');
    await request(appDb, businessId, 'complete');
    for (const principal of ['app', 'worker', 'settlement'] as const) {
      expect(await outcome(resolve(PRINCIPALS[principal](), businessId, 'complete'))).toMatch(
        /^42501 permission denied for function subscription_operator_resolve_review/,
      );
    }
    for (const principal of ['app', 'worker', 'settlement', 'operator'] as const) {
      const db = PRINCIPALS[principal]();
      expect(
        await outcome(
          withBusiness(db, businessId, (tx) =>
            tx.execute(sql`
              INSERT INTO plan_change_reviews (business_id, from_plan, to_plan, paid_through)
              VALUES (${businessId}::uuid, 'chat', 'complete', now() + interval '1 day')`),
          ),
        ),
      ).toMatch(/^42501 permission denied for table plan_change_reviews/);
      expect(
        await outcome(
          withBusiness(db, businessId, (tx) =>
            tx.execute(
              sql`UPDATE plan_change_reviews SET to_plan = 'integrate', paid_through = now() + interval '5 years' WHERE business_id = ${businessId}::uuid`,
            ),
          ),
        ),
      ).toMatch(/^42501 permission denied for table plan_change_reviews/);
    }
    /* A review is asked for by the application only (the merchant's own request). */
    for (const principal of ['worker', 'operator'] as const) {
      expect(await outcome(request(PRINCIPALS[principal](), businessId, 'complete'))).toMatch(
        /^42501 permission denied for function subscription_request_plan_review/,
      );
    }
    expect((await subscriptionOf(businessId)).plan).toBe('chat');
  });

  it('cannot reach another business: the pin decides, whatever id is passed', async () => {
    const mine = await onPaidPlan('chat');
    const theirs = await onPaidPlan('chat');
    await request(appDb, theirs, 'complete');
    expect(
      await outcome(
        withBusiness(operatorDb, mine, (tx) =>
          tx.execute(
            sql`SELECT subscription_operator_resolve_review(${theirs}::uuid, 'complete', 'operator:alice', 'r')`,
          ),
        ),
      ),
    ).toMatch(/^42501 .*not the pinned tenant/);
    expect((await subscriptionOf(theirs)).plan).toBe('chat');
  });

  it('a repeated resolution changes nothing and writes no second audit row', async () => {
    const businessId = await onPaidPlan('chat');
    await request(appDb, businessId, 'complete');
    const first = await resolve(operatorDb, businessId, 'complete');
    const afterFirst = await subscriptionOf(businessId);
    const again = await resolve(operatorDb, businessId, 'complete');
    expect(again).toMatchObject({
      review_id: first.review_id,
      previous_plan: 'chat',
      changed: false,
    });
    expect(await subscriptionOf(businessId)).toEqual(afterFirst);
    expect(await planChanged(businessId)).toHaveLength(2); // the assignment, then one resolution
  });

  it('writes one audit row: actor, previous and new plan, the paid-through date kept, the review and the reason', async () => {
    const businessId = await onPaidPlan('chat');
    const before = await subscriptionOf(businessId);
    const reviewId = await request(appDb, businessId, 'complete');
    await resolve(
      operatorDb,
      businessId,
      'complete',
      'difference paid by bank transfer, ticket 4417',
    );
    const rows = await planChanged(businessId);
    const row = rows[rows.length - 1]!;
    const kept = new Date(before.plan_expires_at!).toISOString();
    expect(row.actor).toBe('operator:alice');
    expect(row.source_type).toBe('operator');
    expect(row.reason).toBe('difference paid by bank transfer, ticket 4417');
    expect(row.old_value).toMatchObject({ plan: 'chat', expiresAt: kept });
    expect(row.new_value).toMatchObject({
      plan: 'complete',
      expiresAt: kept,
      supportReview: reviewId,
      paidThroughKept: true,
    });
    const [review] = await ownerDb.execute<{ status: string; resolved_by: string; reason: string }>(
      sql`SELECT status, resolved_by, reason FROM plan_change_reviews WHERE id = ${reviewId}::uuid`,
    );
    expect(review).toMatchObject({ status: 'resolved', resolved_by: 'operator:alice' });
  });

  it('refuses a missing reason, a caller-shaped actor and a plan that is not paid', async () => {
    const businessId = await onPaidPlan('chat');
    await request(appDb, businessId, 'complete');
    const call = (plan: string, actor: string, reason: string | null) =>
      outcome(
        withBusiness(operatorDb, businessId, (tx) =>
          tx.execute(
            sql`SELECT subscription_operator_resolve_review(${businessId}::uuid, ${plan}, ${actor}, ${reason})`,
          ),
        ),
      );
    expect(await call('complete', 'operator:alice', '   ')).toMatch(/^22023 .*invalid input/);
    expect(await call('complete', 'operator:alice', null)).toMatch(/^22023 .*invalid input/);
    expect(await call('complete', 'alice', 'r')).toMatch(/^22023 .*invalid input/);
    expect(await call('trial', 'operator:alice', 'r')).toMatch(/^22023 .*invalid input/);
    expect(await call('expired', 'operator:alice', 'r')).toMatch(/^22023 .*invalid input/);
    expect((await subscriptionOf(businessId)).plan).toBe('chat');
  });

  it('a review is only ever an upgrade: a cheaper or the same plan cannot be requested', async () => {
    const businessId = await onPaidPlan('integrate');
    expect(await outcome(request(appDb, businessId, 'chat'))).toMatch(/^22023 .*not an upgrade/);
    expect(await outcome(request(appDb, businessId, 'integrate'))).toMatch(
      /^22023 .*not an upgrade/,
    );
    /* Asking again for the same upgrade is the same request; a different one replaces it. */
    const first = await request(appDb, businessId, 'complete');
    expect(await request(appDb, businessId, 'complete')).toBe(first);
    const [open] = await ownerDb.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM plan_change_reviews WHERE business_id = ${businessId}::uuid AND status = 'open'`,
    );
    expect(open!.n).toBe(1);
  });

  it('ordinary assignments still run the standard period and still refuse a date (0207 unchanged)', async () => {
    const businessId = await seedBusiness();
    const set = (plan: string, expires: string | null, interval: string | null) =>
      withBusiness(operatorDb, businessId, (tx) =>
        tx.execute<{ cycle_start: string; expires_at: string; changed: boolean }>(
          sql`SELECT cycle_start::text, expires_at::text, changed FROM subscription_operator_set_plan(${businessId}::uuid, ${plan}, ${expires}::timestamptz, ${interval}, 'operator:alice')`,
        ),
      );
    expect(await outcome(set('chat', '2099-01-01T00:00:00Z', 'monthly'))).toMatch(
      /^22023 .*runs its standard period; give no end date/,
    );
    for (const interval of ['monthly', 'annual'] as const) {
      const [row] = [...(await set('complete', null, interval))];
      const [bound] = await ownerDb.execute<{ at: string }>(
        sql`SELECT rekoda_private.add_billing_interval(${row!.cycle_start}::timestamptz, ${interval})::text AS at`,
      );
      expect(new Date(row!.expires_at).getTime()).toBe(new Date(bound!.at).getTime());
    }
    /* The trial start stays fixed for every runtime role, the operator included. */
    for (const principal of ['app', 'worker', 'settlement', 'operator'] as const) {
      expect(
        await outcome(
          withBusiness(PRINCIPALS[principal](), businessId, (tx) =>
            tx.execute(
              sql`UPDATE businesses SET trial_started_at = now() WHERE id = ${businessId}::uuid`,
            ),
          ),
        ),
      ).toMatch(/^42501 /);
    }
  });
});
