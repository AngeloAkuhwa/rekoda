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
 * Clearing `payment_failed_at` and the reminder day is part of the same fact
 * rather than a separate call: a cycle that has been paid for is not in
 * grace, and leaving that to a second statement is leaving room for a
 * merchant who paid to keep receiving reminders.
 *
 * The grandfathering pin (spec §30) is part of the fact too, with one rule:
 * a cycle applied for the plan the pin already belongs to KEEPS the pin -
 * that is grandfathering, and a renewal that re-pinned to the current
 * version would end it on the first cycle. A cycle for a different plan
 * (upgrade, first purchase, a downgrade taking effect) pins to the version
 * of the new plan in force at the cycle start, because that is the version
 * the merchant is being sold today. A cycle that started BEFORE the
 * catalogue existed pins the plan's earliest version: pre-catalogue terms
 * were the constants, and version 1 is those constants as data.
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
  await writeSubscriptionState(tx, businessId, {
    plan: cycle.plan,
    paid: true,
    cycleStartedAt: cycle.cycleStartedAt,
    planExpiresAt: cycle.renewsAt,
    anchorDay: cycle.anchorDay,
    pendingPlan: cycle.pendingPlan ?? null,
  });
}

/** What a business's subscription columns say, written as one fact. */
export interface SubscriptionState {
  plan: string;
  /**
   * A paid plan (a cycle or an operator arrangement) or not (trial, expired).
   * Paid pins the plan-version and records the retention exemption (G-103);
   * unpaid leaves the pin alone: every read checks it against the plan, so a
   * stale pin is ignored, and keeping it keeps the grandfathering for the day
   * the business resumes.
   */
  paid: boolean;
  /** Null for an unpaid plan: no paid cycle began. */
  cycleStartedAt: Date | null;
  /** The renewal date, a trial's hard stop, or null for an open-ended arrangement. */
  planExpiresAt: Date | null;
  /** Null where there is no dated renewable cycle to anchor. */
  anchorDay: number | null;
  pendingPlan: string | null;
}

/**
 * The one writer of a business's subscription state (G-62).
 *
 * A paid cycle and an operator plan change both land here, so they cannot
 * disagree about what moving a business to a plan resets: the grace clock
 * and its reminder claim, a downgrade scheduled against the old plan, and
 * the plan-version pin (a pin that already belongs to the plan is KEPT,
 * which is grandfathering; one that belongs to another plan never survives
 * the move). `ever_paid_at` is only ever set here, never cleared (G-103).
 */
export async function writeSubscriptionState(
  tx: TenantDb,
  businessId: string,
  state: SubscriptionState,
): Promise<void> {
  const startStamp = (state.cycleStartedAt ?? new Date()).toISOString();
  const cycleStarted = state.cycleStartedAt ? sql`${startStamp}::timestamptz` : sql`NULL`;
  const expires = state.planExpiresAt
    ? sql`${state.planExpiresAt.toISOString()}::timestamptz`
    : sql`NULL`;
  const pin = state.paid
    ? sql`CASE
        WHEN plan_version_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM plan_versions pv
          WHERE pv.id = plan_version_id AND pv.plan_id = ${state.plan})
          THEN plan_version_id
        ELSE COALESCE(
          (SELECT id FROM plan_versions
           WHERE plan_id = ${state.plan}
             AND effective_from <= ${startStamp}::timestamptz
             AND (effective_to IS NULL OR effective_to > ${startStamp}::timestamptz)
           ORDER BY version DESC
           LIMIT 1),
          (SELECT id FROM plan_versions
           WHERE plan_id = ${state.plan}
           ORDER BY version
           LIMIT 1))
      END`
    : sql`plan_version_id`;
  await tx.execute(sql`
    UPDATE businesses SET
      plan = ${state.plan},
      plan_version_id = ${pin},
      plan_expires_at = ${expires},
      cycle_started_at = ${cycleStarted},
      renewal_anchor_day = ${state.anchorDay},
      pending_plan = ${state.pendingPlan},
      payment_failed_at = NULL,
      last_grace_reminder_day = NULL,
      -- G-103: a paid plan establishes the retention exemption; never cleared.
      ever_paid_at = ${state.paid ? sql`COALESCE(ever_paid_at, now())` : sql`ever_paid_at`},
      -- G-104: this IS a subscription decision; plan charges opened before it are stale.
      -- clock_timestamp(), not now(): ordering must follow when the statement ran,
      -- not when its transaction began.
      plan_decided_at = clock_timestamp(),
      plan_decided_before_pending = NULL,
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
  /* Business row first, then charge rows: the order settlement uses (G-104).
   * Touching a charge first lets a concurrent settlement deadlock with this. */
  await lockBusiness(tx, businessId);
  /* Scheduling a change is a decision (G-104): a plan charge opened before it
   * must not silently undo it. Clearing one is not: an undone cancellation
   * leaves the subscription as it was, so the renewal already open still
   * renews. */
  if (plan === null) {
    /* Undo. A RENEWAL opened WHILE the change was pending was priced for the
     * pending plan (the sweep prices the next cycle's plan); restoring the old
     * plan makes it wrong, so it is flagged stale. An upgrade opened meanwhile
     * was priced on the current plan and stays valid, as does anything opened
     * before. A change pending from before migration 0162 has no decision time:
     * every such renewal counts. */
    await tx.execute(sql`
      UPDATE subscription_charges c SET superseded_at = clock_timestamp(), updated_at = now()
      FROM businesses b
      WHERE b.id = ${businessId}::uuid AND c.business_id = b.id
        AND b.pending_plan IS NOT NULL
        AND c.status = 'pending' AND c.superseded_at IS NULL
        AND c.kind = 'renewal' AND c.plan IS NOT NULL AND c.plan <> b.plan
        AND c.created_at > COALESCE(b.plan_decided_at, '-infinity'::timestamptz)
    `);
    /* A charge opened BEFORE the schedule but retired AFTER it (the merchant
     * asked for another paid plan while the change waited) was only stale
     * because of the schedule. The undo removes that reason, so it is current
     * again, unless a fresh charge already took its slot.
     *
     * `superseded_at >= plan_decided_at` is what keeps this to charges retired
     * AFTER the schedule's own decision: a REPLACEMENT retires the first plan's
     * renewals in a statement that runs BEFORE it stamps the new decision, so
     * those are not revived (a renewal priced for an abandoned downgrade must
     * stay retired). That depends on the statement order in the replacement
     * branch below and is pinned by "undoing after a REPLACED downgrade ...". */
    await tx.execute(sql`
      UPDATE subscription_charges c SET superseded_at = NULL, updated_at = now()
      FROM businesses b
      WHERE b.id = ${businessId}::uuid AND c.business_id = b.id
        AND b.pending_plan IS NOT NULL
        AND c.status = 'pending' AND c.superseded_at IS NOT NULL
        AND c.unapplied_at IS NULL AND c.abandoned_at IS NULL AND c.plan IS NOT NULL
        AND b.plan_decided_at IS NOT NULL AND b.plan_decided_before_pending IS NOT NULL
        AND c.created_at >= b.plan_decided_before_pending AND c.created_at < b.plan_decided_at
        AND c.superseded_at >= b.plan_decided_at
        AND NOT EXISTS (
          SELECT 1 FROM subscription_charges o
          WHERE o.business_id = c.business_id AND o.id <> c.id
            AND o.status = 'pending' AND o.superseded_at IS NULL
            AND o.kind = c.kind
            AND (CASE WHEN c.kind = 'upgrade' THEN o.plan = c.plan
                      ELSE o.period_start IS NOT DISTINCT FROM c.period_start END))
    `);
    /* Put the decision time back to what it was before the change was
     * scheduled, so a charge opened before the cancellation is current again. */
    await tx.execute(sql`
      UPDATE businesses SET pending_plan = NULL,
        plan_decided_at = CASE WHEN pending_plan IS NULL
          THEN plan_decided_at ELSE plan_decided_before_pending END,
        plan_decided_before_pending = NULL,
        updated_at = now()
      WHERE id = ${businessId}::uuid
    `);
    return;
  }
  /* REPLACING a pending change with a different one is a new decision: a charge
   * opened for the first pending plan in between is flagged stale now (an undo
   * only looks at charges since the latest schedule). */
  await tx.execute(sql`
    UPDATE subscription_charges c SET superseded_at = clock_timestamp(), updated_at = now()
    FROM businesses b
    WHERE b.id = ${businessId}::uuid AND c.business_id = b.id
      AND b.pending_plan IS NOT NULL AND b.pending_plan IS DISTINCT FROM ${plan}
      AND c.status = 'pending' AND c.superseded_at IS NULL
      AND c.kind = 'renewal' AND c.plan IS NOT NULL AND c.plan <> b.plan
      AND c.created_at > COALESCE(b.plan_decided_at, '-infinity'::timestamptz)
  `);
  await tx.execute(sql`
    UPDATE businesses SET pending_plan = ${plan},
      plan_decided_before_pending = CASE WHEN pending_plan IS NULL
        THEN plan_decided_at ELSE plan_decided_before_pending END,
      plan_decided_at = CASE WHEN pending_plan IS DISTINCT FROM ${plan}
        THEN clock_timestamp() ELSE plan_decided_at END,
      updated_at = now()
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
       reference, period_start, period_end, created_at)
    VALUES (
      ${charge.businessId}::uuid, ${charge.kind}, ${charge.plan ?? null},
      ${charge.packId ?? null}, ${charge.quantity ?? 1}, ${charge.amountK},
      ${charge.provider ?? 'paystack'}, ${charge.reference},
      ${charge.periodStart ? charge.periodStart.toISOString() : null}::timestamptz,
      ${charge.periodEnd ? charge.periodEnd.toISOString() : null}::timestamptz,
      clock_timestamp())
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
  /** Paid (or pending) but its plan change was refused as stale (G-104): an operator reconciles it. */
  supersededAt: Date | null;
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
  superseded_at: string | null;
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
  supersededAt: at(row.superseded_at),
});

/**
 * Settle a pending charge, exactly once.
 *
 * `status = 'pending'` in the WHERE is the idempotency: a provider that
 * delivers the same webhook three times settles the charge once and gets null
 * twice, so the caller can apply the cycle inside the same transaction
 * knowing it is applying it for the first time.
 */
/**
 * The pending charge a conflicting open just collided with.
 *
 * When openCharge answers null, somebody already opened this exact charge
 * and it has not settled: the right response is to hand the caller THAT
 * charge's reference, so a double-clicked upgrade or a re-posted pack
 * purchase resolves to one payment link instead of two payable charges.
 */
export async function pendingCharge(
  tx: TenantDb,
  businessId: string,
  match:
    | { kind: 'first_purchase'; periodStart: Date; plan: string }
    | { kind: 'upgrade'; plan: string }
    | { kind: 'add_on'; packId: string },
): Promise<{ reference: string; amountK: number } | null> {
  const rows = await tx.execute<{ reference: string; amount_k: string }>(sql`
    SELECT reference, amount_k::bigint AS amount_k
    FROM subscription_charges
    WHERE business_id = ${businessId}::uuid
      AND status = 'pending'
      AND superseded_at IS NULL
      AND kind = ${match.kind}
      ${
        match.kind === 'first_purchase'
          ? sql`AND period_start = ${match.periodStart.toISOString()}::timestamptz
                AND plan = ${match.plan}`
          : match.kind === 'upgrade'
            ? sql`AND plan = ${match.plan}`
            : sql`AND pack_id = ${match.packId}`
      }
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const row = [...rows][0];
  return row ? { reference: row.reference, amountK: Number(row.amount_k) } : null;
}

/**
 * Lock the business row. The first statement of every transaction that
 * settles a subscription charge, before it writes any charge row.
 *
 * LOCK ORDER (G-103). Retention deletes a whole tenant, and it takes the
 * business row first (`retention_delete_business` reads it FOR UPDATE) and
 * the tenant's tables, `subscription_charges` among them, after. Settlement
 * used to write the charge row and reach the business row only at
 * `applyCycle`, the opposite order, so the two could each hold what the
 * other wanted: a Postgres deadlock, with a paying merchant's transaction as
 * one possible victim. Every settlement now takes the business row first, so
 * both paths run business, then charge, and the later one simply waits.
 *
 * FOR NO KEY UPDATE is what `applyCycle`'s UPDATE takes anyway, so this moves
 * an existing lock earlier rather than adding a stronger one. It conflicts
 * with retention's FOR UPDATE, which is the point.
 *
 * Other paths that touch both tables, and why none inverts:
 *   - openCharge inserts a new charge (invisible to retention's snapshot) and
 *     markRenewalFailed then updates the business: no existing charge row is
 *     held.
 *   - expireSubscription, schedulePlanChange, the grace claims and operator
 *     setPlan write the business first, and never a charge.
 *   - refundCharge writes a paid charge, and a business with a paid or
 *     refunded charge is never selected by retention, so it is never locked.
 *
 * Returns false when the business no longer exists (retention won the race
 * and deleted it): the caller has nothing to settle against.
 */
export async function lockBusiness(tx: TenantDb, businessId: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT id FROM businesses WHERE id = ${businessId}::uuid FOR NO KEY UPDATE
  `);
  return [...rows].length === 1;
}

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
 * Was the subscription decided AFTER this charge was opened (G-104)?
 *
 * A plan charge is priced and promised against the subscription as it stood
 * when it was opened. If an operator move, a settled charge or a scheduled
 * change has been decided since, paying it must not apply its plan: the payment
 * is real, the entitlement it was meant to buy is not. Call with the business
 * row locked, so the answer cannot change under the caller.
 */
export async function decidedSince(
  tx: TenantDb,
  businessId: string,
  reference: string,
): Promise<boolean> {
  /* Compared in SQL at full microsecond precision: a JS Date would truncate
   * the charge's created_at to the millisecond. */
  const rows = await tx.execute<{ stale: boolean }>(sql`
    SELECT ((c.superseded_at IS NOT NULL AND c.abandoned_at IS NULL)
            OR (b.plan_decided_at IS NOT NULL AND b.plan_decided_at > c.created_at)) AS stale
    FROM businesses b
    JOIN subscription_charges c ON c.business_id = b.id AND c.reference = ${reference}
    WHERE b.id = ${businessId}::uuid
  `);
  return [...rows][0]?.stale === true;
}

/**
 * The merchant chose a different way to pay (G-105): retire the still-pending
 * charges they abandoned, so the one they just asked for is the only payable
 * link and takes the slot the abandoned one held.
 *
 * - `first_purchase` for `plan` retires pending first purchases of the same
 *   cycle for any OTHER plan (they share `subscription_charges_cycle_ux`).
 * - `upgrade` retires a pending upgrade to the same plan priced before today's
 *   state (used when the upgrade now costs nothing and is applied directly).
 *
 * An abandoned charge is retired but NOT stale (`abandoned_at`): paid later,
 * it still buys its plan unless a newer decision exists by then, in which case
 * the stale-charge rules (G-104) apply as to any other. Call with the business
 * row locked.
 */
export async function retireAbandonedPending(
  tx: TenantDb,
  businessId: string,
  match:
    { kind: 'first_purchase'; periodStart: Date; plan: string } | { kind: 'upgrade'; plan: string },
): Promise<void> {
  await tx.execute(sql`
    UPDATE subscription_charges
    SET superseded_at = clock_timestamp(), abandoned_at = clock_timestamp(), updated_at = now()
    WHERE business_id = ${businessId}::uuid
      AND status = 'pending' AND superseded_at IS NULL
      AND kind = ${match.kind}
      ${
        match.kind === 'first_purchase'
          ? sql`AND period_start = ${match.periodStart.toISOString()}::timestamptz
                AND plan IS DISTINCT FROM ${match.plan}`
          : sql`AND plan = ${match.plan}`
      }
  `);
}

/**
 * Flag every still-pending plan charge opened before the latest decision as
 * stale (G-104), so it can no longer be handed out as a payment link and does
 * not occupy the one-pending-upgrade slot. A late payment of one is still
 * recorded (it stays `pending` until the provider settles it) and then refused
 * its plan change at settlement. Call with the business row locked.
 */
export async function retireStalePending(tx: TenantDb, businessId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE subscription_charges c SET superseded_at = clock_timestamp(), updated_at = now()
    FROM businesses b
    WHERE b.id = ${businessId}::uuid AND c.business_id = b.id
      AND c.status = 'pending' AND c.superseded_at IS NULL AND c.plan IS NOT NULL
      AND b.plan_decided_at IS NOT NULL AND c.created_at < b.plan_decided_at
  `);
}

/**
 * One business's renewal-due state, read under the caller's row lock (G-104).
 * Null when it is no longer due (moved, cancelled, already in grace, paid).
 */
export async function dueForRenewalLocked(
  tx: TenantDb,
  businessId: string,
  now: Date,
): Promise<DueBusiness | null> {
  const rows = await tx.execute<RawDue>(sql`
    SELECT id, plan, pending_plan, plan_expires_at, cycle_started_at,
           renewal_anchor_day, payment_failed_at
    FROM businesses
    WHERE id = ${businessId}::uuid
      AND plan NOT IN ('trial', 'expired')
      AND plan_expires_at IS NOT NULL
      AND plan_expires_at <= ${now.toISOString()}::timestamptz
      AND (payment_failed_at IS NULL OR ${NO_PAYABLE_RENEWAL})
  `);
  const row = [...rows][0];
  return row ? due(row) : null;
}

/**
 * A PAID charge whose plan change was refused (OD-30): it stays `paid`, is
 * flagged superseded and UNAPPLIED, and waits in the operator queue. Money
 * truth is untouched. Idempotent: the first refusal keeps its time and reason.
 */
export async function markUnapplied(
  tx: TenantDb,
  reference: string,
  reason: string,
  when: Date,
): Promise<void> {
  const stamp = when.toISOString();
  await tx.execute(sql`
    UPDATE subscription_charges
    SET superseded_at = COALESCE(superseded_at, ${stamp}::timestamptz),
        unapplied_at = ${stamp}::timestamptz,
        unapplied_reason = ${reason},
        updated_at = now()
    WHERE reference = ${reference} AND status = 'paid' AND unapplied_at IS NULL
  `);
}

export interface UnappliedChargeRow {
  reference: string;
  businessId: string;
  kind: string;
  plan: string | null;
  packId: string | null;
  amountK: number;
  paidAt: Date | null;
  supersededAt: Date | null;
  unappliedAt: Date;
  reason: string | null;
  /** The business's plan and renewal state NOW, so an operator sees what the payment collided with. */
  currentPlan: string;
  currentPendingPlan: string | null;
  currentRenewsAt: Date | null;
  /**
   * The payable plan charge the merchant has open right now, if any. When a
   * renewal is paid but unapplied, the sweep asks for the correct one, so the
   * merchant may pay twice; an operator needs to see that to reconcile it.
   */
  openChargeReference: string | null;
}

/**
 * Paid-but-unapplied Rekoda charges still waiting for an operator (OD-30),
 * oldest first. Cross-tenant by nature, so it takes the worker credential,
 * like the event exception queue. A fully refunded charge has left the queue
 * by its status; any other leaves only by an explicit resolution.
 */
export async function unappliedCharges(db: Db, limit = 50): Promise<UnappliedChargeRow[]> {
  const rows = await db.execute<{
    reference: string;
    business_id: string;
    kind: string;
    plan: string | null;
    pack_id: string | null;
    amount_k: string | number;
    paid_at: string | null;
    superseded_at: string | null;
    unapplied_at: string;
    unapplied_reason: string | null;
    current_plan: string;
    current_pending_plan: string | null;
    current_renews_at: string | null;
    open_charge_reference: string | null;
  }>(sql`
    SELECT c.reference, c.business_id, c.kind, c.plan, c.pack_id, c.amount_k, c.paid_at,
           c.superseded_at, c.unapplied_at, c.unapplied_reason,
           b.plan AS current_plan, b.pending_plan AS current_pending_plan,
           b.plan_expires_at AS current_renews_at,
           (SELECT n.reference FROM subscription_charges n
             WHERE n.business_id = c.business_id AND n.status = 'pending'
               AND n.superseded_at IS NULL AND n.plan IS NOT NULL
             ORDER BY n.created_at DESC LIMIT 1) AS open_charge_reference
    FROM subscription_charges c
    JOIN businesses b ON b.id = c.business_id
    WHERE c.unapplied_at IS NOT NULL AND c.unapplied_resolved_at IS NULL AND c.status = 'paid'
    ORDER BY c.unapplied_at, c.reference
    LIMIT ${limit}
  `);
  return [...rows].map((r) => ({
    reference: r.reference,
    businessId: r.business_id,
    kind: r.kind,
    plan: r.plan,
    packId: r.pack_id,
    amountK: Number(r.amount_k),
    paidAt: at(r.paid_at),
    supersededAt: at(r.superseded_at),
    unappliedAt: new Date(r.unapplied_at),
    reason: r.unapplied_reason,
    currentPlan: r.current_plan,
    currentPendingPlan: r.current_pending_plan,
    currentRenewsAt: at(r.current_renews_at),
    openChargeReference: r.open_charge_reference,
  }));
}

/** An operator's resolution of an unapplied charge. True when this call closed it. */
export async function resolveUnapplied(
  tx: TenantDb,
  reference: string,
  resolution: string,
  actor: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE subscription_charges
    SET unapplied_resolved_at = now(), unapplied_resolution = ${resolution},
        unapplied_resolved_by = ${actor}, updated_at = now()
    WHERE reference = ${reference} AND unapplied_at IS NOT NULL AND unapplied_resolved_at IS NULL
    RETURNING id
  `);
  return [...rows].length === 1;
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
  /** Who decided, and under which of ADR 0024's rows. */
  record?: { actor: string; reason: string },
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
  if (!row) return null;

  /* Written here rather than by the caller, because a refund and the record
   * of who decided it are one fact: a caller that could forget the second is
   * a caller that will. */
  if (record) {
    await tx.execute(sql`
      INSERT INTO audit_events
        (business_id, actor, entity, entity_id, action, new_value, source_type)
      VALUES (${row.business_id}::uuid, ${record.actor}, 'subscription_charge',
              ${reference}, 'refunded',
              ${JSON.stringify({ amountK, reason: record.reason, status: row.status })}::jsonb,
              'operator')
    `);
  }
  return shape(row);
}

/**
 * One charge, by the reference a provider named, under the tenant pin.
 *
 * Tenant-scoped deliberately, unlike `businessForCharge`: by the time a job
 * is running, the tenant is known, and re-deriving it from the reference
 * would be trusting the attribution instead of checking it.
 */
export async function chargeByReference(
  tx: TenantDb,
  businessId: string,
  reference: string,
): Promise<ChargeRow | null> {
  const rows = await tx.execute<RawCharge>(sql`
    SELECT * FROM subscription_charges
    WHERE business_id = ${businessId}::uuid AND reference = ${reference}
  `);
  const row = [...rows][0];
  return row ? shape(row) : null;
}

/**
 * A merchant's own billing history, newest first, and how many there are.
 *
 * `count` matters more here than on most lists. The page's own empty state
 * promises that every payment they make to Rekoda will be listed with its
 * reference "so you can put it in your own books" — a completeness promise
 * that a silent cap breaks. A merchant reconciling their books against these
 * charges would come up short and have nothing on the page to explain why.
 */
export interface Charges {
  rows: ChargeRow[];
  count: number;
}

export async function chargesFor(tx: TenantDb, businessId: string, limit = 50): Promise<Charges> {
  const rows = await tx.execute<RawCharge & { n: number }>(sql`
    SELECT *, count(*) OVER ()::int AS n
    FROM subscription_charges
    WHERE business_id = ${businessId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  const list = [...rows];
  return { rows: list.map(shape), count: list[0]?.n ?? 0 };
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
 * A business with no PAYABLE renewal for the cycle that just ended: every
 * renewal opened for it is retired, or was opened before the latest decision
 * and so would be refused. Such a business owes the sweep a fresh one even if
 * its grace clock is already running (G-104), and the clock is never reset:
 * the seven days still count from the renewal date, so toggling a downgrade
 * cannot buy a merchant more grace.
 */
const NO_PAYABLE_RENEWAL = sql`NOT EXISTS (
  SELECT 1 FROM subscription_charges c
  WHERE c.business_id = businesses.id AND c.kind = 'renewal'
    AND c.period_start = businesses.plan_expires_at
    AND c.superseded_at IS NULL
    -- Anything still holding the cycle blocks a replacement, EXCEPT a pending
    -- renewal opened before the latest decision: that one is retired under the
    -- lock, which frees the slot. A failed or paid renewal is never retired, so
    -- selecting its business would only fail to open a charge on every pass.
    -- (G-105 lets a FAILED renewal's cycle slot be reused by a new charge, but
    -- nothing re-raises one yet: the sweep still leaves it to grace.)
    AND NOT (c.status = 'pending'
             AND businesses.plan_decided_at IS NOT NULL
             AND businesses.plan_decided_at > c.created_at)
)`;

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
      AND (payment_failed_at IS NULL OR ${NO_PAYABLE_RENEWAL})
    ORDER BY plan_expires_at
    LIMIT ${limit}
  `);
  return [...rows].map(due);
}

export interface GraceBusiness extends DueBusiness {
  /** E.164, for the reminder. Joined here rather than looked up per row. */
  ownerPhone: string;
  /** STOP, as a fact. Checked before every proactive send, this one included. */
  ownerOptedOut: boolean;
  /** The last reminder day already sent, or null. */
  lastReminderDay: number | null;
}

/**
 * Businesses whose renewal failed and whose grace period is still running.
 *
 * Returned whole rather than filtered to today's reminder days, because which
 * day counts as a reminder is `billingState`'s decision in core and this is
 * SQL. The sweep asks core and sends at most one message.
 *
 * The owner's phone is joined rather than fetched per row: a sweep that made
 * one extra query per merchant in grace would be a sweep that gets slower
 * exactly when more merchants are having payment trouble.
 */
export async function inGrace(
  db: Db,
  limit = 500,
  /**
   * Keyset cursor, so a pass can WALK the whole grace population in pages.
   * Ordered by id rather than failure date: a business in grace stays in
   * this set for the whole window, so an offset-free date ordering plus a
   * cap silently starved everyone past the cap — the newest failures, the
   * exact merchants a day-one reminder saves.
   */
  afterId: string | null = null,
): Promise<GraceBusiness[]> {
  const rows = await db.execute<
    RawDue & {
      owner_phone: string;
      opted_out_at: string | null;
      last_grace_reminder_day: number | null;
    }
  >(sql`
    SELECT b.id, b.plan, b.pending_plan, b.plan_expires_at, b.cycle_started_at,
           b.renewal_anchor_day, b.payment_failed_at, b.last_grace_reminder_day,
           u.phone AS owner_phone, u.opted_out_at
    FROM businesses b
    JOIN users u ON u.id = b.owner_user_id
    WHERE b.payment_failed_at IS NOT NULL
      AND b.plan NOT IN ('trial', 'expired')
      AND b.plan_expires_at IS NOT NULL
      ${afterId === null ? sql`` : sql`AND b.id > ${afterId}::uuid`}
    ORDER BY b.id
    LIMIT ${limit}
  `);
  return [...rows].map((row) => ({
    ...due(row),
    ownerPhone: row.owner_phone,
    ownerOptedOut: row.opted_out_at !== null,
    lastReminderDay: row.last_grace_reminder_day,
  }));
}

/**
 * Claim today's grace reminder, or discover somebody else already sent it.
 *
 * A conditional UPDATE rather than a read then a write, because the sweep
 * runs on a timer and may run in more than one process: two overlapping
 * passes would both decide day 5 had not been sent and both send it. The
 * strictly-greater comparison also stops a clock that jumps backwards
 * re-sending day 1 after day 5 has gone out.
 *
 * Returns true exactly once per day, to exactly one caller.
 */
export async function claimGraceReminder(
  tx: TenantDb,
  businessId: string,
  day: number,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE businesses
    SET last_grace_reminder_day = ${day}, updated_at = now()
    WHERE id = ${businessId}::uuid
      AND (last_grace_reminder_day IS NULL OR last_grace_reminder_day < ${day})
    RETURNING id
  `);
  return [...rows].length === 1;
}

/**
 * Stop a lapsed subscription, explicitly.
 *
 * `planFor` deliberately never expires a paid plan on a date comparison, so a
 * late billing job cannot cut off a merchant who is paying. The consequence
 * is that the transition has to be an ACT: this is it, and it happens only
 * after seven days of grace and two reminders.
 *
 * The previous plan goes into the audit trail rather than being lost, so
 * "resume your Complete plan" is answerable later. `payment_failed_at` stays
 * as it was: it is the record of why this happened.
 */
/**
 * Give a claimed reminder day back after a failed send.
 *
 * Set to day - 1 rather than NULL: NULL would reopen EARLIER days too, and
 * the only thing being returned is the one day this pass claimed and then
 * failed to deliver. The next hourly pass re-claims it, so a merchant in
 * grace is warned as soon as the channel recovers instead of never.
 */
export async function releaseGraceReminder(
  tx: TenantDb,
  businessId: string,
  day: number,
): Promise<void> {
  await tx.execute(sql`
    UPDATE businesses
    SET last_grace_reminder_day = ${day - 1}, updated_at = now()
    WHERE id = ${businessId}::uuid AND last_grace_reminder_day = ${day}
  `);
}

/**
 * Why a subscription is being stopped (G-106). Each reason is a condition
 * the write re-checks, because the plan name alone does not change when a
 * renewal is paid or a cancel is undone.
 *
 * - `grace`: the renewal is still unpaid (`payment_failed_at` set). A paid
 *   renewal clears it (`applyCycle`).
 * - `cancelled`: the merchant still wants out (`pending_plan = 'expired'`).
 *   Undoing the cancel clears it.
 */
export type ExpiryReason = 'grace' | 'cancelled';

export async function expireSubscription(
  tx: TenantDb,
  businessId: string,
  actor: string,
  reason: ExpiryReason,
): Promise<string | null> {
  const before = await tx.execute<{ plan: string }>(sql`
    SELECT plan FROM businesses WHERE id = ${businessId}::uuid
  `);
  const previous = [...before][0]?.plan;
  if (!previous || previous === 'trial' || previous === 'expired') return null;

  const updated = await tx.execute<{ id: string }>(sql`
    UPDATE businesses
    SET plan = 'expired', pending_plan = NULL, plan_decided_at = clock_timestamp(),
        updated_at = now()
    WHERE id = ${businessId}::uuid AND plan = ${previous}
      AND ${reason === 'grace' ? sql`payment_failed_at IS NOT NULL` : sql`pending_plan = 'expired'`}
    RETURNING id
  `);
  /* Somebody paid, or undid the cancel, between the read and the write.
   * Their plan stands. */
  if ([...updated].length !== 1) return null;

  await tx.execute(sql`
    INSERT INTO audit_events
      (business_id, actor, entity, entity_id, action, old_value, new_value, source_type)
    VALUES (${businessId}::uuid, ${actor}, 'business', ${businessId}, 'subscription_expired',
            ${JSON.stringify({ plan: previous })}::jsonb,
            ${JSON.stringify({ plan: 'expired' })}::jsonb, 'system')
  `);
  return previous;
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
