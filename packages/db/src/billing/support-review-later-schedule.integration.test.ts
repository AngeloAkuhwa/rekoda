/**
 * OD-50, review follow-up (migration 0219; independent review of `2b602b0`): resolving a
 * support-reviewed upgrade never overrides a plan change the merchant scheduled AFTER asking for
 * it, and two operators resolving the same review at once move the plan once.
 *
 * Before 0219 the resolution cleared `pending_plan` unconditionally. A merchant who asked to
 * upgrade, then scheduled a cancellation while waiting for support, had the cancellation removed
 * and would have been renewed on the dearer plan.
 *
 * Every assertion runs on a live connection as that principal.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness } from '../client.js';
import { subscriptionsRepo } from '../index.js';
import {
  appDb,
  operatorDb,
  outcome,
  ownerDb,
  seedBusiness,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

const state = async (businessId: string) =>
  [
    ...(await ownerDb.execute<{
      plan: string;
      pending_plan: string | null;
      plan_expires_at: string;
      open_reviews: number;
      audits: number;
    }>(sql`
      SELECT b.plan, b.pending_plan, b.plan_expires_at::text,
             (SELECT count(*)::int FROM plan_change_reviews r
               WHERE r.business_id = b.id AND r.status = 'open') AS open_reviews,
             (SELECT count(*)::int FROM audit_events a
               WHERE a.business_id = b.id AND a.action = 'plan_changed'
                 AND a.new_value ->> 'supportReview' IS NOT NULL) AS audits
      FROM businesses b WHERE b.id = ${businessId}::uuid`)),
  ][0]!;

/** An operator-assigned Chat month: the custom cycle whose upgrade the product sends to review. */
async function onChat(): Promise<string> {
  const businessId = await seedBusiness();
  await withBusiness(operatorDb, businessId, async (tx) => {
    await tx.execute(
      sql`SELECT subscription_operator_set_plan(${businessId}::uuid, 'chat', NULL, 'monthly', 'operator:alice')`,
    );
    await tx.execute(sql`
      UPDATE businesses SET cycle_started_at = now(), subscription_origin = 'operator',
        plan_version_id = (SELECT id FROM plan_versions WHERE plan_id = 'chat' ORDER BY version LIMIT 1)
      WHERE id = ${businessId}::uuid`);
  });
  return businessId;
}
const askToUpgrade = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.requestPlanReview(tx, businessId, 'complete'),
  );
const schedule = (businessId: string, plan: string | null) =>
  withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.schedulePlanChange(tx, businessId, plan),
  );
const resolve = (businessId: string, actor = 'operator:alice') =>
  withBusiness(operatorDb, businessId, async (tx) => {
    const rows = await tx.execute<{ changed: boolean; expires_at: string }>(
      sql`SELECT changed, expires_at::text FROM subscription_operator_resolve_review(
            ${businessId}::uuid, 'complete', ${actor}, 'paid the difference by transfer')`,
    );
    return [...rows][0]!;
  });

describe('the merchant’s later decision stands (0219)', () => {
  it('a cancellation scheduled after the upgrade request is not cleared: the resolution is refused', async () => {
    const businessId = await onChat();
    expect(await askToUpgrade(businessId)).not.toBeNull();
    await schedule(businessId, 'expired'); // the merchant changed their mind while waiting
    const before = await state(businessId);
    expect(before).toMatchObject({ plan: 'chat', pending_plan: 'expired', open_reviews: 1 });

    expect(await outcome(resolve(businessId))).toMatch(
      /the merchant scheduled a plan change after asking for this review/,
    );

    expect(await state(businessId)).toEqual(before);
  });

  it('once the merchant undoes that schedule, the same review can be resolved', async () => {
    const businessId = await onChat();
    await askToUpgrade(businessId);
    await schedule(businessId, 'expired');
    await schedule(businessId, null);
    const before = await state(businessId);

    expect((await resolve(businessId)).changed).toBe(true);

    expect(await state(businessId)).toMatchObject({
      plan: 'complete',
      pending_plan: null,
      plan_expires_at: before.plan_expires_at,
      open_reviews: 0,
      audits: 1,
    });
  });

  it('a change scheduled BEFORE the request was overtaken by it, and goes with the upgrade as before', async () => {
    const businessId = await onChat();
    await schedule(businessId, 'expired');
    expect(await askToUpgrade(businessId)).not.toBeNull();
    const before = await state(businessId);

    expect((await resolve(businessId)).changed).toBe(true);

    expect(await state(businessId)).toMatchObject({
      plan: 'complete',
      pending_plan: null,
      plan_expires_at: before.plan_expires_at,
      audits: 1,
    });
  });
});

describe('two operators resolving one review at once (0213, 0219)', () => {
  it('move the plan once, keep the date, and write one audit row', async () => {
    const businessId = await onChat();
    await askToUpgrade(businessId);
    const before = await state(businessId);

    const results = await Promise.all([
      resolve(businessId, 'operator:alice'),
      resolve(businessId, 'operator:bola'),
      resolve(businessId, 'operator:chidi'),
    ]);

    expect(results.filter((r) => r.changed)).toHaveLength(1);
    for (const result of results) expect(result.expires_at).toBe(before.plan_expires_at);
    expect(await state(businessId)).toMatchObject({
      plan: 'complete',
      plan_expires_at: before.plan_expires_at,
      open_reviews: 0,
      audits: 1,
    });
  });
});
