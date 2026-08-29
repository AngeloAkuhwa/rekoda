/**
 * The four statements (ADR 0015): trial balance, profit and loss, balance
 * sheet, cash flow — assembled here as pure functions over per-account
 * debit/credit sums the database supplies.
 *
 * VERSION TWO, ON THE KERNEL (D1, PR-095): the rows carry the account's
 * OWN metadata — code, name, type, system role — read from the business's
 * chart, and the assembly is driven by TYPE and ROLE rather than a fixed
 * key table. That is the difference between a statement and a template:
 * a connection-scoped clearing account provisioned last week (PR-053), a
 * second bank, an account an accountant adds later — every one of them
 * appears, because the chart in the DATABASE is the authority and this
 * module no longer keeps a private copy to disagree with it. Version one
 * dropped any account its table did not know, which meant money the
 * ledger demonstrably held could vanish from a balance sheet that then
 * failed to balance.
 *
 * The split of labour is unchanged: SQL aggregates, this module decides
 * what the figures MEAN, and the API/web tiers only carry the result.
 * Keeping the assembly pure is what lets the accounting identities
 * (debits = credits, assets = liabilities + equity) be tested against
 * hand arithmetic with no database in the room.
 */

export type StatementAccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

/** Per-account sums the database supplies: for the period, and all time up
 * to the period's end, with the account's own chart metadata. Absent
 * accounts mean zero movement. */
export interface AccountSums {
  readonly code: string;
  readonly name: string;
  readonly type: StatementAccountType;
  readonly systemRole: string | null;
  readonly periodDebitK: number;
  readonly periodCreditK: number;
  readonly cumulativeDebitK: number;
  readonly cumulativeCreditK: number;
}

export interface StatementLine {
  readonly code: string;
  readonly name: string;
  readonly amountK: number;
}

const byCode = (a: { code: string }, b: { code: string }) => (a.code < b.code ? -1 : 1);

const debitNormal = (type: StatementAccountType) => type === 'asset' || type === 'expense';

/** Natural balance: debits minus credits for debit-normal accounts (assets,
 * expenses), credits minus debits for the rest. */
function cumulativeBalanceK(row: AccountSums): number {
  return debitNormal(row.type)
    ? row.cumulativeDebitK - row.cumulativeCreditK
    : row.cumulativeCreditK - row.cumulativeDebitK;
}

/* ── trial balance ───────────────────────────────────────────────────────── */

export interface TrialBalanceRowV1 {
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
    const balance = cumulativeBalanceK(row);
    // A balance on the account's natural side sits in its natural column; a
    // negative one crosses over, so neither column ever carries a negative.
    const onNaturalSide = balance >= 0;
    const magnitude = Math.abs(balance);
    out.push({
      code: row.code,
      name: row.name,
      debitK: debitNormal(row.type) === onNaturalSide ? magnitude : 0,
      creditK: debitNormal(row.type) === onNaturalSide ? 0 : magnitude,
    });
  }
  out.sort(byCode);
  const totalDebitK = out.reduce((n, r) => n + r.debitK, 0);
  const totalCreditK = out.reduce((n, r) => n + r.creditK, 0);
  return { rows: out, totalDebitK, totalCreditK, balanced: totalDebitK === totalCreditK };
}

/* ── profit and loss ─────────────────────────────────────────────────────── */

export interface ProfitAndLoss {
  readonly income: StatementLine[];
  /**
   * Every expense account, cost of sales included.
   *
   * Kept whole so `totalExpensesK` still means what it always meant and
   * nothing reading this has to add two numbers to get it. The gross profit
   * figures below are a SECOND view of the same rows, not a replacement.
   */
  readonly expenses: StatementLine[];
  /**
   * The same rows without cost of sales.
   *
   * What the "Expenses" block of a statement actually lists once gross profit
   * is shown above it. Derived here rather than filtered in each renderer,
   * because a page, a PDF and a workbook filtering separately is three places
   * for one of them to stop.
   */
  readonly operatingExpenses: StatementLine[];
  readonly totalIncomeK: number;
  readonly totalExpensesK: number;
  /**
   * What the goods sold cost, on its own.
   *
   * The line every accountant looks for first, because revenue minus the cost
   * of what was sold is the only number that says whether the trade itself
   * works. Identified by the COGS role, never by a code convention.
   */
  readonly costOfSalesK: number;
  /** Revenue less the cost of the goods that earned it. */
  readonly grossProfitK: number;
  /** Everything else: rent, salaries, transport, fees. */
  readonly operatingExpensesK: number;
  readonly netProfitK: number;
}

/** Income earned and expenses incurred WITHIN the period (accrual lens). */
export function buildProfitAndLoss(rows: readonly AccountSums[]): ProfitAndLoss {
  const income: StatementLine[] = [];
  const expenses: StatementLine[] = [];
  const cogsCodes = new Set<string>();
  let costOfSalesK = 0;
  for (const row of rows) {
    if (row.type === 'income') {
      const amountK = row.periodCreditK - row.periodDebitK;
      if (amountK !== 0) income.push({ code: row.code, name: row.name, amountK });
    } else if (row.type === 'expense') {
      const amountK = row.periodDebitK - row.periodCreditK;
      if (row.systemRole === 'COGS') {
        costOfSalesK += amountK;
        cogsCodes.add(row.code);
      }
      if (amountK !== 0) expenses.push({ code: row.code, name: row.name, amountK });
    }
  }
  income.sort(byCode);
  expenses.sort(byCode);
  const totalIncomeK = income.reduce((n, l) => n + l.amountK, 0);
  const totalExpensesK = expenses.reduce((n, l) => n + l.amountK, 0);
  return {
    income,
    expenses,
    operatingExpenses: expenses.filter((l) => !cogsCodes.has(l.code)),
    totalIncomeK,
    totalExpensesK,
    costOfSalesK,
    grossProfitK: totalIncomeK - costOfSalesK,
    /* Derived by subtraction rather than summed again, so the three figures
     * cannot disagree about which account went where. */
    operatingExpensesK: totalExpensesK - costOfSalesK,
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
 * drawn IS equity, and no posting writes it anywhere else. It lands on the
 * chart's own RETAINED_EARNINGS account, added to anything posted there.
 */
export function buildBalanceSheet(rows: readonly AccountSums[]): BalanceSheet {
  const assets: StatementLine[] = [];
  const liabilities: StatementLine[] = [];
  const equity: StatementLine[] = [];
  let retainedK = 0;
  let retainedHome: { code: string; name: string } | null = null;

  for (const row of rows) {
    const balance = cumulativeBalanceK(row);
    if (row.type === 'income' || row.type === 'expense') {
      retainedK += row.type === 'income' ? balance : -balance;
      continue;
    }
    if (row.systemRole === 'RETAINED_EARNINGS') {
      /* Whatever was POSTED to retained earnings joins the derived figure
       * on the one line, so the statement never shows the account twice. */
      retainedHome = { code: row.code, name: row.name };
      retainedK += balance;
      continue;
    }
    if (balance === 0) continue;
    const line = { code: row.code, name: row.name, amountK: balance };
    if (row.type === 'asset') assets.push(line);
    else if (row.type === 'liability') liabilities.push(line);
    else equity.push(line);
  }

  if (retainedK !== 0) {
    equity.push({
      code: retainedHome?.code ?? '3100',
      name: retainedHome?.name ?? 'Retained earnings',
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

/* A merchant's cash position is what they can spend, and money sitting at
 * the provider waiting to settle is still theirs (ADR 0025): every CASH
 * and BANK account, and every connection's clearing account (PR-053/065),
 * however many of each the chart holds. */
const CASH_ROLES = new Set(['CASH', 'BANK', 'PAYMENT_PROVIDER_CLEARING']);

/**
 * Direct method, merchant labels: what you started the period with, what
 * came in, what went out, what you hold now. Closing is derived from the
 * other three so the statement cannot disagree with itself.
 */
export function buildCashflowStatement(rows: readonly AccountSums[]): CashflowStatement {
  let inK = 0;
  let outK = 0;
  let closingK = 0;
  for (const row of rows) {
    if (!row.systemRole || !CASH_ROLES.has(row.systemRole)) continue;
    inK += row.periodDebitK;
    outK += row.periodCreditK;
    closingK += row.cumulativeDebitK - row.cumulativeCreditK;
  }
  return { openingK: closingK - inK + outK, inK, outK, closingK };
}
