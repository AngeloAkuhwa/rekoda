/**
 * The webhook-processing job (docs/payments-v1.md §20–25) — where a stored,
 * attributed provider event becomes (or pointedly does not become) money in
 * the books.
 *
 * The event body is treated as a HINT and nothing more. Every authoritative
 * number — amount, currency, status — comes from the provider's verify
 * endpoint, called server-side inside this job; a forged-but-somehow-signed
 * body, a stale retry and an honest webhook all converge on the same truth.
 *
 * Idempotency has three layers, each of which alone would do:
 *   1. the event table's (provider, external_id) uniqueness — a retried
 *      delivery is one row, one job (singleton-keyed on the event id);
 *   2. the intent's terminal-state gate — `advanceIntent` has one winner,
 *      and a second confirming event finds the transition already taken;
 *   3. the payments table's unique rekoda_reference — the backstop that
 *      turns any bug above into a loud error instead of a double booking.
 *
 * The handler's writes and the job's completion share one transaction (the
 * runner's contract), so "did this event get booked?" is a question with
 * exactly one answer.
 */
import { Logger } from '@nestjs/common';
import { judgeProviderPayment, type FeePolicy } from '@rekoda/core';
import { paystackWebhookBody, summarisePaystackEvent } from '@rekoda/contracts';
import { events, paymentsHub, settleRepo, type TenantDb } from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import { openPayload } from '../privacy/payload-vault.js';
import type { PaymentProviderPort } from '../payments/provider.port.js';
import type { JobContext, JobHandler } from './runner.js';

export interface ProcessPaymentEventDeps {
  provider: PaymentProviderPort;
  config: Pick<ApiConfig, 'vaultKey'>;
}

/** Provider statuses that mean "this attempt is over", not "still cooking". */
const DEAD_PROVIDER_STATUSES = new Set(['failed', 'abandoned', 'reversed']);

export function processPaymentEventHandler(deps: ProcessPaymentEventDeps): JobHandler {
  const log = new Logger('ProcessPaymentEventJob');

  return async ({ tx, payload, businessId }: JobContext): Promise<void> => {
    const eventId = typeof payload['eventId'] === 'string' ? payload['eventId'] : null;
    if (!eventId) throw new Error('payment.process: payload is missing eventId');

    // Tenant-scoped read: a stray id from a payload cannot reach another
    // tenant's event (the one no-RLS table, so the predicate matters).
    const event = await events.eventForBusiness(tx, eventId, businessId);
    if (!event) {
      log.warn('payment.process: no such event for this tenant');
      return;
    }

    const reference = referenceOf(event.payload, deps.config.vaultKey);
    if (!reference) {
      await events.markProcessed(tx, eventId, 'unreadable_at_processing', businessId);
      return;
    }

    const intent = await paymentsHub.intentByReference(tx, businessId, reference);
    if (!intent) {
      // Attribution said this business; the tenant-scoped read disagrees.
      // That inconsistency is exactly what must never be papered over.
      await events.markProcessed(tx, eventId, 'intent_missing_for_tenant', businessId);
      return;
    }

    /* ── the authoritative call (§20) ─────────────────────────────────── */
    const verified = await deps.provider.verifyTransaction(reference);
    if (!verified.found) {
      // A signed event for a transaction the provider says does not exist.
      // Recorded as an exception — this is either provider lag or something
      // a human should be staring at.
      await exception(tx, businessId, intent, 'verify_not_found');
      await events.markProcessed(tx, eventId, 'verify_not_found', businessId);
      return;
    }
    const t = verified.transaction;

    const judgement = judgeProviderPayment(
      { reference: intent.reference, amountK: intent.expectedAmountK, currency: intent.currency },
      { reference: t.reference, amountK: t.amountK, currency: t.currency, succeeded: t.succeeded },
    );

    if (judgement.verdict === 'rejected') {
      if (judgement.reason === 'provider_not_success') {
        if (DEAD_PROVIDER_STATUSES.has(t.providerStatus)) {
          // The attempt is over. The intent follows it; the obligation stays.
          await paymentsHub.advanceIntent(tx, intent.id, 'failed', {
            providerReference: t.providerTransactionId,
          });
          await events.markProcessed(tx, eventId, `provider_${t.providerStatus}`, businessId);
        } else {
          // Pending/ongoing: not a failure, just not money yet. The success
          // event, when it comes, is a NEW event — nothing to retry here.
          await events.markProcessed(tx, eventId, 'provider_pending', businessId);
        }
        return;
      }
      // Wrong currency or a non-positive amount, CONFIRMED by verify — not
      // this obligation's money, and loudly a human's problem.
      await exception(tx, businessId, intent, judgement.reason);
      await events.markProcessed(tx, eventId, judgement.reason, businessId);
      return;
    }

    /* ── confirmed: one winner books it (§21–25) ──────────────────────── */
    const won = await paymentsHub.advanceIntent(tx, intent.id, 'succeeded', {
      providerReference: t.providerTransactionId,
    });
    if (!won) {
      if (intent.status === 'succeeded') {
        // Layer 2 caught a replay: already booked, nothing downstream fires.
        await events.markProcessed(tx, eventId, 'already_booked', businessId);
      } else {
        // Real money confirmed against an expired/cancelled intent — late
        // by definition, and never booked silently (§37 "expired intent").
        await exception(tx, businessId, intent, 'late_confirmation');
        await events.markProcessed(tx, eventId, 'late_confirmation', businessId);
      }
      return;
    }

    const connection = await paymentsHub.connectionFor(tx, businessId, deps.provider.providerType);
    const booked = await settleRepo.bookVerifiedPayment(tx, {
      businessId,
      intent: {
        id: intent.id,
        reference: intent.reference,
        invoiceId: intent.invoiceId,
        customerId: intent.customerId,
      },
      confirmedAmountK: judgement.amountK,
      currency: t.currency.toUpperCase(),
      providerType: deps.provider.providerType,
      providerRef: t.providerTransactionId,
      providerStatus: t.providerStatus,
      providerFeeK: t.providerFeeK,
      feePolicy: (connection?.feePolicy ?? 'merchant_bearing') as FeePolicy,
      method: t.method,
      actor: 'system:payments',
      eventId,
    });

    await events.markProcessed(tx, eventId, null, businessId);
    log.log(
      `booked ${intent.reference}: ${booked.reconciliation}` +
        (booked.receiptNumber ? `, receipt ${booked.receiptNumber}` : ''),
    );
  };
}

/** A reconciliation exception with no payment row — money that did NOT book. */
async function exception(
  tx: TenantDb,
  businessId: string,
  intent: { id: string; invoiceId: string | null; expectedAmountK: number },
  reason: string,
): Promise<void> {
  await settleRepo.recordException(tx, {
    businessId,
    reason,
    expectationKind: intent.invoiceId ? 'invoice' : 'intent',
    expectationId: intent.invoiceId ?? intent.id,
    amountK: intent.expectedAmountK,
  });
}

function referenceOf(payload: unknown, vaultKey: string): string | null {
  try {
    const parsed = paystackWebhookBody.safeParse(openPayload(payload, vaultKey));
    if (!parsed.success) return null;
    return summarisePaystackEvent(parsed.data).reference;
  } catch {
    return null;
  }
}
