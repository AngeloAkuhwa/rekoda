/**
 * Booking a provider-CONFIRMED payment (docs/payments-v1.md §16–25).
 *
 * One database transaction, or nothing — the same discipline as `issueSale`,
 * because it is the same kind of moment: money that really moved becomes
 * records a tax officer can read. The order:
 *
 *   1. payment row (VERIFIED — the provider confirmed it server-side)
 *   2. allocation against the invoice, up to its balance
 *   3. invoice paid/balance/status — derived, never asserted
 *   4. receipt, numbered and hashed, exactly once
 *   5. ledger posting from `@rekoda/core` (fees never touch revenue)
 *   6. reconciliation record — how the money answered the obligation
 *   7. audit event
 *
 * What this file does NOT decide: whether the money is ours. That decision —
 * `judgeProviderPayment` — happened in `@rekoda/core` before this is called,
 * on values from the SERVER-SIDE verify call, never from the webhook body.
 *
 * Overpayment is booked conservatively: the allocation, the receipt and the
 * posting cover the invoice's balance, and the excess appears ONLY in the
 * reconciliation row (negative `outstanding_k`), where a human decides whether
 * it becomes a refund or a credit. Books that quietly absorb an overpayment
 * are books that overstate what the merchant may keep.
 */
import { and, eq, sql } from 'drizzle-orm';
import { postProviderPayment, splitFees, type FeePolicy } from '@rekoda/core';
import { documentHash } from '@rekoda/core/documents';
import type { TenantDb } from '../client.js';
import { auditEvents } from '../schema/ops.js';
import {
  invoices,
  ledgerEntries,
  ledgerTransactions,
  paymentAllocations,
  payments,
  receipts,
  reconciliations,
} from '../schema/finance.js';
import { nextDocumentNumber } from './issue.js';

/** The same rekoda_reference booked twice — the terminal-intent gate's job,
 * and this error firing means that gate was bypassed. Callers treat it as
 * "already booked", never as work to retry. */
export class AlreadyBooked extends Error {}

export interface BookVerifiedPaymentInput {
  businessId: string;
  /** The resolved intent this confirmation answers. */
  intent: {
    id: string;
    reference: string;
    invoiceId: string | null;
    customerId?: string | null;
  };
  /** From the SERVER-SIDE verify call — never the webhook body. */
  confirmedAmountK: number;
  currency: string;
  providerType: string;
  /** The provider's own transaction reference/id. */
  providerRef: string;
  providerStatus: string;
  providerFeeK: number;
  feePolicy: FeePolicy;
  /** cash | transfer | pos | unknown — already normalised by the adapter. */
  method: string;
  actor: string;
  /** The external event that carried the confirmation, for the audit trail. */
  eventId: string;
  bookedAt?: Date;
}

export interface BookedPayment {
  paymentId: string;
  allocatedK: number;
  receiptNumber: string | null;
  /** For enqueueing the render job — null exactly when receiptNumber is. */
  receiptId: string | null;
  invoiceStatus: string | null;
  ledgerTransactionId: string | null;
  reconciliation: 'matched' | 'partial_match' | 'overpaid' | 'duplicate' | 'requires_review';
}

export async function bookVerifiedPayment(
  tx: TenantDb,
  input: BookVerifiedPaymentInput,
): Promise<BookedPayment> {
  const bookedAt = input.bookedAt ?? new Date();
  const split = splitFees({
    invoiceAmountK: input.confirmedAmountK,
    providerFeeK: input.providerFeeK,
    policy: input.feePolicy,
  });

  /* 1 ── the payment row. The partial unique index on (business_id,
   * rekoda_reference) is the last line of defence against double-booking. */
  let paymentId: string;
  try {
    const paymentRows = await tx
      .insert(payments)
      .values({
        businessId: input.businessId,
        customerId: input.intent.customerId ?? null,
        amountK: input.confirmedAmountK,
        currency: input.currency,
        method: input.method,
        /** VERIFIED: the provider confirmed this server-side (ADR 0014). */
        verified: 1,
        providerRef: input.providerRef,
        grossAmountK: input.confirmedAmountK,
        providerFeeK: input.providerFeeK,
        platformFeeK: 0,
        settlementAmountK: split.merchantSettlementK,
        rekodaReference: input.intent.reference,
        providerType: input.providerType,
        paymentIntentId: input.intent.id,
        providerStatus: input.providerStatus,
        status: 'confirmed',
        settlementStatus: 'pending',
        sourceType: 'webhook',
        sourceId: input.eventId,
      })
      .returning({ id: payments.id });
    const payment = paymentRows[0];
    if (!payment) throw new Error('bookVerifiedPayment: payment insert returned no row');
    paymentId = payment.id;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AlreadyBooked(`reference ${input.intent.reference} is already booked`);
    }
    throw error;
  }

  /* No invoice — an intent minted without an obligation to settle. The money
   * is real and recorded; what it MEANS is a human's question. */
  if (!input.intent.invoiceId) {
    await recordReconciliation(tx, input, paymentId, 'EXCEPTION', 'requires_review', null);
    await audit(tx, input, paymentId, 0, bookedAt);
    return {
      paymentId,
      allocatedK: 0,
      receiptNumber: null,
      receiptId: null,
      invoiceStatus: null,
      ledgerTransactionId: null,
      reconciliation: 'requires_review',
    };
  }

  /* 2–3 ── the invoice, locked. Two intents confirming against one invoice is
   * legal (two partial transfers); FOR UPDATE makes their arithmetic serial. */
  const invoiceRows = await tx.execute<{
    id: string;
    invoice_number: string;
    balance_due_k: number;
    paid_k: number;
    customer_id: string | null;
  }>(sql`
    SELECT id, invoice_number, balance_due_k::bigint AS balance_due_k,
           paid_k::bigint AS paid_k, customer_id
    FROM invoices
    WHERE id = ${input.intent.invoiceId}::uuid AND business_id = ${input.businessId}::uuid
    FOR UPDATE
  `);
  const invoice = [...invoiceRows][0];
  if (!invoice) throw new Error('bookVerifiedPayment: intent points at no invoice for this tenant');

  const balanceK = Number(invoice.balance_due_k);
  const allocatedK = Math.min(input.confirmedAmountK, balanceK);

  /* Balance already zero: real money against a settled obligation. Recorded,
   * flagged as duplicate, and NOTHING downstream fires — no allocation, no
   * receipt, no posting. */
  if (allocatedK <= 0) {
    await recordReconciliation(tx, input, paymentId, 'EXCEPTION', 'duplicate', balanceK);
    await audit(tx, input, paymentId, 0, bookedAt);
    return {
      paymentId,
      allocatedK: 0,
      receiptNumber: null,
      receiptId: null,
      invoiceStatus: null,
      ledgerTransactionId: null,
      reconciliation: 'duplicate',
    };
  }

  await tx.insert(paymentAllocations).values({
    businessId: input.businessId,
    paymentId,
    invoiceId: invoice.id,
    amountK: allocatedK,
  });

  const newBalanceK = balanceK - allocatedK;
  const invoiceStatus = newBalanceK === 0 ? 'paid' : 'partially_paid';
  await tx
    .update(invoices)
    .set({
      paidK: Number(invoice.paid_k) + allocatedK,
      balanceDueK: newBalanceK,
      status: invoiceStatus,
    })
    .where(and(eq(invoices.id, invoice.id), eq(invoices.businessId, input.businessId)));

  /* 4 ── the receipt. Numbered inside this transaction, so a failure below
   * un-bumps the counter and numbering stays dense. */
  const receiptNumber = await nextDocumentNumber(
    tx,
    input.businessId,
    'receipt',
    bookedAt.getUTCFullYear(),
  );
  const receiptSnapshot = {
    documentNumber: receiptNumber,
    issuedAtIso: bookedAt.toISOString(),
    invoiceNumber: invoice.invoice_number,
    rekodaReference: input.intent.reference,
    providerType: input.providerType,
    amountK: input.confirmedAmountK,
    allocatedK,
    currency: input.currency,
  };
  const receiptRows = await tx
    .insert(receipts)
    .values({
      businessId: input.businessId,
      customerId: invoice.customer_id,
      receiptNumber,
      paymentId,
      invoiceId: invoice.id,
      amountK: input.confirmedAmountK,
      currency: input.currency,
      snapshotJson: receiptSnapshot as never,
      docHash: documentHash(receiptSnapshot),
    })
    .returning({ id: receipts.id });
  const receipt = receiptRows[0];
  if (!receipt) throw new Error('bookVerifiedPayment: receipt insert returned no row');

  /* 5 ── the books. Only the allocated portion posts; see the file comment. */
  const posting = postProviderPayment({
    memo: `Payment ${input.intent.reference} → ${invoice.invoice_number}`,
    allocatedK,
    providerFeeK: input.providerFeeK,
    feePolicy: input.feePolicy,
  });
  const txRows = await tx
    .insert(ledgerTransactions)
    .values({
      businessId: input.businessId,
      memo: posting.memo,
      sourceType: 'webhook',
      sourceId: input.eventId,
    })
    .returning({ id: ledgerTransactions.id });
  const ledgerTx = txRows[0];
  if (!ledgerTx) throw new Error('bookVerifiedPayment: ledger transaction insert returned no row');
  await tx.insert(ledgerEntries).values(
    posting.lines.map((line) => ({
      businessId: input.businessId,
      transactionId: ledgerTx.id,
      account: line.account,
      debitK: line.debitK,
      creditK: line.creditK,
    })),
  );

  /* 6 ── how the money answered the obligation. */
  const reconciliation =
    input.confirmedAmountK === balanceK
      ? ('matched' as const)
      : input.confirmedAmountK < balanceK
        ? ('partial_match' as const)
        : ('overpaid' as const);
  const status =
    reconciliation === 'matched'
      ? 'MATCHED'
      : reconciliation === 'partial_match'
        ? 'PARTIAL'
        : 'EXCEPTION';
  /** Positive: still owed. Negative: the unallocated excess a human resolves. */
  const outstandingK =
    reconciliation === 'overpaid' ? -(input.confirmedAmountK - allocatedK) : newBalanceK;
  await recordReconciliation(tx, input, paymentId, status, reconciliation, outstandingK);

  await audit(tx, input, paymentId, allocatedK, bookedAt);

  return {
    paymentId,
    allocatedK,
    receiptNumber,
    receiptId: receipt.id,
    invoiceStatus,
    ledgerTransactionId: ledgerTx.id,
    reconciliation,
  };
}

/**
 * A reconciliation exception with NO payment attached — the record of money
 * that arrived and was deliberately not booked (wrong currency, late after
 * expiry, a verify miss). This is the admin exception queue's raw material.
 */
export async function recordException(
  tx: TenantDb,
  input: {
    businessId: string;
    reason: string;
    expectationKind: string;
    expectationId: string;
    amountK: number | null;
  },
): Promise<void> {
  await tx.insert(reconciliations).values({
    businessId: input.businessId,
    status: 'EXCEPTION',
    reason: input.reason,
    expectationKind: input.expectationKind,
    expectationId: input.expectationId,
    paymentId: null,
    amountK: input.amountK,
    outstandingK: null,
  });
}

async function recordReconciliation(
  tx: TenantDb,
  input: BookVerifiedPaymentInput,
  paymentId: string,
  status: string,
  reason: string,
  outstandingK: number | null,
): Promise<void> {
  await tx.insert(reconciliations).values({
    businessId: input.businessId,
    status,
    reason,
    expectationKind: input.intent.invoiceId ? 'invoice' : 'intent',
    expectationId: input.intent.invoiceId ?? input.intent.id,
    paymentId,
    amountK: input.confirmedAmountK,
    outstandingK,
  });
}

async function audit(
  tx: TenantDb,
  input: BookVerifiedPaymentInput,
  paymentId: string,
  allocatedK: number,
  at: Date,
): Promise<void> {
  await tx.insert(auditEvents).values({
    businessId: input.businessId,
    actor: input.actor,
    entity: 'payment',
    entityId: paymentId,
    action: 'confirmed',
    newValue: {
      rekodaReference: input.intent.reference,
      amountK: input.confirmedAmountK,
      allocatedK,
      providerType: input.providerType,
      at: at.toISOString(),
    } as never,
    sourceType: 'webhook',
  });
}

/* ── read-backs (admin surfaces and the tests that keep this honest) ─────── */

export async function paymentCount(tx: TenantDb): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM payments`);
  return [...rows][0]?.n ?? 0;
}

export interface ReceiptForRender {
  receiptNumber: string;
  issuedAt: Date;
  /** The immutable snapshot — the ONLY thing a render may read (spec §42). */
  snapshot: unknown;
}

/** One receipt, by id, for the render job. */
export async function receiptForRender(
  tx: TenantDb,
  businessId: string,
  receiptId: string,
): Promise<ReceiptForRender | null> {
  const rows = await tx
    .select({
      receiptNumber: receipts.receiptNumber,
      issuedAt: receipts.issuedAt,
      snapshot: receipts.snapshotJson,
    })
    .from(receipts)
    .where(and(eq(receipts.businessId, businessId), eq(receipts.id, receiptId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * One receipt by its NUMBER — what the deliver job holds, since the stored
 * document row carries `refNumber` and nothing else about its origin.
 */
export async function receiptByNumber(
  tx: TenantDb,
  businessId: string,
  receiptNumber: string,
): Promise<ReceiptForRender | null> {
  const rows = await tx
    .select({
      receiptNumber: receipts.receiptNumber,
      issuedAt: receipts.issuedAt,
      snapshot: receipts.snapshotJson,
    })
    .from(receipts)
    .where(and(eq(receipts.businessId, businessId), eq(receipts.receiptNumber, receiptNumber)))
    .limit(1);
  return rows[0] ?? null;
}

export async function receiptCount(tx: TenantDb): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM receipts`);
  return [...rows][0]?.n ?? 0;
}

export interface PaymentReadback {
  verified: number;
  status: string | null;
  method: string;
  grossAmountK: number | null;
  providerFeeK: number | null;
  settlementAmountK: number | null;
  rekodaReference: string | null;
}

/** Every payment for the pinned business, oldest first. */
export async function paymentsFor(tx: TenantDb): Promise<PaymentReadback[]> {
  const rows = await tx
    .select({
      verified: payments.verified,
      status: payments.status,
      method: payments.method,
      grossAmountK: payments.grossAmountK,
      providerFeeK: payments.providerFeeK,
      settlementAmountK: payments.settlementAmountK,
      rekodaReference: payments.rekodaReference,
    })
    .from(payments)
    .orderBy(payments.createdAt);
  return rows;
}

export interface ReconciliationReadback {
  id: string;
  status: string;
  reason: string | null;
  amountK: number | null;
  outstandingK: number | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

/** The reconciliation trail — the admin exception queue's query. */
export async function reconciliationsFor(tx: TenantDb): Promise<ReconciliationReadback[]> {
  const rows = await tx
    .select({
      id: reconciliations.id,
      status: reconciliations.status,
      reason: reconciliations.reason,
      amountK: reconciliations.amountK,
      outstandingK: reconciliations.outstandingK,
      createdAt: reconciliations.createdAt,
      resolvedAt: reconciliations.resolvedAt,
    })
    .from(reconciliations)
    .orderBy(reconciliations.createdAt);
  return rows;
}

/**
 * Mark one exception reviewed. Conditional on being an UNRESOLVED EXCEPTION,
 * so a double-tap or a stale id changes nothing and says so: exactly one
 * caller ever wins, and a resolved row stays resolved by whoever reviewed it
 * first.
 */
export async function resolveException(
  tx: TenantDb,
  businessId: string,
  reconciliationId: string,
  actor: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE reconciliations
    SET resolved_at = now(), resolved_by = ${actor}
    WHERE id = ${reconciliationId}::uuid
      AND business_id = ${businessId}::uuid
      AND status = 'EXCEPTION'
      AND resolved_at IS NULL
    RETURNING id
  `);
  return [...rows].length === 1;
}

/** PostgreSQL unique-violation, wrapped by drizzle under `.cause`. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    if (
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      (e as { code?: string }).code === '23505'
    ) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
