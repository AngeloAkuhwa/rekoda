/**
 * OD-44: start a fresh payment for a renewal that was blocked before it could be paid.
 *
 * A renewal raised while Rekoda could not take a payment (OWN-70: a live Paystack key without the
 * §47 confirmation, or no usable key) was recorded as blocked and has no Paystack session, no
 * provider reference and no provider event: there is nothing to recover, because nothing was ever
 * started. When the gate opens, the close pass closes the block and enqueues this job in the same
 * transaction. The job starts a NEW payment, and does nothing else:
 *
 *  - it re-checks that the gate is open now (the restriction may have come back);
 *  - it re-checks that the renewal is still owed and still buys the cycle it was raised for: the
 *    charge is a pending, unsuperseded renewal whose block was closed, the business's paid-to date
 *    is still the charge's period start (the same binding settlement applies, migration 0206), and
 *    the merchant has not cancelled;
 *  - it then asks the ordinary checkout path (`BillingCheckoutService.checkout`) for a payment.
 *    That path is the only one that talks to Paystack for a Rekoda charge, and it already carries
 *    every initiation safeguard: the §47 gate again, the merchant's own billing email (never an
 *    invented one), a fresh provider reference per attempt, at most one live attempt per charge
 *    enforced by the database under the charge's lock, and an existing session handed back or
 *    verified with Paystack before anything replaces it. A repeated or concurrent run therefore
 *    never opens a second session.
 *
 * Nothing here marks a charge paid, extends a plan or moves the grace clock: the renewal is applied
 * only when `billing.process` verifies the payment with Paystack and `applySettledCharge` settles
 * it. The grace clock that the renewal started keeps running exactly as before (ADR 0024).
 *
 * The merchant is not messaged here. The grace reminders already link to the billing page, where
 * the checkout started by this job is handed back as their payment link.
 *
 * Every run is audited (`renewal_payment_initiation`) with a fixed outcome code and Rekoda's own
 * references only: never the checkout link, the billing email or provider text.
 */
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import { BillingCheckoutService } from '../billing/billing-checkout.service.js';
import { chargeGate } from '../billing/paystack-key.js';
import type { PaymentProviderPort } from '../payments/provider.port.js';
import type { JobContext, JobHandler } from './runner.js';

export interface InitiateBlockedRenewalDeps {
  config: ApiConfig;
  /** `rekoda_app`: the checkout path runs its own short transactions under the tenant pin. */
  appDb: Db;
  provider: PaymentProviderPort;
}

const REFERENCE = /^RKD-SUB-\d{8}-[0-9A-Z]{6}$/;

export function initiateBlockedRenewalHandler(deps: InitiateBlockedRenewalDeps): JobHandler {
  const log = new Logger('InitiateBlockedRenewalJob');
  const checkouts = new BillingCheckoutService(deps.config, deps.appDb, deps.provider);

  return async ({ tx, payload, businessId, attempt, maxAttempts }: JobContext): Promise<void> => {
    const reference = typeof payload['reference'] === 'string' ? payload['reference'] : null;
    if (!reference || !REFERENCE.test(reference)) {
      throw new Error('billing.renewal_initiate: payload has no subscription charge reference');
    }
    const record = (
      outcome: subscriptionsRepo.RenewalInitiationOutcome,
      detail: { reason?: string; providerReference?: string } = {},
    ) => subscriptionsRepo.recordRenewalInitiation(tx, businessId, reference, outcome, detail);

    /* The restriction must be lifted NOW, not only when the block was closed. */
    const gate = chargeGate(deps.config);
    if (!gate.ok) {
      await record('gate_closed', { reason: gate.reason });
      return;
    }

    const reason = await ineligibility(tx, businessId, reference);
    if (reason) {
      await record('not_eligible', { reason });
      return;
    }

    const charge = await subscriptionsRepo.chargeByReference(tx, businessId, reference);
    const before = charge ? await subscriptionsRepo.liveAttempt(tx, businessId, charge.id) : null;

    let answer;
    try {
      answer = await checkouts.checkout(businessId, reference, undefined);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        /* Paystack could not be reached. The attempt is recorded as ambiguous by the checkout path,
         * so the next try (this job's retry, or the merchant's own checkout) asks Paystack about it
         * before anything replaces it. Retried while attempts remain; recorded on the last. */
        if (attempt < maxAttempts) throw error;
        await record('provider_unreachable');
        return;
      }
      /* Any other failure on the last attempt is recorded and alerted rather than left to die
       * unseen: nothing was paid or started that needs recovering, and the merchant can still pay
       * from the billing page. */
      if (attempt < maxAttempts) throw error;
      await record('unavailable', { reason: 'initiation_failed' });
      log.error(
        `ALERT billing_renewal_initiation_failed business=${businessId} reference=${reference}`,
      );
      return;
    }

    switch (answer.state) {
      case 'ready': {
        const live = charge ? await liveAttemptOf(deps.appDb, businessId, charge.id) : null;
        /* The same session that was already live and linked before this run: handed back. Any
         * other (none before, or one with no usable link that Paystack confirmed unpaid and the
         * checkout path replaced) is a session this run started. */
        const reused =
          before !== null &&
          live !== null &&
          before.id === live.id &&
          before.status === 'active' &&
          before.checkoutUrl !== null;
        await record(reused ? 'existing_payment_link' : 'initiated', {
          ...(live ? { providerReference: live.providerReference } : {}),
        });
        log.log(`business ${businessId}: renewal ${reference} payment ready (OD-44)`);
        return;
      }
      case 'requires_billing_email':
        await record('requires_billing_email');
        return;
      case 'requires_billing_email_verification':
        await record('requires_billing_email_verification');
        return;
      case 'unavailable':
        await record('unavailable', { reason: answer.reason });
        return;
    }
  };
}

const liveAttemptOf = (db: Db, businessId: string, chargeId: string) =>
  withBusiness(db, businessId, (tx) => subscriptionsRepo.liveAttempt(tx, businessId, chargeId));

/** Why this renewal may not be offered for payment now, or null when it may. */
async function ineligibility(
  tx: JobContext['tx'],
  businessId: string,
  reference: string,
): Promise<string | null> {
  const state = await subscriptionsRepo.blockedRenewalInitiationState(tx, businessId, reference);
  if (!state) return 'unknown_charge';
  if (state.kind !== 'renewal') return 'not_a_renewal';
  if (!state.blockedAt) return 'never_blocked';
  if (!state.blockedResolvedAt) return 'still_blocked';
  if (state.status !== 'pending') return 'not_pending';
  if (state.supersededAt) return 'superseded';
  const subscription = await subscriptionsRepo.subscriptionFor(tx, businessId);
  if (!subscription) return 'no_subscription';
  /* The merchant cancelled: the next cycle is nothing, so nothing is owed for it. */
  if (subscription.pendingPlan === 'expired') return 'cancelled';
  /* The binding settlement applies (0206): a renewal buys the cycle that starts at the paid-to
   * date it was raised against. Once that date has moved (an operator change, a later payment),
   * this renewal can no longer be applied, so nobody is invited to pay it. */
  if (
    !state.periodStart ||
    !subscription.planExpiresAt ||
    subscription.planExpiresAt.getTime() !== state.periodStart.getTime()
  ) {
    return 'cycle_moved';
  }
  return null;
}
