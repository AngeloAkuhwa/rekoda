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
      last_grace_reminder_day = NULL,
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
    | { kind: 'first_purchase'; periodStart: Date }
    | { kind: 'upgrade'; plan: string }
    | { kind: 'add_on'; packId: string },
): Promise<{ reference: string; amountK: number } | null> {
  const rows = await tx.execute<{ reference: string; amount_k: string }>(sql`
    SELECT reference, amount_k::bigint AS amount_k
    FROM subscription_charges
    WHERE business_id = ${businessId}::uuid
      AND status = 'pending'
      AND kind = ${match.kind}
      ${
        match.kind === 'first_purchase'
          ? sql`AND period_start = ${match.periodStart.toISOString()}::timestamptz`
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

export async function expireSubscription(
  tx: TenantDb,
  businessId: string,
  actor: string,
): Promise<string | null> {
  const before = await tx.execute<{ plan: string }>(sql`
    SELECT plan FROM businesses WHERE id = ${businessId}::uuid
  `);
  const previous = [...before][0]?.plan;
  if (!previous || previous === 'trial' || previous === 'expired') return null;

  const updated = await tx.execute<{ id: string }>(sql`
    UPDATE businesses SET plan = 'expired', pending_plan = NULL, updated_at = now()
    WHERE id = ${businessId}::uuid AND plan = ${previous}
    RETURNING id
  `);
  /* Somebody paid between the read and the write. Their plan stands. */
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
