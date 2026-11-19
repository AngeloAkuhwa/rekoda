/**
 * OD-51 (migration 0221; independent database review of `208c919`, IMPORTANT): the billing operator
 * changes a subscription only through its two audited database operations.
 *
 * Until 0221 the operator credential kept column UPDATE on twelve subscription cycle columns, so
 * the application could write the rest of the cycle after `subscription_operator_set_plan`. The
 * same grant let a holder of the credential stop a grace clock, move the renewal anchor or switch
 * the interval with no audit row, and backdate `plan_decided_at` to defeat 0219's refusal. The
 * writer now records the whole cycle itself, from its own values, and the operator writes nothing
 * directly.
 *
 * Every assertion runs on a live connection as that principal.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness } from '../client.js';
import {
  operatorDb,
  outcome,
  ownerDb,
  seedBusiness,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

const cycleOf = async (businessId: string) =>
  [
    ...(await ownerDb.execute<{
      plan: string;
      plan_expires_at: string | null;
      cycle_started_at: string | null;
      renewal_anchor_day: number | null;
      billing_interval: string;
      pending_billing_interval: string | null;
      subscription_origin: string | null;
      payment_failed_at: string | null;
      ever_paid: boolean;
      pin_plan: string | null;
      decided_recently: boolean;
    }>(sql`
      SELECT b.plan, b.plan_expires_at::text, b.cycle_started_at::text, b.renewal_anchor_day,
             b.billing_interval, b.pending_billing_interval, b.subscription_origin,
             b.payment_failed_at::text, b.ever_paid_at IS NOT NULL AS ever_paid,
             v.plan_id AS pin_plan,
             b.plan_decided_at > now() - interval '1 minute' AS decided_recently
      FROM businesses b LEFT JOIN plan_versions v ON v.id = b.plan_version_id
      WHERE b.id = ${businessId}::uuid`)),
  ][0]!;

const setPlan = (businessId: string, plan: string, interval: string | null) =>
  withBusiness(operatorDb, businessId, (tx) =>
    tx.execute(sql`SELECT * FROM subscription_operator_set_plan(
      ${businessId}::uuid, ${plan}, NULL, ${interval}, 'operator:alice')`),
  );

describe('the operator writes a subscription only through its operations (0221)', () => {
  it('cannot write a cycle column directly: grace clock, decision time, anchor, interval, origin', async () => {
    /* `updated_at` alone stays writable: it is what lets the operator path lock the row. */
    const businessId = await seedBusiness();
    await setPlan(businessId, 'chat', 'monthly');
    for (const statement of [
      sql`UPDATE businesses SET payment_failed_at = NULL WHERE id = ${businessId}::uuid`,
      sql`UPDATE businesses SET plan_decided_at = '2000-01-01' WHERE id = ${businessId}::uuid`,
      sql`UPDATE businesses SET renewal_anchor_day = 1 WHERE id = ${businessId}::uuid`,
      sql`UPDATE businesses SET billing_interval = 'annual' WHERE id = ${businessId}::uuid`,
      sql`UPDATE businesses SET subscription_origin = 'provider' WHERE id = ${businessId}::uuid`,
      sql`UPDATE businesses SET cycle_started_at = now() WHERE id = ${businessId}::uuid`,
      sql`UPDATE businesses SET ever_paid_at = now() WHERE id = ${businessId}::uuid`,
      sql`UPDATE businesses SET pending_plan = 'expired' WHERE id = ${businessId}::uuid`,
    ]) {
      expect(
        await outcome(withBusiness(operatorDb, businessId, (tx) => tx.execute(statement))),
      ).toMatch(/permission denied/);
    }
  });

  it('a paid plan change still records the whole cycle, from the writer’s own values', async () => {
    const businessId = await seedBusiness();
    await setPlan(businessId, 'integrate', 'annual');
    const cycle = await cycleOf(businessId);
    expect(cycle).toMatchObject({
      plan: 'integrate',
      billing_interval: 'annual',
      pending_billing_interval: null,
      subscription_origin: 'operator',
      payment_failed_at: null,
      ever_paid: true,
      pin_plan: 'integrate',
      decided_recently: true,
    });
    expect(cycle.cycle_started_at).not.toBeNull();
    const end = new Date(cycle.plan_expires_at!);
    expect(cycle.renewal_anchor_day).toBe(new Date(end.getTime() + 3_600_000).getUTCDate());
  });

  it('a trial or an expiry clears the paid cycle as before', async () => {
    const businessId = await seedBusiness();
    await setPlan(businessId, 'chat', 'monthly');
    await setPlan(businessId, 'expired', null);
    expect(await cycleOf(businessId)).toMatchObject({
      plan: 'expired',
      cycle_started_at: null,
      renewal_anchor_day: null,
      billing_interval: 'monthly',
      subscription_origin: null,
      ever_paid: true,
    });
  });
});
