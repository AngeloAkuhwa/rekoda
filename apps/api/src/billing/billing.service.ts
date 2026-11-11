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
  paymentRecordState,
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
  pricingSourceOf,
  termsOfCharge,
  type PlanTermsConfig,
} from './plan-terms.js';
import type {
  BillingCancelResponse,
  BillingOverviewResponse,
  BillingPaymentRecord,
  BillingIntervalResponse,
  BillingPlanChangeResponse,
  BillingQuoteResponse,
  BillingStateView,
} from '@rekoda/contracts';
import {
  addOnsRepo,
  deadJobsRepo,
  jobsRepo,
  subscriptionsRepo,
  usageRepo,
  withBusiness,
  type Db,
  type TenantDb,
} from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { chargeGate } from './paystack-key.js';
import { DB } from '../db/db.module.js';
import { JobKind } from '../jobs/queue.service.js';

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
    /**
     * `rekoda_app`. Since OD-51 (migration 0209) the API holds no settlement credential: it prices
     * and opens charges as the application, and settlement (the worker's `billing.process`)
     * verifies each price before it applies anything.
     */
    @Inject(DB) private readonly db: Db,
  ) {}

  /**
   * How long a zero-priced upgrade waits for the worker to apply it before answering `processing`
   * (OD-51): the upgrade is settled by the worker, which holds the settlement credential.
   */
  zeroChargeWaitMs = 4_000;

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
    return changePricesKFor(this.config, tx, businessId, from, to, now, interval);
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
      /* OWN-76: the oldest open dead billing job, if any, as a notice on this page. */
      const [stuck] = await deadJobsRepo.openForBusiness(tx, businessId, 'billing.process');
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
        processingIssue: stuck
          ? { since: stuck.openedAt.toISOString(), recovering: stuck.status === 'recovering' }
          : null,
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
            /* The checkout's own test for "replaced": stamped, or (plan charges) a newer
             * subscription decision the retirement sweep has not stamped yet. */
            superseded:
              charge.status === 'pending' &&
              (charge.supersededAt !== null ||
                (charge.plan !== null &&
                  (await subscriptionsRepo.decidedSince(tx, businessId, charge.reference)))),
            applied: charge.status === 'paid' && charge.unappliedAt === null,
            createdAt: charge.createdAt.toISOString(),
          })),
        ),
      };
    });
  }

  /**
   * One payment in full (billing Slice A). Null when the reference is not this business's own, so
   * the controller answers 404 for another tenant's payment exactly as for one that never existed.
   * Every field comes from the charge row; the state is core's `paymentRecordState`.
   */
  async paymentRecord(businessId: string, reference: string): Promise<BillingPaymentRecord | null> {
    return withBusiness(this.db, businessId, async (tx) => {
      const charge = await subscriptionsRepo.chargeRecordByReference(tx, businessId, reference);
      if (!charge) return null;
      const status = charge.status as BillingPaymentRecord['status'];
      const replaced =
        status === 'pending' &&
        (charge.supersededAt !== null ||
          charge.abandonedAt !== null ||
          (charge.plan !== null &&
            (await subscriptionsRepo.decidedSince(tx, businessId, charge.reference))));
      const unapplied = charge.unappliedAt !== null;
      const state = paymentRecordState({
        status,
        replaced,
        unapplied,
        amountK: charge.amountK,
        refundedAmountK: charge.refundedAmountK,
      });
      return {
        reference: charge.reference,
        kind: charge.kind as BillingPaymentRecord['kind'],
        state,
        status,
        plan: charge.plan,
        packId: charge.packId,
        packLabel: charge.packId
          ? ((await packOffer(this.config, tx, charge.packId, charge.createdAt))?.label ?? null)
          : null,
        quantity: charge.quantity,
        interval: charge.billingInterval,
        amountK: charge.amountK,
        paidAmountK: charge.paidAmountK,
        refundedAmountK: charge.refundedAmountK,
        currency: charge.currency,
        /* The cycle actually bought, or nothing: never the estimate made when the charge was
         * opened, and never for a charge that bought no cycle. */
        periodStart: charge.appliedPeriodStart?.toISOString() ?? null,
        periodEnd: charge.appliedPeriodEnd?.toISOString() ?? null,
        createdAt: charge.createdAt.toISOString(),
        paidAt: charge.paidAt?.toISOString() ?? null,
        providerPaidAt: charge.providerPaidAt?.toISOString() ?? null,
        providerSettledAt: charge.providerSettledAt?.toISOString() ?? null,
        unitsCreditedAt: charge.unitsCreditedAt?.toISOString() ?? null,
        failedAt: charge.failedAt?.toISOString() ?? null,
        refundedAt: charge.refundedAt?.toISOString() ?? null,
        /* A refund returns money; it does not un-apply a plan that took effect. */
        applied: (status === 'paid' || status === 'refunded') && !unapplied,
        reconciled: unapplied && charge.unappliedResolvedAt !== null,
        noCharge: charge.noCharge,
        notAppliedReason: unapplied ? notAppliedReason(charge.unappliedReason) : null,
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
    /* As the application (OD-51): a charge is opened pending with the instant it was priced, and
     * settlement re-prices it before applying anything. A zero-priced upgrade is queued to the
     * worker, which alone holds the settlement credential. */
    const decided = await withBusiness(this.db, businessId, async (tx) => {
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
       * cycle is never prorated automatically. No charge is opened and no plan changes. */
      if (charge.kind === 'upgrade' && isCustomCycle(subscription)) {
        /* OD-50 (0213): the request is recorded, so an operator can resolve exactly this upgrade
         * with the paid-through date kept. The database checks the facts itself; a request it
         * refuses (nothing to review) records nothing. No charge, no plan change. */
        await subscriptionsRepo.requestPlanReview(tx, businessId, to);
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
          pricedAt: now,
          pricingSource: pricingSourceOf(this.config),
        });
        if (!free) return { state: 'unavailable' as const, reason: 'no_cycle' as const };
        /* Settled by the worker (OD-51), in its own transaction, through the same settlement every
         * paid charge uses, after it has re-priced the charge to zero itself. One job per charge. */
        await jobsRepo.enqueue(tx, {
          businessId,
          kind: JobKind.ApplyNoChargeUpgrade,
          payload: { reference },
          singletonKey: `no-charge:${reference}`,
        });
        return { state: 'queued' as const, plan: to, reference };
      }

      /* §47, by key kind (paystack-key.ts): a live key waits for the written
       * confirmation, a test key does not, and a missing or unrecognised key
       * opens nothing. Refused BEFORE a charge exists, so lifting the gate
       * leaves nothing behind to reconcile. */
      const gate = chargeGate(this.config);
      if (!gate.ok) return { state: 'unavailable' as const, reason: gate.reason };

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
      const open = () =>
        subscriptionsRepo.openCharge(tx, {
          businessId,
          kind: charge.kind === 'first_purchase' ? 'first_purchase' : 'upgrade',
          plan: to,
          amountK: charge.amountK,
          reference,
          periodStart,
          periodEnd: charge.renewsAt,
          billingInterval: interval,
          pricedAt: now,
          pricingSource: pricingSourceOf(this.config),
        });
      let opened = await open();
      if (!opened) {
        const pending = await subscriptionsRepo.pendingCharge(
          tx,
          businessId,
          charge.kind === 'first_purchase'
            ? { kind: 'first_purchase', periodStart, plan: to, billingInterval: interval }
            : { kind: 'upgrade', plan: to },
        );
        /* Handed back only at the price just computed. One at another price (an upgrade prorated
         * on an earlier day, or one this code never opened, OD-51) is never shown as what the
         * merchant owes: it is retired and today's charge opened in its place. */
        if (pending && pending.amountK === charge.amountK) {
          return {
            state: 'payment_required' as const,
            reference: pending.reference,
            amountK: pending.amountK,
            plan: to,
          };
        }
        if (
          pending &&
          (await subscriptionsRepo.retirePendingCharge(tx, businessId, pending.reference))
        ) {
          opened = await open();
        }
        if (!opened) return { state: 'unavailable' as const, reason: 'no_cycle' as const };
      }
      return {
        state: 'payment_required' as const,
        reference,
        amountK: charge.amountK,
        plan: to,
      };
    });
    if (decided.state !== 'queued') return decided;
    return (await this.awaitNoCharge(businessId, decided.reference))
      ? { state: 'applied' as const, plan: decided.plan }
      : { state: 'processing' as const, plan: decided.plan };
  }

  /** Whether the worker applied a zero-priced upgrade within the wait (OD-51). */
  private async awaitNoCharge(businessId: string, reference: string): Promise<boolean> {
    const deadline = Date.now() + this.zeroChargeWaitMs;
    for (;;) {
      const charge = await withBusiness(this.db, businessId, (tx) =>
        subscriptionsRepo.chargeByReference(tx, businessId, reference),
      );
      if (charge && charge.status !== 'pending') return charge.unappliedAt === null;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
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
      /* A cancelled plan has no next renewal to switch at; undoing a waiting switch (above) stays open. */
      if (subscription.pendingPlan === 'expired') {
        return { state: 'unavailable' as const, reason: 'cancelling' as const };
      }
      if (subscription.pendingBillingInterval === interval) {
        return {
          state: 'scheduled' as const,
          interval,
          effectiveAt: subscription.planExpiresAt.toISOString(),
        };
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
    /* As the application (OD-51, migration 0209): the pack's price is re-checked by settlement
     * before any unit is credited. */
    return withBusiness(this.db, businessId, async (tx) => {
      const pack = await packOffer(this.config, tx, packId, now);
      if (!pack) return { state: 'unavailable' as const, reason: 'unknown_pack' };
      const plan = await usageRepo.planFor(tx, businessId, now);
      const offered = await packsForBusiness(this.config, tx, businessId, plan, now);
      if (!offered.some((candidate) => candidate.id === pack.id)) {
        return { state: 'unavailable' as const, reason: 'not_available_on_plan' };
      }
      /* §47, by key kind, exactly as a plan charge (paystack-key.ts). */
      const gate = chargeGate(this.config);
      if (!gate.ok) return { state: 'unavailable' as const, reason: gate.reason };

      const reference = addOnReference(now, randomBytes);
      /* `replaces` names the retired charge a new one stands in for (OD-51.7, 0214): the two are
       * one intended purchase, so whichever link is paid first credits the pack and the other is
       * set aside. A charge opened with nothing to replace is a new purchase. */
      const open = (replaces?: string) =>
        subscriptionsRepo.openCharge(tx, {
          businessId,
          kind: 'add_on',
          packId: pack.id,
          amountK: pack.priceK,
          reference,
          pricedAt: now,
          pricingSource: pricingSourceOf(this.config),
          ...(replaces ? { replaces } : {}),
        });
      let opened = await open();
      if (!opened) {
        /* A pending charge for this very pack already exists; hand back its link rather than
         * minting a second payable, but only at today's price. One at another price (the
         * catalogue repriced, or OD-51) is retired and today's charge opened in its place. */
        const pending = await subscriptionsRepo.pendingCharge(tx, businessId, {
          kind: 'add_on',
          packId: pack.id,
        });
        if (pending && pending.amountK === pack.priceK) {
          return {
            state: 'payment_required' as const,
            reference: pending.reference,
            amountK: pending.amountK,
          };
        }
        if (
          pending &&
          (await subscriptionsRepo.retirePendingCharge(tx, businessId, pending.reference))
        ) {
          opened = await open(pending.reference);
        }
        if (!opened) return { state: 'unavailable' as const, reason: 'pack' };
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
    /** OD-40: when the provider's verify response says the payment happened; null or absent when it gave none. */
    providerPaidAt?: Date | null;
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
    providerPaidAt: input.providerPaidAt ?? null,
    when: input.when,
  });
  if (!charge) return 'already_settled';

  /* OD-51.6 (0215): the charge is re-priced from the source it recorded when it was opened, so the
   * settling process's own setting cannot disagree with the opener's about what it cost. */
  const terms = termsOfCharge(input.config, charge);

  if (charge.kind === 'add_on' && charge.packId) {
    /* OD-51: the price is checked before anything is credited (see verifiedPriceRefusal). */
    const refused = await verifiedPriceRefusal(tx, terms, input.businessId, charge, null);
    if (refused) {
      await subscriptionsRepo.markUnapplied(tx, input.reference, refused, input.when);
      return 'superseded';
    }
    /* OD-51.7 (0214): one intended purchase is credited once. A replacement charge shares its
     * purchase with the retired charge it stood in for, and both links can be paid. The first
     * verified payment of the purchase grants the units; this one, arriving second, is real money
     * and stays recorded as paid, set aside for an operator to reconcile or refund. The business
     * row is locked (above), so two settlements of one purchase cannot both pass this check, and
     * the unique index on a credited purchase holds the rule whatever runs the settlement. */
    if (
      await subscriptionsRepo.purchaseCreditedElsewhere(
        tx,
        input.businessId,
        charge.purchaseId,
        input.reference,
      )
    ) {
      await subscriptionsRepo.markUnapplied(tx, input.reference, 'duplicate_purchase', input.when);
      return 'superseded';
    }
    /* The version in force when the charge was PRICED (the instant the price check above used),
     * not when the webhook arrived: a pack repriced or resized between purchase and settlement
     * still credits exactly what was bought and paid for. */
    const pack = await packOffer(terms, tx, charge.packId, charge.pricedAt ?? charge.createdAt);
    if (pack) {
      await usageRepo.creditBonus(
        tx,
        input.businessId,
        usagePeriod(input.when),
        pack.unit,
        pack.quantity * charge.quantity,
      );
      /* OD-40: the credit's own time, in the transaction that made it. A pack that could
       * not be resolved credited nothing and so records no credit time. */
      await subscriptionsRepo.markUnitsCredited(tx, input.businessId, input.reference);
      /* The purchase is complete: its other links are no longer offered as payable. */
      await subscriptionsRepo.retirePurchaseSiblings(
        tx,
        input.businessId,
        charge.purchaseId,
        input.reference,
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

    /* B3 (0206): a renewal or an upgrade buys the cycle it was priced for, read from the
     * charge's frozen period, not from the business columns a merchant's own scheduling (or a
     * stolen application credential) can move. A renewal must still start at the paid-to date;
     * an upgrade must still end at it. The provider writer refuses anything else, so this keeps
     * an honest stale payment out of an exception and in the operator queue. */
    const paidTo = subscription?.planExpiresAt?.getTime();
    if (
      (charge.kind === 'upgrade' && charge.periodEnd?.getTime() !== paidTo) ||
      (charge.kind === 'renewal' && charge.periodStart?.getTime() !== paidTo) ||
      ((charge.kind === 'upgrade' || charge.kind === 'renewal') && paidTo === undefined)
    ) {
      await subscriptionsRepo.markUnapplied(
        tx,
        input.reference,
        'subscription_decided_after_charge',
        input.when,
      );
      return 'superseded';
    }

    /* OWN-34 (G-115): an upgrade charge opened before the origin rule existed
     * must not turn an operator-defined or unknown-origin cycle into a
     * provider one by settling; it uses the same rule as quote and changePlan. The money stays recorded for an operator. */
    if (charge.kind === 'upgrade' && (!subscription || isCustomCycle(subscription))) {
      await subscriptionsRepo.markUnapplied(tx, input.reference, 'support_review', input.when);
      return 'superseded';
    }

    /* OD-51: settlement does not take the opener's word for what the charge costs. The kind and
     * the amount are recomputed here, from the database's own truth, with the same pricing the
     * opener uses; a charge that disagrees is recorded as paid and set aside for an operator,
     * never applied. */
    const refused = await verifiedPriceRefusal(tx, terms, input.businessId, charge, subscription);
    if (refused) {
      await subscriptionsRepo.markUnapplied(tx, input.reference, refused, input.when);
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
      chargeReference: input.reference,
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
    /* What the payment actually bought, kept apart from the period it was priced for: a checkout
     * opened one day and paid the next buys the later cycle. */
    /* An upgrade keeps the cycle it lands in (cycleStartedAt stays the original start so later
     * proration is right), but what it bought runs from the day it was paid. */
    await subscriptionsRepo.markChargeApplied(
      tx,
      input.reference,
      charge.kind === 'upgrade' ? input.when : cycleStartedAt,
      renewsAt,
    );
  }
  return 'applied';
}

/**
 * The two plans' prices a plan change compares (BL2): `from` at the merchant's pinned version, `to`
 * at the version on sale at `now`, at the given interval. Undefined on the constant path, where
 * `planChangeCharge` uses the pre-BL2 table. Shared by the opener (`changePlan`) and settlement
 * (`verifiedPriceRefusal`) so both price a charge with one function.
 */
export async function changePricesKFor(
  config: PlanTermsConfig,
  tx: TenantDb,
  businessId: string,
  from: string,
  to: string,
  now: Date,
  interval: BillingInterval = 'monthly',
): Promise<{ from: number; to: number } | undefined> {
  if (!config.planCatalogueReads) return undefined;
  return {
    from: await planPriceKFor(config, tx, businessId, from, now),
    to: await planPriceKFor(config, tx, businessId, to, now, interval),
  };
}

/**
 * What this charge should cost, recomputed from the database's own truth at the instant it was
 * priced (OD-51, migration 0209): the plan catalogue (or the constant table), the merchant's pinned
 * version, the subscription's cycle (guarded columns, 0206) and the charge's own frozen terms. The
 * same functions the openers use (the renewal sweep, `changePlan`, `buyPack`), on the same inputs,
 * so an honest charge always agrees. Null when the charge cannot be priced at all.
 */
export async function expectedChargeTerms(
  tx: TenantDb,
  config: PlanTermsConfig,
  businessId: string,
  charge: subscriptionsRepo.ChargeRow,
  subscription: subscriptionsRepo.Subscription | null,
): Promise<{ kind: string; amountK: number } | null> {
  const pricedAt = charge.pricedAt ?? charge.createdAt;
  if (charge.kind === 'add_on') {
    if (!charge.packId) return null;
    const pack = await packOffer(config, tx, charge.packId, pricedAt);
    if (!pack) return null;
    return { kind: 'add_on', amountK: pack.priceK * charge.quantity };
  }
  if (!charge.plan) return null;
  if (charge.kind === 'renewal') {
    return {
      kind: 'renewal',
      amountK: await planPriceKFor(
        config,
        tx,
        businessId,
        charge.plan,
        pricedAt,
        charge.billingInterval,
      ),
    };
  }
  if (charge.kind !== 'first_purchase' && charge.kind !== 'upgrade') return null;
  const from = await usageRepo.planFor(tx, businessId, pricedAt);
  const interval = intervalFor(from, subscription, charge.billingInterval);
  const priced = planChangeCharge({
    interval,
    from,
    to: charge.plan,
    cycleStart: subscription?.cycleStartedAt ?? pricedAt,
    renewsAt: subscription?.planExpiresAt ?? addMonth(pricedAt),
    now: pricedAt,
    pricesK: await changePricesKFor(
      config,
      tx,
      businessId,
      from,
      charge.plan,
      pricedAt,
      pricingIntervalFor(from, interval),
    ),
  });
  return { kind: priced.kind, amountK: priced.amountK };
}

/**
 * Why settlement will not apply this charge as priced, or null when its kind and amount are what
 * Rekoda's own pricing says (OD-51). A first purchase must also buy the interval it was priced on.
 */
async function verifiedPriceRefusal(
  tx: TenantDb,
  config: PlanTermsConfig,
  businessId: string,
  charge: subscriptionsRepo.ChargeRow,
  subscription: subscriptionsRepo.Subscription | null,
): Promise<'price_not_verified' | null> {
  const expected = await expectedChargeTerms(tx, config, businessId, charge, subscription);
  if (!expected) return 'price_not_verified';
  if (expected.kind !== charge.kind || expected.amountK !== charge.amountK) {
    return 'price_not_verified';
  }
  return null;
}

/** The merchant-safe family of an internal reason a paid charge was not applied (OD-30). */
function notAppliedReason(
  reason: string | null,
): 'plan_changed' | 'period_ended' | 'paid_twice' | 'under_review' {
  if (reason === 'subscription_decided_after_charge') return 'plan_changed';
  if (reason === 'cycle_ended') return 'period_ended';
  if (reason === 'duplicate_purchase') return 'paid_twice';
  return 'under_review';
}

function statusOf(
  plan: string,
  subscription: {
    planExpiresAt: Date | null;
    paymentFailedAt: Date | null;
    plan: string;
  } | null,
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
    /* What ended, from the STORED plan, the rule WhatsApp already uses (G-65, `usageRepo.lapseOf`):
     * a trial past its date is still stored as `trial`; a paid plan that lapsed, or that an operator
     * moved to expired, is stored as `expired`. `subscription_origin` is not used: it can be NULL
     * for a merchant who paid (an operator move clears it; rows lapsed before 0167 were never
     * backfilled), and telling a payer their free trial ended would be untrue. */
    return {
      state: 'expired',
      since: since.toISOString(),
      wasTrial: subscription?.plan === 'trial',
    };
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
  return { state: 'expired', since: state.since.toISOString(), wasTrial: false };
}

/**
 * OWN-33 (G-115): a subscription that cannot be shown to be a provider-bought
 * standard month is never prorated automatically (`upgradeProrationEligibility`).
 * No subscription row means a first purchase, which has no cycle to prorate.
 */
export function isCustomCycle(
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
