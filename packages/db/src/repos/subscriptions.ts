/**
 * Where a merchant's subscription lives (ADR 0024).
 *
 * The arithmetic is in `@rekoda/core/billing` and stays there. This file
 * stores what that arithmetic decided and answers the two questions a sweep
 * asks - who renews today, and who is in grace - and nothing else. Money is
 * computed in one place and persisted in another for the same reason it
 * always is here: a figure that can only be checked by reading SQL is a
 * figure nobody checks.
 *
 * A subscription charge is Rekoda's revenue, not the merchant's, so nothing
 * in this file posts to a ledger. `docs/` and migration 0020 say why at
 * length.
 */
import { sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';

export type ChargeKind = 'first_purchase' | 'renewal' | 'upgrade' | 'add_on' | 'seat';
export type ChargeStatus = 'pending' | 'paid' | 'failed' | 'refunded';

/** The subscription side of a business row, as the biller needs it. */
export interface Subscription {
  plan: string;
  /** The renewal date on a paid plan, the hard stop on a trial. */
  planExpiresAt: Date | null;
  cycleStartedAt: Date | null;
  renewalAnchorDay: number | null;
  /** Non-null means a renewal charge failed and the grace clock is running. */
  paymentFailedAt: Date | null;
  /** A downgrade waiting for the next renewal. */
  pendingPlan: string | null;
}

interface SubscriptionRow extends Record<string, unknown> {
  plan: string;
  plan_expires_at: string | null;
  cycle_started_at: string | null;
  renewal_anchor_day: number | null;
  payment_failed_at: string | null;
  pending_plan: string | null;
}

const at = (value: string | null): Date | null => (value ? new Date(value) : null);

export async function subscriptionFor(
  tx: TenantDb,
  businessId: string,
): Promise<Subscription | null> {
  const rows = await tx.execute<SubscriptionRow>(sql`
    SELECT plan, plan_expires_at, cycle_started_at, renewal_anchor_day,
           payment_failed_at, pending_plan
    FROM businesses WHERE id = ${businessId}::uuid
  `);
  const row = [...rows][0];
  if (!row) return null;
  return {
    plan: row.plan,
    planExpiresAt: at(row.plan_expires_at),
    cycleStartedAt: at(row.cycle_started_at),
    renewalAnchorDay: row.renewal_anchor_day,
    paymentFailedAt: at(row.payment_failed_at),
    pendingPlan: row.pending_plan,
  };
}

/**
 * Put a business on a cycle: the plan, the dates and the anchor together.
 *
 * One statement, because these five columns are one fact. A plan written
 * without its cycle start is a subscription that cannot be prorated, and a
 * renewal date written without its anchor drifts backwards through the year.
 *
 * Clearing `payment_failed_at` is part of the same fact rather than a
 * separate call: a cycle that has been paid for is not in grace, and leaving
 * that to a second statement is leaving room for a merchant who paid to keep
 * receiving reminders.
 */
export async function applyCycle(
  tx: TenantDb,
  businessId: string,
  cycle: {
    plan: string;
    cycleStartedAt: Date;
    renewsAt: Date;
    anchorDay: number;
    /** The plan the NEXT renewal moves to. Null clears a scheduled downgrade. */
    pendingPlan?: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE businesses SET
      plan = ${cycle.plan},
      plan_expires_at = ${cycle.renewsAt.toISOString()}::timestamptz,
      cycle_started_at = ${cycle.cycleStartedAt.toISOString()}::timestamptz,
      renewal_anchor_day = ${cycle.anchorDay},
      pending_plan = ${cycle.pendingPlan ?? null},
      payment_failed_at = NULL,
      updated_at = now()
    WHERE id = ${businessId}::uuid
  `);
}

/**
 * Schedule a downgrade for the next renewal (ADR 0024).
 *
 * Nothing else moves. The merchant keeps the plan they paid for until the
 * cycle they paid for ends, which is the arrangement they can predict without
 * doing arithmetic.
 */
export async function schedulePlanChange(
  tx: TenantDb,
  businessId: string,
  plan: string | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE businesses SET pending_plan = ${plan}, updated_at = now()
    WHERE id = ${businessId}::uuid
  `);
}

/**
 * Start the grace clock, once.
 *
 * `IS NULL` in the WHERE is what makes a second failed attempt harmless: the
 * seven days run from the FIRST failure, so a card retried daily cannot push
 * the deadline forward one day at a time and keep a merchant in grace
 * forever.
 */
export async function markRenewalFailed(
  tx: TenantDb,
  businessId: string,
  when: Date,
): Promise<void> {
  await tx.execute(sql`
    UPDATE businesses SET payment_failed_at = ${when.toISOString()}::timestamptz, updated_at = now()
    WHERE id = ${businessId}::uuid AND payment_failed_at IS NULL
  `);
}

/* ── charges ──────────────────────────────────────────────────────────────── */

export interface NewCharge {
  businessId: string;
  kind: ChargeKind;
  amountK: number;
  /** Ours, and globally unique. The provider callback names this. */
  reference: string;
  plan?: string | null;
  packId?: string | null;
  quantity?: number;
  provider?: string;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

/**
 * Open a pending charge.
 *
 * Returns null when this exact charge already exists, which is the whole
 * point: a renewal sweep that runs twice, or two workers that both pick up
 * the same business, meet the unique index rather than a check somebody has
 * to remember to write. The caller treats null as "already opened", never as
 * a failure to retry.
 */
export async function openCharge(tx: TenantDb, charge: NewCharge): Promise<string | null> {
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO subscription_charges
      (business_id, kind, plan, pack_id, quantity, amount_k, provider,
       reference, period_start, period_end)
    VALUES (
      ${charge.businessId}::uuid, ${charge.kind}, ${charge.plan ?? null},
      ${charge.packId ?? null}, ${charge.quantity ?? 1}, ${charge.amountK},
      ${charge.provider ?? 'paystack'}, ${charge.reference},
      ${charge.periodStart ? charge.periodStart.toISOString() : null}::timestamptz,
      ${charge.periodEnd ? charge.periodEnd.toISOString() : null}::timestamptz)
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  return [...rows][0]?.id ?? null;
}

export interface ChargeRow extends Record<string, unknown> {
  id: string;
  businessId: string;
  kind: string;
  plan: string | null;
  packId: string | null;
  quantity: number;
  amountK: number;
  status: string;
  reference: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  createdAt: Date;
}

interface RawCharge extends Record<string, unknown> {
  id: string;
  business_id: string;
  kind: string;
  plan: string | null;
  pack_id: string | null;
  quantity: number;
  amount_k: string | number;
  status: string;
  reference: string;
  period_start: string | null;
  period_end: string | null;
  created_at: string;
}

const shape = (row: RawCharge): ChargeRow => ({
  id: row.id,
  businessId: row.business_id,
  kind: row.kind,
  plan: row.plan,
  packId: row.pack_id,
  quantity: row.quantity,
  amountK: Number(row.amount_k),
  status: row.status,
  reference: row.reference,
  periodStart: at(row.period_start),
  periodEnd: at(row.period_end),
  createdAt: new Date(row.created_at),
});

/**
 * Settle a pending charge, exactly once.
 *
 * `status = 'pending'` in the WHERE is the idempotency: a provider that
 * delivers the same webhook three times settles the charge once and gets null
 * twice, so the caller can apply the cycle inside the same transaction
 * knowing it is applying it for the first time.
 */
export async function settleCharge(
  tx: TenantDb,
  settlement: {
    reference: string;
    status: Extract<ChargeStatus, 'paid' | 'failed'>;
    providerReference?: string | null;
    failureReason?: string | null;
    when: Date;
  },
): Promise<ChargeRow | null> {
  const stamp = settlement.when.toISOString();
  const rows = await tx.execute<RawCharge>(sql`
    UPDATE subscription_charges SET
      status = ${settlement.status},
      provider_reference = COALESCE(${settlement.providerReference ?? null}, provider_reference),
      failure_reason = ${settlement.failureReason ?? null},
      paid_at = CASE WHEN ${settlement.status} = 'paid' THEN ${stamp}::timestamptz ELSE paid_at END,
      failed_at = CASE WHEN ${settlement.status} = 'failed' THEN ${stamp}::timestamptz ELSE failed_at END,
      updated_at = now()
    WHERE reference = ${settlement.reference} AND status = 'pending'
    RETURNING *
  `);
  const row = [...rows][0];
  return row ? shape(row) : null;
}

/**
 * Record a refund against a paid charge (ADR 0024's refund matrix).
 *
 * Partial refunds accumulate, and the CHECK constraint stops the total
 * exceeding what was charged. The status only becomes `refunded` when the
 * whole amount has come back, so a merchant refunded half a month still shows
 * a paid charge with a refund against it rather than a charge that reads as
 * though it never happened.
 */
export async function refundCharge(
  tx: TenantDb,
  reference: string,
  amountK: number,
  when: Date,
): Promise<ChargeRow | null> {
  const rows = await tx.execute<RawCharge>(sql`
    UPDATE subscription_charges SET
      refunded_amount_k = refunded_amount_k + ${amountK},
      status = CASE WHEN refunded_amount_k + ${amountK} >= amount_k THEN 'refunded' ELSE status END,
      refunded_at = ${when.toISOString()}::timestamptz,
      updated_at = now()
    WHERE reference = ${reference}
      AND status IN ('paid', 'refunded')
      AND refunded_amount_k + ${amountK} <= amount_k
    RETURNING *
  `);
  const row = [...rows][0];
  return row ? shape(row) : null;
}

/** A merchant's own billing history, newest first. The receipts page. */
export async function chargesFor(
  tx: TenantDb,
  businessId: string,
  limit = 50,
): Promise<ChargeRow[]> {
  const rows = await tx.execute<RawCharge>(sql`
    SELECT * FROM subscription_charges
    WHERE business_id = ${businessId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  return [...rows].map(shape);
}

/* ── the sweeps ───────────────────────────────────────────────────────────── */

export interface DueBusiness {
  businessId: string;
  plan: string;
  /** What the next cycle should be on: the scheduled downgrade, or the same plan. */
  nextPlan: string;
  renewsAt: Date;
  cycleStartedAt: Date | null;
  renewalAnchorDay: number | null;
  paymentFailedAt: Date | null;
}

interface RawDue extends Record<string, unknown> {
  id: string;
  plan: string;
  pending_plan: string | null;
  plan_expires_at: string;
  cycle_started_at: string | null;
  renewal_anchor_day: number | null;
  payment_failed_at: string | null;
}

const due = (row: RawDue): DueBusiness => ({
  businessId: row.id,
  plan: row.plan,
  nextPlan: row.pending_plan ?? row.plan,
  renewsAt: new Date(row.plan_expires_at),
  cycleStartedAt: at(row.cycle_started_at),
  renewalAnchorDay: row.renewal_anchor_day,
  paymentFailedAt: at(row.payment_failed_at),
});

/**
 * Paid businesses whose cycle has ended and who are not already in grace.
 *
 * Cross-tenant, so it needs the `rekoda_worker` credential: the sweep does
 * not know which tenants to ask about, which is the whole reason it is a
 * sweep. Migration 0019 granted that role SELECT on `businesses` and says why
 * that is a convenience rather than a widening.
 *
 * Trials are excluded here on purpose. A trial that ends is not a failed
 * payment and must not be charged; `planFor` already answers `expired` for
 * one, and that is the whole of the trial lifecycle.
 */
export async function dueForRenewal(db: Db, now: Date, limit = 200): Promise<DueBusiness[]> {
  const rows = await db.execute<RawDue>(sql`
    SELECT id, plan, pending_plan, plan_expires_at, cycle_started_at,
           renewal_anchor_day, payment_failed_at
    FROM businesses
    WHERE plan NOT IN ('trial', 'expired')
      AND plan_expires_at IS NOT NULL
      AND plan_expires_at <= ${now.toISOString()}::timestamptz
      AND payment_failed_at IS NULL
    ORDER BY plan_expires_at
    LIMIT ${limit}
  `);
  return [...rows].map(due);
}

/**
 * Businesses whose renewal failed and whose grace period is still running.
 *
 * Returned whole rather than filtered to today's reminder days, because which
 * day counts as a reminder is `billingState`'s decision in core and this is
 * SQL. The sweep asks core and sends at most one message.
 */
export async function inGrace(db: Db, limit = 500): Promise<DueBusiness[]> {
  const rows = await db.execute<RawDue>(sql`
    SELECT id, plan, pending_plan, plan_expires_at, cycle_started_at,
           renewal_anchor_day, payment_failed_at
    FROM businesses
    WHERE payment_failed_at IS NOT NULL
      AND plan NOT IN ('trial', 'expired')
      AND plan_expires_at IS NOT NULL
    ORDER BY payment_failed_at
    LIMIT ${limit}
  `);
  return [...rows].map(due);
}

/**
 * Which business a provider reference belongs to.
 *
 * Pre-tenant by nature and therefore worker-only: a callback names a
 * reference, and the tenant is the answer rather than the input. The same
 * shape, and the same reasoning, as resolving a payment intent.
 */
export async function businessForCharge(db: Db, reference: string): Promise<string | null> {
  const rows = await db.execute<{ business_id: string }>(sql`
    SELECT business_id FROM subscription_charges WHERE reference = ${reference}
  `);
  return [...rows][0]?.business_id ?? null;
}
