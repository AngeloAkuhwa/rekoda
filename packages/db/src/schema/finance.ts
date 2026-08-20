/**
 * Financial documents + the double-entry ledger — spec §39, ADR 0004.
 *
 * Invariants the application layer enforces (and tests):
 *  - invoices/receipts are IMMUTABLE once issued: corrections are credit
 *    notes / reversing postings, never UPDATEs to money columns;
 *  - every ledger transaction's lines sum debits = credits (checked in
 *    @rekoda/core before insert, and by the trial-balance job after);
 *  - snapshot_json + doc_hash make any later tampering detectable.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { businesses } from './tenancy.js';
import { customers } from './privacy.js';
import { orders, suppliers } from './commerce.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const kobo = (name: string) => bigint(name, { mode: 'number' });
const businessId = () =>
  uuid('business_id')
    .notNull()
    .references(() => businesses.id);

export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    businessId: businessId(),
    customerId: uuid('customer_id').references(() => customers.id),
    orderId: uuid('order_id').references(() => orders.id),
    invoiceNumber: text('invoice_number').notNull(),
    status: text('status').notNull().default('issued'), // issued | partially_paid | paid | voided
    subtotalK: kobo('subtotal_k').notNull(),
    discountK: kobo('discount_k').notNull().default(0),
    deliveryFeeK: kobo('delivery_fee_k').notNull().default(0),
    vatK: kobo('vat_k').notNull().default(0),
    totalK: kobo('total_k').notNull(),
    paidK: kobo('paid_k').notNull().default(0),
    balanceDueK: kobo('balance_due_k').notNull(),
    currency: text('currency').notNull().default('NGN'),
    dueDate: timestamp('due_date', { withTimezone: true }),
    /** The document exactly as issued (tokenised refs, not PII). */
    snapshotJson: jsonb('snapshot_json'),
    docHash: text('doc_hash'),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    /** Where the sale happened (§27) — NOT how it reached Rekoda. Optional. */
    saleSource: text('sale_source'),
    issuedAt: createdAt(),
  },
  /**
   * Business-leading composites, because every query is tenant-scoped by
   * construction — an index that does not start with `business_id` cannot
   * serve a query RLS will allow.
   *
   * The single-column `(business_id)` and `(customer_id)` indexes these
   * replace were doing no work a composite could not: PostgreSQL uses any
   * leading subset of a composite key, so `(business_id, status)` already
   * answers everything `(business_id)` did. And `(customer_id)` alone could
   * only ever serve a cross-tenant lookup, which the policies forbid. Each
   * index removed is write amplification removed from an append-heavy ledger.
   */
  (t) => [
    uniqueIndex('invoices_number_ux').on(t.businessId, t.invoiceNumber),
    // "Who owes me?" — the debtors question, asked constantly.
    index('invoices_business_status_ix').on(t.businessId, t.status),
    // One customer's statement.
    index('invoices_business_customer_ix').on(t.businessId, t.customerId),
  ],
);

export const invoiceItems = pgTable(
  'invoice_items',
  {
    id: id(),
    businessId: businessId(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    name: text('name').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceK: kobo('unit_price_k').notNull(),
    lineTotalK: kobo('line_total_k').notNull(),
  },
  (t) => [index('invoice_items_invoice_ix').on(t.invoiceId)],
);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    businessId: businessId(),
    customerId: uuid('customer_id').references(() => customers.id),
    amountK: kobo('amount_k').notNull(),
    currency: text('currency').notNull().default('NGN'),
    method: text('method').notNull().default('transfer'), // cash | transfer | pos | unknown
    /** Payment Recorded vs Payment Verified — the honesty rule (spec §10). */
    verified: integer('verified').notNull().default(0),
    providerRef: text('provider_ref'),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    /* ── the verified-payment breakdown (payments-v1 §14–17, migration 0011).
     * All nullable: merchant-RECORDED payments have no provider, no fee and
     * no settlement, and zeros would blur RECORDED vs VERIFIED (ADR 0014). */
    grossAmountK: kobo('gross_amount_k'),
    providerFeeK: kobo('provider_fee_k'),
    platformFeeK: kobo('platform_fee_k'),
    settlementAmountK: kobo('settlement_amount_k'),
    rekodaReference: text('rekoda_reference'),
    providerType: text('provider_type'),
    paymentIntentId: uuid('payment_intent_id'),
    /** The provider's native status verbatim, for audit — never trusted. */
    providerStatus: text('provider_status'),
    status: text('status'), // pending|processing|confirmed|failed|reversed|refunded|partially_refunded
    /** not_applicable (merchant-recorded: NULL) · pending · processing · settled · failed · held */
    settlementStatus: text('settlement_status'),
    /** The provider's effective settlement date, stamped by the polling sweep. */
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('payments_provider_ref_ux').on(t.businessId, t.providerRef),
    // One verified payment per Rekoda reference (see migration 0011).
    uniqueIndex('payments_rekoda_reference_ux')
      .on(t.businessId, t.rekodaReference)
      .where(sql`rekoda_reference IS NOT NULL`),
    /**
     * The reconciliation queue: unverified payments for one business.
     *
     * `verified` rather than `status` — this table records whether the money
     * was CONFIRMED with the provider, which is the distinction the whole
     * anti-fake-alert feature rests on (spec §10, ADR 0014).
     */
    index('payments_business_verified_ix').on(t.businessId, t.verified),
  ],
);

/** One payment can settle several invoices; one invoice several payments. */
export const paymentAllocations = pgTable(
  'payment_allocations',
  {
    id: id(),
    businessId: businessId(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    amountK: kobo('amount_k').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('alloc_payment_ix').on(t.paymentId), index('alloc_invoice_ix').on(t.invoiceId)],
);

export const receipts = pgTable(
  'receipts',
  {
    id: id(),
    businessId: businessId(),
    customerId: uuid('customer_id').references(() => customers.id),
    receiptNumber: text('receipt_number').notNull(),
    /** A receipt represents a REAL recorded payment — spec rule 12. */
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id),
    invoiceId: uuid('invoice_id').references(() => invoices.id),
    amountK: kobo('amount_k').notNull(),
    currency: text('currency').notNull().default('NGN'),
    snapshotJson: jsonb('snapshot_json'),
    docHash: text('doc_hash'),
    issuedAt: createdAt(),
  },
  (t) => [
    uniqueIndex('receipts_number_ux').on(t.businessId, t.receiptNumber),
    index('receipts_business_ix').on(t.businessId),
  ],
);

export const expenses = pgTable(
  'expenses',
  {
    id: id(),
    businessId: businessId(),
    description: text('description').notNull(),
    category: text('category'),
    amountK: kobo('amount_k').notNull(),
    method: text('method').notNull().default('cash'),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    createdAt: createdAt(),
  },
  (t) => [index('expenses_business_ix').on(t.businessId)],
);

/* ── the double-entry ledger (ADR 0004) ── */

export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: id(),
    businessId: businessId(),
    memo: text('memo').notNull(),
    /** Reversal chains: a correction points at what it reverses. */
    reversesId: uuid('reverses_id'),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    createdAt: createdAt(),
  },
  (t) => [index('ledger_tx_business_ix').on(t.businessId)],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: id(),
    businessId: businessId(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id),
    /** Account key from @rekoda/core ACCOUNTS (CASH, SALES_REVENUE, …). */
    account: text('account').notNull(),
    debitK: kobo('debit_k').notNull().default(0),
    creditK: kobo('credit_k').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('ledger_entries_tx_ix').on(t.transactionId),
    index('ledger_entries_account_ix').on(t.businessId, t.account),
  ],
);

/* ── reconciliation (spec §25) ── */

export const reconciliations = pgTable(
  'reconciliations',
  {
    id: id(),
    businessId: businessId(),
    status: text('status').notNull(), // MATCHED | PARTIAL | UNMATCHED | EXCEPTION
    reason: text('reason'),
    expectationKind: text('expectation_kind'), // invoice | order | reported_payment
    expectationId: text('expectation_id'),
    paymentId: uuid('payment_id').references(() => payments.id),
    amountK: kobo('amount_k'),
    outstandingK: kobo('outstanding_k'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
    createdAt: createdAt(),
  },
  (t) => [index('recon_business_status_ix').on(t.businessId, t.status)],
);
