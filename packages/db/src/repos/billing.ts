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
import { trialExpiry, TRIAL_DAYS, type BillingInterval } from '@rekoda/core';

/** The plans nobody paid for; every other plan is a paid one (G-103). */
const UNPAID_PLANS = new Set(['trial', 'expired']);

/** The day of the month in Lagos (UTC+1), which renewals anchor to. */
const lagosDayOfMonth = (at: Date): number => new Date(at.getTime() + 3_600_000).getUTCDate();

export interface PlanChange {
  businessId: string;
  plan: string;
  /**
   * When the plan ends: only for `expired`, which ends now (null) or at a time that is not in the
   * future. A paid plan and a trial run Rekoda's standard period, computed by the database writer
   * (OD-50, migration 0207), so the caller gives null; a date is refused.
   */
  expiresAt: Date | null;
  /** A paid plan's interval (monthly by default). Trial and expired have none. */
  billingInterval?: BillingInterval;
  /** Who did this: `operator:<name>`, never a bare 'system'. */
  actor: string;
}

/** Why an operator plan date was refused: the caller's input, answered with a 400. */
export class PlanDateRefused extends Error {
  override readonly name = 'PlanDateRefused';
}

/**
 * Rekoda's operator plan periods (OD-50, owner instruction of 11 Nov 2026; the same rule the
 * database writer enforces, migration 0207):
 *  - a paid plan runs exactly one billing interval from the moment it is written (one Lagos calendar
 *    month, or twelve), computed by the database: the caller gives no end;
 *  - a trial runs to exactly 14 days after the business's own trial start, which is fixed at signup:
 *    the caller gives no end, and a business whose trial is over cannot be given another;
 *  - `expired` ends now (no end) or at a given time that is not in the future. Ending a plan early is
 *    this operation, never a shorter paid period.
 * Returns the refusal, or null when the request is inside the rule.
 */
export function planDateRefusal(
  change: { plan: string; expiresAt: Date | null; billingInterval: BillingInterval | null },
  trialStartedAt: Date,
  now: Date,
): string | null {
  if (!UNPAID_PLANS.has(change.plan)) {
    if (change.expiresAt !== null) {
      return 'a paid plan runs exactly one billing period from now; give no end date';
    }
    return null;
  }
  if (change.billingInterval) return `a ${change.plan} plan has no billing interval`;
  if (change.plan === 'trial') {
    if (change.expiresAt !== null) {
      return `a trial runs exactly ${TRIAL_DAYS} days from the business's trial start; give no end date`;
    }
    if (trialExpiry(trialStartedAt).getTime() <= now.getTime()) {
      return `this business's ${TRIAL_DAYS}-day trial is already over`;
    }
    return null;
  }
  if (change.expiresAt !== null && change.expiresAt.getTime() > now.getTime()) {
    return 'an expired plan cannot end in the future';
  }
  return null;
}

/**
 * Move a business onto a plan as an operator, recording who and when (`POST /v1/businesses/plan`).
 *
 * `db` must be the billing-operator pool (`rekoda_billing_operator`, OPERATOR_DATABASE_URL): the
 * operator writer is executable by that role only (OD-37, migration 0202). Returns false when the
 * business does not exist rather than throwing: an operator typo is a 404 for the caller to report.
 * Throws `PlanDateRefused` for a date outside Rekoda's plan durations (a 400).
 */
export async function setPlan(db: Db, change: PlanChange): Promise<boolean> {
  return withBusiness(db, change.businessId, async (tx) => {
    const previous = await lockForPlanChange(tx, change.businessId);
    if (!previous) return false;
    const paid = !UNPAID_PLANS.has(change.plan);
    if (!paid && change.billingInterval) {
      throw new PlanDateRefused(`a ${change.plan} plan has no billing interval`);
    }
    const billingInterval: BillingInterval | null = paid
      ? (change.billingInterval ?? 'monthly')
      : null;
    /* Judged on the database clock, the clock the writer itself uses. */
    const refusal = planDateRefusal(
      { plan: change.plan, expiresAt: change.expiresAt, billingInterval },
      previous.trialStartedAt,
      await databaseNow(tx),
    );
    if (refusal) throw new PlanDateRefused(refusal);
    await writePlanChange(tx, previous, change, billingInterval, {
      kind: 'operator',
      actor: change.actor,
      billingInterval,
    });
    /* The `plan_changed` audit row (what the move replaced and what it set, G-62) is written by
     * subscription_operator_set_plan itself, in this transaction (OD-37, 0200): an operator plan
     * change cannot happen without it, whichever code path called the writer. */
    return true;
  });
}

/* The database's clock (the statement time), the one the writer's `clock_timestamp()` checks use,
 * whatever the API host's clock says. */
async function databaseNow(tx: TenantDb): Promise<Date> {
  const rows = await tx.execute<{ at: string }>(sql`SELECT clock_timestamp()::text AS at`);
  return new Date([...rows][0]!.at);
}

interface PlanChangeBefore {
  plan: string;
  expiresAt: Date | null;
  cycleStartedAt: Date | null;
  anchorDay: number | null;
  trialStartedAt: Date;
  pendingPlan: string | null;
  paymentFailedAt: Date | null;
  billingInterval: BillingInterval;
}

async function lockForPlanChange(
  tx: TenantDb,
  businessId: string,
): Promise<PlanChangeBefore | undefined> {
  const before = await tx
    .select({
      plan: businesses.plan,
      expiresAt: businesses.planExpiresAt,
      cycleStartedAt: businesses.cycleStartedAt,
      anchorDay: businesses.renewalAnchorDay,
      trialStartedAt: businesses.trialStartedAt,
      pendingPlan: businesses.pendingPlan,
      paymentFailedAt: businesses.paymentFailedAt,
      billingInterval: businesses.billingInterval,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)
    // The audit's old value is what the UPDATE below overwrites, so it is read under the row lock.
    .for('update');
  const row = before[0];
  return row ? { ...row, billingInterval: row.billingInterval as BillingInterval } : undefined;
}

/**
 * The subscription state an operator-style move writes (G-62), for the given authority.
 *
 * One writer for the whole subscription: a downgrade scheduled against the old plan, a failed
 * renewal and its reminders, the old plan-version pin and the old cycle dates all go with the old
 * plan. The `expiresAt` is kept exactly as given; with none there is no dated cycle, so no cycle
 * start and no anchor day is invented (only a test fixture can still ask for that). Re-posting the
 * same plan and expiry changes nothing about the cycle, so its start is kept: moving it forward
 * would shrink the proration denominator and overcharge a later upgrade.
 */
async function writePlanChange(
  tx: TenantDb,
  previous: PlanChangeBefore,
  change: Omit<PlanChange, 'billingInterval'>,
  billingInterval: BillingInterval | null,
  authority: subscriptionsRepo.PlanWriteAuthority,
): Promise<void> {
  const paid = !UNPAID_PLANS.has(change.plan);
  /* A different interval is a different cycle (owner review of #432): the writer validates and
   * audits the interval it is given, so the state must record that same interval. */
  const sameCycle =
    previous.plan === change.plan &&
    previous.cycleStartedAt !== null &&
    previous.expiresAt !== null &&
    change.expiresAt !== null &&
    previous.expiresAt.getTime() === change.expiresAt.getTime() &&
    (billingInterval === null || billingInterval === previous.billingInterval);
  await subscriptionsRepo.writeSubscriptionState(tx, change.businessId, {
    authority,
    plan: change.plan,
    paid,
    cycleStartedAt:
      paid && change.expiresAt ? (sameCycle ? previous.cycleStartedAt : new Date()) : null,
    planExpiresAt: change.expiresAt,
    /* An operator-defined cycle is never provider-priced (OWN-33). Re-posting
     * the identical cycle changes nothing commercially, so its origin stays. */
    origin: !paid ? null : sameCycle ? 'keep' : 'operator',
    anchorDay:
      paid && change.expiresAt
        ? sameCycle && previous.anchorDay !== null
          ? previous.anchorDay // a short-month renewal's day is clamped; the anchor is the original day
          : lagosDayOfMonth(change.expiresAt)
        : null,
    pendingPlan: null,
    keepPendingInterval: sameCycle,
    ...(billingInterval && !sameCycle ? { billingInterval } : {}),
  });
}

/**
 * TEST FIXTURES ONLY: the operator move's state, written through the harness-only fixture writer
 * (`test_fixture_set_plan`, never present in a deployed database) with none of the duration rules,
 * so a suite can put a business on an open-ended or past-dated plan. Exported for
 * `@rekoda/db/testing`, which is the only caller.
 */
export async function setPlanAsFixture(db: Db, change: PlanChange): Promise<boolean> {
  return withBusiness(db, change.businessId, async (tx) => {
    const previous = await lockForPlanChange(tx, change.businessId);
    if (!previous) return false;
    await writePlanChange(tx, previous, change, change.billingInterval ?? null, {
      kind: 'fixture',
    });
    /* The same `plan_changed` row the operator writer records (0200, 0203), so a fixture move is the
     * evidence an operator move is (the 0167 origin backfill and the audit trail read it). */
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    await tx.insert(auditEvents).values({
      businessId: change.businessId,
      actor: change.actor,
      entity: 'business',
      entityId: change.businessId,
      action: 'plan_changed',
      oldValue: {
        plan: previous.plan,
        expiresAt: iso(previous.expiresAt),
        pendingPlan: previous.pendingPlan,
        paymentFailedAt: iso(previous.paymentFailedAt),
      },
      newValue: { plan: change.plan, expiresAt: iso(change.expiresAt) },
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
