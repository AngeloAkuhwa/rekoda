/**
 * The payment commands (spec §25; PR-022): `RecordPayment`,
 * `ConfirmPayment`, `RecordPaymentEvidence`.
 *
 * Same pattern as PR-021: each function is the WORK an ingress used to hold
 * inline, and both flag positions call it — the rollout flag decides whether
 * `CommandBus.run`'s gates wrap the call, never what a payment is.
 *
 * The provenance split (§6.2) is the whole design: `recordPaymentWork` books
 * MERCHANT_ATTESTED money the merchant reported; `confirmPaymentWork` books
 * PROVIDER_VERIFIED money a server-side verify confirmed. They do not share
 * a function because they must never share a badge.
 *
 * `AllocatePayment` and `CreatePaymentIntent` are deliberately absent:
 * allocation today is implicit in the booking writers and gets its own
 * command when F1's append-only `PaymentAllocation` model lands, and an
 * intent's creation is dominated by a provider call that cannot sit inside
 * command-transaction work — it stays behind `PaymentIntentsService` until
 * P1 (PR-054) restructures attempts.
 */
import { evidenceRepo, jobsRepo, outboxRepo, settleRepo, type TenantDb } from '@rekoda/db';

/* ── RecordPayment (MERCHANT_ATTESTED) ──────────────────────────────────── */

export interface RecordPaymentInput {
  businessId: string;
  /** Chat resolved an invoice id; the dashboard types a NUMBER. Which one
   * arrives says which resolution the work runs — never both. */
  invoice: { id: string } | { number: string };
  /** Already gated in core — never a model's figure. */
  amountK: number;
  method: 'cash' | 'transfer';
  /* 'api' since PR-111: a public-API caller is a third front door, and the
   * record must say which one asserted the payment. */
  sourceType: 'chat' | 'dashboard' | 'api';
  sourceId: string;
  actor: string;
  clientRef?: string | null;
  /** TYPED · SPOKEN · SAW_AN_IMAGE · NOT_A_MESSAGE (spec E.7). Context for
   * a human, never a trust grade; absent when the ingress cannot say. */
  evidenceBasis?: string | null;
  /** The PaymentEvidence row this attestation cites, when an image came
   * with the claim. */
  paymentEvidenceId?: string | null;
}

/**
 * Every refusal is an outcome, not a thrown error, and that is load-bearing
 * here: the outcome IS the command's answer, so the idempotency snapshot
 * completes with it and a retried refusal replays as the same refusal
 * instead of leaving a claim forever "running".
 */
export type RecordPaymentResult =
  | {
      outcome: 'recorded';
      paymentId: string | null;
      receiptId: string;
      receiptNumber: string;
      invoiceNumber: string;
      amountK: number;
      balanceDueK: number;
      invoiceStatus: string;
    }
  | { outcome: 'not_found' }
  | { outcome: 'already_settled'; invoiceNumber: string }
  | { outcome: 'balance_moved'; invoiceNumber: string; balanceDueK: number; excessK: number };

export async function recordPaymentWork(
  tx: TenantDb,
  input: RecordPaymentInput,
): Promise<RecordPaymentResult> {
  let result: RecordPaymentResult;

  if ('number' in input.invoice) {
    const done = await settleRepo.recordPaymentByNumber(tx, {
      businessId: input.businessId,
      invoiceNumber: input.invoice.number,
      amountK: input.amountK,
      method: input.method,
      actor: input.actor,
      clientRef: input.clientRef ?? null,
      evidenceBasis: input.evidenceBasis ?? null,
    });
    if (done.outcome !== 'recorded') return done;
    result = {
      outcome: 'recorded',
      /* The by-number wrapper does not surface the payment id; the receipt
       * is the merchant-facing identity and the audit trail carries the
       * rest. Null rather than invented. */
      paymentId: null,
      receiptId: done.receiptId,
      receiptNumber: done.receiptNumber,
      invoiceNumber: done.invoiceNumber,
      amountK: done.amountK,
      balanceDueK: done.balanceDueK,
      invoiceStatus: done.balanceDueK === 0 ? 'paid' : 'partially_paid',
    };
  } else {
    try {
      const recorded = await settleRepo.recordMerchantPayment(tx, {
        businessId: input.businessId,
        invoiceId: input.invoice.id,
        amountK: input.amountK,
        method: input.method,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        actor: input.actor,
        clientRef: input.clientRef ?? null,
        evidenceBasis: input.evidenceBasis ?? null,
        paymentEvidenceId: input.paymentEvidenceId ?? null,
      });
      result = { outcome: 'recorded', ...recorded };
    } catch (error) {
      /* Application refusals thrown before any write — the transaction is
       * still healthy, and each is a sentence the merchant can act on. */
      if (error instanceof settleRepo.AlreadySettled) {
        return { outcome: 'already_settled', invoiceNumber: invoiceNameOf(error) };
      }
      if (error instanceof settleRepo.BalanceMoved) {
        return {
          outcome: 'balance_moved',
          invoiceNumber: error.invoiceNumber,
          balanceDueK: error.balanceDueK,
          excessK: error.excessK,
        };
      }
      throw error;
    }
  }

  /* The receipt's paper, in the same transaction, so paper and record commit
   * together — the singleton key both ingresses already used. */
  await jobsRepo.enqueue(tx, {
    businessId: input.businessId,
    kind: 'document.render',
    payload: { receiptId: result.receiptId },
    singletonKey: `receipt:${result.receiptId}`,
  });

  await outboxRepo.append(tx, {
    businessId: input.businessId,
    type: 'payment.recorded',
    payload: {
      receiptNumber: result.receiptNumber,
      invoiceNumber: result.invoiceNumber,
      amountK: result.amountK,
      balanceDueK: result.balanceDueK,
      sourceType: input.sourceType,
    },
  });

  return result;
}

/** `AlreadySettled`'s message carries the number; parsing it back out would
 * be brittle, so the outcome names the invoice only when it can. */
function invoiceNameOf(error: settleRepo.AlreadySettled): string {
  return error.message.split(' ')[0] ?? '';
}

/* ── ConfirmPayment (PROVIDER_VERIFIED) ─────────────────────────────────── */

export type ConfirmPaymentInput = Parameters<typeof settleRepo.bookVerifiedPayment>[1];
export type ConfirmedPayment = Awaited<ReturnType<typeof settleRepo.bookVerifiedPayment>>;

/**
 * Money a server-side verify confirmed: the booking, the receipt's paper,
 * and the announcement, in one transaction. The intent race, the exception
 * queue and "did real money arrive" all stay with the callers — they are
 * webhook-shape questions, and an ingress owns its shape.
 */
export async function confirmPaymentWork(
  tx: TenantDb,
  input: ConfirmPaymentInput,
): Promise<ConfirmedPayment> {
  const booked = await settleRepo.bookVerifiedPayment(tx, input);

  if (booked.receiptId) {
    await jobsRepo.enqueue(tx, {
      businessId: input.businessId,
      kind: 'document.render',
      payload: { receiptId: booked.receiptId },
      singletonKey: `render:receipt:${booked.receiptId}`,
    });
  }

  await outboxRepo.append(tx, {
    businessId: input.businessId,
    type: 'payment.confirmed',
    payload: {
      paymentId: booked.paymentId,
      reference: input.intent.reference,
      providerType: input.providerType,
      amountK: input.confirmedAmountK,
      receiptNumber: booked.receiptNumber,
      reconciliation: booked.reconciliation,
    },
  });

  return booked;
}

/* ── RecordPaymentEvidence (§6.1: proves nothing) ───────────────────────── */

export interface RecordPaymentEvidenceInput {
  businessId: string;
  customerId?: string | null;
  source: string;
  claimedAmountK?: number | null;
  /** Resolved now (the attestation it accompanies is the resolution), or
   * awaiting an answer with the §23 deadline. */
  resolution: Parameters<typeof evidenceRepo.recordEvidence>[1]['resolution'];
}

/**
 * The first `payment_evidence` writer. No outbox event, deliberately: the
 * evidence proves nothing (§6.1), so there is no financial fact to announce
 * — the payment that cites it announces itself.
 */
export async function recordPaymentEvidenceWork(
  tx: TenantDb,
  input: RecordPaymentEvidenceInput,
): Promise<{ evidenceId: string }> {
  const { id } = await evidenceRepo.recordEvidence(tx, {
    businessId: input.businessId,
    customerId: input.customerId ?? null,
    source: input.source,
    mediaRef: null,
    mediaMimeType: null,
    claimedAmountK: input.claimedAmountK ?? null,
    resolution: input.resolution,
  });
  return { evidenceId: id };
}
