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
 *
 * Which pipeline an event enters is decided by its KIND — the event name,
 * for refunds and disputes; every other kind (a charge, and anything the
 * summary does not classify) walks the charge confirmation path below, where
 * a verify that finds nothing retires it. Provider-executed refunds and
 * chargebacks are recorded here as facts, not authorised as commands, so
 * they do not pass the CommandBus; `auditPaymentAdjustment` writes the
 * actor and reason Appendix D.2 asks for.
 *
 * never the payload (G-06). A charge event walks the confirmation path
 * below, unchanged. A refund event or a dispute event is about money going
 * BACK on a payment already booked, and is handled by its own branch: the
 * same verify-first rule, the same one-transaction rule, and the repos that
 * record and post refunds, reversals and chargebacks (0091, 0092). Before
 * this, every one of those events was judged as a fresh confirmation of the
 * original charge and retired as `already_booked`, and the books kept saying
 * the customer had paid.
 */
import { Logger } from '@nestjs/common';
import { judgeProviderPayment, type FeePolicy } from '@rekoda/core';
import {
  paystackWebhookBody,
  summarisePaystackEvent,
  type PaystackEventSummary,
} from '@rekoda/contracts';
import { events, jobsRepo, paymentsHub, refundsRepo, settleRepo, type TenantDb } from '@rekoda/db';
import { isProductionEnv, type ApiConfig } from '../config.js';
import { openPayload } from '../privacy/payload-vault.js';
import type { PaymentProviderPort } from '../payments/provider.port.js';
import type { CommandBus } from '../commands/command-bus.service.js';
import { confirmPaymentWork, type ConfirmPaymentInput } from '../commands/payment-commands.js';
import {
  chargebackPaymentWork,
  refundPaymentWork,
  reversePaymentWork,
} from '../commands/payment-adjustment-commands.js';
import type { JobContext, JobHandler } from './runner.js';
import { describeFailure } from './runner.js';
import type { VerifiedRefund } from '../payments/provider.port.js';

export interface ProcessPaymentEventDeps {
  provider: PaymentProviderPort;
  config: Pick<ApiConfig, 'vaultKey' | 'commandConfirmPayment'>;
  commandBus: CommandBus;
}

/** Provider statuses that mean "this attempt is over", not "still cooking". */
const DEAD_PROVIDER_STATUSES = new Set(['failed', 'abandoned', 'reversed']);

const ACTOR = 'system:payments';

type Intent = NonNullable<Awaited<ReturnType<typeof paymentsHub.intentByReference>>>;

export function processPaymentEventHandler(deps: ProcessPaymentEventDeps): JobHandler {
  const log = new Logger('ProcessPaymentEventJob');

  return async ({ tx, payload, businessId, attempt, maxAttempts }: JobContext): Promise<void> => {
    const eventId = typeof payload['eventId'] === 'string' ? payload['eventId'] : null;
    if (!eventId) throw new Error('payment.process: payload is missing eventId');

    // Tenant-scoped read: a stray id from a payload cannot reach another
    // tenant's event (the one no-RLS table, so the predicate matters).
    const event = await events.eventForBusiness(tx, eventId, businessId);
    if (!event) {
      log.warn('payment.process: no such event for this tenant');
      return;
    }

    const summary = summaryOf(event.payload, deps.config.vaultKey, event.externalId);
    const reference = summary?.reference ?? null;
    if (!summary || !reference) {
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

    const ctx: Ctx = { tx, businessId, eventId, intent, summary, log, attempt, maxAttempts };
    if (summary.kind === 'refund') return handleRefund(deps, ctx);
    if (summary.kind === 'dispute') return handleDispute(deps, ctx);

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
        /**
         * The provider now says a payment it once confirmed is REVERSED —
         * undone on its side before it paid out (§14.3 PaymentReversal).
         * Only a booked payment can be undone; anything else on this
         * status is the ordinary dead-attempt case below.
         */
        if (t.providerStatus === 'reversed' && intent.status === 'succeeded') {
          return handleReversal(deps, ctx, t.providerTransactionId);
        }
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
      actor: ACTOR,
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
          actor: ACTOR,
          ingress: 'AUTOMATION',
          idempotencyKey: `confirm:${intent.id}:${t.providerTransactionId}`,
        },
        () => confirmPaymentWork(tx, input, { requireLiveProvider: isProductionEnv(process.env) }),
      );
      if (run.outcome !== 'done') {
        /* Unreachable by construction — ConfirmPayment is STANDARD and
         * ungated — so reaching it is a bug worth a loud error. */
        throw new Error(`ConfirmPayment refused unexpectedly: ${run.outcome}`);
      }
      booked = run.result;
    } else {
      booked = await confirmPaymentWork(tx, input, {
        requireLiveProvider: isProductionEnv(process.env),
      });
    }

    await events.markProcessed(tx, eventId, null, businessId);
    log.log(
      `booked ${intent.reference}: ${booked.reconciliation}` +
        (booked.receiptNumber ? `, receipt ${booked.receiptNumber}` : ''),
    );
  };
}

/* ── money going back (G-06) ─────────────────────────────────────────────── */

interface Ctx {
  tx: TenantDb;
  businessId: string;
  eventId: string;
  intent: Intent;
  summary: PaystackEventSummary;
  log: Logger;
  /** This job's attempt and the queue's ceiling for it. */
  attempt: number;
  maxAttempts: number;
}

/**
 * A refund event. Only `refund.processed` means money actually went back;
 * the pending and failed stages are recorded and nothing moves. Then the
 * same discipline as a charge: the provider's refund read is the truth, the
 * envelope is the hint, and a truth that does not describe THIS payment —
 * another reference, another currency, more than was paid — is a human's
 * question, never a posting.
 */
/**
 * A `refund.processed` event whose provider read has not caught up. Thrown
 * so the job attempt fails and is retried; see `handleRefund`.
 */
export class RefundReadLagging extends Error {
  constructor(providerRefundId: string, providerStatus: string) {
    super(
      `refund ${providerRefundId} reads as ${providerStatus} on a refund.processed event; retrying`,
    );
  }
}

/**
 * The provider's own record of the refund this event announces.
 *
 * With a refund id in the envelope, `GET /refund/:id`. The documented
 * Paystack refund envelope carries NO refund id, only the charge's
 * reference, so without one the refund is found among the refunds the
 * provider lists against the charge (by the transaction id the booking
 * stored), matched on the envelope's amount when it has one. A read that
 * finds nothing yet, or that fails, is retried by the runner and becomes an
 * exception on the last attempt — never a dead job, never a retirement
 * that loses the refund (the redelivery is dropped at ingress).
 */
async function readRefundForEvent(
  deps: ProcessPaymentEventDeps,
  ctx: Ctx,
  providerTransactionId: string | null,
): Promise<{ refund: VerifiedRefund } | { reason: string; amountK: number | null }> {
  const { summary } = ctx;
  const lastAttempt = ctx.attempt >= ctx.maxAttempts;
  try {
    if (summary.objectId) {
      const verified = await deps.provider.verifyRefund(summary.objectId);
      if (verified.found) return { refund: verified.refund };
      if (lastAttempt) return { reason: 'refund_verify_not_found', amountK: summary.amountK };
      throw new RefundReadLagging(summary.objectId, 'not found');
    }
    if (!providerTransactionId) {
      return { reason: 'refund_without_provider_id', amountK: summary.amountK };
    }
    const listed = await deps.provider.listRefunds(providerTransactionId);
    const matching = listed.filter(
      (c) => c.succeeded && (summary.amountK === null || c.amountK === summary.amountK),
    );
    /* Refunds already on file are not candidates: two equal partial refunds
     * are routine, and the second event announces the one not yet booked. */
    const onFile = new Set(
      (await refundsRepo.refundsFor(ctx.tx, ctx.businessId)).map((r) => r.providerRefundId),
    );
    const fresh = matching.filter((c) => !onFile.has(c.providerRefundId));
    if (fresh.length === 1) return { refund: fresh[0]! };
    if (fresh.length > 1) return { reason: 'refund_ambiguous', amountK: summary.amountK };
    /* Everything that matches is already booked: a redelivery under a new
     * fingerprint. The command answers already_recorded for it. */
    if (matching.length > 0) return { refund: matching[0]! };
    if (lastAttempt) return { reason: 'refund_verify_not_found', amountK: summary.amountK };
    throw new RefundReadLagging(providerTransactionId, 'no processed refund listed yet');
  } catch (error) {
    if (error instanceof RefundReadLagging) throw error;
    if (!lastAttempt) throw error;
    /* The last attempt: a provider that could not be read (an outage, an
     * unreadable response) is a row a human reviews, not a dead job. */
    ctx.log.warn(`refund read failed on the last attempt: ${describeFailure(error)}`);
    return { reason: 'refund_read_unavailable', amountK: summary.amountK };
  }
}

async function handleRefund(deps: ProcessPaymentEventDeps, ctx: Ctx): Promise<void> {
  const { tx, businessId, eventId, intent, summary } = ctx;

  if (summary.eventType === 'refund.needs-attention') {
    /* Paystack says this refund could not complete on its own and needs a
     * human: that is an exception in the merchant's queue, never a label. */
    await flag(ctx, 'refund_needs_attention', summary.amountK);
    return;
  }
  if (summary.eventType !== 'refund.processed') {
    /* Nothing has moved yet (pending, processing) or nothing will (failed):
     * retired with the stage as the reason, for the audit trail. */
    const stage =
      summary.eventType === 'refund.failed'
        ? 'refund_failed'
        : summary.eventType === 'refund.processing'
          ? 'refund_processing'
          : 'refund_pending';
    await events.markProcessed(tx, eventId, stage, businessId);
    return;
  }

  const payment = await settleRepo.paymentForIntent(tx, businessId, intent.id);
  if (!payment) {
    // A refund of money Rekoda never booked. Nothing to reverse; a human
    // decides what this is.
    await flag(ctx, 'refund_without_booked_payment', summary.amountK);
    return;
  }
  /* ── the authoritative call ─────────────────────────────────────────── */
  const read = await readRefundForEvent(deps, ctx, intent.providerReference ?? null);
  if ('reason' in read) {
    await flag(ctx, read.reason, read.amountK);
    return;
  }
  const r = read.refund;
  if (!r.succeeded) {
    if (r.providerStatus === 'failed') {
      // The envelope said processed; the provider's own record says it
      // failed. Two provider truths disagree: a human's, not a posting.
      await flag(ctx, 'refund_failed_on_processed_event', r.amountK);
      return;
    }
    /* The envelope said processed; the read still says pending. A later
     * redelivery of the same event carries the same refund id and is
     * dropped at ingress as a duplicate, so retiring this one here would
     * lose the refund for good. Fail the attempt instead: the runner
     * retries with backoff. On the LAST attempt the disagreement becomes an
     * exception in the merchant's queue and the event is retired with that
     * reason, so a refund that never turns processed is a row somebody
     * reviews, never a dead job nobody looks at. */
    if (ctx.attempt >= ctx.maxAttempts) {
      await flag(ctx, 'refund_read_never_processed', r.amountK);
      return;
    }
    throw new RefundReadLagging(r.providerRefundId, r.providerStatus);
  }
  const mismatch = describesPayment(
    r.transactionReference,
    r.transactionId,
    r.currency,
    r.amountK,
    intent,
    payment,
  );
  if (mismatch) {
    await flag(ctx, mismatch, r.amountK);
    return;
  }

  const connection = await paymentsHub.connectionFor(tx, businessId, deps.provider.providerType);
  const result = await refundPaymentWork(tx, {
    businessId,
    paymentId: payment.id,
    paymentAmountK: payment.amountK,
    amountK: r.amountK,
    providerRefundId: r.providerRefundId,
    paymentConnectionId: connection?.id ?? null,
    reason: `provider refund ${r.providerRefundId}`,
    actor: ACTOR,
    eventId,
  });

  switch (result.outcome) {
    case 'refunded':
      await events.markProcessed(tx, eventId, null, businessId);
      ctx.log.log(
        `refunded ${intent.reference}: ${result.lifecycle}, ` +
          `${result.unwind.unwound.length} allocation(s) unwound`,
      );
      return;
    case 'already_recorded':
      // The provider re-notifying an executed refund: one row, one posting.
      await events.markProcessed(tx, eventId, 'refund_already_recorded', businessId);
      return;
    default:
      await flag(ctx, `refund_${result.outcome}`, r.amountK);
      return;
  }
}

/**
 * A dispute event. Opening one moves no money: it is filed as an exception
 * so somebody is looking. Only a dispute the provider reports as LOST —
 * verified by its own read, never from the envelope — becomes a chargeback,
 * with the timing (clearing reversal or a payable to the provider) decided
 * by the payment's settlement state inside the repo (§21).
 */
async function handleDispute(deps: ProcessPaymentEventDeps, ctx: Ctx): Promise<void> {
  const { tx, businessId, eventId, intent, summary } = ctx;

  const payment = await settleRepo.paymentForIntent(tx, businessId, intent.id);
  if (!payment) {
    await flag(ctx, 'dispute_without_booked_payment', summary.amountK);
    return;
  }
  if (!summary.objectId) {
    await flag(ctx, 'dispute_without_provider_id', summary.amountK);
    return;
  }

  const verified = await deps.provider.verifyDispute(summary.objectId);
  if (!verified.found) {
    await flag(ctx, 'dispute_verify_not_found', summary.amountK);
    return;
  }
  const d = verified.dispute;

  if (d.outcome === 'open' && d.providerStatus === 'resolved') {
    /* A resolution word Rekoda does not know (`disputeOutcome` maps only
     * the published vocabulary, OD-9). Not "still open": a distinct row
     * every time, so a lost dispute under an unknown word is never hidden
     * behind an earlier dispute-opened exception. */
    await flag(ctx, 'dispute_resolution_unrecognised', d.amountK ?? summary.amountK);
    return;
  }
  if (d.outcome === 'open') {
    // Pending: a risk state, not a reversal. One exception per dispute,
    // however many reminders the provider sends.
    await flagOnce(
      ctx,
      'dispute_opened',
      summary.eventType === 'charge.dispute.remind' ? 'dispute_reminder' : 'dispute_opened',
      d.amountK ?? summary.amountK,
    );
    return;
  }
  if (d.outcome === 'won') {
    // Closed in the merchant's favour: nothing moves; the operator closes
    // the exception the opening left.
    await events.markProcessed(tx, eventId, 'dispute_won', businessId);
    return;
  }

  /* The amount that posts comes from the provider's own record of the
   * dispute, never from the envelope: a webhook is a hint about which
   * dispute to read, and its amount may describe an earlier state of it.
   * The envelope's figure may describe the exception, not the posting. */
  if (d.amountK === null) {
    await flag(ctx, 'chargeback_without_amount', summary.amountK);
    return;
  }
  const amountK = d.amountK;
  const mismatch = describesPayment(
    d.transactionReference,
    null,
    d.currency,
    amountK,
    intent,
    payment,
  );
  if (mismatch) {
    await flag(ctx, mismatch.replace('refund_', 'chargeback_'), amountK);
    return;
  }
  const connection = await paymentsHub.connectionFor(tx, businessId, deps.provider.providerType);
  if (!connection) {
    await flag(ctx, 'chargeback_without_connection', amountK);
    return;
  }

  const result = await chargebackPaymentWork(tx, {
    businessId,
    paymentId: payment.id,
    paymentAmountK: payment.amountK,
    paymentConnectionId: connection.id,
    providerChargebackId: d.providerDisputeId,
    amountK,
    reason: `dispute ${d.providerDisputeId} ${d.providerResolution ?? 'lost'}`,
    actor: ACTOR,
    eventId,
  });
  switch (result.outcome) {
    case 'charged_back':
      await events.markProcessed(tx, eventId, null, businessId);
      ctx.log.log(`chargeback on ${intent.reference}: ${result.timing}`);
      return;
    case 'already_recorded':
      await events.markProcessed(tx, eventId, 'chargeback_already_recorded', businessId);
      return;
    default:
      await flag(ctx, `chargeback_${result.outcome}`, amountK);
      return;
  }
}

/**
 * The provider's verify now says a booked payment is REVERSED. Before the
 * payout that is a PaymentReversal (whole, once, back through clearing).
 * After the payout it is a refund or a chargeback and which one is not the
 * provider status's to say — a human's, with the payment left standing.
 */
async function handleReversal(
  deps: ProcessPaymentEventDeps,
  ctx: Ctx,
  providerTransactionId: string,
): Promise<void> {
  const { tx, businessId, eventId, intent } = ctx;
  const payment = await settleRepo.paymentForIntent(tx, businessId, intent.id);
  if (!payment) {
    await flag(ctx, 'reversal_without_booked_payment', null);
    return;
  }
  if (await refundsRepo.paymentSettled(tx, businessId, payment.id)) {
    await flag(ctx, 'reversal_after_settlement', payment.amountK);
    return;
  }
  const connection = await paymentsHub.connectionFor(tx, businessId, deps.provider.providerType);
  if (!connection) {
    await flag(ctx, 'reversal_without_connection', payment.amountK);
    return;
  }
  const result = await reversePaymentWork(tx, {
    businessId,
    paymentId: payment.id,
    paymentAmountK: payment.amountK,
    paymentConnectionId: connection.id,
    providerReversalId: providerTransactionId,
    reason: 'provider reported the charge reversed',
    actor: ACTOR,
    eventId,
  });
  switch (result.outcome) {
    case 'reversed':
      await events.markProcessed(tx, eventId, null, businessId);
      ctx.log.log(`reversed ${intent.reference}: ${result.unwind.unwound.length} allocation(s)`);
      return;
    case 'already_recorded':
      await events.markProcessed(tx, eventId, 'reversal_already_recorded', businessId);
      return;
    default:
      await flag(ctx, `reversal_${result.outcome}`, payment.amountK);
      return;
  }
}

/**
 * Does the provider's truth describe THIS payment? A different charge
 * reference, a different currency, or more than the payment ever held are
 * each a reason to stop and ask rather than post.
 */
function describesPayment(
  transactionReference: string | null,
  transactionId: string | null,
  currency: string | null,
  amountK: number,
  intent: Intent,
  payment: { amountK: number; currency: string | null },
): string | null {
  if (transactionReference) {
    if (transactionReference !== intent.reference) return 'refund_reference_mismatch';
  } else if (transactionId) {
    /* Paystack's refund read names the charge by transaction id, not by
     * reference: the booking stored that id on the intent from the charge's
     * own verify (`advanceIntent`, `providerReference`). */
    if (!intent.providerReference || transactionId !== intent.providerReference) {
      return 'refund_reference_mismatch';
    }
  } else {
    /* The provider's own record names no charge: the envelope alone said
     * which payment this is about, and the envelope is a hint. */
    return 'refund_reference_missing';
  }
  if (currency && payment.currency && currency.toUpperCase() !== payment.currency.toUpperCase()) {
    return 'refund_currency_mismatch';
  }
  if (!Number.isSafeInteger(amountK) || amountK <= 0 || amountK > payment.amountK) {
    return 'refund_amount_mismatch';
  }
  return null;
}

/** File an exception for a human AND retire the event with the same reason. */
async function flag(ctx: Ctx, reason: string, amountK: number | null): Promise<void> {
  await exception(ctx.tx, ctx.businessId, ctx.intent, reason, amountK);
  await events.markProcessed(ctx.tx, ctx.eventId, reason, ctx.businessId);
}

/** Like `flag`, but one exception per expectation however many events say so. */
async function flagOnce(
  ctx: Ctx,
  exceptionReason: string,
  eventReason: string,
  amountK: number | null,
): Promise<void> {
  const kind = ctx.intent.invoiceId ? 'invoice' : 'intent';
  const id = ctx.intent.invoiceId ?? ctx.intent.id;
  /* Once per REASON, while it is OPEN: an obligation that already carries
   * an overpaid or duplicate row, or one a human has resolved, still gets
   * its dispute-opened row. `hasException` (any reason, any state) would
   * swallow it. */
  if (!(await settleRepo.hasOpenException(ctx.tx, ctx.businessId, kind, id, exceptionReason))) {
    await exception(ctx.tx, ctx.businessId, ctx.intent, exceptionReason, amountK);
  }
  await events.markProcessed(ctx.tx, ctx.eventId, eventReason, ctx.businessId);
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
  /** `undefined`: the intent's expectation is the best figure. `null`: no
   * figure is known. A number is kept only if it is an integer kobo the
   * column can hold; a provider envelope is unvalidated input and must not
   * turn a fail-safe exception into a failed insert (and a dead job). */
  amountK?: number | null,
): Promise<void> {
  const recorded =
    amountK === undefined ? intent.expectedAmountK : Number.isSafeInteger(amountK) ? amountK : null;
  await settleRepo.recordException(tx, {
    businessId,
    reason,
    expectationKind: intent.invoiceId ? 'invoice' : 'intent',
    expectationId: intent.invoiceId ?? intent.id,
    amountK: recorded,
  });
}

function summaryOf(
  payload: unknown,
  vaultKey: string,
  externalId: string,
): PaystackEventSummary | null {
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
  return summarisePaystackEvent(parsed.data);
}
