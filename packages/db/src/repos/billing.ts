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
import { addInterval, TRIAL_DAYS, type BillingInterval } from '@rekoda/core';

/** The plans nobody paid for; every other plan is a paid one (G-103). */
const UNPAID_PLANS = new Set(['trial', 'expired']);

/** The day of the month in Lagos (UTC+1), which renewals anchor to. */
const lagosDayOfMonth = (at: Date): number => new Date(at.getTime() + 3_600_000).getUTCDate();

export interface PlanChange {
  businessId: string;
  plan: string;
  /** TEST FIXTURES ONLY (`setPlanAsFixture`): an operator move never chooses a date (OD-50). */
  expiresAt: Date | null;
  /** A paid plan's interval (monthly by default). Trial and expired have none. */
  billingInterval?: BillingInterval;
  /** Who did this: `operator:<name>`, never a bare 'system'. */
  actor: string;
}

/**
 * An operator plan change (`POST /v1/businesses/plan`, OD-50). No date: Rekoda's standard period
 * is assigned by the database writer (migration 0207): exactly one calendar month or twelve
 * calendar months from now for a paid plan, the business's ORIGINAL 14-day trial end for a trial
 * (refused once that has passed), now for `expired`. `expired` is the explicit early end and needs
 * a `reason`, which the writer audits; nothing is refunded or credited.
 */
export interface OperatorPlanChange {
  businessId: string;
  plan: string;
  billingInterval?: BillingInterval;
  actor: string;
  reason?: string | null;
}

/** Why an operator plan change was refused: the caller's input, answered with a 400. */
export class PlanDateRefused extends Error {
  override readonly name = 'PlanDateRefused';
}

/**
 * Move a business onto a plan as an operator, recording who, when and why
 * (`POST /v1/businesses/plan`).
 *
 * `db` must be the billing-operator pool (`rekoda_billing_operator`, OPERATOR_DATABASE_URL): the
 * operator writer is executable by that role only (OD-37, migration 0202). Returns false when the
 * business does not exist rather than throwing: an operator typo is a 404 for the caller to report.
 * Throws `PlanDateRefused` for an input outside the rules (a 400).
 */
export async function setPlan(db: Db, change: OperatorPlanChange): Promise<boolean> {
  const paid = !UNPAID_PLANS.has(change.plan);
  if (!paid && change.billingInterval) {
    throw new PlanDateRefused(`a ${change.plan} plan has no billing interval`);
  }
  const reason = change.reason?.trim() ? change.reason.trim() : null;
  if (change.plan === 'expired' && !reason) {
    throw new PlanDateRefused('ending a plan early needs a reason');
  }
  const billingInterval: BillingInterval | null = paid
    ? (change.billingInterval ?? 'monthly')
    : null;
  return withBusiness(db, change.businessId, async (tx) => {
    const previous = await lockForPlanChange(tx, change.businessId);
    if (!previous) return false;
    /* The standard end, from the database writer's own rule on its own clock (0207): the same
     * `now()` the writer uses in this transaction, so the cycle written beside it agrees. */
    const ends = await tx.execute<{ at: string | null }>(sql`
      SELECT to_char(subscription_operator_period_end(${change.businessId}::uuid, ${change.plan},
        ${billingInterval}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`);
    const at = [...ends][0]?.at;
    if (!at) return false;
    const expiresAt = new Date(at);
    if (change.plan === 'trial' && expiresAt.getTime() <= (await databaseNow(tx)).getTime()) {
      throw new PlanDateRefused(
        `the business's ${TRIAL_DAYS}-day trial has ended; a trial cannot be re-opened`,
      );
    }
    await writePlanChange(
      tx,
      previous,
      { businessId: change.businessId, plan: change.plan, expiresAt, actor: change.actor },
      billingInterval,
      { kind: 'operator', actor: change.actor, billingInterval, reason },
      await databaseNow(tx),
    );
    /* The `plan_changed` audit row (what the move replaced, what it set and why, G-62) is written by
     * subscription_operator_set_plan itself, in this transaction (OD-37, 0200, 0207): an operator
     * plan change cannot happen without it, whichever code path called the writer. */
    return true;
  });
}

/**
 * Record a REFUSED operator plan change (0207), in its own transaction: the refused change rolled
 * back, and the record of the attempt must not. Best effort by design of the caller: a failure to
 * record never turns a 400 into a 500, but it is logged by the caller.
 */
export async function recordOperatorRefusal(
  db: Db,
  refusal: { businessId: string | null; actor: string; action: string; refusal: string },
): Promise<void> {
  await db.execute(sql`
    SELECT operator_record_refusal(${refusal.businessId}::uuid, ${refusal.actor},
      ${refusal.action}, ${refusal.refusal})`);
}

/* The start of the period of `interval` that ends at `end` (UTC calendar months; fixtures only). */
function periodBefore(end: Date, interval: BillingInterval): Date {
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - (interval === 'annual' ? 12 : 1));
  return start;
}

/* The DATABASE clock (the transaction start), the one the writer compares with. */
async function databaseNow(tx: TenantDb): Promise<Date> {
  const rows = await tx.execute<{ at: string }>(sql`
    SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`);
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
  /* When the new cycle starts: the database clock for an operator move (the instant its period
   * end was computed from, 0207); the host clock for a test fixture. */
  startedAt: Date = new Date(),
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
      paid && change.expiresAt ? (sameCycle ? previous.cycleStartedAt : startedAt) : null,
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
    /* A paid fixture plan is one Rekoda's durations allow (OD-49, migration 0208), or the plan
     * reader treats it as lapsed: no date means one standard period from now; a date means the
     * period that ends then (it may lie in the past, for a cycle that has run out). */
    const paid = !UNPAID_PLANS.has(change.plan);
    const interval: BillingInterval = change.billingInterval ?? 'monthly';
    const now = new Date();
    const expiresAt = paid ? (change.expiresAt ?? addInterval(now, interval)) : change.expiresAt;
    const startedAt = paid && change.expiresAt ? periodBefore(change.expiresAt, interval) : now;
    await writePlanChange(
      tx,
      previous,
      { ...change, expiresAt },
      change.billingInterval ?? null,
      { kind: 'fixture' },
      startedAt,
    );
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
      newValue: { plan: change.plan, expiresAt: iso(expiresAt) },
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
