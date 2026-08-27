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
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  numeric,
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
    /** How much of this invoice has been credited. The over-credit guard. */
    creditedK: kobo('credited_k').notNull().default(0),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    /** Where the sale happened (§27) — NOT how it reached Rekoda. Optional. */
    saleSource: text('sale_source'),
    /**
     * The posting this invoice wrote.
     *
     * `expenses` and `credit_notes` have carried this since they existed;
     * invoices did not, and two things depended on it. A void could not say
     * what it reverses, and nothing could get from a credit on SALES_REVENUE
     * back to the invoice that caused it, which is why `sale_source` was
     * written and never read. Nullable: documents issued before the column
     * existed keep their null, and a null means unattributed rather than
     * something invented.
     */
    ledgerTransactionId: uuid('ledger_transaction_id'),
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
    /* ── provenance (spec §6.2–6.3, migration 0058) ──────────────────────
     * How this payment's truth was established, and on what instrument.
     * Nullable on every historical row, which is honest: nothing has been
     * established about them yet, and PR-006's approved backfill is the
     * only thing allowed to say otherwise.
     *
     * `initialConfirmationSource` is SET ONCE, enforced by a BEFORE UPDATE
     * trigger in the database rather than by this comment. Correction is a
     * PaymentVerification, never a rewrite; the single exemption is the
     * named rollback function in rekoda_private, reachable by no
     * application role. */
    initialConfirmationSource: text('initial_confirmation_source'),
    paymentMethod: text('payment_method'),
    evidenceBasis: text('evidence_basis'),
    paymentEvidenceId: uuid('payment_evidence_id'),
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
    /** recorded | voided. A void marks the row and mirrors its posting. */
    status: text('status').notNull().default('recorded'),
    /** The posting this entry wrote, so a void reverses what was written. */
    ledgerTransactionId: uuid('ledger_transaction_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('expenses_business_ix').on(t.businessId),
    index('expenses_business_status_ix').on(t.businessId, t.status),
  ],
);

/**
 * Credit notes — reducing an invoice money has already arrived against.
 *
 * A document, so it is never rewritten: the grants revoke UPDATE and DELETE
 * for the application role exactly as the append-only tables do.
 */
export const creditNotes = pgTable(
  'credit_notes',
  {
    id: id(),
    businessId: businessId(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    creditNoteNumber: text('credit_note_number').notNull(),
    amountK: kobo('amount_k').notNull(),
    /** The share of the credit that was VAT. Zero when the sale carried none. */
    vatK: kobo('vat_k').notNull().default(0),
    reason: text('reason').notNull(),
    actor: text('actor').notNull(),
    ledgerTransactionId: uuid('ledger_transaction_id'),
    snapshotJson: jsonb('snapshot_json'),
    docHash: text('doc_hash'),
    /** One-shot key the credit form brings, so a resubmission credits once. */
    clientRef: text('client_ref'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('credit_notes_number_ux').on(t.businessId, t.creditNoteNumber),
    index('credit_notes_invoice_ix').on(t.businessId, t.invoiceId),
    uniqueIndex('credit_notes_client_ref_ux')
      .on(t.businessId, t.clientRef)
      .where(sql`${t.clientRef} IS NOT NULL`),
  ],
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
    /** One-shot key a dashboard journal brings. Null on every other posting. */
    clientRef: text('client_ref'),
    /** §16 invariant: equals the business's own currency; a PR-039 trigger
     * enforces it. Kobo columns everywhere are this currency's minor unit. */
    functionalCurrency: char('functional_currency', { length: 3 }).notNull().default('NGN'),
    /** §9.4: what kind of financial event this entry records. Partial
     * unique with (sourceType, sourceId) when set; null on history and on
     * writers whose purpose is not yet in the vocabulary. */
    postingPurpose: text('posting_purpose'),
    /** The ledger-level dedupe key (PR-040) for writers whose event
     * identity is not (sourceType, sourceId) shaped. Partial unique. */
    postingKey: text('posting_key'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ledger_tx_business_ix').on(t.businessId),
    uniqueIndex('ledger_tx_client_ref_ux')
      .on(t.businessId, t.clientRef)
      .where(sql`${t.clientRef} IS NOT NULL`),
  ],
);

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: id(),
    businessId: businessId(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id),
    /** The chart row this entry moves (PR-031…034). The composite FK to
     * `accounts (business_id, id)` lives in migration 0063; another
     * tenant's account is unrepresentable. */
    accountId: uuid('account_id').notNull(),
    /** debitFunctionalMinor / creditFunctionalMinor (§16): always the
     * entry's functional currency. Kobo IS the NGN minor unit. */
    debitK: kobo('debit_k').notNull().default(0),
    creditK: kobo('credit_k').notNull().default(0),
    /** What the money actually was (§16). Same-currency lines carry their
     * functional amount here and no snapshot; the FX requirement — snapshot
     * REQUIRED exactly when currencies differ — lands with PR-038. */
    transactionCurrency: char('transaction_currency', { length: 3 }).notNull().default('NGN'),
    transactionAmountMinor: bigint('transaction_amount_minor', { mode: 'number' }).notNull(),
    exchangeRateSnapshotId: uuid('exchange_rate_snapshot_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ledger_entries_tx_ix').on(t.transactionId),
    /* The statement schedules: business + account + a month of created_at;
     * by prefix, every business+account balance read too. */
    index('ledger_entries_business_account_id_created_ix').on(
      t.businessId,
      t.accountId,
      t.createdAt,
    ),
    /* The overview cards and cashflow chart: a created_at window with the
     * account only in FILTER clauses, which no account-pinned index serves. */
    index('ledger_entries_business_created_ix').on(t.businessId, t.createdAt),
  ],
);

/* ── reconciliation (spec §25) ── */

/**
 * What the merchant's bank says happened (migration 0036).
 *
 * The independent half of a reconciliation. Rekoda's books are built from
 * what a merchant told it; this is what actually moved, according to somebody
 * with no reason to agree.
 *
 * Append-only by grant, like the ledger: a statement line edited to agree
 * with the books is no longer evidence of anything.
 */
export const bankStatementLines = pgTable(
  'bank_statement_lines',
  {
    id: id(),
    businessId: businessId(),
    /** The day the bank posted it. A day, because a statement reports days. */
    postedOn: date('posted_on').notNull(),
    /** Signed kobo. Positive is money INTO the account. */
    amountK: kobo('amount_k').notNull(),
    /**
     * The bank's own words, which carry counterparty names.
     *
     * Stored because it is what makes a line matchable to an invoice, shown
     * to the merchant who downloaded it, and never sent to a model.
     */
    narration: text('narration').notNull().default(''),
    bankRef: text('bank_ref'),
    /** Stops a re-upload duplicating. Computed in @rekoda/core. */
    fingerprint: text('fingerprint').notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bank_lines_fingerprint_ux').on(t.businessId, t.fingerprint),
    index('bank_lines_business_day_ix').on(t.businessId, t.postedOn),
    /* The keyset walk in allBankLinesFor: WHERE business_id AND id > ? ORDER BY id. */
    index('bank_lines_business_id_ix').on(t.businessId, t.id),
  ],
);

/**
 * Which statement line is which posting (migration 0037).
 *
 * Its own table rather than columns on the line, because a match is not part
 * of what the bank said. It is Rekoda's assertion about it, made later, by a
 * rule or by a merchant, and revisable without touching the evidence.
 *
 * One line to one posting, both ways, enforced by two unique indexes: a
 * reconciliation that explained the same money twice would report a
 * difference of zero that means nothing.
 */
export const bankLineMatches = pgTable(
  'bank_line_matches',
  {
    id: id(),
    businessId: businessId(),
    lineId: uuid('line_id')
      .notNull()
      .references(() => bankStatementLines.id, { onDelete: 'cascade' }),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id),
    /** `auto` when the rule was certain, `manual` when a person decided. */
    decidedBy: text('decided_by').notNull(),
    matchedAt: timestamp('matched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bank_match_line_ux').on(t.businessId, t.lineId),
    uniqueIndex('bank_match_tx_ux').on(t.businessId, t.transactionId),
  ],
);

/**
 * The live bank feed's standing authorisation (migration 0045, ADR 0012).
 *
 * The second door into `bank_statement_lines`: an aggregator the merchant
 * authorised reads their account and Rekoda pulls what moved. This row holds
 * only the fact of the link — provider, opaque account reference, a label —
 * never credentials, tokens or the account number. One row per business,
 * because V1 has one BANK ledger account to reconcile against.
 */
export const bankFeedConnections = pgTable(
  'bank_feed_connections',
  {
    id: id(),
    businessId: businessId(),
    provider: text('provider').notNull(),
    /** The aggregator's id for the linked account. Opaque and theirs. */
    accountRef: text('account_ref').notNull(),
    bankName: text('bank_name').notNull(),
    accountLast4: text('account_last4').notNull(),
    /** linked | unlinked. Unlinked keeps the row: lapsed is not never-was. */
    status: text('status').notNull().default('linked'),
    /** The last Lagos day a sync ran, so the next fetch knows where to start. */
    lastSyncedOn: date('last_synced_on'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('bank_feed_business_ux').on(t.businessId)],
);

/**
 * Paying a supplier back.
 *
 * The row is what attributes a settlement to the purchase it settles. Without
 * it a payment is a movement on a liability account and no arithmetic can say
 * which debt it cleared, which is how the ageing came to report a debt the
 * balance sheet said was gone.
 *
 * Append-only: a payment made is a fact, and correcting one is a second fact.
 */
export const supplierPayments = pgTable(
  'supplier_payments',
  {
    id: id(),
    businessId: businessId(),
    expenseId: uuid('expense_id')
      .notNull()
      .references(() => expenses.id),
    amountK: kobo('amount_k').notNull(),
    /** `cash` or `transfer`, which decides whether CASH or BANK gave it up. */
    method: text('method').notNull(),
    ledgerTransactionId: uuid('ledger_transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id),
    paidOn: date('paid_on').notNull(),
    /** One-shot key the pay form brings, so a resubmission pays once. */
    clientRef: text('client_ref'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('supplier_payments_expense_ix').on(t.businessId, t.expenseId),
    uniqueIndex('supplier_payments_client_ref_ux')
      .on(t.businessId, t.clientRef)
      .where(sql`${t.clientRef} IS NOT NULL`),
  ],
);

/**
 * Things the business keeps and uses (ADR 0026).
 *
 * `monthsCharged` rather than a last-charged date, because the arithmetic
 * that keeps an asset depreciating to exactly its cost counts months. A
 * missed sweep shows up as a count that is behind rather than as a gap
 * nobody can see.
 */
export const fixedAssets = pgTable(
  'fixed_assets',
  {
    id: id(),
    businessId: businessId(),
    description: text('description').notNull(),
    costK: kobo('cost_k').notNull(),
    usefulLifeMonths: integer('useful_life_months').notNull(),
    monthsCharged: integer('months_charged').notNull().default(0),
    boughtOn: date('bought_on').notNull(),
    ledgerTransactionId: uuid('ledger_transaction_id').references(() => ledgerTransactions.id),
    /**
     * recorded | withdrawn | sold.
     *
     * A withdrawal MIRRORS the purchase posting: it should never have been
     * recorded. A sale does not, because the business really did own the
     * thing and really did use it, and reversing the purchase would erase
     * months of depreciation that genuinely reached the profit and loss.
     */
    status: text('status').notNull().default('recorded'),
    /** What came back. Zero when it was scrapped; null when not sold. */
    proceedsK: kobo('proceeds_k'),
    soldOn: date('sold_on'),
    /** One-shot key the record form brings, so a resubmission records once. */
    clientRef: text('client_ref'),
    createdAt: createdAt(),
  },
  (t) => [
    index('fixed_assets_business_ix').on(t.businessId, t.status),
    uniqueIndex('fixed_assets_client_ref_ux')
      .on(t.businessId, t.clientRef)
      .where(sql`${t.clientRef} IS NOT NULL`),
  ],
);

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

/**
 * A cost that repeats: the template, plus the day of the month it lands on.
 *
 * A working row rather than a document. What it raises is an ordinary expense
 * with an ordinary posting, correctable the same way, and retiring a schedule
 * never disturbs an entry it already wrote.
 */
export const recurringEntries = pgTable(
  'recurring_entries',
  {
    id: id(),
    businessId: businessId(),
    description: text('description').notNull(),
    category: text('category'),
    amountK: kobo('amount_k').notNull(),
    method: text('method').notNull().default('cash'),
    /** 1 to 31, as the merchant chose it. Never overwritten by a clamped date. */
    anchorDay: integer('anchor_day').notNull(),
    /** A Lagos calendar day, `YYYY-MM-DD`. Not an instant: "the 1st" is a day. */
    nextDueOn: date('next_due_on').notNull(),
    /** The sweep's claim. Null until the schedule has raised anything. */
    lastRaisedOn: date('last_raised_on'),
    active: boolean('active').notNull().default(true),
    /** One-shot key the schedule form brings, so a resubmission creates once. */
    clientRef: text('client_ref'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('recurring_business_ix').on(t.businessId, t.createdAt),
    uniqueIndex('recurring_client_ref_ux')
      .on(t.businessId, t.clientRef)
      .where(sql`${t.clientRef} IS NOT NULL`),
  ],
);

/* ── accounting periods (spec §8; migration 0067, PR-036) ── */

/**
 * A closed month as a row. A month never closed has no row at all; a
 * reopened month keeps its row with status 'open', because the fact that it
 * was once closed is history and history is kept. The watermark the ledger
 * triggers enforce is DERIVED: MAX(period) over rows with status 'closed'.
 */
export const accountingPeriods = pgTable(
  'accounting_periods',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    /** Lagos month, YYYY-MM. */
    period: char('period', { length: 7 }).notNull(),
    status: text('status').notNull(), // closed | open
    closedAt: timestamp('closed_at', { withTimezone: true }).notNull().defaultNow(),
    closedBy: text('closed_by').notNull(),
    reopenedAt: timestamp('reopened_at', { withTimezone: true }),
    reopenedBy: text('reopened_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('accounting_periods_business_period_ux').on(t.businessId, t.period)],
);

/* ── exchange rate snapshots (spec §16, Appendix A.1; migration 0069) ── */

/**
 * A market fact, not tenant data: no businessId, no RLS. Immutable once
 * written (UPDATE/DELETE revoked in 0069); `effectiveAt` is the moment the
 * rate applies to, never fetch time; a MANUAL_OVERRIDE carries who decided
 * and why, by CHECK.
 */
export const exchangeRateSnapshots = pgTable('exchange_rate_snapshots', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  baseCurrency: char('base_currency', { length: 3 }).notNull(),
  quoteCurrency: char('quote_currency', { length: 3 }).notNull(),
  /** Full provider precision, never rounded — a decimal string. */
  rate: numeric('rate').notNull(),
  effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  source: text('source').notNull(), // PROVIDER | MANUAL_OVERRIDE | INHERITED
  providerName: text('provider_name').notNull(),
  providerReference: text('provider_reference'),
  actorId: text('actor_id'),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
