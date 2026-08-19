/**
 * The transaction engine (MASTER-PLAN §5.3.5).
 *
 * One database transaction, or nothing:
 *
 *   1. bump the counter → the document number
 *   2. invoice + items
 *   3. payment + allocation, if money changed hands
 *   4. postings from `@rekoda/core` → assertBalanced → ledger
 *   5. snapshot + doc_hash
 *   6. audit event
 *
 * If any step throws, nothing is written. The draft survives, the merchant is
 * told plainly, and they can try again — which is the only acceptable failure
 * mode for something that issues numbered financial documents.
 *
 * Every function here takes a `TenantDb`. The engine cannot open a transaction
 * of its own, so "all of it or none of it" is the caller's transaction, not a
 * property this file has to remember to preserve.
 */
import { eq, sql } from 'drizzle-orm';
import { formatDocumentNumber, postSale, type Posting } from '@rekoda/core';
import { snapshotHash, type DocumentSnapshot } from '@rekoda/core/documents';
import type { TenantDb } from '../client.js';
import { auditEvents } from '../schema/ops.js';
import {
  invoiceItems,
  invoices,
  ledgerEntries,
  ledgerTransactions,
  paymentAllocations,
  payments,
} from '../schema/finance.js';

export interface IssueItem {
  name: string;
  quantity: number;
  unitPriceK: number;
}

export interface IssueSaleInput {
  businessId: string;
  /** Resolved customer row id, when we know who. */
  customerId: string | null;
  /** The pseudonymous token, for the snapshot. Never a name. */
  customerToken: string | null;
  items: readonly IssueItem[];
  subtotalK: number;
  discountK: number;
  deliveryFeeK: number;
  vatK: number;
  totalK: number;
  paidK: number;
  balanceDueK: number;
  method: 'cash' | 'transfer';
  /** Where this came from: the draft that was confirmed. */
  sourceType: string;
  sourceId: string;
  actor: string;
  issuedAt?: Date;
}

export interface IssuedSale {
  invoiceId: string;
  invoiceNumber: string;
  docHash: string;
  ledgerTransactionId: string;
  paymentId: string | null;
}

/**
 * Take the next number for this business, document type and year.
 *
 * `ON CONFLICT … DO UPDATE … RETURNING` is one statement, so two confirmations
 * arriving together cannot take the same number. Read-then-write here produces
 * two invoices numbered INV-2026-000041 — a duplicate in the one field that is
 * supposed to be unique, and a `invoices_number_ux` violation that rolls back
 * a sale the merchant already watched succeed.
 */
export async function nextDocumentNumber(
  tx: TenantDb,
  businessId: string,
  docType: 'invoice' | 'receipt' | 'credit_note',
  year: number,
): Promise<string> {
  const rows = await tx.execute<{ last_seq: number }>(sql`
    INSERT INTO doc_counters (business_id, doc_type, year, last_seq)
    VALUES (${businessId}::uuid, ${docType}, ${year}, 1)
    ON CONFLICT (business_id, doc_type, year) DO UPDATE
      SET last_seq = doc_counters.last_seq + 1
    RETURNING last_seq
  `);
  const seq = [...rows][0]?.last_seq;
  if (seq === undefined) throw new Error('nextDocumentNumber: counter returned nothing');
  return formatDocumentNumber(docType, year, seq);
}

/** Write a balanced posting. `assertBalanced` already ran in `@rekoda/core`. */
async function writePosting(
  tx: TenantDb,
  businessId: string,
  posting: Posting,
  sourceType: string,
  sourceId: string,
): Promise<string> {
  const inserted = await tx
    .insert(ledgerTransactions)
    .values({ businessId, memo: posting.memo, sourceType, sourceId })
    .returning({ id: ledgerTransactions.id });

  const transaction = inserted[0];
  if (!transaction) throw new Error('writePosting: ledger transaction insert returned no row');

  await tx.insert(ledgerEntries).values(
    posting.lines.map((line) => ({
      businessId,
      transactionId: transaction.id,
      account: line.account,
      debitK: line.debitK,
      creditK: line.creditK,
    })),
  );
  return transaction.id;
}

/**
 * Issue one sale, atomically.
 *
 * The counter bump is the first step AND is inside the caller's transaction,
 * which together give a property the plan did not assume: a failure anywhere
 * below un-bumps the counter, so numbering stays dense. Designs that reserve
 * the number in a separate transaction have to explain the gaps they leave;
 * this one has none to explain.
 */
export async function issueSale(tx: TenantDb, input: IssueSaleInput): Promise<IssuedSale> {
  const issuedAt = input.issuedAt ?? new Date();
  const invoiceNumber = await nextDocumentNumber(
    tx,
    input.businessId,
    'invoice',
    issuedAt.getUTCFullYear(),
  );

  const snapshot: DocumentSnapshot = {
    documentNumber: invoiceNumber,
    issuedAtIso: issuedAt.toISOString(),
    customerToken: input.customerToken,
    items: input.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unitPriceK: item.unitPriceK,
      lineTotalK: Math.round(item.quantity * item.unitPriceK),
    })),
    subtotalK: input.subtotalK,
    discountK: input.discountK,
    deliveryFeeK: input.deliveryFeeK,
    vatK: input.vatK,
    totalK: input.totalK,
    paidK: input.paidK,
    balanceDueK: input.balanceDueK,
    currency: 'NGN',
  };
  const docHash = snapshotHash(snapshot);

  const status = input.balanceDueK === 0 ? 'paid' : input.paidK > 0 ? 'partially_paid' : 'issued';

  const invoiceRows = await tx
    .insert(invoices)
    .values({
      businessId: input.businessId,
      customerId: input.customerId,
      invoiceNumber,
      status,
      subtotalK: input.subtotalK,
      discountK: input.discountK,
      deliveryFeeK: input.deliveryFeeK,
      vatK: input.vatK,
      totalK: input.totalK,
      paidK: input.paidK,
      balanceDueK: input.balanceDueK,
      snapshotJson: snapshot as never,
      docHash,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      issuedAt,
    })
    .returning({ id: invoices.id });

  const invoice = invoiceRows[0];
  if (!invoice) throw new Error('issueSale: invoice insert returned no row');

  if (input.items.length > 0) {
    await tx.insert(invoiceItems).values(
      input.items.map((item) => ({
        businessId: input.businessId,
        invoiceId: invoice.id,
        name: item.name,
        quantity: item.quantity,
        unitPriceK: item.unitPriceK,
        lineTotalK: Math.round(item.quantity * item.unitPriceK),
      })),
    );
  }

  let paymentId: string | null = null;
  if (input.paidK > 0) {
    const paymentRows = await tx
      .insert(payments)
      .values({
        businessId: input.businessId,
        customerId: input.customerId,
        amountK: input.paidK,
        method: input.method,
        /**
         * RECORDED, not VERIFIED (ADR 0014, spec §10). The merchant told us
         * money arrived; nobody has confirmed it with a provider. Marking this
         * 1 here would be the fake-alert defence defeating itself on day one.
         */
        verified: 0,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
      })
      .returning({ id: payments.id });

    const payment = paymentRows[0];
    if (!payment) throw new Error('issueSale: payment insert returned no row');
    paymentId = payment.id;

    await tx.insert(paymentAllocations).values({
      businessId: input.businessId,
      paymentId: payment.id,
      invoiceId: invoice.id,
      amountK: Math.min(input.paidK, input.totalK),
    });
  }

  /**
   * The books. `postSale` throws `UnbalancedPostingError` rather than writing
   * a lopsided transaction, and it throws INSIDE this database transaction —
   * so a posting that does not balance takes the invoice, the items and the
   * payment down with it. That is the guarantee: there is no state in which a
   * document exists and the ledger disagrees with it.
   */
  const posting = postSale({
    memo: `Sale ${invoiceNumber}`,
    totalK: input.totalK,
    paidK: Math.min(input.paidK, input.totalK),
    vatK: input.vatK,
    method: input.method,
  });
  const ledgerTransactionId = await writePosting(
    tx,
    input.businessId,
    posting,
    input.sourceType,
    input.sourceId,
  );

  await tx.insert(auditEvents).values({
    businessId: input.businessId,
    actor: input.actor,
    entity: 'invoice',
    entityId: invoice.id,
    action: 'issued',
    newValue: { invoiceNumber, docHash, totalK: input.totalK } as never,
    sourceType: input.sourceType,
  });

  return { invoiceId: invoice.id, invoiceNumber, docHash, ledgerTransactionId, paymentId };
}

/**
 * A document that WAS issued and is being voided.
 *
 * Not the rollback path: `nextDocumentNumber` runs inside the same transaction
 * as everything else, so a failed issue un-bumps the counter and numbering
 * stays dense. There is nothing to explain there.
 *
 * This is for the other case — a document that exists, was sent, and is being
 * withdrawn. The plan is explicit that a gap in the sequence must be EXPLAINED
 * rather than mysterious, because an unexplained gap is what an auditor reads
 * as a deleted invoice.
 */
export async function recordVoidedDocument(
  tx: TenantDb,
  businessId: string,
  documentNumber: string,
  reason: string,
  actor = 'system',
): Promise<void> {
  await tx.insert(auditEvents).values({
    businessId,
    actor,
    entity: 'invoice',
    entityId: null,
    action: 'voided',
    newValue: { documentNumber } as never,
    reason,
    sourceType: 'system',
  });
}

/** Every ledger entry for a business, for the trial-balance check. */
export async function ledgerEntriesFor(
  tx: TenantDb,
  businessId: string,
): Promise<Array<{ account: string; debitK: number; creditK: number }>> {
  return tx
    .select({
      account: ledgerEntries.account,
      debitK: ledgerEntries.debitK,
      creditK: ledgerEntries.creditK,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.businessId, businessId));
}

/** How many invoices this business has. Row-level security does the scoping. */
export async function invoiceCount(tx: TenantDb): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM invoices`);
  return [...rows][0]?.n ?? 0;
}
