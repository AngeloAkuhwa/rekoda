import { describe, expect, it } from 'vitest';
import { layoutStatements, periodLabel, type StatementDocument } from './statement-layout.js';
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

function doc(overrides: Partial<StatementDocument> = {}): StatementDocument {
  return {
    businessName: 'Mama Chidi Stores',
    period: '2026-08',
    generatedAt: new Date('2026-09-01T10:00:00Z'),
    profitAndLoss: PROFIT,
    balanceSheet: SHEET,
    cashflow: CASHFLOW,
    trialBalance: TRIAL,
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
