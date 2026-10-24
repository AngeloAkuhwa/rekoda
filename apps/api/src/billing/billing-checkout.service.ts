/**
 * A merchant paying Rekoda: turning a pending charge into a Paystack checkout
 * (G-102, OWN-39).
 *
 * The settlement half already existed (`billing.process` verifies the payment
 * server-side and `applySettledCharge` settles a charge exactly once). What was
 * missing is only the way in, and the way in has one awkward fact: Paystack
 * will not start a checkout without an email, and Rekoda holds none for a
 * merchant. OWN-39 settles who supplies it: the merchant, inside this flow,
 * once. It is checked, kept sealed under the vault key, and never invented,
 * never swapped for the owner's own address, never one of Rekoda's own.
 *
 * Three phases, like the customer-payment path, because a provider call must
 * not sit inside a database transaction: decide and store, then call Paystack,
 * then record the link. A charge's reference is Paystack's idempotency key and
 * Paystack refuses to initialise one twice, so the first link is stored and
 * every later request is handed that same link.
 *
 * This money is Rekoda's revenue. It is initialised without a subaccount and
 * lands in no merchant's books.
 */
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { checkBillingEmail } from '@rekoda/core';
import { decryptFacet, encryptFacet } from '@rekoda/core/vault';
import type { BillingCheckoutResponse } from '@rekoda/contracts';
import { subscriptionsRepo, withBusiness, type Db, type TenantDb } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import { isCustomCycle } from './billing.service.js';
import { PAYMENT_PROVIDER, type PaymentProviderPort } from '../payments/provider.port.js';

/** A sealed billing email belongs to one business: a blob copied onto another row fails to open. */
const emailAad = (businessId: string): string => `billing-email:${businessId}`;

type Prepared =
  | { state: 'done'; response: BillingCheckoutResponse }
  | { state: 'initialise'; reference: string; amountK: number; email: string };

@Injectable()
export class BillingCheckoutService {
  private readonly log = new Logger(BillingCheckoutService.name);

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderPort,
  ) {}

  async checkout(
    businessId: string,
    reference: string,
    billingEmail: string | undefined,
    now = new Date(),
  ): Promise<BillingCheckoutResponse> {
    /* A missing key degrades honestly, and a live key waits for the written
     * Paystack confirmation (§47), exactly as opening a charge does. */
    const key = this.config.paystackSecretKey;
    if (!key) return { state: 'unavailable', reason: 'payments_not_configured' };
    if (key.startsWith('sk_live') && !this.config.paystackPlatformConfirmed) {
      return { state: 'unavailable', reason: 'awaiting_platform_confirmation' };
    }

    /* A bad address is refused before anything is read or written. */
    let given: string | null = null;
    if (billingEmail !== undefined && billingEmail.trim() !== '') {
      const checked = checkBillingEmail(billingEmail);
      if (!checked.ok) return { state: 'invalid_billing_email', reason: checked.reason };
      given = checked.email;
    }

    const prepared = await this.prepare(businessId, reference, given, now);
    if (prepared.state === 'done') return prepared.response;

    /* The provider, outside any transaction. */
    let url: string;
    try {
      const initialised = await this.provider.initializeTransaction({
        reference: prepared.reference,
        amountK: prepared.amountK,
        currency: 'NGN',
        customerEmail: prepared.email,
        subaccountCode: null,
      });
      if (initialised.state === 'requires_customer_information') {
        return { state: 'unavailable', reason: 'provider_rejected_billing_email' };
      }
      url = initialised.checkoutUrl;
    } catch (error) {
      /* Two tabs can both reach here with one reference, and Paystack refuses
       * the second. If the first has already stored its link, that link is the
       * answer; otherwise this is an outage, not a result. */
      const stored = await this.storedCheckout(businessId, prepared.reference, now);
      if (stored) return { state: 'ready', reference: prepared.reference, ...stored };
      this.log.warn(`Paystack initialize failed: ${error instanceof Error ? error.name : 'error'}`);
      throw new ServiceUnavailableException('the payment provider is not reachable right now');
    }

    const recorded = await withBusiness(this.db, businessId, (tx) =>
      subscriptionsRepo.recordCheckout(tx, businessId, prepared.reference, url, now),
    );
    /* Paid, failed or retired while the provider call was in flight. */
    if (!recorded) return { state: 'unavailable', reason: 'not_pending' };
    return {
      state: 'ready',
      reference: prepared.reference,
      checkoutUrl: recorded,
      amountK: prepared.amountK,
    };
  }

  private async prepare(
    businessId: string,
    reference: string,
    given: string | null,
    now: Date,
  ): Promise<Prepared> {
    return withBusiness(this.db, businessId, async (tx): Promise<Prepared> => {
      const charge = await subscriptionsRepo.chargeByReference(tx, businessId, reference);
      if (!charge) {
        return { state: 'done', response: { state: 'unavailable', reason: 'unknown_charge' } };
      }
      const refused = await this.refusal(tx, businessId, charge, now);
      if (refused) return { state: 'done', response: { state: 'unavailable', reason: refused } };
      /* Already initialised: the same link again, and no email needed. */
      if (charge.checkoutUrl) {
        return {
          state: 'done',
          response: {
            state: 'ready',
            reference: charge.reference,
            checkoutUrl: charge.checkoutUrl,
            amountK: charge.amountK,
          },
        };
      }

      let email = given;
      if (email) {
        await subscriptionsRepo.setBillingEmailSealed(
          tx,
          businessId,
          encryptFacet(email, this.config.vaultKey, emailAad(businessId)),
          now,
        );
      } else {
        const sealed = await subscriptionsRepo.billingEmailSealed(tx, businessId);
        if (!sealed) {
          return { state: 'done', response: { state: 'requires_billing_email' } };
        }
        email = decryptFacet(sealed, this.config.vaultKey, emailAad(businessId));
      }
      return { state: 'initialise', reference: charge.reference, amountK: charge.amountK, email };
    });
  }

  /**
   * Why this charge may not be paid now, or null when it may. One rule set for
   * every path that could hand out a link (a fresh checkout, a stored link, the
   * recovery after a provider error), so they cannot drift apart: each mirrors
   * what `applySettledCharge` would do with a payment on it.
   */
  private async refusal(
    tx: TenantDb,
    businessId: string,
    charge: subscriptionsRepo.ChargeRow,
    now: Date,
  ): Promise<
    'not_pending' | 'superseded' | 'nothing_to_pay' | 'cycle_ended' | 'support_review' | null
  > {
    if (charge.status !== 'pending') return 'not_pending';
    /* Retired charges keep status `pending` and gain `superseded_at` (a newer
     * plan choice or subscription decision): a payment on one is recorded but
     * never applied, so nobody is invited to pay for it, cached link or not. */
    if (
      charge.supersededAt ||
      /* A newer subscription decision the retirement sweep has not stamped yet:
       * the predicate settlement applies, for plan charges only (a pack buys
       * against whatever plan is current). */
      (charge.plan && (await subscriptionsRepo.decidedSince(tx, businessId, charge.reference)))
    ) {
      return 'superseded';
    }
    if (charge.amountK <= 0) return 'nothing_to_pay';
    /* An upgrade is priced against the rest of the cycle it was opened in, and
     * settlement refuses to apply it once that cycle has ended or when the
     * cycle is not a provider-bought standard month (OWN-29, OWN-33): the money
     * would be recorded for an operator and the plan would not move. */
    if (charge.kind === 'upgrade') {
      const subscription = await subscriptionsRepo.subscriptionFor(tx, businessId);
      if (subscription?.planExpiresAt && subscription.planExpiresAt <= now) return 'cycle_ended';
      if (!subscription || isCustomCycle(subscription)) return 'support_review';
    }
    return null;
  }

  private async storedCheckout(
    businessId: string,
    reference: string,
    now: Date,
  ): Promise<{ checkoutUrl: string; amountK: number } | null> {
    return withBusiness(this.db, businessId, async (tx) => {
      const charge = await subscriptionsRepo.chargeByReference(tx, businessId, reference);
      if (!charge?.checkoutUrl || (await this.refusal(tx, businessId, charge, now))) return null;
      return { checkoutUrl: charge.checkoutUrl, amountK: charge.amountK };
    });
  }
}
