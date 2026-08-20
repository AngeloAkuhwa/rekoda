/**
 * The four statements (ADR 0015): trial balance, profit and loss, balance
 * sheet, cash flow — assembled here as pure functions over per-account
 * debit/credit sums the database supplies.
 *
 * The split of labour is the same as the document layouts: SQL aggregates,
 * this module decides what the figures MEAN, and the API/web tiers only
 * carry the result. Keeping the assembly pure is what lets the accounting
 * identities (debits = credits, assets = liabilities + equity) be tested
 * against hand arithmetic with no database in the room.
 *
 * Labels stay in the merchant's language on screen ("money actually
 * received"); the statement structure underneath is the standard one an
 * accountant expects (ADR 0015: one ledger, two lenses).
 */
import { ACCOUNTS, type AccountKey } from './ledger.js';

/** Per-account sums the database supplies: for the period, and all time up
 * to the period's end. Absent accounts mean zero movement. */
export interface AccountSums {
  readonly account: AccountKey;
  readonly periodDebitK: number;
  readonly periodCreditK: number;
  readonly cumulativeDebitK: number;
  readonly cumulativeCreditK: number;
}

export interface StatementLine {
  readonly account: AccountKey;
  readonly code: string;
  readonly name: string;
  readonly amountK: number;
}

const byCode = (a: StatementLine, b: StatementLine) => (a.code < b.code ? -1 : 1);

function sums(rows: readonly AccountSums[]): Map<AccountKey, AccountSums> {
  return new Map(rows.map((r) => [r.account, r]));
}

/** Natural balance: debits minus credits for debit-normal accounts (assets,
 * expenses), credits minus debits for the rest. */
function cumulativeBalanceK(row: AccountSums): number {
  const type = ACCOUNTS[row.account].type;
  const debitNormal = type === 'asset' || type === 'expense';
  return debitNormal
    ? row.cumulativeDebitK - row.cumulativeCreditK
    : row.cumulativeCreditK - row.cumulativeDebitK;
}

/* ── trial balance ───────────────────────────────────────────────────────── */

export interface TrialBalanceRowV1 {
  readonly account: AccountKey;
  readonly code: string;
  readonly name: string;
  readonly debitK: number;
  readonly creditK: number;
}

export interface TrialBalance {
  readonly rows: TrialBalanceRowV1[];
  readonly totalDebitK: number;
  readonly totalCreditK: number;
  readonly balanced: boolean;
}

/**
 * Every account's cumulative balance on its natural side, as at the period
 * end. `balanced` is computed, never asserted: if it is ever false the books
 * are corrupt and the page must say so, loudly.
 */
export function buildTrialBalance(rows: readonly AccountSums[]): TrialBalance {
  const out: TrialBalanceRowV1[] = [];
  for (const row of rows) {
    if (row.cumulativeDebitK === 0 && row.cumulativeCreditK === 0) continue;
    const meta = ACCOUNTS[row.account];
    const debitNormal = meta.type === 'asset' || meta.type === 'expense';
    const balance = cumulativeBalanceK(row);
    // A balance on the account's natural side sits in its natural column; a
    // negative one crosses over, so neither column ever carries a negative.
    const onNaturalSide = balance >= 0;
    const magnitude = Math.abs(balance);
    out.push({
      account: row.account,
      code: meta.code,
      name: meta.name,
      debitK: debitNormal === onNaturalSide ? magnitude : 0,
      creditK: debitNormal === onNaturalSide ? 0 : magnitude,
    });
  }
  out.sort((a, b) => (a.code < b.code ? -1 : 1));
  const totalDebitK = out.reduce((n, r) => n + r.debitK, 0);
  const totalCreditK = out.reduce((n, r) => n + r.creditK, 0);
  return { rows: out, totalDebitK, totalCreditK, balanced: totalDebitK === totalCreditK };
}

/* ── profit and loss ─────────────────────────────────────────────────────── */

export interface ProfitAndLoss {
  readonly income: StatementLine[];
  readonly expenses: StatementLine[];
  readonly totalIncomeK: number;
  readonly totalExpensesK: number;
  readonly netProfitK: number;
}

/** Income earned and expenses incurred WITHIN the period (accrual lens). */
export function buildProfitAndLoss(rows: readonly AccountSums[]): ProfitAndLoss {
  const income: StatementLine[] = [];
  const expenses: StatementLine[] = [];
  for (const row of rows) {
    const meta = ACCOUNTS[row.account];
    if (meta.type === 'income') {
      const amountK = row.periodCreditK - row.periodDebitK;
      if (amountK !== 0)
        income.push({ account: row.account, code: meta.code, name: meta.name, amountK });
    } else if (meta.type === 'expense') {
      const amountK = row.periodDebitK - row.periodCreditK;
      if (amountK !== 0)
        expenses.push({ account: row.account, code: meta.code, name: meta.name, amountK });
    }
  }
  income.sort(byCode);
  expenses.sort(byCode);
  const totalIncomeK = income.reduce((n, l) => n + l.amountK, 0);
  const totalExpensesK = expenses.reduce((n, l) => n + l.amountK, 0);
  return {
    income,
    expenses,
    totalIncomeK,
    totalExpensesK,
    netProfitK: totalIncomeK - totalExpensesK,
  };
}

/* ── balance sheet ───────────────────────────────────────────────────────── */

export interface BalanceSheet {
  readonly assets: StatementLine[];
  readonly liabilities: StatementLine[];
  readonly equity: StatementLine[];
  readonly totalAssetsK: number;
  readonly totalLiabilitiesK: number;
  readonly totalEquityK: number;
  /** assets = liabilities + equity. Computed, never asserted. */
  readonly balanced: boolean;
}

/**
 * Positions as at the period end. Retained earnings is derived — all income
 * minus all expenses since the beginning — because profit that has not been
 * drawn IS equity, and no posting writes it anywhere else.
 */
export function buildBalanceSheet(rows: readonly AccountSums[]): BalanceSheet {
  const assets: StatementLine[] = [];
  const liabilities: StatementLine[] = [];
  const equity: StatementLine[] = [];
  let retainedK = 0;

  for (const row of rows) {
    const meta = ACCOUNTS[row.account];
    const balance = cumulativeBalanceK(row);
    if (meta.type === 'income' || meta.type === 'expense') {
      retainedK += meta.type === 'income' ? balance : -balance;
      continue;
    }
    if (balance === 0) continue;
    const line = { account: row.account, code: meta.code, name: meta.name, amountK: balance };
    if (meta.type === 'asset') assets.push(line);
    else if (meta.type === 'liability') liabilities.push(line);
    else equity.push(line);
  }

  if (retainedK !== 0) {
    equity.push({
      account: 'OWNERS_EQUITY',
      code: ACCOUNTS.OWNERS_EQUITY.code,
      name: 'Retained Earnings',
      amountK: retainedK,
    });
  }

  assets.sort(byCode);
  liabilities.sort(byCode);
  equity.sort(byCode);
  const totalAssetsK = assets.reduce((n, l) => n + l.amountK, 0);
  const totalLiabilitiesK = liabilities.reduce((n, l) => n + l.amountK, 0);
  const totalEquityK = equity.reduce((n, l) => n + l.amountK, 0);
  return {
    assets,
    liabilities,
    equity,
    totalAssetsK,
    totalLiabilitiesK,
    totalEquityK,
    balanced: totalAssetsK === totalLiabilitiesK + totalEquityK,
  };
}

/* ── cash flow ───────────────────────────────────────────────────────────── */

export interface CashflowStatement {
  readonly openingK: number;
  readonly inK: number;
  readonly outK: number;
  readonly closingK: number;
}

const CASH_KEYS: readonly AccountKey[] = ['CASH', 'BANK_PAYSTACK'];

/**
 * Direct method, merchant labels: what you started the period with, what
 * came in, what went out, what you hold now. Closing is derived from the
 * other three so the statement cannot disagree with itself.
 */
export function buildCashflowStatement(rows: readonly AccountSums[]): CashflowStatement {
  const map = sums(rows);
  let inK = 0;
  let outK = 0;
  let closingK = 0;
  for (const key of CASH_KEYS) {
    const row = map.get(key);
    if (!row) continue;
    inK += row.periodDebitK;
    outK += row.periodCreditK;
    closingK += row.cumulativeDebitK - row.cumulativeCreditK;
  }
  return { openingK: closingK - inK + outK, inK, outK, closingK };
}
