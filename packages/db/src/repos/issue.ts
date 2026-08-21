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
import { and, eq, sql } from 'drizzle-orm';
import { formatDocumentNumber, postSale, reversal, type Posting } from '@rekoda/core';
import { snapshotHash, type DocumentSnapshot } from '@rekoda/core/documents';
import type { TenantDb } from '../client.js';
import { auditEvents, documents } from '../schema/ops.js';
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
  /** Where the sale HAPPENED (§27) — Instagram, the shop, a phone order.
   * Optional by design; captured only when the merchant names a channel. */
  saleSource?: string | null;
  /**
   * When the merchant said the money is expected, already resolved to a date.
   *
   * Resolved by `resolveDueDate` in core, never here and never by the model:
   * a due date decides when a real customer is chased, and "what day is
   * Friday" has one right answer. Null when they named no date, which is the
   * common case and an honest one.
   */
  dueDate?: Date | null;
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

/** Write a balanced posting. `assertBalanced` already ran in `@rekoda/core`.
 * Exported for the other repos that persist postings (spend.ts) — one write
 * path for ledger rows, so the shape cannot fork. */
export async function writePosting(
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
    /* Only when there is one. An explicit null on every undated invoice would
     * change the hash of documents that predate due dates. */
    ...(input.dueDate ? { dueDateIso: input.dueDate.toISOString() } : {}),
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
      saleSource: input.saleSource ?? null,
      dueDate: input.dueDate ?? null,
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

export type VoidOutcome =
  | { outcome: 'voided'; invoiceNumber: string; reversedK: number }
  | { outcome: 'not_found' }
  | { outcome: 'already_void' }
  /** Money has been received against it. Credit it, do not void it. */
  | { outcome: 'has_payments'; paidK: number };

/**
 * Withdraw an invoice that was issued and should not have been.
 *
 * Not a delete. The ledger is append-only and the document sequence is dense
 * on purpose, so a void leaves the invoice where it is, marks it, and writes
 * the MIRROR of its original posting. An auditor reading the books sees a
 * sale and its reversal, which is a different story from a sale that never
 * happened, and telling those two apart is the reason the rule exists.
 *
 * REFUSES an invoice with money against it. That is real practice rather than
 * caution: reversing the revenue while the cash stays in the account leaves
 * books that do not describe anything, and what the merchant actually wants
 * there is a credit note against a refund. An invoice nobody has paid has no
 * such problem, and it is the case a merchant hits: the wrong customer, the
 * wrong figure, a duplicate.
 *
 * The reversal is built from the invoice rather than looked up, because the
 * only invoices reachable here are unpaid ones, and `postSale` with nothing
 * paid is exactly what was written when it was issued. Matching the original
 * transaction by memo would be one more thing that can drift.
 */
export async function voidInvoice(
  tx: TenantDb,
  businessId: string,
  invoiceNumber: string,
  reason: string,
  actor: string,
): Promise<VoidOutcome> {
  const rows = await tx
    .select({
      id: invoices.id,
      status: invoices.status,
      totalK: invoices.totalK,
      paidK: invoices.paidK,
      vatK: invoices.vatK,
      sourceType: invoices.sourceType,
      sourceId: invoices.sourceId,
    })
    .from(invoices)
    .where(and(eq(invoices.businessId, businessId), eq(invoices.invoiceNumber, invoiceNumber)))
    .limit(1);

  const invoice = rows[0];
  if (!invoice) return { outcome: 'not_found' };
  if (invoice.status === 'voided') return { outcome: 'already_void' };
  if (Number(invoice.paidK) > 0) {
    return { outcome: 'has_payments', paidK: Number(invoice.paidK) };
  }

  const totalK = Number(invoice.totalK);
  const vatK = Number(invoice.vatK);
  const original = postSale({ memo: `Sale ${invoiceNumber}`, totalK, paidK: 0, vatK });

  /**
   * Claim the invoice BEFORE writing to the ledger.
   *
   * The status in the WHERE is the mutual exclusion, and the order is the
   * whole of it. The status read above settles nothing: two operators both
   * read `issued` before either writes. Only this UPDATE decides, so only its
   * winner may post. Posting first would leave the loser's reversal standing
   * in an append-only ledger with nothing to explain it.
   */
  const marked = await tx
    .update(invoices)
    .set({ status: 'voided', balanceDueK: 0 })
    .where(and(eq(invoices.id, invoice.id), eq(invoices.status, invoice.status)))
    .returning({ id: invoices.id });
  if (marked.length !== 1) return { outcome: 'already_void' };

  await writePosting(
    tx,
    businessId,
    reversal(original, `Void ${invoiceNumber}`),
    invoice.sourceType,
    invoice.sourceId ?? invoiceNumber,
  );

  await recordVoidedDocument(tx, businessId, invoiceNumber, reason, actor);
  return { outcome: 'voided', invoiceNumber, reversedK: totalK };
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

export interface DocumentRecord {
  businessId: string;
  kind: string;
  storageKey: string;
  refNumber: string | null;
  bytes: number;
}

/**
 * Record a rendered artefact. The KEY, never the blob (ADR 0006).
 *
 * `documents_storage_ux` makes the key unique, so a job that runs twice cannot
 * leave two rows pointing at one object — and because each render generates a
 * fresh unguessable key, a genuine re-render is a new row rather than a
 * silent overwrite of the document a customer may already be holding.
 */
export async function recordDocument(
  tx: TenantDb,
  record: DocumentRecord,
): Promise<{ id: string }> {
  const rows = await tx
    .insert(documents)
    .values({
      businessId: record.businessId,
      kind: record.kind,
      storageKey: record.storageKey,
      refNumber: record.refNumber,
      bytes: record.bytes,
    })
    .returning({ id: documents.id });

  const row = rows[0];
  if (!row) throw new Error('recordDocument: insert returned no row');
  return { id: row.id };
}

export interface StoredDocument {
  id: string;
  kind: string;
  storageKey: string;
  refNumber: string | null;
  bytes: number | null;
}

/** A business's own documents. Row-level security does the scoping. */
export async function documentsFor(tx: TenantDb, businessId: string): Promise<StoredDocument[]> {
  return tx
    .select({
      id: documents.id,
      kind: documents.kind,
      storageKey: documents.storageKey,
      refNumber: documents.refNumber,
      bytes: documents.bytes,
    })
    .from(documents)
    .where(eq(documents.businessId, businessId))
    .orderBy(documents.createdAt);
}

/** The newest invoice still carrying a balance — what "payment details" collects for. */
export async function latestOpenInvoice(
  tx: TenantDb,
  businessId: string,
): Promise<{ id: string; invoiceNumber: string; balanceDueK: number } | null> {
  const rows = await tx.execute<{
    id: string;
    invoice_number: string;
    balance_due_k: string;
  }>(sql`
    SELECT id, invoice_number, balance_due_k::bigint AS balance_due_k
    FROM invoices
    WHERE business_id = ${businessId}::uuid AND status IN ('issued', 'partially_paid')
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const row = [...rows][0];
  if (!row) return null;
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    balanceDueK: Number(row.balance_due_k),
  };
}

/** One invoice, for minting a payment intent against it. */
export async function invoiceForPayment(
  tx: TenantDb,
  businessId: string,
  invoiceId: string,
): Promise<{
  id: string;
  invoiceNumber: string;
  status: string;
  balanceDueK: number;
  currency: string;
  customerId: string | null;
} | null> {
  const rows = await tx
    .select({
      id: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      status: invoices.status,
      balanceDueK: invoices.balanceDueK,
      currency: invoices.currency,
      customerId: invoices.customerId,
    })
    .from(invoices)
    .where(and(eq(invoices.businessId, businessId), eq(invoices.id, invoiceId)))
    .limit(1);
  return rows[0] ?? null;
}

/** One invoice, for the renderer. Everything it needs and nothing it does not. */
export async function invoiceForRender(
  tx: TenantDb,
  businessId: string,
  invoiceId: string,
): Promise<{
  invoiceNumber: string;
  issuedAt: Date;
  snapshot: unknown;
} | null> {
  const rows = await tx
    .select({
      invoiceNumber: invoices.invoiceNumber,
      issuedAt: invoices.issuedAt,
      snapshot: invoices.snapshotJson,
    })
    .from(invoices)
    .where(and(eq(invoices.businessId, businessId), eq(invoices.id, invoiceId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface OpenInvoice {
  id: string;
  invoiceNumber: string;
  balanceDueK: number;
}

/**
 * What resolving a reported payment to an invoice can honestly conclude.
 *
 * Three outcomes rather than "an invoice or null", because "there is nothing
 * open" and "I could not tell which one" need different answers from the
 * merchant, and collapsing them is how a payment ends up on a guess.
 */
export type PaymentTarget =
  | { outcome: 'found'; invoice: OpenInvoice }
  | { outcome: 'none' }
  | { outcome: 'ambiguous'; openCount: number };

/**
 * The invoice a reported payment belongs to.
 *
 * Two ways of naming one, in the order a merchant's certainty runs: an
 * invoice number they typed, then the newest open invoice of the customer
 * they named. Neither FALLS THROUGH to a wider search when it misses, and
 * that is the whole point of the function. Money applied to the wrong
 * customer's books is worse than money not applied yet, because only one of
 * those is visible: the customer who paid still shows as owing, and the one
 * who did not shows as settled.
 *
 * Naming nobody is allowed only where it is unambiguous. One open invoice is
 * the only invoice they could have meant; several is a question.
 *
 * The customer match reads the SNAPSHOT as well as the joined customer row.
 * A chat-issued invoice carries `customer_id = NULL` and keeps the token in
 * `snapshot_json`, so a join alone matched nothing for exactly the invoices
 * this product creates.
 */
export async function openInvoiceForPayment(
  tx: TenantDb,
  businessId: string,
  hint: { invoiceNumber?: string | null; customerToken?: string | null },
): Promise<PaymentTarget> {
  if (hint.invoiceNumber) {
    const rows = await tx.execute<OpenInvoiceRow>(sql`
      SELECT id, invoice_number, balance_due_k::bigint AS balance_due_k
      FROM invoices
      WHERE business_id = ${businessId}::uuid
        AND upper(invoice_number) = upper(${hint.invoiceNumber})
        AND status IN ('issued', 'partially_paid')
      LIMIT 1
    `);
    const row = [...rows][0];
    return row ? { outcome: 'found', invoice: readOpenInvoice(row) } : { outcome: 'none' };
  }

  if (hint.customerToken) {
    const rows = await tx.execute<OpenInvoiceRow>(sql`
      SELECT i.id, i.invoice_number, i.balance_due_k::bigint AS balance_due_k
      FROM invoices i
      LEFT JOIN customers c ON c.id = i.customer_id AND c.business_id = i.business_id
      WHERE i.business_id = ${businessId}::uuid
        AND i.status IN ('issued', 'partially_paid')
        AND (c.token = ${hint.customerToken}
             OR i.snapshot_json ->> 'customerToken' = ${hint.customerToken})
      ORDER BY i.created_at DESC
      LIMIT 1
    `);
    const row = [...rows][0];
    return row ? { outcome: 'found', invoice: readOpenInvoice(row) } : { outcome: 'none' };
  }

  /* Nobody named. `count(*) OVER ()` is evaluated before LIMIT, so one pass
   * reads the candidate and how many candidates there were. */
  const rows = await tx.execute<OpenInvoiceRow & { open_count: number }>(sql`
    SELECT id, invoice_number, balance_due_k::bigint AS balance_due_k,
           count(*) OVER ()::int AS open_count
    FROM invoices
    WHERE business_id = ${businessId}::uuid AND status IN ('issued', 'partially_paid')
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const row = [...rows][0];
  if (!row) return { outcome: 'none' };
  if (row.open_count > 1) return { outcome: 'ambiguous', openCount: row.open_count };
  return { outcome: 'found', invoice: readOpenInvoice(row) };
}

type OpenInvoiceRow = {
  id: string;
  invoice_number: string;
  balance_due_k: string;
};

function readOpenInvoice(row: OpenInvoiceRow): OpenInvoice {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    balanceDueK: Number(row.balance_due_k),
  };
}

/**
 * One invoice by its number, for chasing it.
 *
 * Deliberately not `openInvoiceForPayment`: that one resolves what a merchant
 * MEANT and refuses to guess, which is right for money and wrong here. A
 * reminder names an exact document, and "that one is already paid" is a
 * useful answer rather than a failure.
 */
export async function invoiceByNumber(
  tx: TenantDb,
  businessId: string,
  invoiceNumber: string,
): Promise<{ invoiceNumber: string; balanceDueK: number; dueDate: Date | null } | null> {
  const rows = await tx.execute<{
    invoice_number: string;
    balance_due_k: string;
    due_date: Date | null;
  }>(sql`
    SELECT invoice_number, balance_due_k::bigint AS balance_due_k, due_date
    FROM invoices
    WHERE business_id = ${businessId}::uuid AND upper(invoice_number) = upper(${invoiceNumber})
    LIMIT 1
  `);
  const row = [...rows][0];
  if (!row) return null;
  return {
    invoiceNumber: row.invoice_number,
    balanceDueK: Number(row.balance_due_k),
    dueDate: row.due_date === null ? null : new Date(row.due_date),
  };
}

/**
 * Everything one customer still owes.
 *
 * Matches the snapshot token as well as the joined customer row, for the same
 * reason `openInvoiceForPayment` does: a chat-issued invoice carries
 * `customer_id = NULL` and keeps the token in `snapshot_json`, so a join
 * alone finds nothing for exactly the invoices this product creates.
 *
 * Oldest first. A balance question is usually the prelude to a chase, and the
 * oldest debt is the one that matters.
 */
export async function openInvoicesForCustomer(
  tx: TenantDb,
  businessId: string,
  customerToken: string,
): Promise<OpenInvoice[]> {
  const rows = await tx.execute<OpenInvoiceRow>(sql`
    SELECT i.id, i.invoice_number, i.balance_due_k::bigint AS balance_due_k
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id AND c.business_id = i.business_id
    WHERE i.business_id = ${businessId}::uuid
      AND i.status IN ('issued', 'partially_paid')
      AND (c.token = ${customerToken}
           OR i.snapshot_json ->> 'customerToken' = ${customerToken})
    ORDER BY i.created_at ASC
    LIMIT 20
  `);
  return [...rows].map(readOpenInvoice);
}
