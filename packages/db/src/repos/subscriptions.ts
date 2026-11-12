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
  /** Who created the current paid cycle; null is unknown (G-115, OWN-33). */
  origin: SubscriptionOrigin | null;
  /** The interval the current cycle was bought on (G-110, OWN-40). */
  billingInterval: BillingInterval;
  /** An interval switch waiting for the next renewal, or null. */
  pendingBillingInterval: BillingInterval | null;
}

/** How often a subscription bills; the same two values as the plan catalogue (migration 0171). */
export type BillingInterval = 'monthly' | 'annual';

const intervalOf = (value: string | null | undefined): BillingInterval =>
  value === 'annual' ? 'annual' : 'monthly';

/** Who created a paid cycle: a settled provider charge or an operator. */
export type SubscriptionOrigin = 'provider' | 'operator';

interface SubscriptionRow extends Record<string, unknown> {
  plan: string;
  plan_expires_at: string | null;
  cycle_started_at: string | null;
  renewal_anchor_day: number | null;
  payment_failed_at: string | null;
  pending_plan: string | null;
  subscription_origin: string | null;
  billing_interval: string;
  pending_billing_interval: string | null;
}

const at = (value: string | null): Date | null => (value ? new Date(value) : null);

export async function subscriptionFor(
  tx: TenantDb,
  businessId: string,
): Promise<Subscription | null> {
  const rows = await tx.execute<SubscriptionRow>(sql`
    SELECT plan, plan_expires_at, cycle_started_at, renewal_anchor_day,
           payment_failed_at, pending_plan, subscription_origin,
           billing_interval, pending_billing_interval
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
    origin:
      row.subscription_origin === 'provider' || row.subscription_origin === 'operator'
        ? row.subscription_origin
        : null,
    billingInterval: intervalOf(row.billing_interval),
    pendingBillingInterval: row.pending_billing_interval
      ? intervalOf(row.pending_billing_interval)
      : null,
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
  cycle: CycleInput & {
    /**
     * The paid charge this cycle is bought with (OD-37, migration 0200). The database takes the
     * plan from that charge and refuses a charge that is not paid, not a plan charge, or already
     * applied, so `plan` here must be the charge's plan.
     */
    chargeReference: string;
  },
): Promise<void> {
  await writeCycle(tx, businessId, cycle, { kind: 'charge', reference: cycle.chargeReference });
}

/** A paid cycle, as `applyCycle` and the test fixture writer describe it. */
export interface CycleInput {
  plan: string;
  cycleStartedAt: Date;
  renewsAt: Date;
  anchorDay: number;
  /** The plan the NEXT renewal moves to. Null clears a scheduled downgrade. */
  pendingPlan?: string | null;
  /** The interval this cycle was bought on; absent keeps monthly. A switch waiting for renewal is cleared. */
  billingInterval?: BillingInterval;
  /**
   * An upgrade keeps the cycle it lands in, so an interval switch already scheduled for the
   * NEXT renewal must survive it. A renewal or a first purchase starts a new cycle and clears it.
   */
  keepPendingInterval?: boolean;
  /** Leaves this interval waiting for the next renewal (a cycle bought on another interval than the one chosen). */
  nextInterval?: BillingInterval | null;
}

/**
 * Write a paid cycle under the given authority. Production code calls `applyCycle` (a paid
 * charge); the `fixture` authority exists only for test databases (`@rekoda/db/testing`), whose
 * harness installs the function it needs; a production database has no such function.
 */
export async function writeCycle(
  tx: TenantDb,
  businessId: string,
  cycle: CycleInput,
  authority: PlanWriteAuthority,
): Promise<void> {
  await writeSubscriptionState(tx, businessId, {
    authority,
    billingInterval: cycle.billingInterval ?? 'monthly',
    keepPendingInterval: cycle.keepPendingInterval ?? false,
    ...(cycle.nextInterval !== undefined ? { nextInterval: cycle.nextInterval } : {}),
    plan: cycle.plan,
    paid: true,
    cycleStartedAt: cycle.cycleStartedAt,
    planExpiresAt: cycle.renewsAt,
    anchorDay: cycle.anchorDay,
    pendingPlan: cycle.pendingPlan ?? null,
    origin: 'provider',
  });
}

/**
 * Who may move a business's plan fields (OD-37, migration 0200), each mapped to its own database
 * writer: a paid charge (`subscription_apply_paid_charge`, the plan comes from the charge), an
 * operator (`subscription_operator_set_plan`: validated plan, interval, date and `operator:` actor, audited by the writer, billing-operator credential only, 0202/0203), or a
 * test fixture (a function only the test harness installs).
 */
export type PlanWriteAuthority =
  | { kind: 'charge'; reference: string }
  /* The interval a paid operator plan is sold on (null for trial and expired): the writer checks
   * the end against it (migration 0203). */
  | { kind: 'operator'; actor: string; billingInterval: BillingInterval | null }
  | { kind: 'fixture' };

/** What a business's subscription columns say, written as one fact. */
export interface SubscriptionState {
  authority: PlanWriteAuthority;
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
  /** The interval of this cycle (G-110); absent is monthly. A pending interval switch is always cleared by a new state. */
  billingInterval?: BillingInterval;
  /** Keep a scheduled interval switch (an upgrade inside the cycle); otherwise it is cleared. */
  keepPendingInterval?: boolean;
  /** Sets the interval waiting for the next renewal; wins over `keepPendingInterval`. */
  nextInterval?: BillingInterval | null;
  /**
   * Who created this cycle (G-115). Null for an unpaid plan, or to keep the
   * origin the row already has when nothing about the cycle changed.
   */
  origin: SubscriptionOrigin | null | 'keep';
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
  given: SubscriptionState,
): Promise<'written' | 'unchanged'> {
  const state = given;
  /* OD-50 (0207): the operator writer computes a paid plan's or a trial's end itself (Rekoda's
   * standard period from the database clock) and returns it with the cycle start it used, so the
   * rest of the cycle is recorded from the database's own values. Re-posting the plan and interval
   * the business is already on changes nothing. */
  if (given.authority.kind === 'operator') {
    const a = given.authority;
    const asked = given.planExpiresAt
      ? sql`${given.planExpiresAt.toISOString()}::timestamptz`
      : sql`NULL`;
    const rows = await tx.execute<{
      cycle_start: string | null;
      expires_at: string | null;
      changed: boolean;
    }>(sql`
      SELECT cycle_start, expires_at, changed FROM subscription_operator_set_plan(
        ${businessId}::uuid, ${given.plan}, ${asked}, ${a.billingInterval}, ${a.actor})
    `);
    const row = [...rows][0];
    if (!row) throw new Error('subscription_operator_set_plan returned nothing');
    if (!row.changed) return 'unchanged';
    /* Since 0221 the writer records the whole cycle itself, from its own values, and the operator
     * credential holds no column it could write here. */
    return 'written';
  }
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
  /* OD-37 (migrations 0196, 0200): `plan` and `plan_expires_at` are written only by a database
   * function owned by `rekoda_plan_writer`, chosen by the authority; the trigger refuses them from
   * anywhere else. The rest of the cycle is written beside it, in this same transaction, so the
   * state still lands as one fact. */
  const a = state.authority;
  if (a.kind === 'charge') {
    /* The plan comes from the charge in the database; one that disagrees is a caller bug. */
    const rows = await tx.execute<{ plan: string }>(sql`
      SELECT subscription_apply_paid_charge(${businessId}::uuid, ${a.reference}, ${expires}) AS plan
    `);
    if ([...rows][0]?.plan !== state.plan) {
      throw new Error(`charge ${a.reference} buys a different plan than the cycle being applied`);
    }
  } else {
    await tx.execute(sql`
      SELECT test_fixture_set_plan(${businessId}::uuid, ${state.plan}, ${expires})
    `);
  }
  await tx.execute(sql`
    UPDATE businesses SET
      plan_version_id = ${pin},
      cycle_started_at = ${cycleStarted},
      renewal_anchor_day = ${state.anchorDay},
      pending_plan = ${state.pendingPlan},
      -- A re-post of the identical cycle (origin 'keep') changes nothing commercially, so the
      -- interval stays with it; any other state without an interval is monthly.
      billing_interval = ${
        state.billingInterval ?? (state.origin === 'keep' ? sql`billing_interval` : 'monthly')
      },
      pending_billing_interval = ${
        state.nextInterval !== undefined
          ? state.nextInterval
          : state.keepPendingInterval
            ? sql`pending_billing_interval`
            : null
      },
      subscription_origin = ${
        state.origin === 'keep' ? sql`subscription_origin` : sql`${state.origin}`
      },
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
  return 'written';
}

/**
 * Record that the merchant asked for an upgrade the product sends to support review (OD-50,
 * migration 0213). The database function checks the facts itself (an active paid plan with a
 * future paid-through date, a dearer paid target) and freezes the plan and paid-through date the
 * request was made against; asking again for the same upgrade returns the same review. Returns
 * null when the database refuses the request (nothing to review), which changes nothing.
 */
export async function requestPlanReview(
  tx: TenantDb,
  businessId: string,
  plan: string,
): Promise<string | null> {
  try {
    /* A savepoint: a refusal must not abort the caller's transaction. */
    return await tx.transaction(async (sp) => {
      const rows = await sp.execute<{ id: string }>(
        sql`SELECT subscription_request_plan_review(${businessId}::uuid, ${plan}) AS id`,
      );
      return [...rows][0]?.id ?? null;
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code === '22023') return null;
    throw error;
  }
}

/** The business's open support review, if any (the merchant's billing page reads it). */
export async function openPlanReview(
  tx: TenantDb,
  businessId: string,
): Promise<{ id: string; fromPlan: string; toPlan: string; paidThrough: Date } | null> {
  const rows = await tx.execute<{
    id: string;
    from_plan: string;
    to_plan: string;
    paid_through: string;
  }>(sql`
    SELECT id, from_plan, to_plan, paid_through::text AS paid_through
    FROM plan_change_reviews
    WHERE business_id = ${businessId}::uuid AND status = 'open'
  `);
  const row = [...rows][0];
  return row
    ? {
        id: row.id,
        fromPlan: row.from_plan,
        toPlan: row.to_plan,
        paidThrough: new Date(row.paid_through),
      }
    : null;
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
     * stay retired). A renewal priced on an interval other than the one now
     * in force (a yearly switch chosen meanwhile) is never revived either. That depends on the statement order in the replacement
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
        AND (c.kind <> 'renewal'
          OR c.billing_interval IS NOT DISTINCT FROM COALESCE(b.pending_billing_interval, b.billing_interval))
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
 * Schedule a switch of billing interval for the next renewal (G-110, OWN-40).
 *
 * Nothing else moves: a merchant who paid for a month, or a year, keeps it, and the
 * other interval begins when the next cycle would. A year already paid for is never
 * shortened and a month is never stretched, and no credit or refund is invented
 * (the owner authorised none). Null undoes a pending switch.
 *
 * It is NOT a plan decision, so `plan_decided_at` is left alone: an open UPGRADE is
 * priced on the cycle it lands in and is unaffected, and bumping the decision time
 * would have made it stale and stranded the payment. Only an open RENEWAL is priced
 * on the interval, so a renewal charge priced on the interval this switch moves away
 * from is WITHDRAWN (superseded and abandoned, G-105): it is no longer handed out as
 * payable, the sweep raises a replacement at the right price, and a merchant who still
 * pays the old link gets exactly what it was priced for (an abandoned charge is not
 * stale). Abandoned also keeps it out of the undo's revival of stale charges.
 *
 * The business row is locked first, as every settlement does.
 */
export async function scheduleIntervalChange(
  tx: TenantDb,
  businessId: string,
  interval: BillingInterval | null,
): Promise<void> {
  await lockBusiness(tx, businessId);
  await tx.execute(sql`
    UPDATE businesses SET pending_billing_interval = ${interval}, updated_at = now()
    WHERE id = ${businessId}::uuid
  `);
  await tx.execute(sql`
    UPDATE subscription_charges c
    SET superseded_at = clock_timestamp(), abandoned_at = clock_timestamp(), updated_at = now()
    FROM businesses b
    WHERE b.id = ${businessId}::uuid AND c.business_id = b.id
      AND c.kind = 'renewal' AND c.status = 'pending' AND c.superseded_at IS NULL
      AND c.billing_interval IS DISTINCT FROM COALESCE(b.pending_billing_interval, b.billing_interval)
  `);
}

/**
 * Start the grace clock, once.
 *
 * Through `subscription_start_grace` (migration 0217): `payment_failed_at` is one of the guarded
 * cycle columns (0206), because CLEARING it keeps a paid plan running unpaid, so no runtime role
 * writes it directly. The function only ever sets it, from empty, for a paid business whose ended
 * cycle has a renewal open, to a time no earlier than that cycle's end and not in the future. It
 * is what lets the renewal sweep run on the application credential instead of settlement's
 * (OD-51.2).
 *
 * Already running is what makes a second failed attempt harmless: the seven days run from the
 * FIRST failure, so a card retried daily cannot push the deadline forward one day at a time and
 * keep a merchant in grace forever. Answers whether this call started it.
 */
export async function markRenewalFailed(
  tx: TenantDb,
  businessId: string,
  when: Date,
): Promise<boolean> {
  const rows = await tx.execute<{ started: boolean }>(sql`
    SELECT subscription_start_grace(${businessId}::uuid, ${when.toISOString()}::timestamptz)
      AS started
  `);
  return [...rows][0]?.started === true;
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
  /** The interval this charge buys (G-110); absent is monthly. */
  billingInterval?: BillingInterval;
  /**
   * The moment the opener priced it (OD-51, migration 0209): settlement recomputes the price at
   * this same instant. The database bounds it to the insert time; absent is the insert time.
   */
  pricedAt?: Date;
  /**
   * Where the opener's prices came from (OD-51.6, migration 0215): the plan catalogue or the
   * compiled constants. Recorded on the charge, so settlement re-prices it from the same source
   * whatever the settling process is set to; the database refuses a source other than the one in
   * force. Every production opener passes its own setting. Absent (fixtures), the charge names
   * none and is priced at settlement from the source in force then.
   */
  pricingSource?: 'catalogue' | 'constants';
  /**
   * The reference of the retired pending charge this one replaces (OD-51.7, migration 0214): the
   * new charge is the SAME intended purchase and takes that charge's `purchase_id`, so only one of
   * the two can ever be credited. Absent, the charge is a new purchase with its own identity.
   */
  replaces?: string;
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
       reference, period_start, period_end, billing_interval, created_at, priced_at, purchase_id,
       pricing_source)
    VALUES (
      ${charge.businessId}::uuid, ${charge.kind}, ${charge.plan ?? null},
      ${charge.packId ?? null}, ${charge.quantity ?? 1}, ${charge.amountK},
      ${charge.provider ?? 'paystack'}, ${charge.reference},
      ${charge.periodStart ? charge.periodStart.toISOString() : null}::timestamptz,
      ${charge.periodEnd ? charge.periodEnd.toISOString() : null}::timestamptz,
      ${charge.billingInterval ?? 'monthly'}, clock_timestamp(),
      COALESCE(${charge.pricedAt ? charge.pricedAt.toISOString() : null}::timestamptz,
               clock_timestamp()),
      COALESCE((SELECT prior.purchase_id FROM subscription_charges prior
                WHERE prior.business_id = ${charge.businessId}::uuid
                  AND prior.reference = ${charge.replaces ?? null}),
               gen_random_uuid()),
      ${charge.pricingSource ?? null})
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
  /** When the opener priced it (OD-51, 0209); settlement recomputes at this instant. Null before 0209. */
  pricedAt: Date | null;
  /** Paid (or pending) but its plan change was refused as stale (G-104): an operator reconciles it. */
  supersededAt: Date | null;
  /** Paid but its plan change was refused (OD-30): money received, nothing applied. Null otherwise. */
  unappliedAt: Date | null;
  /** What the provider verified it took (G-107). Above `amountK` is an overpayment; null if unrecorded. */
  paidAmountK: number | null;
  /** How much of `amountK` has been returned; the status is `refunded` only when all of it has (G-111). */
  refundedAmountK: number;
  /** The interval this charge buys (G-110). */
  billingInterval: BillingInterval;
  /** The Paystack checkout it was initialised with (G-102); null until the merchant starts paying. */
  checkoutUrl: string | null;
  /** OD-40: when Paystack says the payment happened (verified `paid_at`); null when not known. */
  providerPaidAt: Date | null;
  /** OD-40: when Paystack confirmed settlement; null until verified settlement evidence exists. */
  providerSettledAt: Date | null;
  /** OD-40: when Rekoda committed a pack's units (database time); null for a plan charge or before crediting. */
  unitsCreditedAt: Date | null;
  /** The intended purchase this charge belongs to (OD-51.7, 0214); a replacement shares it. */
  purchaseId: string;
  /** The source it was priced from (OD-51.6, 0215); null for a charge opened before it was recorded. */
  pricingSource: 'catalogue' | 'constants' | null;
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
  priced_at?: string | null;
  superseded_at: string | null;
  unapplied_at: string | null;
  paid_amount_k: string | number | null;
  refunded_amount_k: string | number | null;
  billing_interval: string | null;
  checkout_url: string | null;
  provider_paid_at: string | null;
  provider_settled_at: string | null;
  units_credited_at: string | null;
  purchase_id: string;
  pricing_source?: string | null;
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
  pricedAt: at(row.priced_at ?? null),
  supersededAt: at(row.superseded_at),
  unappliedAt: at(row.unapplied_at),
  paidAmountK: row.paid_amount_k === null ? null : Number(row.paid_amount_k),
  refundedAmountK: Number(row.refunded_amount_k ?? 0),
  billingInterval: intervalOf(row.billing_interval),
  checkoutUrl: row.checkout_url,
  providerPaidAt: at(row.provider_paid_at),
  providerSettledAt: at(row.provider_settled_at),
  unitsCreditedAt: at(row.units_credited_at),
  purchaseId: row.purchase_id,
  pricingSource:
    row.pricing_source === 'catalogue' || row.pricing_source === 'constants'
      ? row.pricing_source
      : null,
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
    | { kind: 'first_purchase'; periodStart: Date; plan: string; billingInterval?: BillingInterval }
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
                AND plan = ${match.plan}
                AND billing_interval = ${match.billingInterval ?? 'monthly'}`
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
    /** The amount the provider verified it took, for a paid settlement (G-107). */
    paidAmountK?: number | null;
    /**
     * OD-40: when the provider says the payment happened, from its verify response only;
     * null (or absent) when it gave none. Never the webhook's receipt time.
     */
    providerPaidAt?: Date | null;
    when: Date;
  },
): Promise<ChargeRow | null> {
  const stamp = settlement.when.toISOString();
  const providerPaidAt =
    settlement.status === 'paid' ? (settlement.providerPaidAt?.toISOString() ?? null) : null;
  const rows = await tx.execute<RawCharge>(sql`
    UPDATE subscription_charges SET
      status = ${settlement.status},
      provider_reference = COALESCE(${settlement.providerReference ?? null}, provider_reference),
      failure_reason = ${settlement.failureReason ?? null},
      paid_amount_k = CASE WHEN ${settlement.status} = 'paid'
                           THEN ${settlement.paidAmountK ?? null}::bigint ELSE paid_amount_k END,
      paid_at = CASE WHEN ${settlement.status} = 'paid' THEN ${stamp}::timestamptz ELSE paid_at END,
      provider_paid_at = COALESCE(provider_paid_at, ${providerPaidAt}::timestamptz),
      failed_at = CASE WHEN ${settlement.status} = 'failed' THEN ${stamp}::timestamptz ELSE failed_at END,
      updated_at = now()
    WHERE reference = ${settlement.reference} AND status = 'pending'
    RETURNING *
  `);
  const row = [...rows][0];
  return row ? shape(row) : null;
}

/**
 * Has this intended pack purchase already been credited by ANOTHER charge (OD-51.7, 0214)? A
 * replacement charge shares its purchase with the retired charge it replaced, and both links can be
 * paid: the first verified settlement grants the units, a later one must not. Call with the
 * business row locked, so two settlements of one purchase cannot both read "not yet".
 */
export async function purchaseCreditedElsewhere(
  tx: TenantDb,
  businessId: string,
  purchaseId: string,
  reference: string,
): Promise<boolean> {
  const rows = await tx.execute<{ reference: string }>(sql`
    SELECT reference FROM subscription_charges
    WHERE business_id = ${businessId}::uuid AND purchase_id = ${purchaseId}::uuid
      AND reference <> ${reference} AND units_credited_at IS NOT NULL
    LIMIT 1
  `);
  return rows.length > 0;
}

/**
 * A purchase was just credited: retire its other still-payable charges (OD-51.7), so the billing
 * page stops offering a link whose payment would be set aside, and buying the pack again opens a
 * new purchase. A payment already in flight on one is still recorded at settlement. Call with the
 * business row locked.
 */
export async function retirePurchaseSiblings(
  tx: TenantDb,
  businessId: string,
  purchaseId: string,
  reference: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE subscription_charges
    SET superseded_at = clock_timestamp(), abandoned_at = clock_timestamp(), updated_at = now()
    WHERE business_id = ${businessId}::uuid AND purchase_id = ${purchaseId}::uuid
      AND reference <> ${reference} AND status = 'pending' AND superseded_at IS NULL
  `);
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
    | { kind: 'first_purchase'; periodStart: Date; plan: string; billingInterval?: BillingInterval }
    | { kind: 'upgrade'; plan: string },
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
                AND (plan IS DISTINCT FROM ${match.plan}
                     OR billing_interval IS DISTINCT FROM ${match.billingInterval ?? 'monthly'})`
          : sql`AND plan = ${match.plan}`
      }
  `);
}

/**
 * Retire one pending charge that is no longer what this business would be asked to pay (OD-51): an
 * upgrade prorated on an earlier day, or a pack the catalogue has since repriced. Marked abandoned,
 * exactly as `retireAbandonedPending`, so a payment already in flight is still recorded and
 * re-priced at settlement. Returns whether a charge was retired. Call with the business row locked.
 */
export async function retirePendingCharge(
  tx: TenantDb,
  businessId: string,
  reference: string,
): Promise<boolean> {
  const rows = await tx.execute<{ reference: string }>(sql`
    UPDATE subscription_charges
    SET superseded_at = clock_timestamp(), abandoned_at = clock_timestamp(), updated_at = now()
    WHERE business_id = ${businessId}::uuid AND reference = ${reference}
      AND status = 'pending' AND superseded_at IS NULL
    RETURNING reference
  `);
  return rows.length > 0;
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
           renewal_anchor_day, payment_failed_at,
           billing_interval, pending_billing_interval
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

/** The dates and flags a payment record shows beyond `ChargeRow` (billing Slice A). */
export interface ChargeRecordRow {
  paidAt: Date | null;
  failedAt: Date | null;
  refundedAt: Date | null;
  abandonedAt: Date | null;
  currency: string;
  unappliedResolvedAt: Date | null;
  /** The cycle the payment actually bought, written at settlement (migration 0182). */
  appliedPeriodStart: Date | null;
  appliedPeriodEnd: Date | null;
  /** Why a paid charge was not applied (OD-30); never shown to a merchant as written. */
  unappliedReason: string | null;
  /** An upgrade that cost nothing: applied with no payment and no provider involved. */
  noCharge: boolean;
}

/** Record the cycle a settled charge actually bought. */
export async function markChargeApplied(
  tx: TenantDb,
  reference: string,
  start: Date,
  end: Date,
): Promise<void> {
  await tx.execute(sql`
    UPDATE subscription_charges
    SET applied_period_start = ${start.toISOString()}::timestamptz,
        applied_period_end = ${end.toISOString()}::timestamptz
    WHERE reference = ${reference} AND status = 'paid' AND unapplied_at IS NULL
  `);
}

/**
 * One charge by our reference with the payment-record extras, read under the tenant pin. A
 * reference belonging to another business reads as null: the `WHERE business_id` is the code
 * fence and RLS is the second.
 */
export async function chargeRecordByReference(
  tx: TenantDb,
  businessId: string,
  reference: string,
): Promise<(ChargeRow & ChargeRecordRow) | null> {
  const rows = await tx.execute<
    RawCharge & {
      paid_at: string | null;
      failed_at: string | null;
      refunded_at: string | null;
      abandoned_at: string | null;
      currency: string;
      unapplied_resolved_at: string | null;
      applied_period_start: string | null;
      applied_period_end: string | null;
      unapplied_reason: string | null;
      provider_reference: string | null;
    }
  >(sql`
    SELECT * FROM subscription_charges
    WHERE business_id = ${businessId}::uuid AND reference = ${reference}
  `);
  const row = [...rows][0];
  if (!row) return null;
  const at = (v: string | null): Date | null => (v === null ? null : new Date(v));
  return {
    ...shape(row),
    paidAt: at(row.paid_at),
    failedAt: at(row.failed_at),
    refundedAt: at(row.refunded_at),
    abandonedAt: at(row.abandoned_at),
    currency: row.currency,
    unappliedResolvedAt: at(row.unapplied_resolved_at),
    appliedPeriodStart: at(row.applied_period_start),
    appliedPeriodEnd: at(row.applied_period_end),
    unappliedReason: row.unapplied_reason,
    noCharge: row.provider_reference?.startsWith('no_charge:') ?? false,
  };
}

/** One charge by id, under the tenant pin. */
export async function chargeById(
  tx: TenantDb,
  businessId: string,
  chargeId: string,
): Promise<ChargeRow | null> {
  const rows = await tx.execute<RawCharge>(sql`
    SELECT * FROM subscription_charges
    WHERE business_id = ${businessId}::uuid AND id = ${chargeId}::uuid
  `);
  const row = [...rows][0];
  return row ? shape(row) : null;
}

/**
 * The merchant's sealed billing email (G-102, OWN-39), or null when none has been
 * given. Returned sealed: opening it is the caller's, at the one boundary that
 * needs the address.
 */
export async function billingEmailSealed(tx: TenantDb, businessId: string): Promise<string | null> {
  const rows = await tx.execute<{ billing_email_sealed: string | null }>(sql`
    SELECT billing_email_sealed FROM businesses WHERE id = ${businessId}::uuid
  `);
  return [...rows][0]?.billing_email_sealed ?? null;
}

/**
 * Keep a sealed billing email (G-102). The caller has validated and sealed it.
 *
 * The audit row records THAT it was set and whether it replaced one, never the
 * address: the trail is read by more people than the vault key.
 */
export async function setBillingEmailSealed(
  tx: TenantDb,
  businessId: string,
  sealed: string,
  when: Date,
): Promise<void> {
  const rows = await tx.execute<{ replaced: boolean }>(sql`
    UPDATE businesses AS b
    SET billing_email_sealed = ${sealed},
        billing_email_set_at = ${when.toISOString()}::timestamptz,
        billing_email_verified_at = NULL,
        billing_email_revision = b.billing_email_revision + 1,
        updated_at = now()
    FROM (SELECT billing_email_sealed IS NOT NULL AS replaced FROM businesses
          WHERE id = ${businessId}::uuid) AS previous
    WHERE b.id = ${businessId}::uuid
    RETURNING previous.replaced
  `);
  const replaced = [...rows][0]?.replaced ?? false;
  await tx.execute(sql`
    INSERT INTO audit_events
      (business_id, actor, entity, entity_id, action, new_value, source_type)
    VALUES (${businessId}::uuid, 'owner', 'business', ${businessId}, 'billing_email_set',
            ${JSON.stringify({ replaced })}::jsonb, 'dashboard')
  `);
}

/* ── checkout attempts (migration 0173, G-102, OWN-50) ──────────────────────── */

export type AttemptStatus =
  'initializing' | 'active' | 'ambiguous' | 'superseded' | 'paid' | 'duplicate_paid' | 'failed';

/** The statuses that mean "this is the session the merchant is being sent to". */
export const LIVE_ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  'initializing',
  'active',
  'ambiguous',
];

export interface AttemptRow extends Record<string, unknown> {
  id: string;
  businessId: string;
  chargeId: string;
  attemptNo: number;
  providerReference: string;
  status: AttemptStatus;
  checkoutUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * The billing email's revision this session was started with (OWN-51), null for a
   * session that predates it. A session started for an address the merchant has since
   * replaced is not handed out again.
   */
  emailRevision: number | null;
  /** Whether a live provider key started this session; null for one that predates the column. */
  providerLive: boolean | null;
  /**
   * Milliseconds since the attempt last changed (opened, or its link stored),
   * measured by the DATABASE clock in the query that read it. Only `liveAttempt`
   * reads it; elsewhere it is 0. Never compare `updatedAt` with the server's
   * clock: the two machines' clocks are not the same clock.
   */
  idleMs: number;
}

interface RawAttempt extends Record<string, unknown> {
  id: string;
  business_id: string;
  charge_id: string;
  attempt_no: number;
  provider_reference: string;
  status: string;
  checkout_url: string | null;
  created_at: string;
  updated_at: string;
  email_revision?: number | null;
  provider_live?: boolean | null;
  idle_ms?: string | number | null;
}

const shapeAttempt = (row: RawAttempt): AttemptRow => ({
  id: row.id,
  businessId: row.business_id,
  chargeId: row.charge_id,
  attemptNo: Number(row.attempt_no),
  providerReference: row.provider_reference,
  status: row.status as AttemptStatus,
  checkoutUrl: row.checkout_url,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
  emailRevision: row.email_revision == null ? null : Number(row.email_revision),
  providerLive: row.provider_live ?? null,
  idleMs: row.idle_ms == null ? 0 : Math.max(0, Number(row.idle_ms)),
});

/**
 * Take the charge's row lock and return the charge.
 *
 * Every decision about a charge's checkout attempts is made holding this lock,
 * so two requests for one charge (two tabs, a retry racing a replacement) are
 * decided one after the other and the second sees what the first did.
 */
export async function lockChargeByReference(
  tx: TenantDb,
  businessId: string,
  reference: string,
): Promise<ChargeRow | null> {
  const rows = await tx.execute<RawCharge>(sql`
    SELECT * FROM subscription_charges
    WHERE business_id = ${businessId}::uuid AND reference = ${reference}
    FOR UPDATE
  `);
  const row = [...rows][0];
  return row ? shape(row) : null;
}

/** The charge's live attempt, if it has one. */
export async function liveAttempt(
  tx: TenantDb,
  businessId: string,
  chargeId: string,
): Promise<AttemptRow | null> {
  const rows = await tx.execute<RawAttempt>(sql`
    SELECT *, (extract(epoch FROM (clock_timestamp() - updated_at)) * 1000)::bigint AS idle_ms
    FROM subscription_charge_attempts
    WHERE business_id = ${businessId}::uuid AND charge_id = ${chargeId}::uuid
      AND status IN ('initializing', 'active', 'ambiguous')
  `);
  const row = [...rows][0];
  return row ? shapeAttempt(row) : null;
}

/** An attempt by the reference the provider knows it by, under the tenant pin. */
export async function attemptByProviderReference(
  tx: TenantDb,
  businessId: string,
  providerReference: string,
): Promise<AttemptRow | null> {
  const rows = await tx.execute<RawAttempt>(sql`
    SELECT * FROM subscription_charge_attempts
    WHERE business_id = ${businessId}::uuid AND provider_reference = ${providerReference}
  `);
  const row = [...rows][0];
  return row ? shapeAttempt(row) : null;
}

/** The attempt that settled a charge, if one did. */
export async function paidAttempt(
  tx: TenantDb,
  businessId: string,
  chargeId: string,
): Promise<AttemptRow | null> {
  const rows = await tx.execute<RawAttempt>(sql`
    SELECT * FROM subscription_charge_attempts
    WHERE business_id = ${businessId}::uuid AND charge_id = ${chargeId}::uuid
      AND status = 'paid'
  `);
  const row = [...rows][0];
  return row ? shapeAttempt(row) : null;
}

/** Has the charge had a session replaced by a newer one (one that might still be paid)? */
export async function hasSupersededAttempt(
  tx: TenantDb,
  businessId: string,
  chargeId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ found: number }>(sql`
    SELECT 1 AS found FROM subscription_charge_attempts
    WHERE business_id = ${businessId}::uuid AND charge_id = ${chargeId}::uuid
      AND status = 'superseded'
    LIMIT 1
  `);
  return [...rows].length === 1;
}

/** The highest attempt number the charge has used (0 when it has none). */
export async function latestAttemptNo(
  tx: TenantDb,
  businessId: string,
  chargeId: string,
): Promise<number> {
  const rows = await tx.execute<{ n: number | null }>(sql`
    SELECT max(attempt_no) AS n FROM subscription_charge_attempts
    WHERE business_id = ${businessId}::uuid AND charge_id = ${chargeId}::uuid
  `);
  return Number([...rows][0]?.n ?? 0);
}

/**
 * Open a charge's next attempt, status `initializing`. Null when the charge
 * already has a live attempt or that number or reference is already taken:
 * the partial unique indexes are what make two concurrent openers safe, and the
 * caller treats null as "someone else got there first".
 */
export async function openAttempt(
  tx: TenantDb,
  input: {
    businessId: string;
    chargeId: string;
    attemptNo: number;
    providerReference: string;
    /** False for a session adopted from before attempts existed: its address is unknown. */
    bindEmail?: boolean;
    /** Whether the provider key starting this session is a live one; omitted for an adopted session. */
    providerLive?: boolean;
  },
): Promise<AttemptRow | null> {
  const bind = input.bindEmail !== false;
  const rows = await tx.execute<RawAttempt>(sql`
    INSERT INTO subscription_charge_attempts
      (business_id, charge_id, attempt_no, provider_reference, status, email_revision, provider_live)
    SELECT ${input.businessId}::uuid, ${input.chargeId}::uuid, ${input.attemptNo},
           ${input.providerReference}, 'initializing',
           CASE WHEN ${bind} THEN b.billing_email_revision END,
           ${input.providerLive ?? null}::boolean
    FROM businesses b WHERE b.id = ${input.businessId}::uuid
    ON CONFLICT DO NOTHING
    RETURNING *
  `);
  const row = [...rows][0];
  return row ? shapeAttempt(row) : null;
}

/**
 * Move an attempt to a new status, only from one of the statuses it is
 * expected to be in. Null when it was not (someone else moved it first): the
 * `from` list is the compare-and-set that keeps a slow request from
 * overwriting a decision made while it waited.
 */
export async function moveAttempt(
  tx: TenantDb,
  businessId: string,
  attemptId: string,
  from: readonly AttemptStatus[],
  to: AttemptStatus,
): Promise<AttemptRow | null> {
  const rows = await tx.execute<RawAttempt>(sql`
    UPDATE subscription_charge_attempts
    SET status = ${to}, updated_at = now()
    WHERE business_id = ${businessId}::uuid AND id = ${attemptId}::uuid
      AND status IN (${sql.join(
        from.map((f) => sql`${f}`),
        sql`, `,
      )})
    RETURNING *
  `);
  const row = [...rows][0];
  return row ? shapeAttempt(row) : null;
}

/**
 * Every live attempt of a charge, other than the one named, retired as
 * `superseded`. Called when a charge is settled: the sessions the merchant did
 * not pay with must stop being presented, and a later payment on one is a
 * duplicate to refund rather than a second entitlement.
 */
export async function supersedeOtherLiveAttempts(
  tx: TenantDb,
  businessId: string,
  chargeId: string,
  keepAttemptId: string | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE subscription_charge_attempts
    SET status = 'superseded', updated_at = now()
    WHERE business_id = ${businessId}::uuid AND charge_id = ${chargeId}::uuid
      AND status IN ('initializing', 'active', 'ambiguous')
      AND (${keepAttemptId}::uuid IS NULL OR id <> ${keepAttemptId}::uuid)
  `);
}

/* ── proving the billing email's mailbox (migration 0174, G-102 slice 2b, OWN-51) ── */

export interface BillingEmailState {
  /** Counts every change of address; a mailed link and a checkout session are bound to it. */
  revision: number;
  /** The sealed address, null when none has been given. */
  sealed: string | null;
  /** When it was last set. A mailed link is bound to this instant. */
  setAt: Date | null;
  /** When its mailbox was proven, null when it has not been (or the address has changed since). */
  verifiedAt: Date | null;
}

export async function billingEmailState(
  tx: TenantDb,
  businessId: string,
): Promise<BillingEmailState> {
  const rows = await tx.execute<{
    sealed: string | null;
    set_at: string | null;
    verified_at: string | null;
    revision: number;
  }>(sql`
    SELECT billing_email_sealed AS sealed, billing_email_set_at AS set_at,
           billing_email_revision AS revision,
           billing_email_verified_at AS verified_at
    FROM businesses WHERE id = ${businessId}::uuid
  `);
  const row = [...rows][0];
  return {
    revision: Number(row?.revision ?? 0),
    sealed: row?.sealed ?? null,
    setAt: at(row?.set_at ?? null),
    verifiedAt: at(row?.verified_at ?? null),
  };
}

/**
 * How many links were requested for this business in the last hour, and how long
 * ago the latest was. Both measured by the DATABASE clock in one query, so the
 * rate limit never compares this server's clock with a stored timestamp.
 */
export async function recentEmailVerificationRequests(
  tx: TenantDb,
  businessId: string,
): Promise<{ lastHour: number; sinceLatestMs: number | null; latestRevision: number | null }> {
  const rows = await tx.execute<{
    n: number;
    since_ms: string | number | null;
    latest_revision: number | null;
  }>(sql`
    SELECT count(*) FILTER (WHERE created_at > clock_timestamp() - interval '1 hour')::int AS n,
           (extract(epoch FROM (clock_timestamp() - max(created_at))) * 1000)::bigint AS since_ms,
           (array_agg(email_revision ORDER BY created_at DESC))[1] AS latest_revision
    FROM billing_email_verifications
    WHERE business_id = ${businessId}::uuid AND voided_at IS NULL
  `);
  const row = [...rows][0];
  return {
    lastHour: Number(row?.n ?? 0),
    sinceLatestMs: row?.since_ms == null ? null : Math.max(0, Number(row.since_ms)),
    /* The address revision the business's own latest link was issued for (SUB-02a). */
    latestRevision: row?.latest_revision == null ? null : Number(row.latest_revision),
  };
}

/**
 * Record one mailed link. Only the token's hash is kept. The link is bound to the
 * address it was mailed to by the business's `billing_email_revision` as it stands
 * now; the caller holds the business lock, so it cannot change underneath.
 */
export async function issueEmailVerification(
  tx: TenantDb,
  input: { businessId: string; tokenHash: string; ttlMs: number },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO billing_email_verifications
      (business_id, token_hash, email_revision, created_at, expires_at)
    SELECT b.id, ${input.tokenHash}, b.billing_email_revision, clock_timestamp(),
           clock_timestamp() + make_interval(secs => ${input.ttlMs / 1000})
    FROM businesses b
    WHERE b.id = ${input.businessId}::uuid AND b.billing_email_set_at IS NOT NULL
    RETURNING id
  `);
  if ([...rows].length === 0) return false;
  await tx.execute(sql`
    INSERT INTO audit_events
      (business_id, actor, entity, entity_id, action, new_value, source_type)
    VALUES (${input.businessId}::uuid, 'owner', 'business', ${input.businessId},
            'billing_email_verification_requested', '{}'::jsonb, 'dashboard')
  `);
  return true;
}

/** Take back a link that could not be mailed, so a failed send does not use up the merchant's allowance. */
export async function voidEmailVerification(
  tx: TenantDb,
  businessId: string,
  tokenHash: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE billing_email_verifications
    SET consumed_at = clock_timestamp(), voided_at = clock_timestamp()
    WHERE business_id = ${businessId}::uuid AND token_hash = ${tokenHash} AND consumed_at IS NULL
  `);
}

/**
 * Decide one confirmation request for an address across every business, and count it when allowed
 * (SUB-02a, OWN-58; migration 0185). Runs inside the caller's tenant transaction, after the
 * business lock: the database function takes the address lock, counts by the database clock and
 * records the request, so the count and the link commit together. The application role cannot read
 * the counter itself; this is its only way in.
 */
export async function claimBillingEmailAddress(
  tx: TenantDb,
  addressKey: string,
  limits: { maxPerHour: number; cooldownMs: number },
): Promise<{ requestId: string } | { requestId: null; retryAfterSeconds: number }> {
  const rows = await tx.execute<{ request_id: string | null; retry_after_seconds: number }>(sql`
    SELECT request_id, retry_after_seconds
    FROM billing_email_address_claim(${addressKey}, ${limits.maxPerHour}::int, ${limits.cooldownMs}::int)
  `);
  const row = [...rows][0];
  if (!row) throw new Error('billing_email_address_claim returned no row');
  return row.request_id !== null
    ? { requestId: row.request_id }
    : { requestId: null, retryAfterSeconds: Number(row.retry_after_seconds) };
}

/**
 * The wait an address would impose right now, without counting a request (migration 0185). Used
 * when the business itself is refusing, so the reply carries the longer of the two waits.
 */
export async function billingEmailAddressWait(
  tx: TenantDb,
  addressKey: string,
  limits: { maxPerHour: number; cooldownMs: number },
): Promise<number> {
  const rows = await tx.execute<{ wait: number }>(sql`
    SELECT billing_email_address_wait(${addressKey}, ${limits.maxPerHour}::int, ${limits.cooldownMs}::int) AS wait
  `);
  return Number([...rows][0]?.wait ?? 0);
}

/** Give an address request back because the provider definitely refused the mail (OWN-66). */
export async function releaseBillingEmailAddress(
  tx: TenantDb,
  requestId: string,
  addressKey: string,
): Promise<void> {
  await tx.execute(sql`SELECT billing_email_address_release(${requestId}::uuid, ${addressKey})`);
}

/* ── operator email-address erasure (migration 0191, OD-39) ─────────────────── */

/** Why an operator erased an address: closed, so no free text can carry the address itself. */
export type EmailErasureReason = 'erasure_request' | 'limit_cleared';

/**
 * Remove one address's rows from the cross-business confirmation counter and write the receipt
 * (migration 0191). Takes the claim's address lock, so it never interleaves with a claim. The
 * application role cannot read the counter or the receipts; this function is its only way in.
 * Returns how many counter rows went (0 on a repeat).
 */
export async function eraseEmailAddressFromCounter(
  q: Db | TenantDb,
  input: {
    addressKey: string;
    operator: string;
    reason: EmailErasureReason;
    billingEmailCleared: boolean;
  },
): Promise<number> {
  const rows = await q.execute<{ removed: number }>(sql`
    SELECT email_address_erase(${input.addressKey}, ${input.operator}, ${input.reason},
                               ${input.billingEmailCleared}) AS removed
  `);
  return Number([...rows][0]?.removed ?? 0);
}

/**
 * Clear a business's billing email on an operator's erasure (OD-39), under the business row lock.
 * The caller has opened the sealed address and found it is the one being erased. The address goes,
 * its proof goes, and the revision moves on, which makes every link and checkout session bound to
 * the old address stale exactly as a change of address does; open links are voided as well. The
 * audit row says THAT it was erased and by whom, never the address. False when nothing was on file.
 */
export async function eraseBillingEmail(
  tx: TenantDb,
  businessId: string,
  actor: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE businesses AS b
    SET billing_email_sealed = NULL,
        billing_email_set_at = NULL,
        billing_email_verified_at = NULL,
        billing_email_revision = b.billing_email_revision + 1,
        updated_at = now()
    WHERE b.id = ${businessId}::uuid AND b.billing_email_sealed IS NOT NULL
    RETURNING b.id
  `);
  if ([...rows].length === 0) return false;
  await tx.execute(sql`
    UPDATE billing_email_verifications
    SET consumed_at = clock_timestamp(), voided_at = clock_timestamp()
    WHERE business_id = ${businessId}::uuid AND consumed_at IS NULL
  `);
  await tx.execute(sql`
    INSERT INTO audit_events
      (business_id, actor, entity, entity_id, action, new_value, source_type)
    VALUES (${businessId}::uuid, ${actor}, 'business', ${businessId}, 'billing_email_erased',
            ${JSON.stringify({ erased: true })}::jsonb, 'system')
  `);
  return true;
}

/** The sealed billing email under the business row lock, for an erasure to compare with. */
export async function billingEmailSealedForUpdate(
  tx: TenantDb,
  businessId: string,
): Promise<{ found: boolean; sealed: string | null }> {
  const rows = await tx.execute<{ billing_email_sealed: string | null }>(sql`
    SELECT billing_email_sealed FROM businesses WHERE id = ${businessId}::uuid FOR UPDATE
  `);
  const row = [...rows][0];
  return row ? { found: true, sealed: row.billing_email_sealed } : { found: false, sealed: null };
}

/** How a link's hand-over to the email provider ended (migration 0183). */
export type EmailSendOutcome = 'accepted' | 'uncertain';

/** Record the outcome of handing a link to the provider; a spent or voided link is left alone. */
export async function markEmailVerificationSend(
  tx: TenantDb,
  businessId: string,
  tokenHash: string,
  outcome: EmailSendOutcome,
): Promise<void> {
  await tx.execute(sql`
    UPDATE billing_email_verifications SET send_outcome = ${outcome}
    WHERE business_id = ${businessId}::uuid AND token_hash = ${tokenHash}
      AND consumed_at IS NULL AND voided_at IS NULL
  `);
}

/**
 * The newest link that could still work (not spent, not voided, not expired) and how its send
 * ended, so the page can say "we could not confirm the email was handed over" truthfully.
 */
export async function outstandingEmailLink(
  tx: TenantDb,
  businessId: string,
): Promise<{ sentAt: Date; outcome: EmailSendOutcome | null } | null> {
  const rows = await tx.execute<{ created_at: string; send_outcome: EmailSendOutcome | null }>(sql`
    SELECT v.created_at, v.send_outcome
    FROM billing_email_verifications v
    JOIN businesses b ON b.id = v.business_id
    WHERE v.business_id = ${businessId}::uuid
      AND v.consumed_at IS NULL AND v.voided_at IS NULL
      AND v.expires_at > clock_timestamp()
      AND v.email_revision = b.billing_email_revision
    ORDER BY v.created_at DESC
    LIMIT 1
  `);
  const row = [...rows][0];
  return row ? { sentAt: new Date(row.created_at), outcome: row.send_outcome } : null;
}

export type EmailVerificationOutcome = 'verified' | 'invalid' | 'expired' | 'address_changed';

/**
 * Spend a link. Works once, only before it expires, only for the address it was
 * mailed to, and only for the business whose session presents it. Everything but
 * a fresh, matching link is refused without saying which of the others it was,
 * except "expired" and "address changed", which the merchant can act on.
 * The caller holds the business lock.
 */
export async function confirmEmailVerification(
  tx: TenantDb,
  businessId: string,
  tokenHash: string,
): Promise<EmailVerificationOutcome> {
  const rows = await tx.execute<{
    id: string;
    consumed: boolean;
    expired: boolean;
    same_address: boolean;
  }>(sql`
    SELECT v.id, v.consumed_at IS NOT NULL AS consumed,
           v.expires_at <= clock_timestamp() AS expired,
           v.email_revision = b.billing_email_revision AS same_address
    FROM billing_email_verifications v
    JOIN businesses b ON b.id = v.business_id
    WHERE v.business_id = ${businessId}::uuid AND v.token_hash = ${tokenHash}
  `);
  const row = [...rows][0];
  if (!row || row.consumed) return 'invalid';
  if (row.expired) return 'expired';
  if (!row.same_address) return 'address_changed';
  /* Every outstanding link is spent with it: one proof is enough. */
  await tx.execute(sql`
    UPDATE billing_email_verifications SET consumed_at = clock_timestamp()
    WHERE business_id = ${businessId}::uuid AND consumed_at IS NULL
  `);
  await tx.execute(sql`
    UPDATE businesses SET billing_email_verified_at = clock_timestamp(), updated_at = now()
    WHERE id = ${businessId}::uuid
  `);
  await tx.execute(sql`
    INSERT INTO audit_events
      (business_id, actor, entity, entity_id, action, new_value, source_type)
    VALUES (${businessId}::uuid, 'owner', 'business', ${businessId},
            'billing_email_verified', '{}'::jsonb, 'dashboard')
  `);
  return 'verified';
}

/**
 * Remember the checkout an attempt was started with (G-102).
 *
 * Only an attempt still waiting for its link (`initializing`, or `ambiguous`
 * after a failed call that Paystack in fact honoured) can take it, and only
 * while the charge is still payable: not paid, failed or retired, and a plan
 * charge not made stale by a newer subscription decision (the same staleness
 * settlement applies, `decidedSince`). Null otherwise, and the caller hands out
 * no link. The link is mirrored onto the charge for the billing history.
 */
export async function recordAttemptCheckout(
  tx: TenantDb,
  businessId: string,
  attemptId: string,
  checkoutUrl: string,
  when: Date,
): Promise<string | null> {
  const rows = await tx.execute<{ checkout_url: string }>(sql`
    UPDATE subscription_charge_attempts a
    SET status = 'active', checkout_url = ${checkoutUrl}, updated_at = now()
    FROM subscription_charges c
    WHERE a.business_id = ${businessId}::uuid AND a.id = ${attemptId}::uuid
      AND a.status IN ('initializing', 'ambiguous')
      AND c.business_id = a.business_id AND c.id = a.charge_id
      AND c.status = 'pending' AND c.superseded_at IS NULL
      AND (c.plan IS NULL OR NOT EXISTS (
        SELECT 1 FROM businesses b
        WHERE b.id = c.business_id AND b.plan_decided_at IS NOT NULL
          AND b.plan_decided_at > c.created_at))
    RETURNING a.checkout_url
  `);
  const url = [...rows][0]?.checkout_url ?? null;
  if (url) {
    await tx.execute(sql`
      UPDATE subscription_charges c
      SET checkout_url = ${url},
          checkout_started_at = COALESCE(c.checkout_started_at, ${when.toISOString()}::timestamptz),
          updated_at = now()
      FROM subscription_charge_attempts a
      WHERE a.id = ${attemptId}::uuid AND c.id = a.charge_id AND c.business_id = ${businessId}::uuid
    `);
  }
  return url;
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
  /**
   * The interval the next cycle bills on: a scheduled switch, or the current one (G-110). Only
   * `dueForRenewalLocked` (read inside the business) fills it; the cross-tenant lists leave it
   * monthly and a caller that prices a cycle must re-read through the locked read.
   */
  nextInterval: BillingInterval;
}

interface RawDue extends Record<string, unknown> {
  id: string;
  plan: string;
  pending_plan: string | null;
  plan_expires_at: string;
  cycle_started_at: string | null;
  renewal_anchor_day: number | null;
  payment_failed_at: string | null;
  /** Only the tenant-pinned read (`dueForRenewalLocked`) selects these; the cross-tenant lists never do. */
  billing_interval?: string;
  pending_billing_interval?: string | null;
}

const due = (row: RawDue): DueBusiness => ({
  businessId: row.id,
  plan: row.plan,
  nextPlan: row.pending_plan ?? row.plan,
  renewsAt: new Date(row.plan_expires_at),
  cycleStartedAt: at(row.cycle_started_at),
  renewalAnchorDay: row.renewal_anchor_day,
  paymentFailedAt: at(row.payment_failed_at),
  nextInterval: intervalOf(row.pending_billing_interval ?? row.billing_interval),
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

export interface TrialBusiness {
  businessId: string;
  trialEndsAt: Date;
  /** The latest reminder attempt on record (OWN-47), if any. */
  attempt: {
    stage: number;
    state: 'sending' | 'sent' | 'unknown' | 'suppressed' | 'refused' | 'undelivered';
    at: Date;
  } | null;
}

/**
 * Businesses on a running trial that end within `withinDays` of `now` (G-109).
 *
 * This is the one cross-tenant read of the reminder sweep: ID-only scheduling discovery
 * (OD-33, ADR 0035 class 2), made ONLY through the dedicated `sweep_trial_candidates`
 * function (migration 0181; EXECUTE for the worker role alone). It returns the MINIMUM needed
 * to decide what is due: the id, the trial end and the latest attempt. No owner phone, name or
 * consent flag; those are read later, inside the tenant's own scope, only for a notice that
 * is about to be sent. Which stage a business is at is core's call (`trialNoticeDue`).
 * Keyset-paged by id.
 */
export async function trialsEndingWithin(
  db: Db,
  now: Date,
  withinDays: number,
  limit = 500,
  afterId: string | null = null,
): Promise<TrialBusiness[]> {
  const rows = await db.execute<{
    id: string;
    plan_expires_at: Date | string;
    last_trial_notice_stage: number | null;
    trial_notice_state:
      'sending' | 'sent' | 'unknown' | 'suppressed' | 'refused' | 'undelivered' | null;
    trial_notice_attempted_at: Date | string | null;
  }>(sql`
    SELECT id, plan_expires_at, last_trial_notice_stage, trial_notice_state, trial_notice_attempted_at
    FROM sweep_trial_candidates(
      ${now.toISOString()}::timestamptz, ${withinDays}::int, ${limit}::int, ${afterId}::uuid
    )
  `);
  return [...rows].map((row) => ({
    businessId: row.id,
    trialEndsAt: new Date(row.plan_expires_at),
    attempt:
      row.trial_notice_state !== null &&
      row.last_trial_notice_stage !== null &&
      row.trial_notice_attempted_at !== null
        ? {
            stage: row.last_trial_notice_stage,
            state: row.trial_notice_state,
            at: new Date(row.trial_notice_attempted_at),
          }
        : null,
  }));
}

/**
 * Claim a trial reminder stage and record the attempt as 'sending'. 'claimed' is returned
 * exactly once per stage to exactly one caller, and only while, AT CLAIM TIME, the business
 * is still on a trial that has not ended as of `asOf` and its owner has not opted out: a
 * page of 500 is processed over minutes, so what the listing saw may be stale. An opted-out
 * owner claims nothing, so the milestone is still owed if they opt back in.
 *
 * Isolation holds when called through `withBusiness()` on the application role (RLS pins
 * the tenant); it is not a guarantee of the function on its own.
 */
export async function claimTrialNotice(
  tx: TenantDb,
  businessId: string,
  stage: number,
  asOf: Date,
): Promise<'claimed' | 'opted_out' | 'not_claimed'> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE businesses
    SET last_trial_notice_stage = ${stage}, trial_notice_state = 'sending',
        trial_notice_attempted_at = now(), trial_notice_provider_message_id = NULL,
        trial_notice_failed_at = NULL, updated_at = now()
    WHERE id = ${businessId}::uuid
      AND plan = 'trial'
      AND plan_expires_at > ${asOf.toISOString()}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = businesses.owner_user_id AND u.opted_out_at IS NOT NULL
      )
      AND (last_trial_notice_stage IS NULL OR last_trial_notice_stage < ${stage})
    RETURNING id
  `);
  if ([...rows].length === 1) return 'claimed';
  const optedOut = await tx.execute<{ id: string }>(sql`
    SELECT b.id FROM businesses b JOIN users u ON u.id = b.owner_user_id
    WHERE b.id = ${businessId}::uuid AND u.opted_out_at IS NOT NULL
  `);
  return [...optedOut].length === 1 ? 'opted_out' : 'not_claimed';
}

/**
 * The final eligibility check, made immediately before the Meta request (OWN-56, owner
 * ruling 25 Oct 2026). One statement, no lock held afterwards: it re-reads the plan, the
 * trial end against the current clock and the owner's consent, and requires that this very
 * attempt is still the one 'sending' for `stage`.
 *
 * - still eligible: returns the owner's phone, read here (inside the tenant's scope) so the
 *   listing never carried it;
 * - no longer eligible: the attempt becomes 'suppressed' and the stage stays claimed, so it
 *   is never retried; returns 'suppressed';
 * - not this attempt any more (another pass or writer moved it): returns 'lost', send nothing.
 *
 * Once the Meta request begins an in-flight message cannot be recalled; this narrows the
 * race to the span between this statement's commit and the request, and does not close it.
 */
export async function finalizeTrialNoticeDispatch(
  tx: TenantDb,
  businessId: string,
  stage: number,
  asOf: Date,
): Promise<{ outcome: 'proceed'; ownerPhone: string } | { outcome: 'suppressed' | 'lost' }> {
  const rows = await tx.execute<{ ok: boolean; phone: string }>(sql`
    WITH cur AS (
      SELECT b.id,
             (b.plan = 'trial'
              AND b.plan_expires_at > ${asOf.toISOString()}::timestamptz
              AND u.opted_out_at IS NULL) AS ok,
             u.phone AS phone
      FROM businesses b JOIN users u ON u.id = b.owner_user_id
      WHERE b.id = ${businessId}::uuid
        AND b.last_trial_notice_stage = ${stage}
        AND b.trial_notice_state = 'sending'
      FOR UPDATE OF b
    )
    UPDATE businesses
    SET trial_notice_state = CASE WHEN cur.ok THEN businesses.trial_notice_state ELSE 'suppressed' END,
        updated_at = CASE WHEN cur.ok THEN businesses.updated_at ELSE now() END
    FROM cur
    WHERE businesses.id = cur.id
    RETURNING cur.ok AS ok, cur.phone AS phone
  `);
  const row = [...rows][0];
  if (!row) return { outcome: 'lost' };
  return row.ok ? { outcome: 'proceed', ownerPhone: row.phone } : { outcome: 'suppressed' };
}

/** The provider accepted the attempt for this stage. */
export async function markTrialNoticeSent(
  tx: TenantDb,
  businessId: string,
  stage: number,
  providerMessageId: string | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE businesses
    SET trial_notice_state = 'sent', trial_notice_provider_message_id = ${providerMessageId},
        updated_at = now()
    WHERE id = ${businessId}::uuid AND last_trial_notice_stage = ${stage}
      AND trial_notice_state = 'sending'
  `);
}

/**
 * The outcome of this stage's attempt cannot be told (timeout, dropped connection, or a
 * worker that died mid-send). The claim stays: the reminder is not resent. `olderThan`
 * (the stale-attempt rule) requires the attempt to have STARTED before that time, so an
 * attempt re-claimed after the listing was read is never mislabelled.
 */
export async function markTrialNoticeUnknown(
  tx: TenantDb,
  businessId: string,
  stage: number,
  olderThan?: Date,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE businesses
    SET trial_notice_state = 'unknown', updated_at = now()
    WHERE id = ${businessId}::uuid AND last_trial_notice_stage = ${stage}
      AND trial_notice_state = 'sending'
      ${olderThan === undefined ? sql`` : sql`AND trial_notice_attempted_at < ${olderThan.toISOString()}::timestamptz`}
    RETURNING id
  `);
  return [...rows].length === 1;
}

/**
 * The provider definitively rejected this stage's message with an error that will repeat
 * identically (a bad recipient, a wrong template). Nothing was sent. The stage stays
 * claimed as 'refused' so it is not hammered hourly; the next milestone is still owed.
 */
export async function markTrialNoticeRefused(
  tx: TenantDb,
  businessId: string,
  stage: number,
): Promise<void> {
  await tx.execute(sql`
    UPDATE businesses
    SET trial_notice_state = 'refused', updated_at = now()
    WHERE id = ${businessId}::uuid AND last_trial_notice_stage = ${stage}
      AND trial_notice_state = 'sending'
  `);
}

/**
 * Meta accepted this business's latest reminder and later reported its delivery as FAILED
 * (REM-01; migration 0186). Moves 'sent' to 'undelivered' only when the failed
 * receipt names THIS business's latest attempt (`providerMessageId` is the wamid Meta returned
 * for it), so a receipt for another business's message, an older stage or an unrelated message
 * changes nothing. The stage stays claimed: an undelivered stage is never resent, and the next
 * milestone is still owed. Idempotent: a duplicate receipt matches no row and returns 0.
 *
 * Isolation holds when called through `withBusiness()` on the application role (RLS pins
 * the tenant); the `id` predicate makes it explicit.
 */
export async function markTrialNoticeUndelivered(
  tx: TenantDb,
  businessId: string,
  providerMessageId: string,
  now: Date,
): Promise<number> {
  const rows = await tx.execute<{ moved: number }>(sql`
    WITH moved AS (
      UPDATE businesses
      SET trial_notice_state = 'undelivered',
          trial_notice_failed_at = ${now.toISOString()}::timestamptz, updated_at = now()
      WHERE id = ${businessId}::uuid
        AND trial_notice_provider_message_id = ${providerMessageId}
        -- 'unknown' is defensive: an unknown attempt never records a wamid, so only 'sent' matches today.
        AND trial_notice_state IN ('sent', 'unknown')
      RETURNING 1
    )
    SELECT count(*)::int AS moved FROM moved
  `);
  return Number([...rows][0]?.moved ?? 0);
}

/**
 * Give a claimed stage back after the provider DEFINITIVELY refused it, so the next pass
 * retries that stage only. Only an attempt still 'sending' is released.
 */
export async function releaseTrialNotice(
  tx: TenantDb,
  businessId: string,
  stage: number,
): Promise<void> {
  await tx.execute(sql`
    UPDATE businesses
    SET last_trial_notice_stage = ${stage - 1}, trial_notice_state = NULL,
        trial_notice_attempted_at = NULL, updated_at = now()
    WHERE id = ${businessId}::uuid AND last_trial_notice_stage = ${stage}
      AND trial_notice_state = 'sending'
  `);
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
 * The final eligibility check, immediately before a grace reminder is dispatched (SUB-03r).
 *
 * The sweep reads its page of businesses, then claims and sends row by row, so a renewal paid,
 * a plan expired or a STOP/START received in between would otherwise act on stale facts. This
 * reads them fresh, in the caller's transaction: 'send' only while the renewal is still unpaid
 * on a live paid plan and the owner has not opted out; 'opted-out' when the owner has (the day
 * stays claimed, they are not owed it tomorrow); 'ineligible' for anything else. No lock is held
 * across the Meta call; the residual in-flight race is the one the trial reminders state.
 */
export async function graceReminderEligibility(
  tx: TenantDb,
  businessId: string,
): Promise<'send' | 'opted-out' | 'ineligible'> {
  const rows = await tx.execute<{ opted_out_at: string | null }>(sql`
    SELECT u.opted_out_at
    FROM businesses b
    JOIN users u ON u.id = b.owner_user_id
    WHERE b.id = ${businessId}::uuid
      AND b.payment_failed_at IS NOT NULL
      AND b.plan NOT IN ('trial', 'expired')
  `);
  const row = [...rows][0];
  if (!row) return 'ineligible';
  return row.opted_out_at === null ? 'send' : 'opted-out';
}

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

  /* OD-37 (migration 0196): the lapse is written by the database function owned by
   * `rekoda_plan_writer`, with the same race-safe condition: still on `previous`, and still unpaid
   * (grace) or still cancelling. */
  const updated = await tx.execute<{ changed: boolean }>(sql`
    SELECT subscription_expire_plan(${businessId}::uuid, ${previous}, ${reason}) AS changed
  `);
  /* Somebody paid, or undid the cancel, between the read and the write.
   * Their plan stands. */
  if ([...updated][0]?.changed !== true) return null;

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

/* ── OWN-70: renewals raised while the payment could not be taken (migration 0195) ── */

export type RenewalBlockReason = 'awaiting_platform_confirmation' | 'payments_not_configured';

/**
 * Stamp a just-opened renewal charge as blocked: Rekoda cannot take its payment (the live key is
 * unconfirmed, or no usable key is configured). Records only: the charge stays pending, the grace
 * clock runs as for any renewal (OD-44 open), nothing is paid, no provider reference exists. Written
 * once, with an audit event, in the sweep's own transaction.
 */
export async function markRenewalBlocked(
  tx: TenantDb,
  businessId: string,
  reference: string,
  reason: RenewalBlockReason,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE subscription_charges
    SET blocked_at = now(), blocked_reason = ${reason}, updated_at = now()
    WHERE business_id = ${businessId}::uuid AND reference = ${reference}
      AND kind = 'renewal' AND status = 'pending' AND blocked_at IS NULL
    RETURNING id
  `);
  if ([...rows].length !== 1) return false;
  await tx.execute(sql`
    INSERT INTO audit_events (business_id, actor, entity, entity_id, action, new_value, source_type)
    VALUES (${businessId}::uuid, 'system:renewal_sweep', 'subscription_charge', ${reference},
            'renewal_blocked', ${JSON.stringify({ reason })}::jsonb, 'system')
  `);
  return true;
}

export interface BlockedRenewalRow {
  reference: string;
  businessId: string;
  plan: string | null;
  amountK: number;
  reason: RenewalBlockReason;
  blockedAt: Date;
  /** The business's plan and paid-to date now. */
  currentPlan: string;
  currentRenewsAt: Date | null;
}

const OPEN_BLOCKED = sql`c.blocked_at IS NOT NULL AND c.blocked_resolved_at IS NULL
  AND c.status = 'pending' AND c.superseded_at IS NULL`;

/** Open blocked renewals, oldest first, for the operator queue. Worker-credentialed, through the
 * fixed-column SECURITY DEFINER function `blocked_renewals_ops` (0195, ADR 0035 Amendment 2). */
export async function blockedRenewals(
  db: Db,
  limit = 50,
  /** Rows to pass over (a caller skipping ones it could not close and could not stamp). */
  offset = 0,
  /**
   * The closing pass's own start time. When given, the list is the close order: rows whose last
   * failed close is NULL or before this time, never-attempted first and then the longest-failed
   * (migration 0198). Omitted, it is the operator order, oldest block first.
   */
  notAttemptedSince: Date | null = null,
): Promise<BlockedRenewalRow[]> {
  const rows = await db.execute<{
    reference: string;
    business_id: string;
    plan: string | null;
    amount_k: string | number;
    blocked_reason: RenewalBlockReason;
    blocked_at: string;
    current_plan: string;
    current_renews_at: string | null;
  }>(
    sql`SELECT * FROM blocked_renewals_ops(${limit}, ${offset}, ${notAttemptedSince?.toISOString() ?? null}::timestamptz)`,
  );
  return [...rows].map((r) => ({
    reference: r.reference,
    businessId: r.business_id,
    plan: r.plan,
    amountK: Number(r.amount_k),
    reason: r.blocked_reason,
    blockedAt: new Date(r.blocked_at),
    currentPlan: r.current_plan,
    currentRenewsAt: at(r.current_renews_at),
  }));
}

/**
 * Record that closing this block failed, so the closing pass tries every other block first
 * (migration 0198). Only an open block is stamped. Returns whether a row was stamped.
 */
export async function noteBlockCloseFailed(
  tx: TenantDb,
  businessId: string,
  reference: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE subscription_charges SET blocked_close_failed_at = now()
    WHERE business_id = ${businessId}::uuid AND reference = ${reference}
      AND blocked_at IS NOT NULL AND blocked_resolved_at IS NULL
    RETURNING id
  `);
  return [...rows].length === 1;
}

/** The database's own clock, for a pass that must compare against rows it stamps. */
export async function databaseNow(db: Db): Promise<Date> {
  const rows = await db.execute<{ now: string | Date }>(sql`SELECT clock_timestamp() AS now`);
  return new Date([...rows][0]!.now);
}

/** How many blocked renewals are open: an approved operational count for the alert (OWN-70). */
export async function blockedRenewalCount(db: Db): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM subscription_charges c WHERE ${OPEN_BLOCKED}
  `);
  return [...rows][0]?.n ?? 0;
}

/** One open block in close order, with its exact keyset position (migration 0199). */
export interface BlockedRenewalCloseRow extends BlockedRenewalRow {
  /** `blocked_at` in microseconds since the epoch, exact (a JS Date would drop the microseconds). */
  blockedAtUs: string;
}

/**
 * The next batch of open blocks after the durable close cursor (migration 0199): keyset order
 * (blocked_at, reference). The position is read from the cursor row by the database; the caller
 * supplies only the batch size. Worker credential only.
 */
export async function blockedRenewalsCloseBatch(
  db: Db,
  limit: number,
): Promise<BlockedRenewalCloseRow[]> {
  const rows = await db.execute<{
    reference: string;
    business_id: string;
    plan: string | null;
    amount_k: string | number;
    blocked_reason: RenewalBlockReason;
    blocked_at: string;
    blocked_at_us: string | number;
    current_plan: string;
    current_renews_at: string | null;
  }>(sql`SELECT * FROM blocked_renewals_close_batch(${limit})`);
  return [...rows].map((r) => ({
    reference: r.reference,
    businessId: r.business_id,
    plan: r.plan,
    amountK: Number(r.amount_k),
    reason: r.blocked_reason,
    blockedAt: new Date(r.blocked_at),
    blockedAtUs: String(r.blocked_at_us),
    currentPlan: r.current_plan,
    currentRenewsAt: at(r.current_renews_at),
  }));
}

/** Claim the close cursor's lease (migration 0199). True when `owner` now holds it. */
export async function claimBlockCloseCursor(
  db: Db,
  owner: string,
  leaseSeconds: number,
): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(
    sql`SELECT renewal_block_close_claim(${owner}::uuid, ${leaseSeconds}) AS ok`,
  );
  return [...rows][0]?.ok === true;
}

/**
 * Renew the close cursor's lease while a pass is working (migration 0201): a compare-and-set on the
 * owner, called before every block the pass closes, so the lease outlives a slow but healthy batch
 * and expires only when the runner stops. False when `owner` no longer holds the lease: the pass
 * must stop at once.
 */
export async function heartbeatBlockCloseCursor(
  db: Db,
  owner: string,
  leaseSeconds: number,
): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(
    sql`SELECT renewal_block_close_heartbeat(${owner}::uuid, ${leaseSeconds}) AS ok`,
  );
  return [...rows][0]?.ok === true;
}

/**
 * Durably record a processed batch: the cursor moves to the batch's last key and the lease is
 * extended. False (nothing written) when `owner` no longer holds the lease.
 */
export async function advanceBlockCloseCursor(
  db: Db,
  owner: string,
  after: { blockedAtUs: string; reference: string },
  counts: { closed: number; failed: number },
  leaseSeconds: number,
): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(sql`
    SELECT renewal_block_close_advance(${owner}::uuid, ${after.blockedAtUs}::bigint,
      ${after.reference}, ${counts.closed}, ${counts.failed}, ${leaseSeconds}) AS ok
  `);
  return [...rows][0]?.ok === true;
}

/** End a pass; `wrapped` (the list was exhausted) moves the cursor back to the start. */
export async function finishBlockClosePass(
  db: Db,
  owner: string,
  wrapped: boolean,
): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(
    sql`SELECT renewal_block_close_finish(${owner}::uuid, ${wrapped}) AS ok`,
  );
  return [...rows][0]?.ok === true;
}

/** Give the lease back without moving the cursor (a pass that stopped on an error). */
export async function releaseBlockCloseCursor(
  db: Db,
  owner: string,
  /** Failures in the batch whose advance did not happen, so the ops alert still counts them. */
  unrecordedFailed = 0,
): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(
    sql`SELECT renewal_block_close_release(${owner}::uuid, ${unrecordedFailed}) AS ok`,
  );
  return [...rows][0]?.ok === true;
}

/** The close cursor's state: counts and times only, for the ops snapshot (migration 0199). */
export interface BlockCloseCursorStatus {
  positioned: boolean;
  leased: boolean;
  /** A lease that expired without a finish or a release: a pass died or could not give it back. */
  abandoned: boolean;
  /** An abandoned pass was taken over in the last 24 hours (keeps the stalled alert visible). */
  recentlyAbandoned: boolean;
  passesCompleted: number;
  passesAbandoned: number;
  /** Failures since the cursor last wrapped, and in the last complete cycle (null before one). */
  cycleFailed: number;
  lastCycleFailed: number | null;
  passClosed: number;
  passFailed: number;
  lastPassClosed: number | null;
  lastPassFailed: number | null;
  lastPassFinishedAt: Date | null;
  lastAdvancedAt: Date | null;
}

export async function blockCloseCursorStatus(db: Db): Promise<BlockCloseCursorStatus | null> {
  const rows = await db.execute<{
    positioned: boolean;
    leased: boolean;
    abandoned: boolean;
    recently_abandoned: boolean;
    passes_completed: string | number;
    passes_abandoned: string | number;
    cycle_failed: number;
    last_cycle_failed: number | null;
    pass_closed: number;
    pass_failed: number;
    last_pass_closed: number | null;
    last_pass_failed: number | null;
    last_pass_finished_at: string | null;
    last_advanced_at: string | null;
  }>(sql`SELECT * FROM renewal_block_close_status()`);
  const r = [...rows][0];
  if (!r) return null;
  return {
    positioned: r.positioned,
    leased: r.leased,
    abandoned: r.abandoned,
    recentlyAbandoned: r.recently_abandoned,
    passesCompleted: Number(r.passes_completed),
    passesAbandoned: Number(r.passes_abandoned),
    cycleFailed: r.cycle_failed,
    lastCycleFailed: r.last_cycle_failed,
    passClosed: r.pass_closed,
    passFailed: r.pass_failed,
    lastPassClosed: r.last_pass_closed,
    lastPassFailed: r.last_pass_failed,
    lastPassFinishedAt: at(r.last_pass_finished_at),
    lastAdvancedAt: at(r.last_advanced_at),
  };
}

/** An operator closes a blocked renewal with a written resolution. True when this call closed it. */
export async function resolveBlockedRenewal(
  tx: TenantDb,
  businessId: string,
  reference: string,
  resolution: string,
  actor: string,
  /** Who closed it: an operator through the route, or the sweep once the gate opens. */
  sourceType: 'operator' | 'system' = 'operator',
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE subscription_charges
    SET blocked_resolved_at = now(), blocked_resolved_by = ${actor},
        blocked_resolution = ${resolution}, updated_at = now()
    WHERE business_id = ${businessId}::uuid AND reference = ${reference}
      AND blocked_at IS NOT NULL AND blocked_resolved_at IS NULL
      AND status = 'pending' AND superseded_at IS NULL
    RETURNING id
  `);
  if ([...rows].length !== 1) return false;
  await tx.execute(sql`
    INSERT INTO audit_events (business_id, actor, entity, entity_id, action, new_value, source_type)
    VALUES (${businessId}::uuid, ${actor}, 'subscription_charge', ${reference},
            'renewal_block_resolved', ${JSON.stringify({ resolution })}::jsonb, ${sourceType})
  `);
  return true;
}

/**
 * OD-44: what a renewal that was blocked before it could be paid looks like now, for the job that
 * starts a fresh payment for it once the gate has opened. Read under the tenant pin; never locks
 * (the checkout service takes its own locks when it opens an attempt).
 */
export interface BlockedRenewalInitiationState {
  chargeId: string;
  kind: string;
  status: string;
  supersededAt: Date | null;
  periodStart: Date | null;
  blockedAt: Date | null;
  blockedResolvedAt: Date | null;
  blockedResolvedBy: string | null;
}

export async function blockedRenewalInitiationState(
  tx: TenantDb,
  businessId: string,
  reference: string,
): Promise<BlockedRenewalInitiationState | null> {
  const rows = await tx.execute<{
    id: string;
    kind: string;
    status: string;
    superseded_at: string | null;
    period_start: string | null;
    blocked_at: string | null;
    blocked_resolved_at: string | null;
    blocked_resolved_by: string | null;
  }>(sql`
    SELECT id, kind, status, superseded_at, period_start, blocked_at, blocked_resolved_at,
           blocked_resolved_by
    FROM subscription_charges
    WHERE business_id = ${businessId}::uuid AND reference = ${reference}
  `);
  const row = [...rows][0];
  if (!row) return null;
  return {
    chargeId: row.id,
    kind: row.kind,
    status: row.status,
    supersededAt: at(row.superseded_at),
    periodStart: at(row.period_start),
    blockedAt: at(row.blocked_at),
    blockedResolvedAt: at(row.blocked_resolved_at),
    blockedResolvedBy: row.blocked_resolved_by,
  };
}

/** The outcomes the OD-44 initiation job records. Fixed codes, never provider or error text. */
export type RenewalInitiationOutcome =
  | 'initiated'
  | 'existing_payment_link'
  | 'gate_closed'
  | 'not_eligible'
  | 'requires_billing_email'
  | 'requires_billing_email_verification'
  | 'unavailable'
  | 'provider_unreachable';

/**
 * Audit one run of the OD-44 initiation job. The detail carries fixed codes and Rekoda's own
 * references only: never the checkout link, the billing email or a provider message.
 */
export async function recordRenewalInitiation(
  tx: TenantDb,
  businessId: string,
  reference: string,
  outcome: RenewalInitiationOutcome,
  detail: { reason?: string; providerReference?: string } = {},
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO audit_events (business_id, actor, entity, entity_id, action, new_value, source_type)
    VALUES (${businessId}::uuid, 'system:renewal_initiate', 'subscription_charge', ${reference},
            'renewal_payment_initiation', ${JSON.stringify({ outcome, ...detail })}::jsonb,
            'system')
  `);
}
