/**
 * Self-service billing, above the storage and below the wire (ADR 0024).
 *
 * All arithmetic comes from `@rekoda/core/billing` and all state from
 * `subscriptionsRepo`. This file decides only which of the two to ask, which
 * is the whole reason it can be read in one sitting.
 *
 * Two rules hold everywhere here. Nothing charges a merchant for something
 * they cannot use, and nothing opens a charge that production is not able to
 * take money for: spec §47 keeps live Paystack behind a written confirmation,
 * and a pending charge opened before that would be a row somebody has to
 * remember to clean up.
 */
import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  addMonth,
  addOnReference,
  addOnPack,
  allowanceFor,
  billingState,
  GRACE_DAYS,
  packsFor,
  planChangeCharge,
  planPriceK,
  subscriptionReference,
  usagePeriod,
  USAGE_UNITS,
} from '@rekoda/core';
import type {
  BillingOverviewResponse,
  BillingPlanChangeResponse,
  BillingQuoteResponse,
  BillingStateView,
} from '@rekoda/contracts';
import { subscriptionsRepo, usageRepo, withBusiness, type Db, type TenantDb } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';

/** Midnight of the Lagos day (UTC+1, no DST) holding this moment. */
function startOfLagosDay(when: Date): Date {
  const shifted = when.getTime() + 3_600_000;
  return new Date(Math.floor(shifted / 86_400_000) * 86_400_000 - 3_600_000);
}

@Injectable()
export class BillingService {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
  ) {}

  /**
   * Everything the billing page shows, in one read.
   *
   * The plan comes from `planFor` rather than the raw column, so a lapsed
   * trial reads `expired` here exactly as it does at the metering gate. A
   * merchant whose allowances are all zero must not be shown a plan that
   * says otherwise.
   */
  async overview(businessId: string, now = new Date()): Promise<BillingOverviewResponse> {
    const period = usagePeriod(now);
    return withBusiness(this.db, businessId, async (tx) => {
      const plan = await usageRepo.planFor(tx, businessId, now);
      const subscription = await subscriptionsRepo.subscriptionFor(tx, businessId);
      const counters = await usageRepo.usageFor(tx, businessId, period);
      const charges = await subscriptionsRepo.chargesFor(tx, businessId);
      const chargeRows = charges.rows;

      const byUnit = new Map(counters.map((row) => [row.unit, row]));
      return {
        plan,
        priceK: planPriceK(plan),
        status: statusOf(plan, subscription, now),
        pendingPlan: subscription?.pendingPlan ?? null,
        period,
        units: USAGE_UNITS.map((unit) => ({
          unit,
          used: byUnit.get(unit)?.used ?? 0,
          allowance: allowanceFor(plan, unit),
          bonus: byUnit.get(unit)?.bonus ?? 0,
        })),
        packs: packsFor(plan).map((pack) => ({
          id: pack.id,
          label: pack.label,
          unit: pack.unit,
          quantity: pack.quantity,
          priceK: pack.priceK,
        })),
        chargesTotal: charges.count,
        charges: chargeRows.map((charge) => ({
          reference: charge.reference,
          kind: charge.kind as BillingOverviewResponse['charges'][number]['kind'],
          plan: charge.plan,
          packId: charge.packId,
          amountK: charge.amountK,
          status: charge.status as BillingOverviewResponse['charges'][number]['status'],
          periodStart: charge.periodStart?.toISOString() ?? null,
          periodEnd: charge.periodEnd?.toISOString() ?? null,
          createdAt: charge.createdAt.toISOString(),
        })),
      };
    });
  }

  /** What moving to `plan` costs today, and when it takes effect. */
  async quote(businessId: string, to: string, now = new Date()): Promise<BillingQuoteResponse> {
    return withBusiness(this.db, businessId, async (tx) => {
      const from = await usageRepo.planFor(tx, businessId, now);
      const subscription = await subscriptionsRepo.subscriptionFor(tx, businessId);
      const charge = planChangeCharge({
        from,
        to,
        /* A merchant with no cycle is a first purchase, and the two dates are
         * unused on that branch. Passing `now` for both keeps the shape whole
         * without inventing a cycle that never existed. */
        cycleStart: subscription?.cycleStartedAt ?? now,
        renewsAt: subscription?.planExpiresAt ?? addMonth(now),
        now,
      });
      return {
        from,
        to,
        kind: charge.kind,
        amountK: charge.amountK,
        effectiveFrom: charge.effectiveFrom,
        renewsAt: charge.renewsAt.toISOString(),
      };
    });
  }

  /**
   * Act on a plan change.
   *
   * A downgrade is recorded and waits, because ADR 0024 says the merchant
   * keeps what they paid for until it runs out. Anything that costs money
   * opens a pending charge and stops there: the plan does not move until a
   * provider has confirmed the payment, which is the same rule the merchant's
   * own payments already follow.
   */
  async changePlan(
    businessId: string,
    to: string,
    now = new Date(),
  ): Promise<BillingPlanChangeResponse> {
    return withBusiness(this.db, businessId, async (tx) => {
      const from = await usageRepo.planFor(tx, businessId, now);
      const subscription = await subscriptionsRepo.subscriptionFor(tx, businessId);
      const renewsAt = subscription?.planExpiresAt ?? addMonth(now);
      const charge = planChangeCharge({
        from,
        to,
        cycleStart: subscription?.cycleStartedAt ?? now,
        renewsAt,
        now,
      });

      if (charge.kind === 'downgrade' || charge.kind === 'same') {
        await subscriptionsRepo.schedulePlanChange(
          tx,
          businessId,
          charge.kind === 'same' ? null : to,
        );
        return {
          state: 'scheduled' as const,
          plan: to,
          effectiveAt: charge.renewsAt.toISOString(),
        };
      }

      /* §47. Refused BEFORE a charge exists, so lifting the gate leaves
       * nothing behind to reconcile. */
      if (!this.config.paystackPlatformConfirmed) {
        return { state: 'unavailable' as const, reason: 'awaiting_platform_confirmation' as const };
      }

      /* Day-truncated so the cycle unique index has something to hold: two
       * tabs confirming a first purchase used to mint two charges because
       * `now` differed by milliseconds. Anchored to the Lagos day, the
       * second INSERT conflicts and is handed the first one's reference. */
      const periodStart =
        charge.kind === 'first_purchase'
          ? startOfLagosDay(now)
          : (subscription?.cycleStartedAt ?? now);
      const reference = subscriptionReference(now, randomBytes);
      const opened = await subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: charge.kind === 'first_purchase' ? 'first_purchase' : 'upgrade',
        plan: to,
        amountK: charge.amountK,
        reference,
        periodStart,
        periodEnd: charge.renewsAt,
      });
      if (!opened) {
        const pending = await subscriptionsRepo.pendingCharge(
          tx,
          businessId,
          charge.kind === 'first_purchase'
            ? { kind: 'first_purchase', periodStart }
            : { kind: 'upgrade', plan: to },
        );
        if (pending) {
          return {
            state: 'payment_required' as const,
            reference: pending.reference,
            amountK: pending.amountK,
            plan: to,
          };
        }
        return { state: 'unavailable' as const, reason: 'no_cycle' as const };
      }
      return {
        state: 'payment_required' as const,
        reference,
        amountK: charge.amountK,
        plan: to,
      };
    });
  }

  /**
   * Open a charge for one add-on pack.
   *
   * `packsFor` decides eligibility rather than this method, so the rule that
   * a merchant cannot buy capacity a plan has no use for lives in one place
   * and is the same rule the page renders from.
   */
  async buyPack(
    businessId: string,
    packId: string,
    now = new Date(),
  ): Promise<
    | { state: 'payment_required'; reference: string; amountK: number }
    | { state: 'unavailable'; reason: string }
  > {
    const pack = addOnPack(packId);
    if (!pack) return { state: 'unavailable', reason: 'unknown_pack' };

    return withBusiness(this.db, businessId, async (tx) => {
      const plan = await usageRepo.planFor(tx, businessId, now);
      if (!packsFor(plan).some((candidate) => candidate.id === pack.id)) {
        return { state: 'unavailable' as const, reason: 'not_available_on_plan' };
      }
      if (!this.config.paystackPlatformConfirmed) {
        return { state: 'unavailable' as const, reason: 'awaiting_platform_confirmation' };
      }

      const reference = addOnReference(now, randomBytes);
      const opened = await subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'add_on',
        packId: pack.id,
        amountK: pack.priceK,
        reference,
      });
      if (!opened) {
        /* A pending charge for this very pack already exists; hand back its
         * link rather than minting a second payable. */
        const pending = await subscriptionsRepo.pendingCharge(tx, businessId, {
          kind: 'add_on',
          packId: pack.id,
        });
        if (pending) {
          return {
            state: 'payment_required' as const,
            reference: pending.reference,
            amountK: pending.amountK,
          };
        }
        return { state: 'unavailable' as const, reason: 'pack' };
      }
      return { state: 'payment_required' as const, reference, amountK: pack.priceK };
    });
  }
}

/**
 * Apply a charge the provider has confirmed.
 *
 * Exported as a function on a transaction rather than a service method
 * because its caller is the webhook path, which is already inside one: a plan
 * that moved without its charge settling, or a charge that settled without
 * the plan moving, are both worse than the payment failing outright.
 *
 * `settleCharge` returning null is a replayed webhook, and nothing happens.
 */
export async function applySettledCharge(
  tx: TenantDb,
  input: { businessId: string; reference: string; providerReference: string; when: Date },
): Promise<'applied' | 'already_settled'> {
  const charge = await subscriptionsRepo.settleCharge(tx, {
    reference: input.reference,
    status: 'paid',
    providerReference: input.providerReference,
    when: input.when,
  });
  if (!charge) return 'already_settled';

  if (charge.kind === 'add_on' && charge.packId) {
    const pack = addOnPack(charge.packId);
    if (pack) {
      await usageRepo.creditBonus(
        tx,
        input.businessId,
        usagePeriod(input.when),
        pack.unit,
        pack.quantity * charge.quantity,
      );
    }
    return 'applied';
  }

  if (charge.plan) {
    const subscription = await subscriptionsRepo.subscriptionFor(tx, input.businessId);

    /**
     * A first purchase resets the anchor to the day it was bought, and MUST.
     *
     * `renewal_anchor_day` survives an expiry, so a merchant who lapsed on a
     * 3rd-of-the-month cycle and came back on the 20th would inherit the 3rd:
     * `addMonth(20 Aug, 3)` is 3 September, and they would have paid a full
     * month for fourteen days. Only a renewal or an upgrade keeps the anchor,
     * because only those continue a cycle that already exists.
     */
    const lagosDay = new Date(input.when.getTime() + 3_600_000).getUTCDate();
    const anchorDay =
      charge.kind === 'first_purchase' ? lagosDay : (subscription?.renewalAnchorDay ?? lagosDay);

    /**
     * When the cycle being paid for STARTED, which is not when the payment
     * settled. A renewal paid three days late still bought the month that
     * began when the last one ended, and `plan_expires_at` still holds that
     * date at this moment. Getting it wrong would not move the renewal date,
     * which the anchor protects, but it would shorten the denominator a later
     * upgrade prorates against and overcharge for it.
     */
    const cycleStartedAt =
      charge.kind === 'upgrade'
        ? (subscription?.cycleStartedAt ?? input.when)
        : charge.kind === 'renewal'
          ? (subscription?.planExpiresAt ?? input.when)
          : input.when;

    const renewsAt =
      charge.kind === 'upgrade'
        ? (subscription?.planExpiresAt ?? addMonth(input.when, anchorDay))
        : addMonth(cycleStartedAt, anchorDay);

    await subscriptionsRepo.applyCycle(tx, input.businessId, {
      plan: charge.plan,
      cycleStartedAt,
      renewsAt,
      anchorDay,
      pendingPlan: null,
    });
  }
  return 'applied';
}

function statusOf(
  plan: string,
  subscription: { planExpiresAt: Date | null; paymentFailedAt: Date | null } | null,
  now: Date,
): BillingStateView {
  if (plan === 'trial') {
    return { state: 'trial', endsAt: subscription?.planExpiresAt?.toISOString() ?? null };
  }

  /**
   * `expired` is a state somebody ACTED into, either by letting a trial run
   * out or through the grace sweep. It outranks the arithmetic: once the plan
   * says expired, no clock reading can put the merchant back in grace.
   */
  if (plan === 'expired') {
    const since = subscription?.paymentFailedAt
      ? new Date(subscription.paymentFailedAt.getTime() + GRACE_DAYS * 86_400_000)
      : (subscription?.planExpiresAt ?? now);
    return { state: 'expired', since: since.toISOString() };
  }

  const state = billingState({
    renewsAt: subscription?.planExpiresAt ?? now,
    failedAt: subscription?.paymentFailedAt ?? null,
    now,
  });
  if (state.state === 'active') return { state: 'active', renewsAt: state.renewsAt.toISOString() };
  if (state.state === 'grace') {
    return { state: 'grace', endsAt: state.endsAt.toISOString(), daysLeft: state.daysLeft };
  }
  /* Grace has run out and the sweep has not caught up yet. Paid features
   * still work for the hour or so until it does, but telling a merchant they
   * are active would be reassuring them about something about to stop. */
  return { state: 'expired', since: state.since.toISOString() };
}
