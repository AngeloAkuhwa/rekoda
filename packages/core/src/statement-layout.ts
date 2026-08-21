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
import { xlsxNaira, type CellValue, type Sheet } from './xlsx.js';
import type { LayoutBlock } from './invoice-layout.js';
import type {
  BalanceSheet,
  CashflowStatement,
  ProfitAndLoss,
  StatementLine,
  TrialBalance,
} from './statements.js';

/**
 * The supporting schedule under the profit and loss statement's operating
 * expenses line, already labelled and totalled.
 *
 * Labels rather than category keys, because this module lays documents out
 * and does not decide what an expense is called. The figures come from the
 * ledger; the words come from `expenses.ts`; this joins them to a page.
 */
export interface ExpenseSchedule {
  readonly lines: ReadonlyArray<{ readonly label: string; readonly amountK: number }>;
  readonly totalK: number;
}

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
  /**
   * Required rather than optional, so a caller cannot quietly ship a document
   * without it while the dashboard shows one with it. An empty schedule is a
   * fact worth stating and prints nothing.
   */
  readonly expenseSchedule: ExpenseSchedule;
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

  /**
   * The detail behind ONE of the expense lines above, not behind all of them.
   *
   * "Total expenses" includes cost of goods sold, which is a different
   * account and a different kind of cost; this schedule breaks out operating
   * expenses only, and its total ties to that line. Saying so in the heading
   * is what stops a reader adding the two together.
   *
   * Printed after the profit and loss rather than inside it, which is where a
   * statement pack puts a supporting schedule: the statement is the claim and
   * the schedule is the working.
   */
  if (doc.expenseSchedule.lines.length > 0) {
    blocks.push({ kind: 'subhead', text: 'Operating expenses in detail' });
    for (const line of doc.expenseSchedule.lines) {
      blocks.push({ kind: 'item', text: line.label, value: formatKobo(line.amountK) });
    }
    blocks.push({
      kind: 'subtotal',
      text: 'Total operating expenses',
      value: formatKobo(doc.expenseSchedule.totalK),
    });
  }

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

/* ── the same statements, as a spreadsheet ────────────────────────────────── */

/**
 * The four statements as four sheets.
 *
 * What a CSV cannot do, and the reason this exists alongside the PDF: an
 * accountant asked for the statements gets ONE file with four tabs, and every
 * figure is a number their spreadsheet can total rather than text it cannot.
 * Four separate CSVs is four files to reconcile by hand.
 *
 * Naira, not kobo. Kobo is Rekoda's internal unit and would read as a hundred
 * times the truth to anybody opening this.
 */
export function statementSheets(doc: StatementDocument): Sheet[] {
  const { profitAndLoss: pl, balanceSheet: bs, cashflow: cf, trialBalance: tb } = doc;
  const label = periodLabel(doc.period);
  const heading = (title: string): CellValue[][] => [
    [doc.businessName, null],
    [title, label],
    [null, null],
  ];
  const money = (rows: readonly StatementLine[]): CellValue[][] =>
    rows.map((line) => [line.name, xlsxNaira(line.amountK)]);

  return [
    {
      name: 'Profit and loss',
      rows: [
        ...heading('Profit and loss'),
        ['Income', null],
        ...money(pl.income),
        ['Total income', xlsxNaira(pl.totalIncomeK)],
        [null, null],
        ['Expenses', null],
        ...money(pl.expenses),
        ['Total expenses', xlsxNaira(pl.totalExpensesK)],
        [null, null],
        /* Signed here rather than named, unlike the PDF. A spreadsheet cell is
         * arithmetic input: somebody will add this column, and "Net loss
         * 15,000" as a positive would make their total wrong. */
        ['Net profit', xlsxNaira(pl.netProfitK)],
        /* Below the net profit, not among the expense lines. Somebody will
         * select this column and total it, and a breakdown sitting inside the
         * statement it breaks down would be counted twice. */
        ...(doc.expenseSchedule.lines.length > 0
          ? ([
              [null, null],
              ['Operating expenses in detail', null],
              ...doc.expenseSchedule.lines.map((line) => [line.label, xlsxNaira(line.amountK)]),
              ['Total operating expenses', xlsxNaira(doc.expenseSchedule.totalK)],
            ] as CellValue[][])
          : []),
      ],
    },
    {
      name: 'Balance sheet',
      rows: [
        ...heading('Balance sheet'),
        ['Assets', null],
        ...money(bs.assets),
        ['Total assets', xlsxNaira(bs.totalAssetsK)],
        [null, null],
        ['Liabilities', null],
        ...money(bs.liabilities),
        ['Total liabilities', xlsxNaira(bs.totalLiabilitiesK)],
        [null, null],
        ['Equity', null],
        ...money(bs.equity),
        ['Total equity', xlsxNaira(bs.totalEquityK)],
        [null, null],
        ['Liabilities and equity', xlsxNaira(bs.totalLiabilitiesK + bs.totalEquityK)],
      ],
    },
    {
      name: 'Cash flow',
      rows: [
        ...heading('Cash flow'),
        ['Opening balance', xlsxNaira(cf.openingK)],
        ['Money in', xlsxNaira(cf.inK)],
        ['Money out', xlsxNaira(cf.outK)],
        ['Closing balance', xlsxNaira(cf.closingK)],
      ],
    },
    {
      name: 'Trial balance',
      rows: [
        ...heading('Trial balance'),
        /* Two real columns here, where the PDF prints one side per line: a
         * spreadsheet has the width for it, and an accountant checking a trial
         * balance wants to sum each column separately. */
        ['Account', 'Debit', 'Credit'],
        ...tb.rows.map((row) => [
          row.name,
          row.debitK > 0 ? xlsxNaira(row.debitK) : null,
          row.creditK > 0 ? xlsxNaira(row.creditK) : null,
        ]),
        ['Total', xlsxNaira(tb.totalDebitK), xlsxNaira(tb.totalCreditK)],
        [null, null],
        [
          tb.balanced
            ? 'Debits and credits agree.'
            : 'Debits and credits DO NOT agree. Treat these figures as provisional.',
          null,
        ],
      ],
    },
  ];
}
