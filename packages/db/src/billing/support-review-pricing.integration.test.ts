/**
 * R02 (second independent review of PR #432; Codex P2 on 0213; migration 0232): the support-review
 * path prices a plan exactly as the billing price resolver (`planPriceKFor`) does.
 *
 *   * an explicit annual price wins;
 *   * a version with no annual row is priced at its monthly price x 10 (OWN-40), never "unpriced";
 *   * a grandfathered merchant is priced at the version they are pinned to, not today's open one;
 *   * a plan with no price at all is still refused (missing pricing), as before;
 *   * resolving keeps the paid-through date exactly.
 *
 * Each case runs the merchant's request on the application credential and the resolution on the
 * billing-operator credential, as production does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness } from '../client.js';
import { requireUrls, resetPlanCatalogue } from '../testing.js';
import {
  appDb,
  operatorDb,
  outcome,
  ownerDb,
  seedBusiness,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();
afterEach(async () => {
  await resetPlanCatalogue(requireUrls());
});

async function onPaidPlan(plan: string, interval: 'monthly' | 'annual'): Promise<string> {
  const businessId = await seedBusiness();
  await withBusiness(operatorDb, businessId, (tx) =>
    tx.execute(
      sql`SELECT subscription_operator_set_plan(${businessId}::uuid, ${plan}, NULL, ${interval}, 'operator:alice')`,
    ),
  );
  return businessId;
}

const request = (businessId: string, plan: string) =>
  withBusiness(appDb, businessId, async (tx) => {
    const rows = await tx.execute<{ id: string | null }>(
      sql`SELECT subscription_request_plan_review(${businessId}::uuid, ${plan}) AS id`,
    );
    return [...rows][0]!.id;
  });

const resolve = (businessId: string, plan: string) =>
  withBusiness(operatorDb, businessId, async (tx) => {
    const rows = await tx.execute<{ changed: boolean; expires_at: string }>(
      sql`SELECT changed, expires_at::text
          FROM subscription_operator_resolve_review(${businessId}::uuid, ${plan}, 'operator:alice', 'paid the difference')`,
    );
    return [...rows][0]!;
  });

const paidThrough = async (businessId: string) =>
  [
    ...(await ownerDb.execute<{ plan: string; at: string }>(
      sql`SELECT plan, plan_expires_at::text AS at FROM businesses WHERE id = ${businessId}::uuid`,
    )),
  ][0]!;

/** Close a plan's open price rows for one interval (or all), as an operator retiring them would. */
const closePrices = (plan: string, interval: 'monthly' | 'annual' | null) =>
  ownerDb.execute(sql`
    UPDATE plan_prices p SET effective_to = now() - interval '2 seconds'
    FROM plan_versions v
    WHERE v.id = p.plan_version_id AND v.plan_id = ${plan} AND p.effective_to IS NULL
      AND (${interval}::text IS NULL OR p.billing_interval = ${interval}::text)`);

describe('R02: support-review pricing matches the billing resolver (0232)', () => {
  it('prices a version with no annual row at monthly x 10, and the upgrade is reviewed and resolved', async () => {
    const businessId = await onPaidPlan('chat', 'annual');
    const before = await paidThrough(businessId);
    await closePrices('chat', 'annual');
    await closePrices('complete', 'annual');

    const reviewId = await request(businessId, 'complete');
    expect(reviewId).toMatch(/^[0-9a-f-]{36}$/);

    const answer = await resolve(businessId, 'complete');
    expect(answer.changed).toBe(true);
    const after = await paidThrough(businessId);
    expect(after.plan).toBe('complete');
    expect(after.at).toBe(before.at);
  });

  it('an explicit annual price wins over monthly x 10', async () => {
    const businessId = await onPaidPlan('chat', 'annual');
    /* Complete's year is republished BELOW chat's explicit year (9,900,000), although its
     * monthly x 10 would be 29,900,000: the explicit row decides, so this is not an upgrade. */
    await closePrices('complete', 'annual');
    await ownerDb.execute(sql`
      INSERT INTO plan_prices (plan_version_id, currency, billing_interval, amount_minor, effective_from)
      SELECT v.id, 'NGN', 'annual', 9000000, now() - interval '1 second'
      FROM plan_versions v WHERE v.plan_id = 'complete' AND v.version = 1`);
    expect(await outcome(request(businessId, 'complete'))).toMatch(
      /^22023 .*the requested plan is not an upgrade/,
    );
  });

  it('prices a grandfathered merchant at the version they are pinned to', async () => {
    const businessId = await onPaidPlan('chat', 'monthly');
    /* Chat is republished as version 2 at 2,500,000 a month, above integrate's 1,990,000. The
     * merchant stays pinned to version 1 (990,000), so chat -> integrate is still an upgrade for
     * them, exactly as the application prices it. */
    await ownerDb.execute(sql`
      UPDATE plan_versions SET effective_to = now() - interval '1 second'
      WHERE plan_id = 'chat' AND version = 1`);
    await ownerDb.execute(sql`
      WITH v AS (
        INSERT INTO plan_versions (plan_id, version, name, seats, effective_from)
        VALUES ('chat', 2, 'Rekoda Chat', 1, now() - interval '1 second') RETURNING id)
      INSERT INTO plan_prices (plan_version_id, currency, billing_interval, amount_minor, effective_from)
      SELECT v.id, 'NGN', 'monthly', 2500000, now() - interval '1 second' FROM v`);
    const [pin] = await ownerDb.execute<{ version: number }>(sql`
      SELECT v.version FROM businesses b JOIN plan_versions v ON v.id = b.plan_version_id
      WHERE b.id = ${businessId}::uuid`);
    expect(pin!.version).toBe(1);

    expect(await request(businessId, 'integrate')).toMatch(/^[0-9a-f-]{36}$/);
    expect((await resolve(businessId, 'integrate')).changed).toBe(true);
  });

  it('still refuses a plan with no price at all, on either interval', async () => {
    for (const interval of ['monthly', 'annual'] as const) {
      const businessId = await onPaidPlan('chat', interval);
      await closePrices('complete', null);
      expect(await outcome(request(businessId, 'complete'))).toMatch(
        /^22023 .*the requested plan is not an upgrade/,
      );
      const [open] = await ownerDb.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM plan_change_reviews WHERE business_id = ${businessId}::uuid`);
      expect(open!.n).toBe(0);
      await resetPlanCatalogue(requireUrls());
    }
  });
});
