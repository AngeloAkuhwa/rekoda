/**
 * Money going BACK: refunds, payment reversals and chargebacks that the
 * provider reports (spec §6.1, §14.2–§14.3, §21; launch gap G-06).
 *
 * Three facts, three records, three postings — the repos already keep them
 * distinct (0091, 0092) and post them balanced. What every one of them
 * shares, and what lived nowhere before this file, is the RECEIVABLE side:
 * a payment that answered an invoice stops answering it, wholly or partly,
 * and the invoice must say so. That is done the only way §14.2 allows —
 * a full reversal row per allocation, then a fresh allocation of whatever
 * the customer still paid — and the invoice's stored figures are then
 * re-derived from the subledger by the same query the proving rebuild uses.
 *
 * Nothing here edits a journal, a payment amount, a provenance field or a
 * receipt. The payment's lifecycle word changes; what it WAS stays on the
 * rows that recorded it.
 *
 * Deterministic and conservative: a refund larger than what the payment
 * still answers (the overpaid part sits in customer credit, whose refund is
 * a different posting nobody has ruled on) is refused to the caller, which
 * files it for a human. Nothing is posted hopefully.
 */
import {
  chargebacksRepo,
  projectionsRepo,
  refundsRepo,
  settleRepo,
  type TenantDb,
} from '@rekoda/db';

/* ── the receivable side, shared by all three ───────────────────────────── */

export interface UnwoundAllocation {
  allocationId: string;
  invoiceId: string;
  /** How much of this allocation stopped answering the invoice. */
  amountK: number;
}

export interface UnwindOutcome {
  unwound: UnwoundAllocation[];
  /** Invoices whose stored figures the projection rebuild changed. */
  invoicesReopened: string[];
}

/**
 * Take `amountK` back out of what the payment answers, newest allocation
 * first. Each touched allocation is reversed in full (§14.2 has no partial
 * reversal); when the amount runs out mid-allocation, the remainder is
 * re-allocated to the same invoice as a fresh row. The caller has already
 * checked that `amountK` does not exceed what stands.
 */
export async function unwindAllocations(
  tx: TenantDb,
  input: {
    businessId: string;
    paymentId: string;
    amountK: number;
    reason: string;
    sourceType: 'refund' | 'payment_reversal' | 'chargeback';
    sourceId: string;
  },
): Promise<UnwindOutcome> {
  const standing = await settleRepo.standingAllocationsFor(tx, input.businessId, input.paymentId);
  let remaining = input.amountK;
  const unwound: UnwoundAllocation[] = [];
  const touched = new Set<string>();

  for (const allocation of standing) {
    if (remaining <= 0) break;
    const reversed = await settleRepo.reverseAllocation(tx, {
      businessId: input.businessId,
      allocationId: allocation.id,
      reason: input.reason,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    });
    if (reversed.outcome !== 'reversed') {
      /* Unreachable: `standingAllocationsFor` returned only rows with no
       * reversal, inside this transaction. Loud rather than silent. */
      throw new Error(`unwindAllocations: ${reversed.outcome} on ${allocation.id}`);
    }
    touched.add(allocation.invoiceId);
    if (remaining >= allocation.amountK) {
      unwound.push({
        allocationId: allocation.id,
        invoiceId: allocation.invoiceId,
        amountK: allocation.amountK,
      });
      remaining -= allocation.amountK;
    } else {
      await settleRepo.allocatePayment(tx, {
        businessId: input.businessId,
        paymentId: input.paymentId,
        invoiceId: allocation.invoiceId,
        amountK: allocation.amountK - remaining,
        reason: `retained after ${input.sourceType.replace('_', ' ')}: ${input.reason}`,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
      });
      unwound.push({
        allocationId: allocation.id,
        invoiceId: allocation.invoiceId,
        amountK: remaining,
      });
      remaining = 0;
    }
  }
  if (remaining > 0) {
    throw new Error('unwindAllocations: amount exceeds standing allocations (caller must check)');
  }

  const invoicesReopened: string[] = [];
  for (const invoiceId of touched) {
    invoicesReopened.push(
      ...(await projectionsRepo.rebuildInvoiceProjection(tx, input.businessId, invoiceId)),
    );
  }
  return { unwound, invoicesReopened: invoicesReopened.sort() };
}

async function standingTotalK(tx: TenantDb, businessId: string, paymentId: string) {
  const standing = await settleRepo.standingAllocationsFor(tx, businessId, paymentId);
  return standing.reduce((sum, a) => sum + a.amountK, 0);
}

/* ── RefundPayment ──────────────────────────────────────────────────────── */

export interface RefundPaymentInput {
  businessId: string;
  paymentId: string;
  /** The payment's own amount, as booked. */
  paymentAmountK: number;
  /** Integer kobo the provider confirmed it returned. */
  amountK: number;
  providerRefundId: string;
  /** Whether the provider had already paid this payment out (§20). */
  settled: boolean;
  paymentConnectionId: string | null;
  reason: string;
  actor: string;
  /** The provider event this answers — the audit link (G-06 invariant 14). */
  eventId: string;
}

export type RefundPaymentResult =
  | { outcome: 'refunded'; refundId: string; unwind: UnwindOutcome; lifecycle: string }
  /** The provider re-notifying an executed refund: nothing changed. */
  | { outcome: 'already_recorded'; refundId: string }
  /** More than the payment still answers: the excess sits in customer
   * credit, whose refund is a posting nobody has ruled on. A human's. */
  | { outcome: 'exceeds_allocations'; standingK: number }
  | { outcome: 'exceeds_payment'; refundedSoFarK: number }
  /** The payment was booked as an overpayment: part of it is customer
   * credit, and refunding ANY of it is partly an OverpaymentRefund (§14.3),
   * whose posting nobody has ruled on (OD-8). A human's. */
  | { outcome: 'overpaid_payment' }
  /** The payment already carries a chargeback. Paystack refunds the customer
   * itself when a dispute is accepted, and may describe that one movement of
   * money twice (a dispute resolution and a refund object). Two facts, one
   * movement: until the G-05 drill says how the provider reports it (OD-11),
   * the second is a human's, never a second posting. */
  | { outcome: 'payment_under_chargeback' }
  | { outcome: 'payment_not_found' }
  | { outcome: 'no_clearing_account' };

export async function refundPaymentWork(
  tx: TenantDb,
  input: RefundPaymentInput,
): Promise<RefundPaymentResult> {
  if (
    (await chargebacksRepo.chargebacksFor(tx, input.businessId)).some(
      (c) => c.paymentId === input.paymentId,
    )
  ) {
    return { outcome: 'payment_under_chargeback' };
  }
  if (await settleRepo.paymentWasOverpaid(tx, input.businessId, input.paymentId)) {
    /* Refunding only the invoice half would reopen an invoice the customer
     * has paid while their credit stands untouched (§14.3: never collapse
     * a refund and an overpayment refund into one). Nothing posts. */
    return { outcome: 'overpaid_payment' };
  }
  const standingK = await standingTotalK(tx, input.businessId, input.paymentId);
  if (input.amountK > standingK) {
    /* Unless the provider is merely re-notifying — then the refund is
     * already on file and the allocations already moved. */
    const existing = (await refundsRepo.refundsFor(tx, input.businessId)).find(
      (r) => r.providerRefundId === input.providerRefundId,
    );
    if (existing) return { outcome: 'already_recorded', refundId: existing.id };
    return { outcome: 'exceeds_allocations', standingK };
  }

  /* Where the money physically left from: the clearing account while the
   * provider still held it, the bank once it had paid out. A booking with
   * no connection posted to the bank directly, so its refund does too. */
  const method = !input.settled && input.paymentConnectionId ? 'provider' : 'bank';
  const recorded = await refundsRepo.recordRefund(tx, {
    businessId: input.businessId,
    paymentId: input.paymentId,
    amountK: input.amountK,
    method,
    ...(method === 'provider' ? { paymentConnectionId: input.paymentConnectionId! } : {}),
    reason: input.reason,
    actor: input.actor,
    providerRefundId: input.providerRefundId,
  });
  if (recorded.outcome !== 'recorded') return recorded;
  if (!recorded.isNew) return { outcome: 'already_recorded', refundId: recorded.id };

  const unwind = await unwindAllocations(tx, {
    businessId: input.businessId,
    paymentId: input.paymentId,
    amountK: input.amountK,
    reason: input.reason,
    sourceType: 'refund',
    sourceId: recorded.id,
  });

  const refundedK = (await refundsRepo.refundsFor(tx, input.businessId))
    .filter((r) => r.paymentId === input.paymentId)
    .reduce((sum, r) => sum + r.amountK, 0);
  const lifecycle = refundedK >= input.paymentAmountK ? 'refunded' : 'partially_refunded';
  await settleRepo.markPaymentLifecycle(tx, input.businessId, input.paymentId, lifecycle);

  await settleRepo.auditPaymentAdjustment(tx, {
    businessId: input.businessId,
    paymentId: input.paymentId,
    actor: input.actor,
    action: 'refunded',
    detail: {
      eventId: input.eventId,
      refundId: recorded.id,
      providerRefundId: input.providerRefundId,
      amountK: input.amountK,
      method,
      allocationsUnwound: unwind.unwound,
      invoicesReopened: unwind.invoicesReopened,
      lifecycle,
    },
  });
  return { outcome: 'refunded', refundId: recorded.id, unwind, lifecycle };
}

/* ── ReversePayment (undone before settlement, whole, once) ─────────────── */

export interface ReversePaymentInput {
  businessId: string;
  paymentId: string;
  paymentAmountK: number;
  paymentConnectionId: string;
  providerReversalId: string;
  reason: string;
  actor: string;
  eventId: string;
}

export type ReversePaymentResult =
  | { outcome: 'reversed'; reversalId: string; unwind: UnwindOutcome }
  | { outcome: 'already_recorded'; reversalId: string }
  | { outcome: 'exceeds_allocations'; standingK: number }
  | { outcome: 'overpaid_payment' }
  | { outcome: 'payment_not_found' }
  | { outcome: 'already_settled' }
  | { outcome: 'no_clearing_account' };

export async function reversePaymentWork(
  tx: TenantDb,
  input: ReversePaymentInput,
): Promise<ReversePaymentResult> {
  if (await settleRepo.paymentWasOverpaid(tx, input.businessId, input.paymentId)) {
    return { outcome: 'overpaid_payment' };
  }
  const standingK = await standingTotalK(tx, input.businessId, input.paymentId);
  if (standingK !== input.paymentAmountK) {
    const existing = (await refundsRepo.reversalsFor(tx, input.businessId)).find(
      (r) => r.paymentId === input.paymentId,
    );
    if (existing) return { outcome: 'already_recorded', reversalId: existing.id };
    /* Part of the money never answered an invoice (an overpayment holds it
     * as customer credit) — reversing that part is a different posting. */
    return { outcome: 'exceeds_allocations', standingK };
  }

  const recorded = await refundsRepo.recordPaymentReversal(tx, {
    businessId: input.businessId,
    paymentId: input.paymentId,
    paymentConnectionId: input.paymentConnectionId,
    reason: input.reason,
    actor: input.actor,
    providerReversalId: input.providerReversalId,
  });
  if (recorded.outcome !== 'recorded') return recorded;
  if (!recorded.isNew) return { outcome: 'already_recorded', reversalId: recorded.id };

  const unwind = await unwindAllocations(tx, {
    businessId: input.businessId,
    paymentId: input.paymentId,
    amountK: recorded.amountK,
    reason: input.reason,
    sourceType: 'payment_reversal',
    sourceId: recorded.id,
  });
  await settleRepo.markPaymentLifecycle(tx, input.businessId, input.paymentId, 'reversed');
  await settleRepo.auditPaymentAdjustment(tx, {
    businessId: input.businessId,
    paymentId: input.paymentId,
    actor: input.actor,
    action: 'reversed',
    detail: {
      eventId: input.eventId,
      reversalId: recorded.id,
      providerReversalId: input.providerReversalId,
      amountK: recorded.amountK,
      allocationsUnwound: unwind.unwound,
      invoicesReopened: unwind.invoicesReopened,
    },
  });
  return { outcome: 'reversed', reversalId: recorded.id, unwind };
}

/* ── Chargeback (a dispute the merchant LOST) ───────────────────────────── */

export interface ChargebackPaymentInput {
  businessId: string;
  paymentId: string;
  paymentAmountK: number;
  paymentConnectionId: string;
  providerChargebackId: string;
  amountK: number;
  reason: string;
  actor: string;
  eventId: string;
}

export type ChargebackPaymentResult =
  | {
      outcome: 'charged_back';
      chargebackId: string;
      timing: 'PRE_SETTLEMENT' | 'POST_SETTLEMENT';
      unwind: UnwindOutcome;
    }
  | { outcome: 'already_recorded'; chargebackId: string }
  | { outcome: 'exceeds_allocations'; standingK: number }
  | { outcome: 'overpaid_payment' }
  /** The payment already carries a refund: the mirror of
   * `payment_under_chargeback` (OD-11). */
  | { outcome: 'payment_already_refunded' }
  | { outcome: 'payment_not_found' }
  | { outcome: 'no_clearing_account' };

export async function chargebackPaymentWork(
  tx: TenantDb,
  input: ChargebackPaymentInput,
): Promise<ChargebackPaymentResult> {
  if (
    (await refundsRepo.refundsFor(tx, input.businessId)).some(
      (r) => r.paymentId === input.paymentId,
    )
  ) {
    return { outcome: 'payment_already_refunded' };
  }
  if (await settleRepo.paymentWasOverpaid(tx, input.businessId, input.paymentId)) {
    /* The provider takes the whole charge back, credit included; the
     * credit-side posting has no rule yet (OD-8). Nothing posts. */
    return { outcome: 'overpaid_payment' };
  }
  const standingK = await standingTotalK(tx, input.businessId, input.paymentId);
  if (input.amountK > standingK) {
    const existing = (await chargebacksRepo.chargebacksFor(tx, input.businessId)).find(
      (c) => c.providerChargebackId === input.providerChargebackId,
    );
    if (existing) return { outcome: 'already_recorded', chargebackId: existing.id };
    return { outcome: 'exceeds_allocations', standingK };
  }

  const recorded = await chargebacksRepo.recordChargeback(tx, {
    businessId: input.businessId,
    paymentConnectionId: input.paymentConnectionId,
    paymentId: input.paymentId,
    providerChargebackId: input.providerChargebackId,
    amountK: input.amountK,
    reason: input.reason,
  });
  if (recorded.outcome !== 'recorded') return recorded;
  if (!recorded.isNew) return { outcome: 'already_recorded', chargebackId: recorded.id };

  const unwind = await unwindAllocations(tx, {
    businessId: input.businessId,
    paymentId: input.paymentId,
    amountK: input.amountK,
    reason: input.reason,
    sourceType: 'chargeback',
    sourceId: recorded.id,
  });
  /* A full chargeback is the payment undone; a partial one leaves the
   * payment standing for the rest, and the chargeback row says how much
   * was taken. The lifecycle vocabulary has no partial-chargeback word and
   * inventing one would be a schema change for a label. */
  if (input.amountK >= input.paymentAmountK) {
    await settleRepo.markPaymentLifecycle(tx, input.businessId, input.paymentId, 'reversed');
  }
  await settleRepo.auditPaymentAdjustment(tx, {
    businessId: input.businessId,
    paymentId: input.paymentId,
    actor: input.actor,
    action: 'charged_back',
    detail: {
      eventId: input.eventId,
      chargebackId: recorded.id,
      providerChargebackId: input.providerChargebackId,
      amountK: input.amountK,
      timing: recorded.timing,
      allocationsUnwound: unwind.unwound,
      invoicesReopened: unwind.invoicesReopened,
    },
  });
  return { outcome: 'charged_back', chargebackId: recorded.id, timing: recorded.timing, unwind };
}
