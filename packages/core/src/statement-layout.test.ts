import { describe, expect, it } from 'vitest';
import {
  layoutStatements,
  periodLabel,
  statementSheets,
  type StatementDocument,
} from './statement-layout.js';
import { xlsxNaira } from './xlsx.js';
import type { LayoutBlock } from './invoice-layout.js';
import type { BalanceSheet, CashflowStatement, ProfitAndLoss, TrialBalance } from './statements.js';

const K = (naira: number) => naira * 100;

const PROFIT: ProfitAndLoss = {
  income: [{ account: 'SALES_REVENUE', code: '4000', name: 'Sales', amountK: K(150_000) }],
  expenses: [{ account: 'RENT', code: '6100', name: 'Rent', amountK: K(12_000) }],
  totalIncomeK: K(150_000),
  totalExpensesK: K(12_000),
  netProfitK: K(138_000),
};

const SHEET: BalanceSheet = {
  assets: [{ account: 'CASH', code: '1000', name: 'Cash', amountK: K(40_000) }],
  liabilities: [
    { account: 'ACCOUNTS_PAYABLE', code: '2000', name: 'Accounts Payable', amountK: K(30_000) },
  ],
  equity: [
    { account: 'OWNERS_EQUITY', code: '3000', name: 'Retained Earnings', amountK: K(10_000) },
  ],
  totalAssetsK: K(40_000),
  totalLiabilitiesK: K(30_000),
  totalEquityK: K(10_000),
  balanced: true,
};

const CASHFLOW: CashflowStatement = {
  openingK: K(5_000),
  inK: K(60_000),
  outK: K(25_000),
  closingK: K(40_000),
};

const TRIAL: TrialBalance = {
  rows: [
    { account: 'CASH', code: '1000', name: 'Cash', debitK: K(40_000), creditK: 0 },
    {
      account: 'SALES_REVENUE',
      code: '4000',
      name: 'Sales',
      debitK: 0,
      creditK: K(40_000),
    },
  ],
  totalDebitK: K(40_000),
  totalCreditK: K(40_000),
  balanced: true,
};

/** Two lines that sum to the operating expenses line in PROFIT. */
const SCHEDULE = {
  lines: [
    { label: 'Rent', amountK: K(9_000) },
    { label: 'Power and fuel', amountK: K(3_000) },
  ],
  totalK: K(12_000),
};

function doc(overrides: Partial<StatementDocument> = {}): StatementDocument {
  return {
    businessName: 'Mama Chidi Stores',
    period: '2026-08',
    generatedAt: new Date('2026-09-01T10:00:00Z'),
    profitAndLoss: PROFIT,
    balanceSheet: SHEET,
    cashflow: CASHFLOW,
    trialBalance: TRIAL,
    expenseSchedule: SCHEDULE,
    ...overrides,
  };
}

const text = (blocks: LayoutBlock[]) => blocks.map((b) => `${b.text} ${b.value ?? ''}`).join('\n');
const find = (blocks: LayoutBlock[], label: string) => blocks.find((b) => b.text === label);

describe('periodLabel', () => {
  it('names the month a merchant would say', () => {
    expect(periodLabel('2026-08')).toBe('August 2026');
    expect(periodLabel('2026-01')).toBe('January 2026');
    expect(periodLabel('2025-12')).toBe('December 2025');
  });
});

describe('what the statements document says', () => {
  it('opens with the business, the period and the date it was prepared', () => {
    const blocks = layoutStatements(doc());
    expect(blocks[0]).toEqual({ kind: 'title', text: 'Mama Chidi Stores' });
    expect(blocks[1]).toMatchObject({ text: 'Financial statements', value: 'August 2026' });
    expect(find(blocks, 'Prepared')?.value).toBe('1 September 2026');
  });

  it('carries all four statements, in the order an accountant reads them', () => {
    const sections = layoutStatements(doc())
      .filter((b) => b.kind === 'section')
      .map((b) => b.text);
    expect(sections).toEqual(['Profit and loss', 'Balance sheet', 'Cash flow', 'Trial balance']);
  });

  it('states the profit and loss figures', () => {
    const blocks = layoutStatements(doc());
    expect(find(blocks, 'Total income')?.value).toBe('₦150,000');
    expect(find(blocks, 'Total expenses')?.value).toBe('₦12,000');
    expect(find(blocks, 'Net profit')?.value).toBe('₦138,000');
  });

  it('names a loss a loss rather than bracketing a negative', () => {
    const blocks = layoutStatements(
      doc({
        profitAndLoss: {
          ...PROFIT,
          totalIncomeK: K(10_000),
          totalExpensesK: K(25_000),
          netProfitK: K(-15_000),
        },
      }),
    );
    expect(find(blocks, 'Net loss')?.value).toBe('₦15,000');
    expect(find(blocks, 'Net profit')).toBeUndefined();
    expect(text(blocks)).not.toContain('-₦');
  });

  it('shows the balance sheet adding up on both sides', () => {
    const blocks = layoutStatements(doc());
    expect(find(blocks, 'Total assets')?.value).toBe('₦40,000');
    expect(find(blocks, 'Liabilities and equity')?.value).toBe('₦40,000');
  });

  it('shows cash flow opening, in, out and closing', () => {
    const blocks = layoutStatements(doc());
    expect(find(blocks, 'Opening balance')?.value).toBe('₦5,000');
    expect(find(blocks, 'Money in')?.value).toBe('₦60,000');
    expect(find(blocks, 'Money out')?.value).toBe('₦25,000');
    expect(find(blocks, 'Closing balance')?.value).toBe('₦40,000');
  });

  it('puts each trial balance account on the side it actually falls', () => {
    const blocks = layoutStatements(doc());
    expect(find(blocks, 'Cash (Dr)')?.value).toBe('₦40,000');
    expect(find(blocks, 'Sales (Cr)')?.value).toBe('₦40,000');
  });

  it('says the books balance rather than staying silent about it', () => {
    expect(text(layoutStatements(doc()))).toContain('Debits and credits agree');
  });

  it('says loudly when they do not', () => {
    const blocks = layoutStatements(
      doc({ trialBalance: { ...TRIAL, totalCreditK: K(39_000), balanced: false } }),
    );
    const rendered = text(blocks);
    expect(rendered).toContain('DO NOT agree');
    expect(rendered).toContain('provisional');
    expect(rendered).not.toContain('Debits and credits agree');
  });

  /**
   * The schedule that makes "Operating Expenses ₦120,000" answerable. Its
   * heading has to say operating, because the total above it includes cost of
   * goods sold and a reader who adds the two double-counts the month.
   */
  it('breaks operating expenses out, after the statement rather than inside it', () => {
    const blocks = layoutStatements(doc());
    const rendered = text(blocks);
    expect(rendered).toContain('Operating expenses in detail');
    expect(rendered).toContain('Power and fuel');
    expect(find(blocks, 'Total operating expenses')?.value).toBe('\u20a612,000');

    const at = (label: string) => blocks.findIndex((b) => b.text === label);
    expect(at('Operating expenses in detail')).toBeGreaterThan(at('Net profit'));
    expect(at('Operating expenses in detail')).toBeLessThan(at('Balance sheet'));
  });

  it('prints no schedule for a month with nothing to break down', () => {
    const blocks = layoutStatements(doc({ expenseSchedule: { lines: [], totalK: 0 } }));
    expect(text(blocks)).not.toContain('Operating expenses in detail');
  });

  it('carries the ADR 0014 caveat and E&OE in the footnote', () => {
    const footnote = layoutStatements(doc()).find((b) => b.kind === 'footnote');
    expect(footnote?.text).toContain('Recorded are merchant-reported');
    expect(footnote?.text).toContain('E&OE');
  });

  it('says a month with no trading is empty rather than printing nothing', () => {
    const blocks = layoutStatements(
      doc({
        profitAndLoss: {
          income: [],
          expenses: [],
          totalIncomeK: 0,
          totalExpensesK: 0,
          netProfitK: 0,
        },
      }),
    );
    const rendered = text(blocks);
    expect(rendered).toContain('No income recorded this month');
    expect(rendered).toContain('No expenses recorded this month');
  });

  it('names no customer, because a statement is totals and not a ledger dump', () => {
    const rendered = text(layoutStatements(doc()));
    expect(rendered).not.toContain('CUSTOMER_');
  });
});

describe('the statements as a workbook', () => {
  const sheets = () => statementSheets(doc());
  const sheet = (name: string) => sheets().find((s) => s.name === name)!;
  const rowFor = (name: string, label: string) =>
    sheet(name).rows.find((r) => r[0] === label) ?? [];

  it('is four sheets, in the order an accountant reads them', () => {
    expect(sheets().map((s) => s.name)).toEqual([
      'Profit and loss',
      'Balance sheet',
      'Cash flow',
      'Trial balance',
    ]);
  });

  it('heads every sheet with the business and the month', () => {
    for (const s of sheets()) {
      expect(s.rows[0]?.[0]).toBe('Mama Chidi Stores');
      expect(s.rows[1]?.[1]).toBe('August 2026');
    }
  });

  it('writes naira as numbers, not kobo and not text', () => {
    /* Kobo is Rekoda's internal unit. In a cell it would read as a hundred
     * times the truth to whoever opened the file. */
    expect(rowFor('Profit and loss', 'Total income')[1]).toBe(150_000);
    expect(typeof rowFor('Profit and loss', 'Total income')[1]).toBe('number');
  });

  it('signs a loss rather than naming it, because a cell gets summed', () => {
    const loss = statementSheets(
      doc({
        profitAndLoss: {
          ...PROFIT,
          totalIncomeK: K(10_000),
          totalExpensesK: K(25_000),
          netProfitK: K(-15_000),
        },
      }),
    );
    const row = loss[0]!.rows.find((r) => r[0] === 'Net profit');
    /* The PDF says "Net loss ₦15,000" because a bracketed negative is read
     * wrong on paper. A spreadsheet is the opposite: somebody will add this
     * column, and a positive here would make their total wrong. */
    expect(row?.[1]).toBe(-15_000);
  });

  it('gives the trial balance real debit and credit columns', () => {
    const rows = sheet('Trial balance').rows;
    expect(rows.find((r) => r[0] === 'Account')).toEqual(['Account', 'Debit', 'Credit']);
    expect(rows.find((r) => r[0] === 'Cash')).toEqual(['Cash', 40_000, null]);
    expect(rows.find((r) => r[0] === 'Sales')).toEqual(['Sales', null, 40_000]);
    expect(rows.find((r) => r[0] === 'Total')).toEqual(['Total', 40_000, 40_000]);
  });

  it('carries the balance warning into the workbook too', () => {
    const unbalanced = statementSheets(
      doc({ trialBalance: { ...TRIAL, totalCreditK: K(39_000), balanced: false } }),
    );
    const flat = JSON.stringify(unbalanced);
    expect(flat).toContain('DO NOT agree');
  });

  /* Below the net profit, because somebody will select the column and sum it
   * and a breakdown inside the statement would be counted twice. */
  it('puts the expense schedule under the profit and loss sheet', () => {
    const rows = sheets()[0]!.rows.map((r) => String(r[0]));
    expect(rows).toContain('Operating expenses in detail');
    expect(rows.indexOf('Operating expenses in detail')).toBeGreaterThan(
      rows.indexOf('Net profit'),
    );
    expect(sheets()[0]!.rows.find((r) => r[0] === 'Total operating expenses')?.[1]).toEqual(
      xlsxNaira(K(12_000)),
    );
  });

  it('says the books agree when they do', () => {
    expect(JSON.stringify(sheets())).toContain('Debits and credits agree');
  });
});
