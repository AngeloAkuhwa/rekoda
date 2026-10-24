/**
 * A merchant paying Rekoda: turning a pending charge into a Paystack checkout
 * (G-102, OWN-39, OWN-50).
 *
 * The settlement half already existed (`billing.process` verifies the payment
 * server-side and `applySettledCharge` settles a charge exactly once). What was
 * missing is only the way in, and the way in has one awkward fact: Paystack
 * will not start a checkout without an email, and Rekoda holds none for a
 * merchant. OWN-39 settles who supplies it: the merchant, inside this flow,
 * once. It is checked, kept sealed under the vault key, and never invented,
 * never swapped for the owner's own address, never one of Rekoda's own.
 *
 * Every provider checkout is an ATTEMPT with its own provider reference. The
 * reason is Paystack's contract: a reference it has seen is rejected, whether
 * the session was paid, failed or abandoned, so a checkout whose link was lost
 * (the response never arrived, or the merchant closed the tab) can never be
 * started again under the same reference, and re-initialising is never assumed
 * to be idempotent. The first attempt keeps the charge's own reference; a
 * replacement appends `-R<n>` (core: `attemptReference`).
 *
 * Recovery, in order of safety:
 *  1. a stored link is simply handed back;
 *  2. a link that is missing (the call failed, timed out, or died) is never
 *     replaced until Paystack has been ASKED about the old session: paid means
 *     the merchant is told so, a payment under way means they wait, and only an
 *     unpaid or unknown session is replaced. If Paystack cannot be asked the
 *     answer is "try again", never a second session;
 *  3. a charge has at most one live attempt, enforced by the database, and every
 *     decision is made holding the charge's row lock, so two tabs, a retry racing
 *     a replacement and a double click cannot produce two live sessions.
 * A payment that nevertheless lands on a replaced session is settled once if the
 * charge is still pending, and is a duplicate for an operator to refund if it is
 * not (the pump and `billing.process` do that); it is never a second entitlement.
 *
 * Phases, because a provider call must not sit inside a database transaction:
 * decide and store, then call Paystack, then record the link.
 *
 * This money is Rekoda's revenue. It is initialised without a subaccount and
 * lands in no merchant's books.
 */
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { MAX_CHECKOUT_ATTEMPTS, attemptReference, checkBillingEmail } from '@rekoda/core';
import { decryptFacet, encryptFacet } from '@rekoda/core/vault';
import type { BillingCheckoutResponse } from '@rekoda/contracts';
import { subscriptionsRepo, withBusiness, type Db, type TenantDb } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import { isCustomCycle } from './billing.service.js';
import { PAYMENT_PROVIDER, type PaymentProviderPort } from '../payments/provider.port.js';

/** A sealed billing email belongs to one business: a blob copied onto another row fails to open. */
const emailAad = (businessId: string): string => `billing-email:${businessId}`;

/** The later of the request's clock and the wall clock, read when a link is about to be handed out. */
const handoffTime = (now: Date): Date => {
  const wall = new Date();
  return wall > now ? wall : now;
};

/**
 * How long a request may be mid-way through starting a checkout before another
 * request treats it as dead and asks Paystack what became of it. Longer than
 * any sane provider timeout, so a slow but live request is not trampled.
 */
const STALE_INITIALIZING_MS = 60_000;

/**
 * A request for a fresh link right after a link was made hands that link back
 * instead of replacing it: a double click must not cost a session, and a link
 * made seconds ago is not one the merchant has lost.
 */
const RESTART_COOLDOWN_MS = 30_000;

/** Provider statuses on which an unpaid session may be replaced (nothing is under way). */
const REPLACEABLE_PROVIDER_STATUSES = new Set(['abandoned', 'failed', 'reversed']);

type Attempt = subscriptionsRepo.AttemptRow;
type Unavailable = Extract<BillingCheckoutResponse, { state: 'unavailable' }>['reason'];

type Decision =
  | { state: 'done'; response: BillingCheckoutResponse }
  /** An attempt is open (status `initializing`) and Paystack has not been called for it. */
  | {
      state: 'initialise';
      attempt: Attempt;
      chargeReference: string;
      amountK: number;
      email: string;
    }
  /** The live attempt has no usable link: ask Paystack about it before doing anything else. */
  | { state: 'resolve'; attempt: Attempt }
  /** A sibling request is calling Paystack for this charge right now. */
  | { state: 'wait' }
  /** Someone else moved the attempt while we waited: decide again from what they did. */
  | { state: 'retry' };

type Verdict = 'paid' | 'in_progress' | 'replaceable';

export interface CheckoutOptions {
  /** The merchant asks for a fresh link (honoured only once Paystack confirms the old one is unpaid). */
  restart?: boolean;
  /** The request's clock; tests pin it. */
  now?: Date;
  /** How long to wait for a sibling request that is mid-way through starting this checkout. */
  siblingWaitMs?: number;
}

/** How long a request waits for a sibling that is starting the same checkout, so a double click gets one link. */
const SIBLING_WAIT_MS = 4_000;
const SIBLING_POLL_MS = 200;

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
    options: CheckoutOptions = {},
  ): Promise<BillingCheckoutResponse> {
    const now = options.now ?? new Date();
    const restart = options.restart === true;
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

    /* Each pass is one decision under the charge's lock. A pass that finds the
     * attempt already moved by a sibling decides again from what the sibling did;
     * three passes is far more than a real race needs. */
    for (let pass = 0; pass < 3; pass += 1) {
      let decision = await this.decide(businessId, reference, given, restart, now);
      if (decision.state === 'resolve') {
        const verdict = await this.verdict(decision.attempt);
        if (verdict === 'paid') return { state: 'unavailable', reason: 'payment_received' };
        if (verdict === 'in_progress')
          return { state: 'unavailable', reason: 'payment_in_progress' };
        decision = await this.replace(businessId, reference, decision.attempt, given, now);
      }
      if (decision.state === 'wait') {
        const linked = await this.awaitSibling(
          businessId,
          reference,
          options.siblingWaitMs ?? SIBLING_WAIT_MS,
        );
        if (linked) return linked;
        continue;
      }
      if (decision.state === 'retry') continue;
      if (decision.state === 'done') return decision.response;
      if (decision.state === 'initialise') return this.initialise(businessId, decision, now);
    }
    return { state: 'unavailable', reason: 'checkout_in_progress' };
  }

  /**
   * Decide what this request should do, holding the charge's lock. Opens the
   * first attempt itself when the charge has none (and returns it to be
   * initialised); everything else is a link to hand back, a refusal, or an
   * attempt that needs Paystack to be asked about it.
   */
  private async decide(
    businessId: string,
    reference: string,
    given: string | null,
    restart: boolean,
    now: Date,
  ): Promise<Decision> {
    return withBusiness(this.db, businessId, async (tx): Promise<Decision> => {
      const charge = await subscriptionsRepo.lockChargeByReference(tx, businessId, reference);
      if (!charge) {
        return { state: 'done', response: { state: 'unavailable', reason: 'unknown_charge' } };
      }
      const refused = await this.refusal(tx, businessId, charge, now);
      if (refused) return { state: 'done', response: { state: 'unavailable', reason: refused } };

      let live = await subscriptionsRepo.liveAttempt(tx, businessId, charge.id);
      const latest = await subscriptionsRepo.latestAttemptNo(tx, businessId, charge.id);

      /* A link stored before attempts existed is attempt 1. */
      if (!live && latest === 0 && charge.checkoutUrl) {
        const adopted = await subscriptionsRepo.openAttempt(tx, {
          businessId,
          chargeId: charge.id,
          attemptNo: 1,
          providerReference: attemptReference(charge.reference, 1),
        });
        if (adopted) {
          await subscriptionsRepo.recordAttemptCheckout(
            tx,
            businessId,
            adopted.id,
            charge.checkoutUrl,
            now,
          );
          live = await subscriptionsRepo.liveAttempt(tx, businessId, charge.id);
        }
      }

      if (live) {
        const age = Date.now() - live.createdAt.getTime();
        if (live.status === 'active' && live.checkoutUrl) {
          if (!restart || age < RESTART_COOLDOWN_MS) {
            return {
              state: 'done',
              response: {
                state: 'ready',
                reference: charge.reference,
                checkoutUrl: live.checkoutUrl,
                amountK: charge.amountK,
              },
            };
          }
        } else if (live.status === 'initializing' && age < STALE_INITIALIZING_MS) {
          /* A sibling request is calling Paystack right now. */
          return { state: 'wait' };
        }
        return { state: 'resolve', attempt: live };
      }

      /* No live attempt: the charge's first, or the next after a settled-away one. */
      if (latest >= MAX_CHECKOUT_ATTEMPTS) {
        return { state: 'done', response: { state: 'unavailable', reason: 'too_many_attempts' } };
      }
      return this.openNext(tx, businessId, charge, latest + 1, given, now);
    });
  }

  /**
   * Wait for a sibling request that is mid-way through starting this checkout.
   * Returns its link as soon as there is one, null when the sibling is no longer
   * starting it (so this request decides afresh), and "ask again" when it is
   * still going after the budget.
   */
  private async awaitSibling(
    businessId: string,
    reference: string,
    budgetMs: number,
  ): Promise<BillingCheckoutResponse | null> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const seen = await withBusiness(this.db, businessId, async (tx) => {
        const charge = await subscriptionsRepo.chargeByReference(tx, businessId, reference);
        if (!charge) return { gone: true as const };
        const live = await subscriptionsRepo.liveAttempt(tx, businessId, charge.id);
        return { charge, live };
      });
      if ('gone' in seen || !seen.live) return null;
      if (seen.live.status === 'active' && seen.live.checkoutUrl) {
        const refused = await withBusiness(this.db, businessId, (tx) =>
          this.refusal(tx, businessId, seen.charge, handoffTime(new Date())),
        );
        if (refused) return { state: 'unavailable', reason: refused };
        return {
          state: 'ready',
          reference: seen.charge.reference,
          checkoutUrl: seen.live.checkoutUrl,
          amountK: seen.charge.amountK,
        };
      }
      if (seen.live.status !== 'initializing') return null;
      if (Date.now() >= deadline) {
        return { state: 'unavailable', reason: 'checkout_in_progress' };
      }
      await new Promise((resolve) => setTimeout(resolve, SIBLING_POLL_MS));
    }
  }

  /** The email to start a session with, stored sealed when the merchant just gave one. */
  private async emailFor(
    tx: TenantDb,
    businessId: string,
    given: string | null,
    now: Date,
  ): Promise<string | null> {
    if (given) {
      await subscriptionsRepo.setBillingEmailSealed(
        tx,
        businessId,
        encryptFacet(given, this.config.vaultKey, emailAad(businessId)),
        now,
      );
      return given;
    }
    const sealed = await subscriptionsRepo.billingEmailSealed(tx, businessId);
    return sealed ? decryptFacet(sealed, this.config.vaultKey, emailAad(businessId)) : null;
  }

  private async openNext(
    tx: TenantDb,
    businessId: string,
    charge: subscriptionsRepo.ChargeRow,
    attemptNo: number,
    given: string | null,
    now: Date,
  ): Promise<Decision> {
    const email = await this.emailFor(tx, businessId, given, now);
    if (!email) return { state: 'done', response: { state: 'requires_billing_email' } };
    const attempt = await subscriptionsRepo.openAttempt(tx, {
      businessId,
      chargeId: charge.id,
      attemptNo,
      providerReference: attemptReference(charge.reference, attemptNo),
    });
    /* Holding the lock, a conflict means a sibling committed first. */
    if (!attempt) return { state: 'retry' };
    return {
      state: 'initialise',
      attempt,
      chargeReference: charge.reference,
      amountK: charge.amountK,
      email,
    };
  }

  /**
   * Ask Paystack what became of an attempt that has no usable link. Outside any
   * transaction. A provider that cannot be reached is an outage, never a result:
   * the caller must not create a second session while it is unsure about the first.
   */
  private async verdict(attempt: Attempt): Promise<Verdict> {
    let verified;
    try {
      verified = await this.provider.verifyTransaction(attempt.providerReference);
    } catch (error) {
      this.log.warn(`Paystack verify failed: ${error instanceof Error ? error.name : 'error'}`);
      throw new ServiceUnavailableException('the payment provider is not reachable right now');
    }
    if (!verified.found) return 'replaceable';
    const t = verified.transaction;
    if (t.succeeded) return 'paid';
    return REPLACEABLE_PROVIDER_STATUSES.has(t.providerStatus) ? 'replaceable' : 'in_progress';
  }

  /**
   * Retire the attempt Paystack confirmed unpaid and open the next one, holding
   * the lock again and re-checking that nobody moved the attempt meanwhile.
   */
  private async replace(
    businessId: string,
    reference: string,
    attempt: Attempt,
    given: string | null,
    now: Date,
  ): Promise<Decision> {
    return withBusiness(this.db, businessId, async (tx): Promise<Decision> => {
      const charge = await subscriptionsRepo.lockChargeByReference(tx, businessId, reference);
      if (!charge) {
        return { state: 'done', response: { state: 'unavailable', reason: 'unknown_charge' } };
      }
      const refused = await this.refusal(tx, businessId, charge, now);
      if (refused) return { state: 'done', response: { state: 'unavailable', reason: refused } };

      const live = await subscriptionsRepo.liveAttempt(tx, businessId, charge.id);
      if (!live || live.id !== attempt.id || live.status !== attempt.status) {
        return { state: 'retry' };
      }
      const latest = await subscriptionsRepo.latestAttemptNo(tx, businessId, charge.id);
      if (latest >= MAX_CHECKOUT_ATTEMPTS) {
        return { state: 'done', response: { state: 'unavailable', reason: 'too_many_attempts' } };
      }
      /* The email is settled before the old attempt is retired, so a missing one
       * leaves the charge exactly as it was. */
      const email = await this.emailFor(tx, businessId, given, now);
      if (!email) return { state: 'done', response: { state: 'requires_billing_email' } };
      const moved = await subscriptionsRepo.moveAttempt(
        tx,
        businessId,
        attempt.id,
        [attempt.status],
        'superseded',
      );
      if (!moved) return { state: 'retry' };
      const next = await subscriptionsRepo.openAttempt(tx, {
        businessId,
        chargeId: charge.id,
        attemptNo: latest + 1,
        providerReference: attemptReference(charge.reference, latest + 1),
      });
      if (!next) return { state: 'retry' };
      return {
        state: 'initialise',
        attempt: next,
        chargeReference: charge.reference,
        amountK: charge.amountK,
        email,
      };
    });
  }

  /** Call Paystack for an open attempt, outside any transaction, then record the link. */
  private async initialise(
    businessId: string,
    decision: Extract<Decision, { state: 'initialise' }>,
    now: Date,
  ): Promise<BillingCheckoutResponse> {
    const { attempt } = decision;
    let url: string;
    try {
      const initialised = await this.provider.initializeTransaction({
        reference: attempt.providerReference,
        amountK: decision.amountK,
        currency: 'NGN',
        customerEmail: decision.email,
        subaccountCode: null,
      });
      if (initialised.state === 'requires_customer_information') {
        /* Paystack refused to create a session at all, so there is nothing to recover. */
        await this.move(businessId, attempt.id, ['initializing'], 'superseded');
        return { state: 'unavailable', reason: 'provider_rejected_billing_email' };
      }
      url = initialised.checkoutUrl;
    } catch (error) {
      /* Paystack may or may not hold a session now, and Rekoda does not have its
       * link. Recorded as ambiguous so the next request asks Paystack before it
       * does anything else; this one is an outage, not a result. */
      await this.move(businessId, attempt.id, ['initializing'], 'ambiguous');
      this.log.warn(`Paystack initialize failed: ${error instanceof Error ? error.name : 'error'}`);
      throw new ServiceUnavailableException('the payment provider is not reachable right now');
    }

    /* The provider call takes real time: an upgrade's cycle can end inside it,
     * and a link handed out then would be paid for an upgrade settlement refuses.
     * The link is still stored, but never handed out once the charge is refusable
     * at the moment of handoff. */
    const handoff = handoffTime(now);
    const outcome = await withBusiness(this.db, businessId, async (tx) => {
      const recorded = await subscriptionsRepo.recordAttemptCheckout(
        tx,
        businessId,
        attempt.id,
        url,
        now,
      );
      const charge = await subscriptionsRepo.chargeById(tx, businessId, attempt.chargeId);
      const refused = charge ? await this.refusal(tx, businessId, charge, handoff) : 'not_pending';
      if (refused) return { refused };
      /* Not recorded though the charge is payable: a sibling replaced this attempt
       * while Paystack was answering. Its link is not the one to give out. */
      if (!recorded) return { refused: 'checkout_in_progress' as const };
      return { recorded };
    });
    if ('refused' in outcome) return { state: 'unavailable', reason: outcome.refused };
    return {
      state: 'ready',
      reference: decision.chargeReference,
      checkoutUrl: outcome.recorded,
      amountK: decision.amountK,
    };
  }

  private async move(
    businessId: string,
    attemptId: string,
    from: readonly subscriptionsRepo.AttemptStatus[],
    to: subscriptionsRepo.AttemptStatus,
  ): Promise<void> {
    await withBusiness(this.db, businessId, (tx) =>
      subscriptionsRepo.moveAttempt(tx, businessId, attemptId, from, to),
    );
  }

  /**
   * Why this charge may not be paid now, or null when it may. One rule set for
   * every path that could hand out a link, so they cannot drift apart: each
   * mirrors what `applySettledCharge` would do with a payment on it.
   */
  private async refusal(
    tx: TenantDb,
    businessId: string,
    charge: subscriptionsRepo.ChargeRow,
    now: Date,
  ): Promise<Extract<
    Unavailable,
    'not_pending' | 'superseded' | 'nothing_to_pay' | 'cycle_ended' | 'support_review'
  > | null> {
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
}
