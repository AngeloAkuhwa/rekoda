/**
 * The four statements, as a document somebody can hand to a bank.
 *
 * ADR 0015 built the statements and the dashboard renders them, but a
 * dashboard is not a deliverable. A merchant asked for a loan, a grant or a
 * landlord's reference needs a file with a date on it, and the answer "log in
 * and look" is not one they can forward.
 *
 * Pure, for the same reason `invoice-layout.ts` is pure: asserting "retained
 * earnings appears under equity" against a compressed PDF with a subsetted
 * font means writing a PDF parser, and a test that needs a PDF parser is a
 * test nobody writes. This decides what the document says; turning blocks
 * into ink stays in `apps/api/src/documents/pdf.ts`.
 */
import { formatKobo } from './money.js';
import type { LayoutBlock } from './invoice-layout.js';
import type {
  BalanceSheet,
  CashflowStatement,
  ProfitAndLoss,
  StatementLine,
  TrialBalance,
} from './statements.js';

export interface StatementDocument {
  readonly businessName: string;
  /** `YYYY-MM`, the Lagos calendar month the figures cover. */
  readonly period: string;
  /** When the file was produced. Printed, because a statement without one is
   * a statement nobody can date, and these are read months later. */
  readonly generatedAt: Date;
  readonly profitAndLoss: ProfitAndLoss;
  readonly balanceSheet: BalanceSheet;
  readonly cashflow: CashflowStatement;
  readonly trialBalance: TrialBalance;
}

/** `2026-08` as a Nigerian reader says it. */
export function periodLabel(period: string): string {
  const [year, month] = period.split('-');
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return at.toLocaleDateString('en-NG', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function lines(rows: readonly StatementLine[], empty: string): LayoutBlock[] {
  if (rows.length === 0) return [{ kind: 'item', text: empty }];
  return rows.map((line) => ({
    kind: 'item' as const,
    text: line.name,
    value: formatKobo(line.amountK),
  }));
}

/**
 * The statements, in the order an accountant reads them.
 *
 * Profit and loss first because it answers the question a merchant actually
 * asked, then the balance sheet, then cash flow, then the trial balance last
 * because it is the proof rather than the point. A lender reads the first
 * three; the fourth is what makes the first three checkable.
 */
export function layoutStatements(doc: StatementDocument): LayoutBlock[] {
  const blocks: LayoutBlock[] = [
    { kind: 'title', text: doc.businessName },
    { kind: 'meta', text: 'Financial statements', value: periodLabel(doc.period) },
    {
      kind: 'meta',
      text: 'Prepared',
      value: doc.generatedAt.toLocaleDateString('en-NG', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }),
    },
  ];

  const { profitAndLoss: pl, balanceSheet: bs, cashflow: cf, trialBalance: tb } = doc;

  blocks.push({ kind: 'section', text: 'Profit and loss' });
  blocks.push({ kind: 'subhead', text: 'Income' });
  blocks.push(...lines(pl.income, 'No income recorded this month'));
  blocks.push({ kind: 'subtotal', text: 'Total income', value: formatKobo(pl.totalIncomeK) });
  blocks.push({ kind: 'subhead', text: 'Expenses' });
  blocks.push(...lines(pl.expenses, 'No expenses recorded this month'));
  blocks.push({ kind: 'subtotal', text: 'Total expenses', value: formatKobo(pl.totalExpensesK) });
  blocks.push({
    /* Named for the sign, because a bracketed negative is read wrong by
     * exactly the people who most need to read it right. */
    kind: 'grand-total',
    text: pl.netProfitK < 0 ? 'Net loss' : 'Net profit',
    value: formatKobo(Math.abs(pl.netProfitK)),
  });

  blocks.push({ kind: 'section', text: 'Balance sheet' });
  blocks.push({ kind: 'subhead', text: 'Assets' });
  blocks.push(...lines(bs.assets, 'None'));
  blocks.push({ kind: 'subtotal', text: 'Total assets', value: formatKobo(bs.totalAssetsK) });
  blocks.push({ kind: 'subhead', text: 'Liabilities' });
  blocks.push(...lines(bs.liabilities, 'None'));
  blocks.push({
    kind: 'subtotal',
    text: 'Total liabilities',
    value: formatKobo(bs.totalLiabilitiesK),
  });
  blocks.push({ kind: 'subhead', text: 'Equity' });
  blocks.push(...lines(bs.equity, 'None'));
  blocks.push({ kind: 'subtotal', text: 'Total equity', value: formatKobo(bs.totalEquityK) });
  blocks.push({
    kind: 'grand-total',
    text: 'Liabilities and equity',
    value: formatKobo(bs.totalLiabilitiesK + bs.totalEquityK),
  });

  blocks.push({ kind: 'section', text: 'Cash flow' });
  blocks.push({ kind: 'item', text: 'Opening balance', value: formatKobo(cf.openingK) });
  blocks.push({ kind: 'item', text: 'Money in', value: formatKobo(cf.inK) });
  blocks.push({ kind: 'item', text: 'Money out', value: formatKobo(cf.outK) });
  blocks.push({ kind: 'grand-total', text: 'Closing balance', value: formatKobo(cf.closingK) });

  blocks.push({ kind: 'section', text: 'Trial balance' });
  for (const row of tb.rows) {
    /* One account, one line, with whichever side it falls on. Printing both
     * columns would need a three-column block the renderer does not have, and
     * an account only ever lands on one side. */
    const debit = row.debitK > 0;
    blocks.push({
      kind: 'item',
      text: `${row.name} (${debit ? 'Dr' : 'Cr'})`,
      value: formatKobo(debit ? row.debitK : row.creditK),
    });
  }
  if (tb.rows.length === 0) blocks.push({ kind: 'item', text: 'Nothing posted yet' });
  blocks.push({ kind: 'subtotal', text: 'Total debits', value: formatKobo(tb.totalDebitK) });
  blocks.push({ kind: 'subtotal', text: 'Total credits', value: formatKobo(tb.totalCreditK) });

  /**
   * The one line that decides whether the rest is worth reading.
   *
   * Stated either way rather than printed only when it fails. A statement
   * that says nothing when the books balance leaves a reader unable to tell a
   * balanced set from a set where the check was never run.
   */
  blocks.push({
    kind: 'memo',
    text: tb.balanced
      ? 'Debits and credits agree. Every entry in these books is double-entry and balanced.'
      : 'Debits and credits DO NOT agree. Treat these figures as provisional and contact support.',
  });

  blocks.push({
    kind: 'footnote',
    text:
      'Prepared by Rekoda from the records this business entered. ' +
      'Figures marked Recorded are merchant-reported and not confirmed by a payment provider. E&OE.',
  });

  return blocks;
}
