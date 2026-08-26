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
import { events, jobsRepo, paymentsHub, settleRepo, type TenantDb } from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import { openPayload } from '../privacy/payload-vault.js';
import type { PaymentProviderPort } from '../payments/provider.port.js';
import type { CommandBus } from '../commands/command-bus.service.js';
import { confirmPaymentWork, type ConfirmPaymentInput } from '../commands/payment-commands.js';
import type { JobContext, JobHandler } from './runner.js';

export interface ProcessPaymentEventDeps {
  provider: PaymentProviderPort;
  config: Pick<ApiConfig, 'vaultKey' | 'commandConfirmPayment'>;
  commandBus: CommandBus;
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

    const reference = referenceOf(event.payload, deps.config.vaultKey, event.externalId);
    if (!reference) {
      await events.markProcessed(tx, eventId, 'unreadable_at_processing', businessId);
      return;
    }

    /**
     * Lazy expiry BEFORE judging: nothing sweeps intents on a schedule yet,
     * so an overdue intent still reads as live here. Sweeping first makes
     * "money after expiry is an exception" true by construction rather than
     * true only when a sweep happened to run.
     */
    await paymentsHub.expireOverdueIntents(tx, businessId);

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
      // this obligation's money, and loudly a human's problem. The exception
      // records the amount the provider reported, since that is the puzzle.
      await exception(tx, businessId, intent, judgement.reason, t.amountK);
      await events.markProcessed(tx, eventId, judgement.reason, businessId);
      return;
    }

    /* ── confirmed: one winner books it (§21–25) ──────────────────────── */
    const won = await paymentsHub.advanceIntent(tx, intent.id, 'succeeded', {
      providerReference: t.providerTransactionId,
    });
    if (!won) {
      /**
       * Losing means SOME terminal state, but `intent.status` was read before
       * the race — a worker that just lost to a parallel booking would still
       * see the pre-race value and mislabel a replay as a late payment. The
       * conditional UPDATE only returns after the winner commits, so a fresh
       * read here sees the truth.
       */
      const current = await paymentsHub.intentByReference(tx, businessId, reference);
      if (current?.status === 'succeeded') {
        // Layer 2 caught a replay: already booked, nothing downstream fires.
        await events.markProcessed(tx, eventId, 'already_booked', businessId);
      } else {
        // Real money confirmed against an expired/cancelled intent — late
        // by definition, and never booked silently (§37 "expired intent").
        // The exception records what actually ARRIVED, not what was expected.
        await exception(tx, businessId, intent, 'late_confirmation', judgement.amountK);
        await events.markProcessed(tx, eventId, 'late_confirmation', businessId);
      }
      return;
    }

    const connection = await paymentsHub.connectionFor(tx, businessId, deps.provider.providerType);
    const input: ConfirmPaymentInput = {
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
      paymentConnectionId: connection?.id ?? null,
      actor: 'system:payments',
      eventId,
    };

    /* The A1 rollout seam (spec §25): `confirmPaymentWork` books the money,
     * enqueues the receipt's paper and announces it, in this transaction;
     * the flag decides whether the bus's gates wrap the call. */
    let booked: Awaited<ReturnType<typeof confirmPaymentWork>>;
    if (deps.config.commandConfirmPayment) {
      const run = await deps.commandBus.run(
        tx,
        {
          businessId,
          command: 'ConfirmPayment',
          payload: input,
          actor: 'system:payments',
          ingress: 'AUTOMATION',
          idempotencyKey: `confirm:${intent.id}:${t.providerTransactionId}`,
        },
        () => confirmPaymentWork(tx, input),
      );
      if (run.outcome !== 'done') {
        /* Unreachable by construction — ConfirmPayment is STANDARD and
         * ungated — so reaching it is a bug worth a loud error. */
        throw new Error(`ConfirmPayment refused unexpectedly: ${run.outcome}`);
      }
      booked = run.result;
    } else {
      booked = await confirmPaymentWork(tx, input);
    }

    await events.markProcessed(tx, eventId, null, businessId);
    log.log(
      `booked ${intent.reference}: ${booked.reconciliation}` +
        (booked.receiptNumber ? `, receipt ${booked.receiptNumber}` : ''),
    );
  };
}

/**
 * A reconciliation exception with no payment row — money that did NOT book.
 * `amountK` is the amount the provider actually reported when one is known;
 * the intent's expectation is the fallback (a verify miss reports nothing).
 */
async function exception(
  tx: TenantDb,
  businessId: string,
  intent: { id: string; invoiceId: string | null; expectedAmountK: number },
  reason: string,
  amountK?: number,
): Promise<void> {
  await settleRepo.recordException(tx, {
    businessId,
    reason,
    expectationKind: intent.invoiceId ? 'invoice' : 'intent',
    expectationId: intent.invoiceId ?? intent.id,
    amountK: amountK ?? intent.expectedAmountK,
  });
}

function referenceOf(payload: unknown, vaultKey: string, externalId: string): string | null {
  let opened: unknown;
  try {
    opened = openPayload(payload, vaultKey, 'paystack', externalId);
  } catch {
    /* A seal that will not open is a KEY problem, not an event problem — the
     * pump refuses to drain the queue on it and so does this handler.
     * Throwing lets the job retry (and heal the moment VAULT_KEY is fixed)
     * and, failing that, die VISIBLY in queue health, instead of quietly
     * retiring a confirmed payment as "unreadable". */
    throw new Error('sealed Paystack payload would not open at processing time; check VAULT_KEY');
  }
  const parsed = paystackWebhookBody.safeParse(opened);
  if (!parsed.success) return null;
  return summarisePaystackEvent(parsed.data).reference;
}
