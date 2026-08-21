/**
 * The reporting read layer (MASTER-PLAN §5.3.7, ADR 0015 "one ledger, two
 * lenses") — every number the dashboard shows, derived from rows, in SQL.
 *
 * Rules this file lives by:
 *   - Every figure is computed by PostgreSQL from `ledger_entries`, `invoices`
 *     and `reconciliations`. No AI anywhere near a number (M3 exit criterion:
 *     "every report figure traceable to SQL").
 *   - "Money in / money out" is the CASH lens: movement on the CASH and
 *     BANK_PAYSTACK accounts. The merchant's default view is money that
 *     actually moved, in plain labels — never the words "cash basis".
 *   - Months are Lagos months. Nigeria is UTC+1 with no DST, so the bucket is
 *     `date_trunc('month', created_at + interval '1 hour')` — the same fixed
 *     offset `usagePeriod` uses, applied in SQL.
 *
 * The VERIFIED split (ADR 0014): a bank debit whose ledger transaction came
 * from a webhook is provider-confirmed money; everything else the merchant
 * told us. The dashboard shows the split rather than blending trust levels
 * into one figure.
 */
import { sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';

/** Accounts whose movement IS "money in / money out" under the cash lens. */
const CASH_ACCOUNTS = sql`'CASH', 'BANK_PAYSTACK'`;

export interface Overview {
  /** Cash that arrived this Lagos month, in kobo. */
  moneyInK: number;
  /** The provider-confirmed portion of moneyInK. */
  verifiedInK: number;
  /** Cash that left this Lagos month. */
  moneyOutK: number;
  /** Sales recognised this Lagos month (accrual — includes money still owed). */
  salesK: number;
  /** Open invoice balances, all time. The "who owes me" total. */
  owedToYouK: number;
  /** What the business owes suppliers (ACCOUNTS_PAYABLE balance), all time. */
  youOweK: number;
  /** Reconciliation exceptions still awaiting a human. */
  exceptionsOpen: number;
}

export async function overviewFor(tx: TenantDb, businessId: string): Promise<Overview> {
  const monthRows = await tx.execute<{
    money_in_k: string;
    verified_in_k: string;
    money_out_k: string;
    sales_k: string;
  }>(sql`
    SELECT
      COALESCE(SUM(e.debit_k)  FILTER (WHERE e.account IN (${CASH_ACCOUNTS})), 0)::bigint AS money_in_k,
      COALESCE(SUM(e.debit_k)  FILTER (WHERE e.account = 'BANK_PAYSTACK'
                                         AND t.source_type = 'webhook'), 0)::bigint      AS verified_in_k,
      COALESCE(SUM(e.credit_k) FILTER (WHERE e.account IN (${CASH_ACCOUNTS})), 0)::bigint AS money_out_k,
      COALESCE(SUM(e.credit_k) FILTER (WHERE e.account = 'SALES_REVENUE'), 0)::bigint     AS sales_k
    FROM ledger_entries e
    JOIN ledger_transactions t ON t.id = e.transaction_id
    WHERE e.business_id = ${businessId}::uuid
      AND e.created_at >= date_trunc('month', now() + interval '1 hour') - interval '1 hour'
  `);
  const month = [...monthRows][0];

  const owedRows = await tx.execute<{ owed_k: string }>(sql`
    SELECT COALESCE(SUM(balance_due_k), 0)::bigint AS owed_k
    FROM invoices
    WHERE business_id = ${businessId}::uuid AND status IN ('issued', 'partially_paid')
  `);

  const apRows = await tx.execute<{ ap_k: string }>(sql`
    SELECT COALESCE(SUM(credit_k) - SUM(debit_k), 0)::bigint AS ap_k
    FROM ledger_entries
    WHERE business_id = ${businessId}::uuid AND account = 'ACCOUNTS_PAYABLE'
  `);

  const exceptionRows = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
    FROM reconciliations
    WHERE business_id = ${businessId}::uuid AND status = 'EXCEPTION' AND resolved_at IS NULL
  `);

  return {
    moneyInK: Number(month?.money_in_k ?? 0),
    verifiedInK: Number(month?.verified_in_k ?? 0),
    moneyOutK: Number(month?.money_out_k ?? 0),
    salesK: Number(month?.sales_k ?? 0),
    owedToYouK: Number([...owedRows][0]?.owed_k ?? 0),
    youOweK: Number([...apRows][0]?.ap_k ?? 0),
    exceptionsOpen: [...exceptionRows][0]?.n ?? 0,
  };
}

export interface CashflowMonth {
  /** Lagos month, `YYYY-MM`. */
  period: string;
  inK: number;
  outK: number;
}

/**
 * The last `months` Lagos months of cash movement, oldest first, with quiet
 * months present as zeros — a chart with missing bars reads as a bug, not as
 * a quiet month.
 */
export async function cashflowFor(
  tx: TenantDb,
  businessId: string,
  months: number,
): Promise<CashflowMonth[]> {
  const rows = await tx.execute<{ period: string; in_k: string; out_k: string }>(sql`
    SELECT
      to_char(date_trunc('month', e.created_at + interval '1 hour'), 'YYYY-MM') AS period,
      COALESCE(SUM(e.debit_k)  FILTER (WHERE e.account IN (${CASH_ACCOUNTS})), 0)::bigint AS in_k,
      COALESCE(SUM(e.credit_k) FILTER (WHERE e.account IN (${CASH_ACCOUNTS})), 0)::bigint AS out_k
    FROM ledger_entries e
    WHERE e.business_id = ${businessId}::uuid
      AND e.created_at >= date_trunc('month', now() + interval '1 hour')
                          - make_interval(months => ${months - 1}) - interval '1 hour'
    GROUP BY 1
    ORDER BY 1
  `);
  const byPeriod = new Map([...rows].map((r) => [r.period, r]));

  /* Gap-fill against the Lagos calendar, computed the same way usagePeriod
   * does it: shift to UTC+1, read the UTC fields. */
  const out: CashflowMonth[] = [];
  const lagosNow = new Date(Date.now() + 3_600_000);
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(lagosNow.getUTCFullYear(), lagosNow.getUTCMonth() - i, 1));
    const period = d.toISOString().slice(0, 7);
    const row = byPeriod.get(period);
    out.push({
      period,
      inK: Number(row?.in_k ?? 0),
      outK: Number(row?.out_k ?? 0),
    });
  }
  return out;
}

export interface DebtorRow {
  invoiceNumber: string;
  balanceDueK: number;
  issuedAt: Date;
  /** When the merchant said the money was expected. Null when they did not. */
  dueDate: Date | null;
}

export interface Debtors {
  rows: DebtorRow[];
  /** Sum over ALL open invoices, not only the listed page. */
  totalK: number;
  count: number;
}

/**
 * Who owes the merchant — per invoice, newest first.
 *
 * Per INVOICE and not per customer: the web tier holds no vault
 * key, so a customer here could only be a token like CUSTOMER_7K2, and a
 * dashboard that shows tokens teaches merchants to ignore the list. The
 * invoice number is real, quotable, and what they read down the phone.
 */
export async function debtorsFor(
  tx: TenantDb,
  businessId: string,
  limit: number,
): Promise<Debtors> {
  /**
   * Ordered by DUE DATE, not by issue date.
   *
   * A debtors list is a work queue, and the work is oldest-debt-first: the
   * money most at risk is the money longest past its promised day. Invoices
   * with no agreed date sort last, because nobody agreed to chase them.
   */
  const rows = await tx.execute<{
    invoice_number: string;
    balance_due_k: string;
    issued_at: Date;
    due_date: Date | null;
    total_k: string;
    n: number;
  }>(sql`
    SELECT invoice_number, balance_due_k::bigint AS balance_due_k, created_at AS issued_at,
           due_date,
           SUM(balance_due_k) OVER ()::bigint AS total_k,
           count(*)  OVER ()::int   AS n
    FROM invoices
    WHERE business_id = ${businessId}::uuid AND status IN ('issued', 'partially_paid')
    ORDER BY due_date ASC NULLS LAST, created_at DESC
    LIMIT ${limit}
  `);
  const list = [...rows];
  return {
    rows: list.map((r) => ({
      invoiceNumber: r.invoice_number,
      balanceDueK: Number(r.balance_due_k),
      issuedAt: new Date(r.issued_at),
      dueDate: r.due_date === null ? null : new Date(r.due_date),
    })),
    totalK: Number(list[0]?.total_k ?? 0),
    count: list[0]?.n ?? 0,
  };
}

/**
 * Receivable ageing — the view an accountant opens first, and the one both
 * QuickBooks and HelloBooks put on the front page.
 *
 * Bucketed in SQL rather than in TypeScript because the whole table has to be
 * summed, not the page of it a list shows: an ageing report that silently
 * described the latest 20 invoices would be wrong in the direction that
 * matters. The boundaries match `ageBucket` in core, which the chat and the
 * PDF use, so the same debt lands in the same bucket wherever it is read.
 *
 * `current` deliberately holds BOTH money not yet due and money with no
 * agreed date: neither is late, and ageing an undated debt would invent a
 * deadline the merchant never set.
 */
export interface Ageing {
  currentK: number;
  d1_30K: number;
  d31_60K: number;
  d61_90K: number;
  d90PlusK: number;
  /** Everything owed, whatever its age. Equal to the buckets summed. */
  totalK: number;
  /** Owed and past its agreed day: the part with a name attached. */
  overdueK: number;
}

export async function ageingFor(
  tx: TenantDb,
  businessId: string,
  now = new Date(),
): Promise<Ageing> {
  const rows = await tx.execute<{
    current_k: string;
    d1_30_k: string;
    d31_60_k: string;
    d61_90_k: string;
    d90_plus_k: string;
    total_k: string;
  }>(sql`
    WITH open_invoices AS (
      SELECT balance_due_k,
             CASE
               WHEN due_date IS NULL THEN 0
               /* Both sides cast to a Lagos DATE first, so this is integer
                * day arithmetic rather than an interval: a debt due at 23:59
                * and read at 00:01 is one day late, not zero point something. */
               ELSE GREATEST(
                 0,
                 (${now.toISOString()}::timestamptz AT TIME ZONE 'Africa/Lagos')::date
                   - (due_date AT TIME ZONE 'Africa/Lagos')::date
               )
             END AS days_late
      FROM invoices
      WHERE business_id = ${businessId}::uuid
        AND status IN ('issued', 'partially_paid')
        AND balance_due_k > 0
    )
    SELECT
      COALESCE(SUM(balance_due_k) FILTER (WHERE days_late <= 0), 0)::bigint  AS current_k,
      COALESCE(SUM(balance_due_k) FILTER (WHERE days_late BETWEEN 1 AND 30), 0)::bigint  AS d1_30_k,
      COALESCE(SUM(balance_due_k) FILTER (WHERE days_late BETWEEN 31 AND 60), 0)::bigint AS d31_60_k,
      COALESCE(SUM(balance_due_k) FILTER (WHERE days_late BETWEEN 61 AND 90), 0)::bigint AS d61_90_k,
      COALESCE(SUM(balance_due_k) FILTER (WHERE days_late > 90), 0)::bigint   AS d90_plus_k,
      COALESCE(SUM(balance_due_k), 0)::bigint                                AS total_k
    FROM open_invoices
  `);
  const row = [...rows][0];
  const current = Number(row?.current_k ?? 0);
  const total = Number(row?.total_k ?? 0);
  return {
    currentK: current,
    d1_30K: Number(row?.d1_30_k ?? 0),
    d31_60K: Number(row?.d31_60_k ?? 0),
    d61_90K: Number(row?.d61_90_k ?? 0),
    d90PlusK: Number(row?.d90_plus_k ?? 0),
    totalK: total,
    overdueK: total - current,
  };
}

export interface ActivityItem {
  kind: 'sale' | 'payment' | 'expense' | 'purchase';
  /** Already merchant-readable; never a token, never PII. */
  label: string;
  amountK: number;
  at: Date;
}

/**
 * The most recent things that happened to the books, as a merchant would
 * name them — built from the operational tables rather than ledger memos,
 * because memos carry customer TOKENS and a feed of CUSTOMER_7K2s is a feed
 * nobody reads.
 */
export async function activityFor(
  tx: TenantDb,
  businessId: string,
  limit: number,
): Promise<ActivityItem[]> {
  const invoices = await tx.execute<{ invoice_number: string; total_k: string; at: Date }>(sql`
    SELECT invoice_number, total_k::bigint AS total_k, created_at AS at
    FROM invoices WHERE business_id = ${businessId}::uuid
    ORDER BY created_at DESC LIMIT ${limit}
  `);
  /* Verified AND recorded. Filtering to `verified = 1` here meant a merchant
   * who recorded a payment in chat, got "Saved", and opened the dashboard saw
   * the invoice change with no payment behind it (ADR 0014: both are real
   * money, they differ in who vouches for it, not in whether it happened). */
  const payments = await tx.execute<{
    reference: string | null;
    amount_k: string;
    at: Date;
    verified: number;
  }>(sql`
    SELECT rekoda_reference AS reference, amount_k::bigint AS amount_k, created_at AS at,
           verified
    FROM payments WHERE business_id = ${businessId}::uuid
    ORDER BY created_at DESC LIMIT ${limit}
  `);
  const spend = await tx.execute<{
    description: string;
    category: string | null;
    amount_k: string;
    at: Date;
  }>(sql`
    SELECT description, category, amount_k::bigint AS amount_k, created_at AS at
    FROM expenses WHERE business_id = ${businessId}::uuid
    ORDER BY created_at DESC LIMIT ${limit}
  `);

  const items: ActivityItem[] = [
    ...[...invoices].map((r): ActivityItem => ({
      kind: 'sale',
      label: `Invoice ${r.invoice_number} issued`,
      amountK: Number(r.total_k),
      at: new Date(r.at),
    })),
    ...[...payments].map((r): ActivityItem => ({
      kind: 'payment',
      label:
        r.verified === 1
          ? r.reference
            ? `Payment ${r.reference} confirmed`
            : 'Payment confirmed'
          : 'Payment recorded',
      amountK: Number(r.amount_k),
      at: new Date(r.at),
    })),
    ...[...spend].map((r): ActivityItem => ({
      kind: r.category === 'stock' ? 'purchase' : 'expense',
      label: r.category === 'stock' ? `Stock: ${r.description}` : `Expense: ${r.description}`,
      amountK: Number(r.amount_k),
      at: new Date(r.at),
    })),
  ];

  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}

export interface AccountSumsRow {
  account: string;
  periodDebitK: number;
  periodCreditK: number;
  cumulativeDebitK: number;
  cumulativeCreditK: number;
}

/**
 * Per-account debit/credit sums for one Lagos month and cumulatively up to
 * its end — the single query all four statements are assembled from
 * (@rekoda/core statements.ts). `period` is validated as YYYY-MM upstream.
 */
export async function accountSumsFor(
  tx: TenantDb,
  businessId: string,
  period: string,
): Promise<AccountSumsRow[]> {
  const rows = await tx.execute<{
    account: string;
    period_debit_k: string;
    period_credit_k: string;
    cumulative_debit_k: string;
    cumulative_credit_k: string;
  }>(sql`
    WITH bounds AS (
      SELECT (${period} || '-01T00:00:00Z')::timestamptz - interval '1 hour' AS pstart,
             ((${period} || '-01T00:00:00Z')::timestamptz - interval '1 hour')
               + interval '1 month' AS pend
    )
    SELECT e.account,
      COALESCE(SUM(e.debit_k)  FILTER (WHERE e.created_at >= b.pstart), 0)::bigint AS period_debit_k,
      COALESCE(SUM(e.credit_k) FILTER (WHERE e.created_at >= b.pstart), 0)::bigint AS period_credit_k,
      COALESCE(SUM(e.debit_k), 0)::bigint  AS cumulative_debit_k,
      COALESCE(SUM(e.credit_k), 0)::bigint AS cumulative_credit_k
    FROM ledger_entries e, bounds b
    WHERE e.business_id = ${businessId}::uuid AND e.created_at < b.pend
    GROUP BY e.account
    ORDER BY e.account
  `);
  return [...rows].map((r) => ({
    account: r.account,
    periodDebitK: Number(r.period_debit_k),
    periodCreditK: Number(r.period_credit_k),
    cumulativeDebitK: Number(r.cumulative_debit_k),
    cumulativeCreditK: Number(r.cumulative_credit_k),
  }));
}

export interface InvoiceListRow {
  invoiceNumber: string;
  status: string;
  totalK: number;
  paidK: number;
  balanceDueK: number;
  /** Already credited. The register offers only what is left to credit. */
  creditedK: number;
  issuedAt: Date;
  /** When the money was agreed to arrive. Null when nobody said. */
  dueDate: Date | null;
}

export interface InvoiceList {
  rows: InvoiceListRow[];
  /** Every invoice the business has issued, not just the page shown. */
  count: number;
  /** Open balances across ALL invoices, so the summary stays honest when truncated. */
  outstandingK: number;
}

/** The invoice register, newest first. Numbers only — never a customer name. */
export async function invoicesFor(
  tx: TenantDb,
  businessId: string,
  limit: number,
): Promise<InvoiceList> {
  const rows = await tx.execute<{
    invoice_number: string;
    status: string;
    due_date: Date | null;
    total_k: string;
    paid_k: string;
    balance_due_k: string;
    credited_k: string;
    issued_at: Date;
  }>(sql`
    SELECT invoice_number, status, due_date, total_k::bigint AS total_k, paid_k::bigint AS paid_k,
           balance_due_k::bigint AS balance_due_k, credited_k::bigint AS credited_k,
           created_at AS issued_at
    FROM invoices
    WHERE business_id = ${businessId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  const totals = await tx.execute<{ n: number; outstanding_k: string }>(sql`
    SELECT count(*)::int AS n,
           COALESCE(SUM(balance_due_k) FILTER (WHERE status IN ('issued', 'partially_paid')), 0)::bigint
             AS outstanding_k
    FROM invoices
    WHERE business_id = ${businessId}::uuid
  `);
  const t = [...totals][0];
  return {
    rows: [...rows].map((r) => ({
      invoiceNumber: r.invoice_number,
      status: r.status,
      totalK: Number(r.total_k),
      paidK: Number(r.paid_k),
      balanceDueK: Number(r.balance_due_k),
      creditedK: Number(r.credited_k),
      issuedAt: new Date(r.issued_at),
      dueDate: r.due_date === null ? null : new Date(r.due_date),
    })),
    count: t?.n ?? 0,
    outstandingK: Number(t?.outstanding_k ?? 0),
  };
}

export interface ReceiptListRow {
  receiptNumber: string;
  amountK: number;
  issuedAt: Date;
  /** The invoice this receipt settled, when one exists. */
  invoiceNumber: string | null;
  /** 1 when a provider confirmed the money behind it, 0 when the merchant did. */
  verified: number;
}

export interface ReceiptList {
  rows: ReceiptListRow[];
  count: number;
}

/** The receipt register, newest first. Every row is a REAL recorded payment. */
export async function receiptsFor(
  tx: TenantDb,
  businessId: string,
  limit: number,
): Promise<ReceiptList> {
  const rows = await tx.execute<{
    receipt_number: string;
    amount_k: string;
    issued_at: Date;
    invoice_number: string | null;
    verified: number;
  }>(sql`
    SELECT r.receipt_number, r.amount_k::bigint AS amount_k, r.created_at AS issued_at,
           i.invoice_number, p.verified
    FROM receipts r
    JOIN payments p ON p.id = r.payment_id AND p.business_id = r.business_id
    LEFT JOIN invoices i ON i.id = r.invoice_id AND i.business_id = r.business_id
    WHERE r.business_id = ${businessId}::uuid
    ORDER BY r.created_at DESC
    LIMIT ${limit}
  `);
  const totals = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM receipts WHERE business_id = ${businessId}::uuid
  `);
  return {
    rows: [...rows].map((r) => ({
      receiptNumber: r.receipt_number,
      amountK: Number(r.amount_k),
      issuedAt: new Date(r.issued_at),
      invoiceNumber: r.invoice_number,
      verified: r.verified,
    })),
    count: [...totals][0]?.n ?? 0,
  };
}

export interface WindowSummary {
  /** Invoiced in the window, at issue: accrual, not cash. */
  salesK: number;
  invoices: number;
  /** Money that actually arrived, verified and merchant-reported together. */
  moneyInK: number;
  moneyOutK: number;
  expenses: number;
}

/**
 * What happened between two instants — the figures a spoken question wants.
 *
 * A window rather than a Lagos month, because "what did I sell this week" is
 * a question the statements page cannot answer and a merchant asks constantly.
 * The boundaries come from `resolvePeriod` in core: the model reports which
 * period was MEANT and code decides what that period is, so a figure in a
 * reply is only ever as trustworthy as a window somebody can read.
 */
export async function summaryFor(
  tx: TenantDb,
  businessId: string,
  from: Date,
  to: Date,
): Promise<WindowSummary> {
  const rows = await tx.execute<{
    sales_k: string;
    invoices: number;
    money_in_k: string;
    money_out_k: string;
    expenses: number;
  }>(sql`
    SELECT
      COALESCE((SELECT SUM(total_k) FROM invoices
                WHERE business_id = ${businessId}::uuid
                  AND status <> 'voided'
                  AND created_at BETWEEN ${from.toISOString()}::timestamptz
                                     AND ${to.toISOString()}::timestamptz), 0)::bigint AS sales_k,
      COALESCE((SELECT count(*) FROM invoices
                WHERE business_id = ${businessId}::uuid
                  AND status <> 'voided'
                  AND created_at BETWEEN ${from.toISOString()}::timestamptz
                                     AND ${to.toISOString()}::timestamptz), 0)::int    AS invoices,
      COALESCE((SELECT SUM(amount_k) FROM payments
                WHERE business_id = ${businessId}::uuid
                  AND created_at BETWEEN ${from.toISOString()}::timestamptz
                                     AND ${to.toISOString()}::timestamptz), 0)::bigint AS money_in_k,
      COALESCE((SELECT SUM(amount_k) FROM expenses
                WHERE business_id = ${businessId}::uuid
                  AND created_at BETWEEN ${from.toISOString()}::timestamptz
                                     AND ${to.toISOString()}::timestamptz), 0)::bigint AS money_out_k,
      COALESCE((SELECT count(*) FROM expenses
                WHERE business_id = ${businessId}::uuid
                  AND created_at BETWEEN ${from.toISOString()}::timestamptz
                                     AND ${to.toISOString()}::timestamptz), 0)::int    AS expenses
  `);
  const row = [...rows][0];
  return {
    salesK: Number(row?.sales_k ?? 0),
    invoices: row?.invoices ?? 0,
    moneyInK: Number(row?.money_in_k ?? 0),
    moneyOutK: Number(row?.money_out_k ?? 0),
    expenses: row?.expenses ?? 0,
  };
}

/* ── the audit trail (MASTER-PLAN §42) ───────────────────────────────────── */

export interface AuditRow {
  id: string;
  actor: string;
  entity: string;
  entityId: string | null;
  action: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  sourceType: string;
  at: Date;
}

export interface AuditList {
  rows: AuditRow[];
  count: number;
}

/**
 * Every recorded change, newest first.
 *
 * `audit_events` has been written since M1 by five repos and read by nothing,
 * which meant the compliance record Rekoda keeps for a merchant had never
 * been shown to one. This is the query that ends that.
 *
 * The values travel as stored and are turned into sentences by
 * `describeAuditEvent` in @rekoda/core, where every shape is pinned by a
 * test. That split is deliberate: what a change MEANS is a product decision
 * and does not belong in SQL, and a page that formatted jsonb inline would be
 * the place a future writer's payload leaked out of.
 */
export async function auditFor(
  tx: TenantDb,
  businessId: string,
  limit: number,
): Promise<AuditList> {
  const rows = await tx.execute<{
    id: string;
    actor: string;
    entity: string;
    entity_id: string | null;
    action: string;
    old_value: unknown;
    new_value: unknown;
    reason: string | null;
    source_type: string;
    at: Date;
  }>(sql`
    SELECT id, actor, entity, entity_id, action, old_value, new_value, reason,
           source_type, created_at AS at
    FROM audit_events
    WHERE business_id = ${businessId}::uuid
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `);
  const totals = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM audit_events WHERE business_id = ${businessId}::uuid
  `);
  return {
    rows: [...rows].map((r) => ({
      id: r.id,
      actor: r.actor,
      entity: r.entity,
      entityId: r.entity_id,
      action: r.action,
      oldValue: r.old_value,
      newValue: r.new_value,
      reason: r.reason,
      sourceType: r.source_type,
      at: new Date(r.at),
    })),
    count: [...totals][0]?.n ?? 0,
  };
}
