/**
 * Plan changes and upgrade requests (docs/pricing-model.md).
 *
 * The smallest honest slice of billing: something has to be able to move a
 * merchant onto a paid plan, and a merchant who asks to pay has to land
 * somewhere a human will see. Both write an audit row, because a plan change
 * is a commercial fact — "who moved this business onto Complete, and when"
 * must be answerable without reading a deploy log.
 *
 * Everything here is deliberately manual. Real self-service billing (M4)
 * replaces the operator call with a verified payment; it does not replace
 * the audit trail, which is why that lives here rather than in the caller.
 */
import { eq, sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';
import { withBusiness } from '../client.js';
import { businesses } from '../schema/tenancy.js';
import { auditEvents } from '../schema/ops.js';
import * as subscriptionsRepo from './subscriptions.js';

/** The plans nobody paid for; every other plan is a paid one (G-103). */
const UNPAID_PLANS = new Set(['trial', 'expired']);

/** The day of the month in Lagos (UTC+1), which renewals anchor to. */
const lagosDayOfMonth = (at: Date): number => new Date(at.getTime() + 3_600_000).getUTCDate();

export interface PlanChange {
  businessId: string;
  plan: string;
  /** Null leaves a paid plan open-ended; a trial without one never expires. */
  expiresAt: Date | null;
  /** Who did this: `operator:<name>`, never a bare 'system'. */
  actor: string;
}

/**
 * Move a business onto a plan, recording who and when.
 *
 * Returns false when the business does not exist rather than throwing: an
 * operator typo is a 404 for the caller to report, not a stack trace.
 */
export async function setPlan(db: Db, change: PlanChange): Promise<boolean> {
  return withBusiness(db, change.businessId, async (tx) => {
    const before = await tx
      .select({
        plan: businesses.plan,
        expiresAt: businesses.planExpiresAt,
        cycleStartedAt: businesses.cycleStartedAt,
        pendingPlan: businesses.pendingPlan,
        paymentFailedAt: businesses.paymentFailedAt,
      })
      .from(businesses)
      .where(eq(businesses.id, change.businessId))
      .limit(1)
      // The audit's old value is what the UPDATE below overwrites, so it is read under the row lock.
      .for('update');
    const previous = before[0];
    if (!previous) return false;

    /* One writer for the whole subscription (G-62): a downgrade scheduled
     * against the old plan, a failed renewal and its reminders, the old
     * plan-version pin and the old cycle dates all go with the old plan.
     * The operator's `expiresAt` is kept exactly as given; with none there
     * is no dated cycle, so no cycle start and no anchor day is invented (a
     * start that never advances would age every later upgrade's proration).
     * Re-posting the same plan and expiry changes nothing about the cycle, so
     * its start is kept: moving it forward would shrink the proration
     * denominator and overcharge a later upgrade. */
    const paid = !UNPAID_PLANS.has(change.plan);
    const sameCycle =
      previous.plan === change.plan &&
      previous.cycleStartedAt !== null &&
      previous.expiresAt !== null &&
      change.expiresAt !== null &&
      previous.expiresAt.getTime() === change.expiresAt.getTime();
    await subscriptionsRepo.writeSubscriptionState(tx, change.businessId, {
      plan: change.plan,
      paid,
      cycleStartedAt:
        paid && change.expiresAt ? (sameCycle ? previous.cycleStartedAt : new Date()) : null,
      planExpiresAt: change.expiresAt,
      anchorDay: paid && change.expiresAt ? lagosDayOfMonth(change.expiresAt) : null,
      pendingPlan: null,
    });

    await tx.insert(auditEvents).values({
      businessId: change.businessId,
      actor: change.actor,
      entity: 'business',
      entityId: change.businessId,
      action: 'plan_changed',
      oldValue: {
        plan: previous.plan,
        expiresAt: previous.expiresAt ? previous.expiresAt.toISOString() : null,
        /* What the move cleared, so an override stays traceable (G-62). */
        pendingPlan: previous.pendingPlan,
        paymentFailedAt: previous.paymentFailedAt ? previous.paymentFailedAt.toISOString() : null,
      } as never,
      newValue: {
        plan: change.plan,
        expiresAt: change.expiresAt ? change.expiresAt.toISOString() : null,
      } as never,
      sourceType: 'operator',
    });
    return true;
  });
}

/**
 * A merchant asked to upgrade, from chat.
 *
 * Recorded rather than acted on: there is no self-service purchase yet, and
 * a request that quietly evaporated would be worse than the doorway it
 * replaced. One row per ask — a merchant who types it three times is three
 * times as interested, and that is information.
 */
export async function recordUpgradeRequest(
  tx: TenantDb,
  businessId: string,
  fromPlan: string,
): Promise<void> {
  await tx.insert(auditEvents).values({
    businessId,
    actor: 'merchant',
    entity: 'business',
    entityId: businessId,
    action: 'upgrade_requested',
    newValue: { fromPlan } as never,
    sourceType: 'chat',
  });
}

/** Upgrade requests for one business, newest first — the operator's queue. */
export async function upgradeRequestsFor(
  tx: TenantDb,
  businessId: string,
): Promise<Array<{ fromPlan: string; at: Date }>> {
  const rows = await tx.execute<{ from_plan: string | null; created_at: string }>(sql`
    SELECT new_value ->> 'fromPlan' AS from_plan, created_at
    FROM audit_events
    WHERE business_id = ${businessId}::uuid AND action = 'upgrade_requested'
    ORDER BY created_at DESC
  `);
  return [...rows].map((r) => ({ fromPlan: r.from_plan ?? 'unknown', at: new Date(r.created_at) }));
}
