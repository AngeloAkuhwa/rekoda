/**
 * The dashboard's numbers, on the wire (MASTER-PLAN §5.3.7, ADR 0015).
 *
 * Every figure here was computed by SQL in the reports repo; these schemas
 * are the border checkpoint that keeps the web tier honest about what it
 * received. Amounts are integer KOBO end to end — the web renders them with
 * formatKobo and nothing else.
 */
import { z } from 'zod';

const kobo = z.number().int().finite().nonnegative();

export const reportsOverviewResponse = z.object({
  /** Lagos month this overview covers, YYYY-MM. */
  period: z.string().regex(/^\d{4}-\d{2}$/),
  moneyInK: kobo,
  /** Provider-confirmed portion of moneyInK (ADR 0014). */
  verifiedInK: kobo,
  moneyOutK: kobo,
  salesK: kobo,
  owedToYouK: kobo,
  youOweK: kobo,
  exceptionsOpen: z.number().int().nonnegative(),
});
export type ReportsOverviewResponse = z.infer<typeof reportsOverviewResponse>;

export const reportsCashflowResponse = z.object({
  months: z
    .array(
      z.object({
        period: z.string().regex(/^\d{4}-\d{2}$/),
        inK: kobo,
        outK: kobo,
      }),
    )
    .max(24),
});
export type ReportsCashflowResponse = z.infer<typeof reportsCashflowResponse>;

export const reportsDebtorsResponse = z.object({
  rows: z
    .array(
      z.object({
        invoiceNumber: z.string(),
        balanceDueK: kobo,
        issuedAt: z.string(), // ISO
      }),
    )
    .max(50),
  totalK: kobo,
  count: z.number().int().nonnegative(),
});
export type ReportsDebtorsResponse = z.infer<typeof reportsDebtorsResponse>;

/** GET /v1/payments/usage — the month's meter, for the dashboard. */
export const usageMeterResponse = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  plan: z.string(),
  units: z.array(
    z.object({
      unit: z.string(),
      used: z.number().int().nonnegative(),
      bonus: z.number().int().nonnegative(),
    }),
  ),
});
export type UsageMeterResponse = z.infer<typeof usageMeterResponse>;

export const reportsActivityResponse = z.object({
  items: z
    .array(
      z.object({
        kind: z.enum(['sale', 'payment', 'expense', 'purchase']),
        label: z.string(),
        amountK: kobo,
        at: z.string(), // ISO
      }),
    )
    .max(50),
});
export type ReportsActivityResponse = z.infer<typeof reportsActivityResponse>;

/* ── the four statements (ADR 0015) ─────────────────────────────────────── */

const statementLine = z.object({
  account: z.string(),
  code: z.string(),
  name: z.string(),
  amountK: z.number().int().finite(),
});

export const reportsStatementsResponse = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  trialBalance: z.object({
    rows: z.array(
      z.object({
        account: z.string(),
        code: z.string(),
        name: z.string(),
        debitK: kobo,
        creditK: kobo,
      }),
    ),
    totalDebitK: kobo,
    totalCreditK: kobo,
    balanced: z.boolean(),
  }),
  profitAndLoss: z.object({
    income: z.array(statementLine),
    expenses: z.array(statementLine),
    totalIncomeK: z.number().int().finite(),
    totalExpensesK: z.number().int().finite(),
    netProfitK: z.number().int().finite(),
  }),
  balanceSheet: z.object({
    assets: z.array(statementLine),
    liabilities: z.array(statementLine),
    equity: z.array(statementLine),
    totalAssetsK: z.number().int().finite(),
    totalLiabilitiesK: z.number().int().finite(),
    totalEquityK: z.number().int().finite(),
    balanced: z.boolean(),
  }),
  cashflow: z.object({
    openingK: z.number().int().finite(),
    inK: kobo,
    outK: kobo,
    closingK: z.number().int().finite(),
  }),
});
export type ReportsStatementsResponse = z.infer<typeof reportsStatementsResponse>;
