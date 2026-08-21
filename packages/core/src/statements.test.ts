/**
 * The four statements (ADR 0015), against hand arithmetic.
 *
 * The scenario is one month of trading:
 *   - ₦150,000 sale, ₦40,000 paid in cash, rest on the book
 *   - ₦50,000 of the balance arrives through the provider (₦750 fee)
 *   - ₦12,000 expense paid in cash
 *   - ₦50,000 of stock, ₦20,000 paid, ₦30,000 owed to the supplier
 * plus a PRIOR month holding ₦62,000 of fully-paid sales and ₦28,000 of
 * expenses, so the period/cumulative split actually does something.
 */
import { describe, expect, it } from 'vitest';
import {
  buildBalanceSheet,
  buildCashflowStatement,
  buildProfitAndLoss,
  buildTrialBalance,
  type AccountSums,
} from './statements.js';

const K = (naira: number) => naira * 100;

/** period = this month; cumulative = prior month + this month. */
const ROWS: AccountSums[] = [
  {
    account: 'CASH',
    // This month in: 40,000 sale cash + 20,000... no — stock paid OUT 20,000.
    // In: 40,000. Out: 12,000 expense + 20,000 stock.
    periodDebitK: K(40_000),
    periodCreditK: K(32_000),
    // Prior month: 62,000 in, 28,000 out.
    cumulativeDebitK: K(40_000 + 62_000),
    cumulativeCreditK: K(32_000 + 28_000),
  },
  {
    account: 'BANK_PAYSTACK',
    periodDebitK: K(49_250), // 50,000 less the 750 fee, banked
    periodCreditK: 0,
    cumulativeDebitK: K(49_250),
    cumulativeCreditK: 0,
  },
  {
    account: 'ACCOUNTS_RECEIVABLE',
    periodDebitK: K(110_000), // 150,000 − 40,000 paid at the counter
    periodCreditK: K(50_000), // settled by the provider payment
    cumulativeDebitK: K(110_000),
    cumulativeCreditK: K(50_000),
  },
  {
    account: 'INVENTORY',
    periodDebitK: K(50_000),
    periodCreditK: 0,
    cumulativeDebitK: K(50_000),
    cumulativeCreditK: 0,
  },
  {
    account: 'ACCOUNTS_PAYABLE',
    periodDebitK: 0,
    periodCreditK: K(30_000),
    cumulativeDebitK: 0,
    cumulativeCreditK: K(30_000),
  },
  {
    account: 'SALES_REVENUE',
    periodDebitK: 0,
    periodCreditK: K(150_000),
    cumulativeDebitK: 0,
    cumulativeCreditK: K(150_000 + 62_000),
  },
  {
    account: 'EXPENSES',
    periodDebitK: K(12_000 + 750), // fuel + the provider fee, merchant-borne
    periodCreditK: 0,
    cumulativeDebitK: K(12_750 + 28_000),
    cumulativeCreditK: 0,
  },
];

describe('trial balance', () => {
  const tb = buildTrialBalance(ROWS);

  it('balances, and says so from its own totals', () => {
    expect(tb.totalDebitK).toBe(tb.totalCreditK);
    expect(tb.balanced).toBe(true);
  });

  it('puts every balance on its natural side, never a negative', () => {
    for (const row of tb.rows) {
      expect(row.debitK).toBeGreaterThanOrEqual(0);
      expect(row.creditK).toBeGreaterThanOrEqual(0);
      expect(row.debitK === 0 || row.creditK === 0).toBe(true);
    }
    expect(tb.rows.find((r) => r.account === 'CASH')?.debitK).toBe(K(42_000));
    expect(tb.rows.find((r) => r.account === 'ACCOUNTS_PAYABLE')?.creditK).toBe(K(30_000));
  });

  it('a balance driven negative crosses to the other column', () => {
    const overdrawn = buildTrialBalance([
      {
        account: 'CASH',
        periodDebitK: 0,
        periodCreditK: K(5_000),
        cumulativeDebitK: K(1_000),
        cumulativeCreditK: K(6_000),
      },
    ]);
    const cash = overdrawn.rows[0]!;
    expect(cash.debitK).toBe(0);
    expect(cash.creditK).toBe(K(5_000));
  });
});

describe('profit and loss (the period, accrual)', () => {
  const pl = buildProfitAndLoss(ROWS);

  it('income is the month`s sales, in full, regardless of cash', () => {
    expect(pl.totalIncomeK).toBe(K(150_000));
  });

  it('expenses include the provider fee the merchant bore', () => {
    expect(pl.totalExpensesK).toBe(K(12_750));
  });

  it('net profit is the difference, by hand', () => {
    expect(pl.netProfitK).toBe(K(137_250));
  });

  /**
   * Nothing sold here has a cost recorded, which is the state a business is
   * in until it tells Rekoda what its stock cost. Gross profit equals revenue
   * and says so, rather than being hidden.
   */
  it('reports no cost of sales when none has been posted', () => {
    expect(pl.costOfSalesK).toBe(0);
    expect(pl.grossProfitK).toBe(pl.totalIncomeK);
    expect(pl.operatingExpensesK).toBe(pl.totalExpensesK);
  });

  /* And when there is one, it comes OUT of operating expenses rather than
   * being counted in both places. */
  it('separates the cost of goods from the cost of running the shop', () => {
    const withCost = buildProfitAndLoss([
      ...ROWS,
      {
        account: 'COGS',
        periodDebitK: K(60_000),
        periodCreditK: 0,
        cumulativeDebitK: K(60_000),
        cumulativeCreditK: 0,
      },
    ]);
    expect(withCost.costOfSalesK).toBe(K(60_000));
    expect(withCost.grossProfitK).toBe(K(90_000));
    expect(withCost.operatingExpensesK).toBe(K(12_750));
    /* The three still add up the only way they can. */
    expect(withCost.grossProfitK - withCost.operatingExpensesK).toBe(withCost.netProfitK);
    expect(withCost.totalExpensesK).toBe(withCost.costOfSalesK + withCost.operatingExpensesK);
  });
});

describe('balance sheet (as at period end)', () => {
  const bs = buildBalanceSheet(ROWS);

  it('assets = liabilities + equity, computed not asserted', () => {
    expect(bs.balanced).toBe(true);
    expect(bs.totalAssetsK).toBe(bs.totalLiabilitiesK + bs.totalEquityK);
  });

  it('carries cash, bank, receivables and stock as assets', () => {
    const byAccount = Object.fromEntries(bs.assets.map((a) => [a.account, a.amountK]));
    expect(byAccount['CASH']).toBe(K(42_000));
    expect(byAccount['BANK_PAYSTACK']).toBe(K(49_250));
    expect(byAccount['ACCOUNTS_RECEIVABLE']).toBe(K(60_000));
    expect(byAccount['INVENTORY']).toBe(K(50_000));
  });

  it('derives retained earnings from lifetime income minus expenses', () => {
    const retained = bs.equity.find((e) => e.name === 'Retained Earnings');
    // (150,000 + 62,000) − (12,750 + 28,000)
    expect(retained?.amountK).toBe(K(171_250));
  });
});

describe('cash flow (direct, merchant labels)', () => {
  const cf = buildCashflowStatement(ROWS);

  it('opening + in − out = closing, always', () => {
    expect(cf.openingK + cf.inK - cf.outK).toBe(cf.closingK);
  });

  it('matches the hand figures', () => {
    expect(cf.openingK).toBe(K(34_000)); // prior month: 62,000 in − 28,000 out
    expect(cf.inK).toBe(K(89_250));
    expect(cf.outK).toBe(K(32_000));
    expect(cf.closingK).toBe(K(91_250));
  });
});

describe('an empty book', () => {
  it('produces empty, balanced statements, never an error', () => {
    expect(buildTrialBalance([]).balanced).toBe(true);
    expect(buildProfitAndLoss([]).netProfitK).toBe(0);
    expect(buildBalanceSheet([]).balanced).toBe(true);
    expect(buildCashflowStatement([])).toEqual({ openingK: 0, inK: 0, outK: 0, closingK: 0 });
  });
});
