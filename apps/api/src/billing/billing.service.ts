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
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  addInterval,
  addMonth,
  addOnReference,
  billingState,
  GRACE_DAYS,
  upgradeProrationEligibility,
  planChangeCharge,
  subscriptionReference,
  usagePeriod,
  USAGE_UNITS,
  type BillingInterval,
} from '@rekoda/core';
import {
  meterAllowances,
  packOffer,
  packsForBusiness,
  planPriceKFor,
  type PlanTermsConfig,
} from './plan-terms.js';
import type {
  BillingCancelResponse,
  BillingOverviewResponse,
  BillingIntervalResponse,
  BillingPlanChangeResponse,
  BillingQuoteResponse,
  BillingStateView,
} from '@rekoda/contracts';
import {
  addOnsRepo,
  subscriptionsRepo,
  usageRepo,
  withBusiness,
  type Db,
  type TenantDb,
} from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';

/** Midnight of the Lagos day (UTC+1, no DST) holding this moment. */
function startOfLagosDay(when: Date): Date {
  const shifted = when.getTime() + 3_600_000;
  return new Date(Math.floor(shifted / 86_400_000) * 86_400_000 - 3_600_000);
}

/** The plans a merchant can buy, in the order the billing page lists them. */
const SELLABLE_PLANS = ['chat', 'integrate', 'complete'] as const;

@Injectable()
export class BillingService {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
  ) {}

  /**
   * Annual billing cannot be NEWLY chosen until it is switched on (`annualBillingSales`), and
   * only from catalogue prices (OWN-40). A subscriber already on a year keeps it either way.
   */
  private refuseUnofferedAnnual(interval: BillingInterval): void {
    if (
      interval === 'annual' &&
      !(this.config.annualBillingSales && this.config.planCatalogueReads)
    ) {
      throw new BadRequestException('annual billing is not available yet');
    }
  }

  /**
   * The two prices a plan change is priced from, off the catalogue.
   *
   * `from` resolves through the grandfathering pin - what the merchant
   * actually pays today - and `to` deliberately does not: they are buying
   * the new plan NOW, so the version currently on sale is the one that
   * prices it (the pin belongs to the old plan, so the stale-pin rule
   * already answers this). Undefined on the constant path, where
   * `planChangeCharge` falls back to the pre-BL2 table.
   */
  private async changePricesK(
    tx: TenantDb,
    businessId: string,
    from: string,
    to: string,
    now: Date,
    interval: BillingInterval = 'monthly',
  ): Promise<{ from: number; to: number } | undefined> {
    if (!this.config.planCatalogueReads) return undefined;
    return {
      from: await planPriceKFor(this.config, tx, businessId, from, now),
      to: await planPriceKFor(this.config, tx, businessId, to, now, interval),
    };
  }

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
      const allowances = await meterAllowances(this.config, tx, businessId, plan, now);
      return {
        plan,
        priceK: await planPriceKFor(this.config, tx, businessId, plan, now),
        annualPriceK: await planPriceKFor(this.config, tx, businessId, plan, now, 'annual'),
        interval: subscription?.billingInterval ?? 'monthly',
        pendingInterval: subscription?.pendingBillingInterval ?? null,
        annualOffered: this.config.annualBillingSales && this.config.planCatalogueReads,
        planPrices: await Promise.all(
          SELLABLE_PLANS.map(async (id) => ({
            plan: id,
            monthlyK: await planPriceKFor(this.config, tx, businessId, id, now),
            annualK: await planPriceKFor(this.config, tx, businessId, id, now, 'annual'),
          })),
        ),
        status: statusOf(plan, subscription, now),
        pendingPlan: subscription?.pendingPlan ?? null,
        period,
        units: USAGE_UNITS.map((unit) => ({
          unit,
          used: byUnit.get(unit)?.used ?? 0,
          allowance: allowances[unit],
          bonus: byUnit.get(unit)?.bonus ?? 0,
        })),
        packs: (await packsForBusiness(this.config, tx, businessId, plan, now)).map((pack) => ({
          id: pack.id,
          label: pack.label,
          unit: pack.unit,
          quantity: pack.quantity,
          priceK: pack.priceK,
        })),
        /* What they hold, not what they could buy. A merchant paying
         * ₦25,000 a month for the API should see it named on the page they
         * go to when they wonder what they are paying for (PR-117). */
        addOns: (await addOnsRepo.heldBy(tx, businessId, now)).map((held) => ({
          addOnId: held.addOnId,
          name: held.name,
          startedAt: held.startedAt.toISOString(),
          endsAt: held.endsAt?.toISOString() ?? null,
        })),
        chargesTotal: charges.count,
        charges: await Promise.all(
          chargeRows.map(async (charge) => ({
            reference: charge.reference,
            kind: charge.kind as BillingOverviewResponse['charges'][number]['kind'],
            plan: charge.plan,
            packId: charge.packId,
            /* The version in force when it was bought, as settlement credits it. */
            packLabel: charge.packId
              ? ((await packOffer(this.config, tx, charge.packId, charge.createdAt))?.label ?? null)
              : null,
            amountK: charge.amountK,
            refundedAmountK: charge.refundedAmountK,
            status: charge.status as BillingOverviewResponse['charges'][number]['status'],
            periodStart: charge.periodStart?.toISOString() ?? null,
            periodEnd: charge.periodEnd?.toISOString() ?? null,
            interval: charge.billingInterval,
            createdAt: charge.createdAt.toISOString(),
          })),
        ),
      };
    });
  }

  /** What moving to `plan` costs today, and when it takes effect. */
  async quote(
    businessId: string,
    to: string,
    now = new Date(),
    requested: BillingInterval = 'monthly',
  ): Promise<BillingQuoteResponse> {
    return withBusiness(this.db, businessId, async (tx) => {
      const from = await usageRepo.planFor(tx, businessId, now);
      const subscription = await subscriptionsRepo.subscriptionFor(tx, businessId);
      const interval = intervalFor(from, subscription, requested);
      if (from === 'trial' || from === 'expired') this.refuseUnofferedAnnual(interval);
      const charge = planChangeCharge({
        interval,
        from,
        to,
        /* A merchant with no cycle is a first purchase, and the two dates are
         * unused on that branch. Passing `now` for both keeps the shape whole
         * without inventing a cycle that never existed. */
        cycleStart: subscription?.cycleStartedAt ?? now,
        renewsAt: subscription?.planExpiresAt ?? addMonth(now),
        now,
        pricesK: await this.changePricesK(
          tx,
          businessId,
          from,
          to,
          now,
          pricingIntervalFor(from, interval),
        ),
      });
      const supportReview = charge.kind === 'upgrade' && isCustomCycle(subscription);
      return {
        from,
        to,
        kind: charge.kind,
        amountK: supportReview ? 0 : charge.amountK,
        effectiveFrom: charge.effectiveFrom,
        renewsAt: charge.renewsAt.toISOString(),
        supportReview,
        interval,
      };
    });
  }

  /**
   * Cancel the subscription (fix-plan 5, H2a).
   *
   * A cancellation is a downgrade whose destination is nothing: the merchant
   * keeps every day they paid for, and at renewal the plan ends instead of
   * charging. It rides `pending_plan` exactly as a downgrade does, so the
   * renewal sweep is the single place plans move, and picking the current
   * plan again on the change table undoes it the same way it undoes a
   * downgrade. Trials are answered, not cancelled: a trial charges nothing
   * and ends by itself, and "cancelled" would imply a charge was averted.
   */
  async cancelPlan(businessId: string): Promise<BillingCancelResponse> {
    return withBusiness(this.db, businessId, async (tx) => {
      const subscription = await subscriptionsRepo.subscriptionFor(tx, businessId);
      const plan = subscription?.plan ?? 'trial';
      if (plan === 'expired') return { state: 'already_stopped' as const };
      if (plan === 'trial') {
        return {
          state: 'trial' as const,
          endsAt: subscription?.planExpiresAt?.toISOString() ?? null,
        };
      }
      /* A paid plan always carries an expiry; guard anyway rather than
       * promise a date that does not exist. */
      const endsAt = subscription?.planExpiresAt?.toISOString();
      if (!endsAt) return { state: 'already_stopped' as const };
      if (subscription?.pendingPlan === 'expired') {
        return { state: 'already_scheduled' as const, endsAt };
      }
      await subscriptionsRepo.schedulePlanChange(tx, businessId, 'expired');
      return { state: 'scheduled' as const, endsAt };
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
    requested: BillingInterval = 'monthly',
  ): Promise<BillingPlanChangeResponse> {
    return withBusiness(this.db, businessId, async (tx) => {
      /* G-104: lock the business row BEFORE reading the plan this charge is
       * priced against, so a concurrent operator move either finished (and is
       * read) or waits until this charge exists (and is then newer). */
      await subscriptionsRepo.lockBusiness(tx, businessId);
      const from = await usageRepo.planFor(tx, businessId, now);
      const subscription = await subscriptionsRepo.subscriptionFor(tx, businessId);
      const renewsAt = subscription?.planExpiresAt ?? addMonth(now);
      /* A first purchase chooses its interval; anything else keeps the cycle's. */
      const interval = intervalFor(from, subscription, requested);
      if (from === 'trial' || from === 'expired') this.refuseUnofferedAnnual(interval);
      const charge = planChangeCharge({
        interval,
        from,
        to,
        cycleStart: subscription?.cycleStartedAt ?? now,
        renewsAt,
        now,
        pricesK: await this.changePricesK(
          tx,
          businessId,
          from,
          to,
          now,
          pricingIntervalFor(from, interval),
        ),
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

      /* OWN-33 (G-115): an operator arrangement that is not a standard monthly
       * cycle is never prorated automatically. Nothing is opened or changed. */
      if (charge.kind === 'upgrade' && isCustomCycle(subscription)) {
        return { state: 'unavailable' as const, reason: 'support_review' as const };
      }

      /* An upgrade priced at nothing (G-105): under a day of the cycle left, or
       * a difference too small to prorate. A cycle that has ended (grace) is not
       * a free switch: the merchant has not paid for it. Within a live cycle the
       * switch happens now, through the same settlement every paid charge uses,
       * so the plan, the pins and the audit trail move exactly as they would
       * for a payment. No provider is involved, so the §47 gate does not apply. */
      if (charge.kind === 'upgrade' && charge.amountK === 0) {
        if (!subscription?.planExpiresAt || subscription.planExpiresAt <= now) {
          return { state: 'unavailable' as const, reason: 'cycle_ended' as const };
        }
        await subscriptionsRepo.retireStalePending(tx, businessId);
        await subscriptionsRepo.retireAbandonedPending(tx, businessId, {
          kind: 'upgrade',
          plan: to,
        });
        const reference = subscriptionReference(now, randomBytes);
        const free = await subscriptionsRepo.openCharge(tx, {
          businessId,
          kind: 'upgrade',
          plan: to,
          amountK: 0,
          reference,
          periodStart: subscription.cycleStartedAt ?? now,
          periodEnd: charge.renewsAt,
        });
        if (!free) return { state: 'unavailable' as const, reason: 'no_cycle' as const };
        await applySettledCharge(tx, {
          businessId,
          reference,
          /* Unique per charge: (provider, provider_reference) is globally unique. */
          providerReference: `no_charge:${reference}`,
          when: now,
          config: this.config,
        });
        return { state: 'applied' as const, plan: to };
      }

      /* §47. Refused BEFORE a charge exists, so lifting the gate leaves
       * nothing behind to reconcile. */
      if (!this.config.paystackPlatformConfirmed) {
        return { state: 'unavailable' as const, reason: 'awaiting_platform_confirmation' as const };
      }

      /* Only now, on the path that opens a charge: a scheduled change or an undo
       * (above) can revive a pending charge, so retiring earlier would flag a
       * charge that an undo is about to make current again. */
      await subscriptionsRepo.retireStalePending(tx, businessId);

      /* Day-truncated so the cycle unique index has something to hold: two
       * tabs confirming a first purchase used to mint two charges because
       * `now` differed by milliseconds. Anchored to the Lagos day, the
       * second INSERT conflicts and is handed the first one's reference. */
      const periodStart =
        charge.kind === 'first_purchase'
          ? startOfLagosDay(now)
          : (subscription?.cycleStartedAt ?? now);
      if (charge.kind === 'first_purchase') {
        /* The merchant picked a different plan the same day: the earlier link is
         * abandoned, so the new plan gets its own charge instead of being handed
         * the first plan's. */
        await subscriptionsRepo.retireAbandonedPending(tx, businessId, {
          kind: 'first_purchase',
          periodStart,
          plan: to,
          billingInterval: interval,
        });
      }
      const reference = subscriptionReference(now, randomBytes);
      const opened = await subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: charge.kind === 'first_purchase' ? 'first_purchase' : 'upgrade',
        plan: to,
        amountK: charge.amountK,
        reference,
        periodStart,
        periodEnd: charge.renewsAt,
        billingInterval: interval,
      });
      if (!opened) {
        const pending = await subscriptionsRepo.pendingCharge(
          tx,
          businessId,
          charge.kind === 'first_purchase'
            ? { kind: 'first_purchase', periodStart, plan: to, billingInterval: interval }
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
   * Switch between monthly and annual billing (OWN-40, G-110).
   *
   * Always at the next renewal: a month or a year already paid for is kept whole,
   * and nothing is credited, refunded or prorated, because the owner authorised none.
   * Choosing the interval already in force undoes a switch that was waiting. A trial or
   * lapsed plan has no cycle to switch; the interval is chosen when buying.
   */
  async switchInterval(
    businessId: string,
    interval: BillingInterval,
    now = new Date(),
  ): Promise<BillingIntervalResponse> {
    return withBusiness(this.db, businessId, async (tx) => {
      await subscriptionsRepo.lockBusiness(tx, businessId);
      const plan = await usageRepo.planFor(tx, businessId, now);
      const subscription = await subscriptionsRepo.subscriptionFor(tx, businessId);
      if (plan === 'trial' || plan === 'expired' || !subscription?.planExpiresAt) {
        return { state: 'unavailable' as const, reason: 'no_cycle' as const };
      }
      if (interval === subscription.billingInterval) {
        if (subscription.pendingBillingInterval === null) {
          return { state: 'unchanged' as const, interval };
        }
        await subscriptionsRepo.scheduleIntervalChange(tx, businessId, null);
        return { state: 'undone' as const, interval };
      }
      if (subscription.pendingBillingInterval === interval) {
        return {
          state: 'scheduled' as const,
          interval,
          effectiveAt: subscription.planExpiresAt.toISOString(),
        };
      }
      /* A cancelled plan has no next renewal to switch at; undoing a waiting switch (above) stays open. */
      if (subscription.pendingPlan === 'expired') {
        return { state: 'unavailable' as const, reason: 'cancelling' as const };
      }
      /* Only a NEW move to a year needs the sale switched on; undoing a switch away from one never does. */
      this.refuseUnofferedAnnual(interval);
      await subscriptionsRepo.scheduleIntervalChange(tx, businessId, interval);
      return {
        state: 'scheduled' as const,
        interval,
        effectiveAt: subscription.planExpiresAt.toISOString(),
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
    return withBusiness(this.db, businessId, async (tx) => {
      const pack = await packOffer(this.config, tx, packId, now);
      if (!pack) return { state: 'unavailable' as const, reason: 'unknown_pack' };
      const plan = await usageRepo.planFor(tx, businessId, now);
      const offered = await packsForBusiness(this.config, tx, businessId, plan, now);
      if (!offered.some((candidate) => candidate.id === pack.id)) {
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
 * `superseded` means the payment was recorded but its plan change was refused
 * because the subscription had been decided again since the charge opened.
 *
 * The business row is locked FIRST, before any charge is written (see
 * `subscriptionsRepo.lockBusiness`): retention locks business then charges,
 * and settlement used to lock them the other way round. `business_gone`
 * means retention deleted the business before this payment could land; the
 * money is the provider's and an operator's to reconcile (the caller logs the
 * reference, since the event and charge rows went with the business), not
 * something to apply to a tenant that no longer exists.
 */
export async function applySettledCharge(
  tx: TenantDb,
  input: {
    businessId: string;
    reference: string;
    providerReference: string;
    /** What the provider verified it took; recorded so an overpayment's excess is visible (G-107). */
    paidAmountK?: number;
    when: Date;
    config: PlanTermsConfig;
  },
): Promise<'applied' | 'already_settled' | 'business_gone' | 'superseded'> {
  if (!(await subscriptionsRepo.lockBusiness(tx, input.businessId))) return 'business_gone';

  const charge = await subscriptionsRepo.settleCharge(tx, {
    reference: input.reference,
    status: 'paid',
    providerReference: input.providerReference,
    ...(input.paidAmountK !== undefined ? { paidAmountK: input.paidAmountK } : {}),
    when: input.when,
  });
  if (!charge) return 'already_settled';

  if (charge.kind === 'add_on' && charge.packId) {
    /* The version in force when the charge was OPENED, not when the webhook
     * arrived: a pack repriced or resized between purchase and settlement
     * still credits exactly what was bought and paid for. */
    const pack = await packOffer(input.config, tx, charge.packId, charge.createdAt);
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
    /* PAYMENT TRUTH is already written: the charge is `paid`. Whether it still
     * BUYS anything is a separate question (G-104). A plan charge opened before
     * a newer subscription decision (an operator move, another settled charge,
     * a scheduled change) was priced against a state that is gone, and applying
     * it would overwrite that decision. The money stays recorded and the charge
     * is marked for an operator to reconcile; no refund is invented here. */
    if (await subscriptionsRepo.decidedSince(tx, input.businessId, input.reference)) {
      await subscriptionsRepo.markUnapplied(
        tx,
        input.reference,
        'subscription_decided_after_charge',
        input.when,
      );
      return 'superseded';
    }
    const subscription = await subscriptionsRepo.subscriptionFor(tx, input.businessId);

    /* An upgrade is priced against the REST of the cycle it was opened in. Paid
     * after that cycle's renewal date it would leave `plan_expires_at` in the
     * past and clear the grace clock, so the merchant would keep the higher plan
     * with nothing ever renewing it (OWN-29). The payment stays recorded and
     * goes to an operator; the plan does not move. */
    if (
      charge.kind === 'upgrade' &&
      subscription?.planExpiresAt &&
      subscription.planExpiresAt <= input.when
    ) {
      await subscriptionsRepo.markUnapplied(tx, input.reference, 'cycle_ended', input.when);
      return 'superseded';
    }

    /* OWN-34 (G-115): an upgrade charge opened before the origin rule existed
     * must not turn an operator-defined or unknown-origin cycle into a
     * provider one by settling; it uses the same rule as quote and changePlan. The money stays recorded for an operator. */
    if (charge.kind === 'upgrade' && (!subscription || isCustomCycle(subscription))) {
      await subscriptionsRepo.markUnapplied(tx, input.reference, 'support_review', input.when);
      return 'superseded';
    }

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

    /* The interval is fixed when the charge is OPENED (G-110): a first purchase or a
     * renewal buys exactly the cycle it was priced for, whatever has been scheduled
     * since. An upgrade keeps the cycle it lands in. */
    const interval =
      charge.kind === 'upgrade'
        ? (subscription?.billingInterval ?? 'monthly')
        : charge.billingInterval;
    const renewsAt =
      charge.kind === 'upgrade'
        ? (subscription?.planExpiresAt ?? addInterval(input.when, interval, anchorDay))
        : addInterval(cycleStartedAt, interval, anchorDay);

    const chosen =
      subscription?.pendingBillingInterval ?? subscription?.billingInterval ?? 'monthly';
    await subscriptionsRepo.applyCycle(tx, input.businessId, {
      plan: charge.plan,
      cycleStartedAt,
      renewsAt,
      anchorDay,
      pendingPlan: null,
      billingInterval: interval,
      /* An upgrade keeps the cycle it lands in, so a switch waiting for renewal waits on.
       * A renewal that buys the interval the merchant chose consumes the choice; one that
       * buys another (a link sent before they chose, paid after) leaves the chosen interval
       * waiting. The choice is the pending switch, or, when the merchant undid a switch,
       * the interval the cycle was already on. */
      ...(charge.kind === 'upgrade'
        ? { keepPendingInterval: true }
        : charge.kind === 'renewal'
          ? { nextInterval: chosen === charge.billingInterval ? null : chosen }
          : {}),
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

/**
 * OWN-33 (G-115): a subscription that cannot be shown to be a provider-bought
 * standard month is never prorated automatically (`upgradeProrationEligibility`).
 * No subscription row means a first purchase, which has no cycle to prorate.
 */
function isCustomCycle(
  subscription: {
    origin: 'provider' | 'operator' | null;
    cycleStartedAt: Date | null;
    planExpiresAt: Date | null;
  } | null,
): boolean {
  if (!subscription) return false;
  return upgradeProrationEligibility(subscription) === 'support_review';
}

/**
 * The interval a plan change is priced and recorded on (G-110). Only a first purchase
 * (no live paid cycle) chooses; a subscriber's change keeps the cycle's own interval,
 * and switching interval is its own scheduled action.
 */
function intervalFor(
  from: string,
  subscription: { billingInterval: BillingInterval } | null,
  requested: BillingInterval,
): BillingInterval {
  if (from === 'trial' || from === 'expired' || !subscription) return requested;
  return subscription.billingInterval;
}

/**
 * The interval a plan change is COMPARED at. Only a first purchase is priced on the
 * interval it chose; every other change compares the two plans' monthly prices, so a
 * downgrade from an annual cycle is not mistaken for an upgrade by comparing a year's
 * price with a month's (G-110).
 */
function pricingIntervalFor(from: string, interval: BillingInterval): BillingInterval {
  return from === 'trial' || from === 'expired' ? interval : 'monthly';
}
