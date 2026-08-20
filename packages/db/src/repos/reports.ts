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
  const rows = await tx.execute<{
    invoice_number: string;
    balance_due_k: string;
    issued_at: Date;
    total_k: string;
    n: number;
  }>(sql`
    SELECT invoice_number, balance_due_k::bigint AS balance_due_k, created_at AS issued_at,
           SUM(balance_due_k) OVER ()::bigint AS total_k,
           count(*)  OVER ()::int   AS n
    FROM invoices
    WHERE business_id = ${businessId}::uuid AND status IN ('issued', 'partially_paid')
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);
  const list = [...rows];
  return {
    rows: list.map((r) => ({
      invoiceNumber: r.invoice_number,
      balanceDueK: Number(r.balance_due_k),
      issuedAt: new Date(r.issued_at),
    })),
    totalK: Number(list[0]?.total_k ?? 0),
    count: list[0]?.n ?? 0,
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
  const payments = await tx.execute<{ reference: string | null; amount_k: string; at: Date }>(sql`
    SELECT rekoda_reference AS reference, amount_k::bigint AS amount_k, created_at AS at
    FROM payments WHERE business_id = ${businessId}::uuid AND verified = 1
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
      label: r.reference ? `Payment ${r.reference} confirmed` : 'Payment confirmed',
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
