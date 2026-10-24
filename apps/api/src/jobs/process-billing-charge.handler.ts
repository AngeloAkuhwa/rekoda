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
import { chargeReferenceOf, judgeProviderPayment } from '@rekoda/core';
import { paystackWebhookBody, summarisePaystackEvent } from '@rekoda/contracts';
import { events, subscriptionsRepo } from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import { openPayload } from '../privacy/payload-vault.js';
import type { PaymentProviderPort } from '../payments/provider.port.js';
import { applySettledCharge } from '../billing/billing.service.js';
import type { JobContext, JobHandler } from './runner.js';

export interface ProcessBillingChargeDeps {
  provider: PaymentProviderPort;
  config: Pick<ApiConfig, 'vaultKey' | 'planCatalogueReads'>;
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

    /* The reference the event names is the PROVIDER's: a charge's first checkout
     * session carries the charge's own reference, a replacement carries it with
     * `-R<n>` appended (G-102, OWN-50). The charge is the one without the suffix. */
    const providerReference = referenceOf(event.payload, deps.config.vaultKey, event.externalId);
    if (!providerReference) {
      await events.markProcessed(tx, eventId, 'unreadable_at_processing', businessId);
      return;
    }
    const reference = chargeReferenceOf(providerReference);

    const charge = await subscriptionsRepo.chargeByReference(tx, businessId, reference);
    if (!charge) {
      /* Attribution said this business; the tenant-scoped read disagrees.
       * That inconsistency is exactly what must never be papered over. */
      await events.markProcessed(tx, eventId, 'charge_missing_for_tenant', businessId);
      return;
    }
    /**
     * Money going BACK on Rekoda's own revenue — a refund of a subscription
     * charge, a dispute on one — is not this handler's to book and must
     * never reach the merchant's refund path either (G-06 invariant 10:
     * the two payment domains cannot cross). It is flagged for an
     * operator, who records it through the ops refund surface, and the
     * charge is left exactly as it stands.
     */
    const kind = eventKindOf(event.payload, deps.config.vaultKey, event.externalId);
    if (kind === 'refund' || kind === 'dispute') {
      await events.markProcessed(tx, eventId, `billing_${kind}_event`, businessId);
      log.warn(`a Paystack ${kind} event named a subscription charge; flagged for an operator`);
      return;
    }

    /* A replacement reference is only ever one Rekoda issued. The suffix is not a
     * secret, so an event naming `-R7` on a charge that never had a seventh attempt
     * is not a session of ours and is never believed. */
    const attempt = await subscriptionsRepo.attemptByProviderReference(
      tx,
      businessId,
      providerReference,
    );
    if (providerReference !== reference && !attempt) {
      await events.markProcessed(tx, eventId, 'unknown_attempt', businessId);
      log.warn('a Paystack event named a checkout attempt Rekoda never issued');
      return;
    }

    if (charge.status !== 'pending') {
      /* A payment on a DIFFERENT session than the one that settled this charge is a
       * second payment for one obligation (a lost link was replaced and both
       * sessions were paid). Never a second entitlement: it is recorded and flagged
       * for an operator refund. A repeat of the settling payment is not that. */
      if (charge.status === 'paid') {
        const settling = await subscriptionsRepo.paidAttempt(tx, businessId, charge.id);
        const settledReference = settling?.providerReference ?? reference;
        if (providerReference !== settledReference) {
          const second = await deps.provider.verifyTransaction(providerReference);
          if (second.found && second.transaction.succeeded && second.transaction.amountK > 0) {
            if (attempt) {
              await subscriptionsRepo.moveAttempt(
                tx,
                businessId,
                attempt.id,
                ['initializing', 'active', 'ambiguous', 'superseded'],
                'duplicate_paid',
              );
            }
            await events.markProcessed(tx, eventId, 'duplicate_payment', businessId);
            log.warn(
              `subscription charge ${reference} was paid twice for business ${businessId} (a replaced checkout session was also paid); refund the duplicate`,
            );
            return;
          }
        }
      }
      /* A redelivery for a payment that is already recorded as paid but
       * UNAPPLIED is the same work item as the charge on the operator queue;
       * flagging the event too would queue it twice. */
      const alreadyQueued = charge.status === 'paid' && charge.supersededAt !== null;
      await events.markProcessed(
        tx,
        eventId,
        alreadyQueued ? null : `already_${charge.status}`,
        businessId,
      );
      return;
    }

    /* ── the authoritative call ────────────────────────────────────────── */
    const verified = await deps.provider.verifyTransaction(providerReference);
    if (!verified.found) {
      log.warn('a signed event named a subscription charge the provider does not know');
      await events.markProcessed(tx, eventId, 'verify_not_found', businessId);
      return;
    }
    const t = verified.transaction;

    const judgement = judgeProviderPayment(
      { reference: providerReference, amountK: charge.amountK, currency: 'NGN' },
      { reference: t.reference, amountK: t.amountK, currency: t.currency, succeeded: t.succeeded },
    );

    if (judgement.verdict === 'rejected') {
      if (judgement.reason === 'provider_not_success') {
        if (DEAD_PROVIDER_STATUSES.has(t.providerStatus)) {
          /* A session Rekoda already replaced dying changes nothing about the charge:
           * the session the merchant was sent to is a different one. */
          const live = await subscriptionsRepo.liveAttempt(tx, businessId, charge.id);
          const replaced = attempt ? live?.id !== attempt.id : live !== null;
          if (replaced) {
            await events.markProcessed(tx, eventId, null, businessId);
            return;
          }
          /* The attempt is over and the charge is closed. The obligation is
           * not: the cycle still ends when it ends, and the grace sweep is
           * already counting. A retry is a NEW charge. */
          await subscriptionsRepo.lockBusiness(tx, businessId);
          await subscriptionsRepo.settleCharge(tx, {
            reference,
            status: 'failed',
            providerReference: t.providerTransactionId,
            failureReason: t.providerStatus,
            when: new Date(),
          });
          if (attempt) {
            await subscriptionsRepo.moveAttempt(
              tx,
              businessId,
              attempt.id,
              ['initializing', 'active', 'ambiguous'],
              'failed',
            );
          }
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
      paidAmountK: judgement.amountK,
      when: new Date(),
      config: deps.config,
    });
    if (outcome === 'already_settled') {
      /* Another session of this charge settled it while this job was verifying (two
       * payments racing). If that was a different session, this is the duplicate. */
      const settling = await subscriptionsRepo.paidAttempt(tx, businessId, charge.id);
      if (settling && settling.providerReference !== providerReference) {
        if (attempt) {
          await subscriptionsRepo.moveAttempt(
            tx,
            businessId,
            attempt.id,
            ['initializing', 'active', 'ambiguous', 'superseded'],
            'duplicate_paid',
          );
        }
        await events.markProcessed(tx, eventId, 'duplicate_payment', businessId);
        log.warn(
          `subscription charge ${reference} was paid twice for business ${businessId} (a replaced checkout session was also paid); refund the duplicate`,
        );
        return;
      }
    }
    if (outcome === 'applied' || outcome === 'superseded') {
      /* The charge is paid, by this session. The session it was paid through is the
       * one on record, and any other live session must stop being presented: a later
       * payment on one is a duplicate to refund, never a second entitlement. */
      if (attempt) {
        await subscriptionsRepo.moveAttempt(
          tx,
          businessId,
          attempt.id,
          ['initializing', 'active', 'ambiguous', 'superseded'],
          'paid',
        );
      }
      await subscriptionsRepo.supersedeOtherLiveAttempts(
        tx,
        businessId,
        charge.id,
        attempt?.id ?? null,
      );
    }
    if (outcome === 'business_gone') {
      /* Retention deleted the business first, and with it this event, the job
       * and the charge: there is no row left to mark. The provider took money
       * for a tenant that no longer exists, and the only trace is this line,
       * so it carries the two non-PII identifiers an operator needs to match
       * the Paystack transaction (a tenant UUID and an RKD-SUB/RKD-PACK
       * reference). Never applied to anything. */
      log.warn(
        `subscription payment ${reference} arrived for business ${businessId}, which retention had already deleted; reconcile it at the provider`,
      );
    }
    // For 'business_gone' this updates nothing: the event went with the tenant.
    /* A superseded payment is already a work item on the CHARGE queue (OD-30);
     * flagging its event too would queue the same payment twice. */
    await events.markProcessed(
      tx,
      eventId,
      outcome === 'applied' || outcome === 'superseded'
        ? /* An overpayment is accepted (the month IS paid for) but flagged: the
           * excess is a refund decision for an operator (ADR 0024, G-107). */
          judgement.reconciliation === 'overpaid' && outcome === 'applied'
          ? 'overpaid'
          : null
        : outcome,
      businessId,
    );
    if (outcome === 'superseded') {
      log.warn(
        `subscription charge ${reference} was paid after a newer subscription decision for business ${businessId}; the payment is recorded, the plan change was refused, reconcile it`,
      );
    }
    if (outcome === 'applied') {
      log.log(`business ${businessId}: subscription charge ${charge.kind} applied`);
    }
  };
}

function eventKindOf(payload: unknown, vaultKey: string, externalId: string): string | null {
  let opened: unknown;
  try {
    opened = openPayload(payload, vaultKey, 'paystack', externalId);
  } catch {
    return null;
  }
  const parsed = paystackWebhookBody.safeParse(opened);
  return parsed.success ? summarisePaystackEvent(parsed.data).kind : null;
}

function referenceOf(payload: unknown, vaultKey: string, externalId: string): string | null {
  let opened: unknown;
  try {
    opened = openPayload(payload, vaultKey, 'paystack', externalId);
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
