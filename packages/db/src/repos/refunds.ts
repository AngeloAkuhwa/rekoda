/**
 * Refund and PaymentReversal, kept distinct (spec §6.1, §9.3; P2, PR-067).
 *
 * A REFUND is money returned deliberately. It is a payment in reverse and
 * posts on the day it happens (postCreditNote's doc said exactly this:
 * handing the money back is a payment, a separate posting):
 *
 *     DR Accounts Receivable · CR Bank (or Cash)
 *
 * Partial refunds are ordinary — money returned deliberately can be some
 * of the money — but the refunds on one payment can never exceed it.
 *
 * A PAYMENT REVERSAL is a payment undone BEFORE SETTLEMENT: the money
 * never left the provider, so the connection's clearing account gives it
 * back — whole, once (§9.3's full-reversal-once, applied to the payment;
 * a partial change of mind is a refund):
 *
 *     DR Accounts Receivable · CR Provider Clearing
 *
 * Undoing a payment the provider has already paid out is not a reversal —
 * it is a refund (deliberate) or a chargeback (disputed), and this repo
 * refuses rather than quietly becoming either.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';
import { ledgerEntries, ledgerTransactions, payments } from '../schema/finance.js';
import { paymentReversals, refunds, settlementItems, settlements } from '../schema/payments-hub.js';
import { accountByRole } from './accounts.js';
import { accountIdsForKeys } from './issue.js';

async function paymentAmountK(
  tx: TenantDb,
  businessId: string,
  paymentId: string,
): Promise<number | null> {
  const rows = await tx
    .select({ amountK: payments.amountK, settlementStatus: payments.settlementStatus })
    .from(payments)
    .where(and(eq(payments.businessId, businessId), eq(payments.id, paymentId)))
    .limit(1);
  return rows[0]?.amountK ?? null;
}

async function coveredBySettledPayout(
  tx: TenantDb,
  businessId: string,
  paymentId: string,
): Promise<boolean> {
  const covered = await tx
    .select({ id: settlementItems.id })
    .from(settlementItems)
    .innerJoin(settlements, eq(settlements.id, settlementItems.settlementId))
    .where(
      and(
        eq(settlementItems.businessId, businessId),
        eq(settlementItems.paymentId, paymentId),
        eq(settlements.status, 'SETTLED'),
      ),
    )
    .limit(1);
  if (covered.length === 1) return true;
  const stamped = await tx
    .select({ settlementStatus: payments.settlementStatus })
    .from(payments)
    .where(and(eq(payments.businessId, businessId), eq(payments.id, paymentId)))
    .limit(1);
  return stamped[0]?.settlementStatus === 'settled';
}

export interface RecordRefundInput {
  businessId: string;
  paymentId: string;
  amountK: number;
  method: 'bank' | 'cash';
  reason: string;
  actor: string;
  providerRefundId?: string;
}

export type RecordRefundOutcome =
  | { outcome: 'recorded'; id: string; isNew: boolean }
  | { outcome: 'payment_not_found' }
  /** The refunds on one payment can never exceed the payment. */
  | { outcome: 'exceeds_payment'; refundedSoFarK: number };

export async function recordRefund(
  tx: TenantDb,
  input: RecordRefundInput,
): Promise<RecordRefundOutcome> {
  const amountK = await paymentAmountK(tx, input.businessId, input.paymentId);
  if (amountK === null) return { outcome: 'payment_not_found' };

  const refundedRows = await tx
    .select({ total: sql<number>`coalesce(sum(${refunds.amountK}), 0)::bigint` })
    .from(refunds)
    .where(and(eq(refunds.businessId, input.businessId), eq(refunds.paymentId, input.paymentId)));
  const refundedSoFarK = Number(refundedRows[0]?.total ?? 0);
  if (refundedSoFarK + input.amountK > amountK) {
    return { outcome: 'exceeds_payment', refundedSoFarK };
  }

  const inserted = await tx
    .insert(refunds)
    .values({
      businessId: input.businessId,
      paymentId: input.paymentId,
      amountK: input.amountK,
      method: input.method,
      reason: input.reason,
      actor: input.actor,
      ...(input.providerRefundId ? { providerRefundId: input.providerRefundId } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: refunds.id });
  const created = inserted[0];
  if (!created) {
    /* The provider re-notifying an executed refund: one row, one posting. */
    const existing = await tx
      .select({ id: refunds.id })
      .from(refunds)
      .where(
        and(
          eq(refunds.businessId, input.businessId),
          eq(refunds.providerRefundId, input.providerRefundId ?? ''),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (!row) throw new Error('recordRefund: conflict reported but no refund found');
    return { outcome: 'recorded', id: row.id, isNew: false };
  }

  const ids = await accountIdsForKeys(tx, input.businessId, [
    'ACCOUNTS_RECEIVABLE',
    input.method === 'cash' ? 'CASH' : 'BANK_PAYSTACK',
  ]);
  await writeTwoLine(tx, input.businessId, {
    memo: `Refund on payment ${input.paymentId.slice(0, 8)}: ${input.reason}`,
    sourceType: 'refund',
    sourceId: created.id,
    postingPurpose: 'REFUND',
    debitAccountId: ids.get('ACCOUNTS_RECEIVABLE')!,
    creditAccountId: ids.get(input.method === 'cash' ? 'CASH' : 'BANK_PAYSTACK')!,
    amountK: input.amountK,
  });
  return { outcome: 'recorded', id: created.id, isNew: true };
}

export interface RecordPaymentReversalInput {
  businessId: string;
  paymentId: string;
  paymentConnectionId: string;
  reason: string;
  actor: string;
  providerReversalId?: string;
}

export type RecordPaymentReversalOutcome =
  | { outcome: 'recorded'; id: string; isNew: boolean; amountK: number }
  | { outcome: 'payment_not_found' }
  /** The provider already paid this out: undoing it now is a refund or a
   * chargeback, and this repo refuses to quietly become either. */
  | { outcome: 'already_settled' }
  | { outcome: 'no_clearing_account' };

export async function recordPaymentReversal(
  tx: TenantDb,
  input: RecordPaymentReversalInput,
): Promise<RecordPaymentReversalOutcome> {
  const amountK = await paymentAmountK(tx, input.businessId, input.paymentId);
  if (amountK === null) return { outcome: 'payment_not_found' };
  if (await coveredBySettledPayout(tx, input.businessId, input.paymentId)) {
    return { outcome: 'already_settled' };
  }

  const inserted = await tx
    .insert(paymentReversals)
    .values({
      businessId: input.businessId,
      paymentId: input.paymentId,
      paymentConnectionId: input.paymentConnectionId,
      amountK,
      reason: input.reason,
      actor: input.actor,
      ...(input.providerReversalId ? { providerReversalId: input.providerReversalId } : {}),
    })
    .onConflictDoNothing({ target: [paymentReversals.businessId, paymentReversals.paymentId] })
    .returning({ id: paymentReversals.id });
  const created = inserted[0];
  if (!created) {
    const existing = await tx
      .select({ id: paymentReversals.id, amountK: paymentReversals.amountK })
      .from(paymentReversals)
      .where(
        and(
          eq(paymentReversals.businessId, input.businessId),
          eq(paymentReversals.paymentId, input.paymentId),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (!row) throw new Error('recordPaymentReversal: conflict reported but no reversal found');
    return { outcome: 'recorded', id: row.id, isNew: false, amountK: row.amountK };
  }

  const clearing = await accountByRole(
    tx,
    input.businessId,
    'PAYMENT_PROVIDER_CLEARING',
    input.paymentConnectionId,
  );
  if (!clearing) return { outcome: 'no_clearing_account' };
  const ids = await accountIdsForKeys(tx, input.businessId, ['ACCOUNTS_RECEIVABLE']);
  await writeTwoLine(tx, input.businessId, {
    memo: `Payment reversal ${input.providerReversalId ?? created.id.slice(0, 8)}: ${input.reason}`,
    sourceType: 'payment_reversal',
    sourceId: created.id,
    postingPurpose: 'REVERSAL',
    debitAccountId: ids.get('ACCOUNTS_RECEIVABLE')!,
    creditAccountId: clearing.id,
    amountK,
  });
  return { outcome: 'recorded', id: created.id, isNew: true, amountK };
}

async function writeTwoLine(
  tx: TenantDb,
  businessId: string,
  input: {
    memo: string;
    sourceType: string;
    sourceId: string;
    postingPurpose: 'REFUND' | 'REVERSAL';
    debitAccountId: string;
    creditAccountId: string;
    amountK: number;
  },
): Promise<void> {
  const txRows = await tx
    .insert(ledgerTransactions)
    .values({
      businessId,
      memo: input.memo,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      postingPurpose: input.postingPurpose,
    })
    .returning({ id: ledgerTransactions.id });
  const ledgerTx = txRows[0];
  if (!ledgerTx) throw new Error('writeTwoLine: ledger transaction insert returned no row');
  await tx.insert(ledgerEntries).values(
    [
      { accountId: input.debitAccountId, debitK: input.amountK, creditK: 0 },
      { accountId: input.creditAccountId, debitK: 0, creditK: input.amountK },
    ].map((entry) => ({
      businessId,
      transactionId: ledgerTx.id,
      accountId: entry.accountId,
      debitK: entry.debitK,
      creditK: entry.creditK,
      /* Same-currency posting (§16): see writePosting. */
      transactionAmountMinor: entry.debitK + entry.creditK,
    })),
  );
}

export interface RefundRow {
  id: string;
  paymentId: string;
  amountK: number;
  method: string;
  reason: string;
  providerRefundId: string | null;
}

export async function refundsFor(tx: TenantDb, businessId: string): Promise<RefundRow[]> {
  return tx
    .select({
      id: refunds.id,
      paymentId: refunds.paymentId,
      amountK: refunds.amountK,
      method: refunds.method,
      reason: refunds.reason,
      providerRefundId: refunds.providerRefundId,
    })
    .from(refunds)
    .where(eq(refunds.businessId, businessId))
    .orderBy(refunds.createdAt);
}
