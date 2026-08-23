/**
 * A merchant paid REKODA (ADR 0024).
 *
 * The same discipline as `payment.process` and a separate job from it, on
 * purpose. That handler books money a merchant's CUSTOMER paid THEM, into
 * their ledger. This one records money they paid US, into `subscription_charges`
 * and nowhere near their books: their revenue is not our revenue, and a
 * single handler with a branch is one refactor away from making it so.
 *
 * What is shared is the rule that matters. The webhook body is a HINT. Every
 * authoritative number comes from the provider's verify endpoint, called
 * server-side inside this job, so a forged-but-signed body, a stale retry and
 * an honest webhook all converge on the same truth.
 *
 * One difference from the payments path, and it is deliberate: a PARTIAL
 * payment does not settle a subscription. Against a merchant's invoice a part
 * payment is real money against a real balance and books as such. Against a
 * plan there is no balance to reduce - either the month is paid for or it is
 * not - and unlocking Complete for someone who sent half its price would be
 * giving the product away by arithmetic accident.
 */
import { Logger } from '@nestjs/common';
import { redactForLog } from '@rekoda/core/privacy';
import { judgeProviderPayment } from '@rekoda/core';
import { paystackWebhookBody, summarisePaystackEvent } from '@rekoda/contracts';
import { events, subscriptionsRepo } from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import { openPayload } from '../privacy/payload-vault.js';
import type { PaymentProviderPort } from '../payments/provider.port.js';
import { applySettledCharge } from '../billing/billing.service.js';
import type { JobContext, JobHandler } from './runner.js';

export interface ProcessBillingChargeDeps {
  provider: PaymentProviderPort;
  config: Pick<ApiConfig, 'vaultKey'>;
}

/** Provider statuses that mean "this attempt is over", not "still cooking". */
const DEAD_PROVIDER_STATUSES = new Set(['failed', 'abandoned', 'reversed']);

export function processBillingChargeHandler(deps: ProcessBillingChargeDeps): JobHandler {
  const log = new Logger('ProcessBillingChargeJob');

  return async ({ tx, payload, businessId }: JobContext): Promise<void> => {
    const eventId = typeof payload['eventId'] === 'string' ? payload['eventId'] : null;
    if (!eventId) throw new Error('billing.process: payload is missing eventId');

    const event = await events.eventForBusiness(tx, eventId, businessId);
    if (!event) {
      log.warn('billing.process: no such event for this tenant');
      return;
    }

    const reference = referenceOf(event.payload, deps.config.vaultKey);
    if (!reference) {
      await events.markProcessed(tx, eventId, 'unreadable_at_processing', businessId);
      return;
    }

    const charge = await subscriptionsRepo.chargeByReference(tx, businessId, reference);
    if (!charge) {
      /* Attribution said this business; the tenant-scoped read disagrees.
       * That inconsistency is exactly what must never be papered over. */
      await events.markProcessed(tx, eventId, 'charge_missing_for_tenant', businessId);
      return;
    }
    if (charge.status !== 'pending') {
      await events.markProcessed(tx, eventId, `already_${charge.status}`, businessId);
      return;
    }

    /* ── the authoritative call ────────────────────────────────────────── */
    const verified = await deps.provider.verifyTransaction(reference);
    if (!verified.found) {
      log.warn('a signed event named a subscription charge the provider does not know');
      await events.markProcessed(tx, eventId, 'verify_not_found', businessId);
      return;
    }
    const t = verified.transaction;

    const judgement = judgeProviderPayment(
      { reference: charge.reference, amountK: charge.amountK, currency: 'NGN' },
      { reference: t.reference, amountK: t.amountK, currency: t.currency, succeeded: t.succeeded },
    );

    if (judgement.verdict === 'rejected') {
      if (judgement.reason === 'provider_not_success') {
        if (DEAD_PROVIDER_STATUSES.has(t.providerStatus)) {
          /* The attempt is over and the charge is closed. The obligation is
           * not: the cycle still ends when it ends, and the grace sweep is
           * already counting. A retry is a NEW charge. */
          await subscriptionsRepo.settleCharge(tx, {
            reference,
            status: 'failed',
            providerReference: t.providerTransactionId,
            failureReason: t.providerStatus,
            when: new Date(),
          });
          await events.markProcessed(tx, eventId, `provider_${t.providerStatus}`, businessId);
        } else {
          // Pending: not a failure, just not money yet. The success event,
          // when it comes, is a new event.
          await events.markProcessed(tx, eventId, 'provider_pending', businessId);
        }
        return;
      }
      /* Wrong currency, or a non-positive amount, CONFIRMED by verify. Not
       * this charge's money. Left pending rather than failed: the merchant
       * still owes the month, and somebody has to look at where this went. */
      log.warn(`a subscription payment was rejected: ${redactForLog(judgement.reason)}`);
      await events.markProcessed(tx, eventId, judgement.reason, businessId);
      return;
    }

    if (judgement.reconciliation === 'partial_match') {
      /**
       * Part of the price. There is no balance on a plan to reduce, so this
       * unlocks nothing and settles nothing: the charge stays pending, the
       * merchant still owes the month, and the shortfall is a human's
       * problem rather than a discount the code granted.
       */
      log.warn('a subscription payment arrived short and was not applied');
      await events.markProcessed(tx, eventId, 'underpaid', businessId);
      return;
    }

    const outcome = await applySettledCharge(tx, {
      businessId,
      reference,
      providerReference: t.providerTransactionId,
      when: new Date(),
    });
    await events.markProcessed(
      tx,
      eventId,
      outcome === 'already_settled' ? 'already_settled' : null,
      businessId,
    );
    if (outcome === 'applied') {
      log.log(`business ${businessId}: subscription charge ${charge.kind} applied`);
    }
  };
}

function referenceOf(payload: unknown, vaultKey: string): string | null {
  let opened: unknown;
  try {
    opened = openPayload(payload, vaultKey);
  } catch {
    /* A seal that will not open is a KEY problem, not an event problem — the
     * pump refuses to drain the queue on it and so does this handler.
     * Throwing lets the job retry (healing when VAULT_KEY is fixed) or die
     * visibly, instead of retiring the platform's own revenue as unread. */
    throw new Error('sealed Paystack payload would not open at processing time; check VAULT_KEY');
  }
  const parsed = paystackWebhookBody.safeParse(opened);
  if (!parsed.success) return null;
  return summarisePaystackEvent(parsed.data).reference ?? null;
}
