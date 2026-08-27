/**
 * Double-entry ledger — ADR 0004.
 *
 * Every financial mutation in Rekoda is a Posting: a set of entries whose
 * debits and credits are EQUAL, in integer kobo, or the posting throws.
 * The ledger is append-only; corrections are reversing postings, never
 * edits. AI has no path into this module.
 *
 * Sign convention (classical):
 *   Assets & Expenses   — debit increases
 *   Liabilities, Equity & Income — credit increases
 */

import { assertKobo, type Kobo } from './money.js';

/* ── chart of accounts (fixed at V1 — ADR 0004) ──────────────────────────── */

export const ACCOUNTS = {
  CASH: { code: '1000', name: 'Cash on Hand', type: 'asset' },
  /**
   * Settlements from the payment provider, and nothing else (ADR 0025).
   * Written by `postProviderPayment` alone. Keeps 1010 rather than being
   * renumbered under `BANK`, because the code is rendered at display time and
   * moving it would change what a re-rendered statement says about a month
   * that has already been reported.
   */
  BANK_PAYSTACK: { code: '1010', name: 'Bank (Paystack settlements)', type: 'asset' },
  /** The merchant's own bank account: every ordinary transfer (ADR 0025). */
  BANK: { code: '1020', name: 'Bank', type: 'asset' },
  ACCOUNTS_RECEIVABLE: { code: '1100', name: 'Accounts Receivable', type: 'asset' },
  INVENTORY: { code: '1200', name: 'Inventory', type: 'asset' },
  /** What the business paid for things it keeps and uses (ADR 0026). */
  EQUIPMENT: { code: '1300', name: 'Equipment', type: 'asset' },
  /**
   * A CONTRA-ASSET: asset-type, credit-normal, and deliberately so.
   *
   * `naturalBalance` computes debits less credits for asset accounts, so this
   * lands on the balance sheet as a negative directly beneath the equipment
   * it reduces, which is how a real balance sheet presents it. Nothing needed
   * telling about depreciation for the accounting identity to hold.
   *
   * Separate from EQUIPMENT rather than netted into it because the two facts
   * are different and an accountant expects both: what the business paid, and
   * how much of that has been used up. A lender asks about the first.
   */
  ACCUMULATED_DEPRECIATION: {
    code: '1310',
    name: 'Less: accumulated depreciation',
    type: 'asset',
  },
  ACCOUNTS_PAYABLE: { code: '2000', name: 'Accounts Payable', type: 'liability' },
  VAT_PAYABLE: { code: '2100', name: 'VAT Payable', type: 'liability' },
  OWNERS_EQUITY: { code: '3000', name: "Owner's Equity", type: 'equity' },
  SALES_REVENUE: { code: '4000', name: 'Sales Revenue', type: 'income' },
  COGS: { code: '5000', name: 'Cost of Goods Sold', type: 'expense' },
  EXPENSES: { code: '6000', name: 'Operating Expenses', type: 'expense' },
  /** This period's charge for using the equipment (ADR 0026). */
  DEPRECIATION: { code: '6100', name: 'Depreciation', type: 'expense' },
  /**
   * What selling equipment left the business better or worse off by.
   *
   * Expense-typed, so a LOSS is a debit and reads as an ordinary cost. A GAIN
   * is a credit and shows as a negative, the same way accumulated
   * depreciation shows as a negative asset: `naturalBalance` handles the sign
   * and nothing needed telling. One account rather than two because a gain
   * and a loss are the same fact with opposite signs, and splitting them
   * would let a merchant with both in one year read neither.
   */
  DISPOSAL_RESULT: {
    code: '6200',
    name: 'Loss (or gain) on equipment sold',
    type: 'expense',
  },
} as const satisfies Record<string, { code: string; name: string; type: AccountType }>;

export type AccountKey = keyof typeof ACCOUNTS;

/**
 * The inverse of the chart: display code back to legacy key (F1, PR-033).
 * Readers now filter and group the ledger by the chart row's CODE through
 * `account_id`; consumers that still speak in keys map back through this.
 */
export const KEY_BY_CODE = Object.fromEntries(
  Object.entries(ACCOUNTS).map(([key, value]) => [value.code, key]),
) as Record<string, AccountKey>;
export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

/** For rows read back from storage, where `account` arrives as a string. */
export function isAccountKey(value: unknown): value is AccountKey {
  return typeof value === 'string' && value in ACCOUNTS;
}

/* ── postings ────────────────────────────────────────────────────────────── */

export interface LedgerLine {
  readonly account: AccountKey;
  readonly debitK: Kobo;
  readonly creditK: Kobo;
}

export interface Posting {
  /** Human-auditable description, e.g. "Sale INV-2026-000041 to CUSTOMER_X81". */
  readonly memo: string;
  readonly lines: readonly LedgerLine[];
}

export class UnbalancedPostingError extends Error {
  override readonly name = 'UnbalancedPostingError';
  constructor(memo: string, debitsK: Kobo, creditsK: Kobo) {
    super(
      `Posting "${memo}" does not balance: debits ${debitsK} ≠ credits ${creditsK} (kobo). ` +
        'This is a bug in the calling code: postings must balance by construction.',
    );
  }
}

/** The invariant. Called by every builder and again by the persistence layer. */
export function assertBalanced(posting: Posting): void {
  let debits = 0;
  let credits = 0;
  for (const line of posting.lines) {
    assertKobo(line.debitK, `debit on ${line.account}`);
    assertKobo(line.creditK, `credit on ${line.account}`);
    if (line.debitK < 0 || line.creditK < 0) {
      throw new UnbalancedPostingError(posting.memo, line.debitK, line.creditK);
    }
    if (line.debitK > 0 && line.creditK > 0) {
      throw new UnbalancedPostingError(posting.memo, line.debitK, line.creditK);
    }
    debits += line.debitK;
    credits += line.creditK;
  }
  if (debits !== credits || debits === 0) {
    throw new UnbalancedPostingError(posting.memo, debits, credits);
  }
}

const line = (account: AccountKey, debitK: Kobo, creditK: Kobo): LedgerLine => ({
  account,
  debitK,
  creditK,
});

/* ── posting builders ────────────────────────────────────────────────────────
 * Each builder returns a Posting that balances BY CONSTRUCTION and then
 * asserts anyway — belt and braces, because this is the layer a tax officer
 * eventually reads.
 */

export type PaymentMethod = 'cash' | 'transfer';

/**
 * The merchant's own bank, never the settlement account (ADR 0025).
 *
 * A transfer is a transfer: a customer paying into a merchant's GTB account
 * and a merchant paying a supplier both move the account they can see a
 * statement for. Provider settlements are the one thing that does not come
 * through here, and `postProviderPayment` names its account itself.
 */
const cashOrBank = (method: PaymentMethod): AccountKey => (method === 'cash' ? 'CASH' : 'BANK');

/**
 * A sale: revenue is recognised in full; whatever was not paid immediately
 * becomes a receivable. VAT (if carved out) is a liability, not revenue.
 */
export function postSale(args: {
  memo: string;
  totalK: Kobo;
  paidK: Kobo;
  vatK?: Kobo;
  method?: PaymentMethod;
}): Posting {
  const vatK = args.vatK ?? 0;
  const receivableK = args.totalK - args.paidK;
  if (receivableK < 0) throw new UnbalancedPostingError(args.memo, args.paidK, args.totalK);
  const lines: LedgerLine[] = [];
  if (args.paidK > 0) lines.push(line(cashOrBank(args.method ?? 'transfer'), args.paidK, 0));
  if (receivableK > 0) lines.push(line('ACCOUNTS_RECEIVABLE', receivableK, 0));
  lines.push(line('SALES_REVENUE', 0, args.totalK - vatK));
  if (vatK > 0) lines.push(line('VAT_PAYABLE', 0, vatK));
  const posting = { memo: args.memo, lines };
  assertBalanced(posting);
  return posting;
}

/**
 * What the business was already holding on the day it started with Rekoda.
 *
 * Every other posting here records something that HAPPENED. This one records
 * something that was already true, and it exists because without it the books
 * describe a business that came into existence with nothing.
 *
 * The symptom is not subtle. A merchant who joins with ₦200,000 in the till
 * and spends ₦195,500 of it gets "Cash on Hand: minus ₦93,500" on their
 * balance sheet: arithmetic that balances perfectly and describes a business
 * that has never existed. Owner's equity has been in the chart since ADR 0004
 * and nothing has ever posted to it, which is the same bug seen from the
 * other side.
 *
 * ── what it deliberately cannot set ───────────────────────────────────────
 *
 * Not receivables and not payables. An opening figure for "what customers
 * owe" has no invoices behind it, so the debtors page and the ledger would
 * hold two different answers to the same question, and the merchant would
 * have no way to chase either. Old unpaid invoices belong in Rekoda AS
 * invoices; that is what invoices are for.
 *
 * ── the balancing figure ──────────────────────────────────────────────────
 *
 * Owner's equity takes whatever makes the entry balance, which is the
 * accounting equation stated as code: what the business holds, less what it
 * owes, is what the owner has in it. It may be zero and it cannot be
 * negative here, because the only things this posting can set are assets.
 */
export function postOpeningBalances(args: {
  memo: string;
  cashK?: Kobo;
  bankK?: Kobo;
  stockK?: Kobo;
}): Posting {
  const cashK = args.cashK ?? 0;
  const bankK = args.bankK ?? 0;
  const stockK = args.stockK ?? 0;
  if (cashK < 0 || bankK < 0 || stockK < 0) {
    throw new RangeError('opening balances cannot be negative');
  }
  const equityK = cashK + bankK + stockK;
  if (equityK === 0) throw new RangeError('opening balances of nothing are not an entry');

  const lines: LedgerLine[] = [];
  if (cashK > 0) lines.push(line('CASH', cashK, 0));
  if (bankK > 0) lines.push(line('BANK', bankK, 0));
  if (stockK > 0) lines.push(line('INVENTORY', stockK, 0));
  lines.push(line('OWNERS_EQUITY', 0, equityK));

  const posting = { memo: args.memo, lines };
  assertBalanced(posting);
  return posting;
}

/** A later payment against an outstanding receivable. */
export function postReceivablePayment(args: {
  memo: string;
  amountK: Kobo;
  method?: PaymentMethod;
}): Posting {
  const posting: Posting = {
    memo: args.memo,
    lines: [
      line(cashOrBank(args.method ?? 'transfer'), args.amountK, 0),
      line('ACCOUNTS_RECEIVABLE', 0, args.amountK),
    ],
  };
  assertBalanced(posting);
  return posting;
}

/** An operating expense, paid now or owed to a supplier. */
export function postExpense(args: {
  memo: string;
  amountK: Kobo;
  paidK?: Kobo;
  method?: PaymentMethod;
}): Posting {
  const paidK = args.paidK ?? args.amountK;
  const owedK = args.amountK - paidK;
  if (owedK < 0) throw new UnbalancedPostingError(args.memo, paidK, args.amountK);
  const lines: LedgerLine[] = [line('EXPENSES', args.amountK, 0)];
  if (paidK > 0) lines.push(line(cashOrBank(args.method ?? 'cash'), 0, paidK));
  if (owedK > 0) lines.push(line('ACCOUNTS_PAYABLE', 0, owedK));
  const posting = { memo: args.memo, lines };
  assertBalanced(posting);
  return posting;
}

/** Stock purchase from a supplier, possibly partly on credit. */
export function postPurchase(args: {
  memo: string;
  amountK: Kobo;
  paidK?: Kobo;
  method?: PaymentMethod;
}): Posting {
  const paidK = args.paidK ?? args.amountK;
  const owedK = args.amountK - paidK;
  if (owedK < 0) throw new UnbalancedPostingError(args.memo, paidK, args.amountK);
  const lines: LedgerLine[] = [line('INVENTORY', args.amountK, 0)];
  if (paidK > 0) lines.push(line(cashOrBank(args.method ?? 'transfer'), 0, paidK));
  if (owedK > 0) lines.push(line('ACCOUNTS_PAYABLE', 0, owedK));
  const posting = { memo: args.memo, lines };
  assertBalanced(posting);
  return posting;
}

/**
 * A provider-confirmed payment settling an outstanding receivable
 * (payments-v1 §15, §23).
 *
 * The amount posted is the ALLOCATED amount — the portion that settles the
 * invoice — never the gross. Fees never touch SALES_REVENUE, which was already
 * recognised in full when the sale was issued; the only question here is what
 * reaches the bank and what the collection cost.
 *
 *   merchant_bearing:  bank gets allocated − fee, the fee is an operating
 *                      expense, and the receivable clears in full;
 *   customer_bearing:  the customer paid the fee on top, so it never enters
 *                      the merchant's books at all;
 *   platform_bearing:  Rekoda absorbed it — same shape as customer_bearing
 *                      from the merchant's side.
 *
 * A fee larger than the payment it collected is a data error, not a posting.
 */
export function postProviderPayment(args: {
  memo: string;
  allocatedK: Kobo;
  providerFeeK?: Kobo;
  feePolicy?: 'customer_bearing' | 'merchant_bearing' | 'platform_bearing';
}): Posting {
  const feeK = args.providerFeeK ?? 0;
  const policy = args.feePolicy ?? 'merchant_bearing';
  if (args.allocatedK <= 0 || feeK < 0) {
    throw new UnbalancedPostingError(args.memo, args.allocatedK, feeK);
  }

  const lines: LedgerLine[] = [];
  if (policy === 'merchant_bearing' && feeK > 0) {
    const settlementK = args.allocatedK - feeK;
    if (settlementK < 0) throw new UnbalancedPostingError(args.memo, args.allocatedK, feeK);
    if (settlementK > 0) lines.push(line('BANK_PAYSTACK', settlementK, 0));
    lines.push(line('EXPENSES', feeK, 0));
  } else {
    lines.push(line('BANK_PAYSTACK', args.allocatedK, 0));
  }
  lines.push(line('ACCOUNTS_RECEIVABLE', 0, args.allocatedK));

  const posting = { memo: args.memo, lines };
  assertBalanced(posting);
  return posting;
}

/**
 * A credit note: revenue given back on an invoice money has arrived against.
 *
 * The instrument the void refuses to be. A void reverses a sale that should
 * never have happened; a credit note reduces a sale that did, which is the
 * case where a customer returned goods, was overcharged, or settled a dispute.
 * Money can already have moved, so reversing the whole posting would describe
 * a payment that is still in the merchant's account.
 *
 * Revenue is debited because it is being taken back, and VAT with it: crediting
 * a sale that carried VAT and leaving the VAT liability standing would have the
 * merchant owing tax on income they no longer have.
 *
 * The receivable is credited by the FULL amount, and it is allowed to go
 * negative. That is not a bug to guard against — a customer credited beyond
 * what they still owe IS in credit, and a negative receivable is exactly how a
 * ledger says so. Inventing a "refunds payable" account to avoid the negative
 * would put customer credits in with what the shop owes its suppliers.
 *
 * The credit note moves no cash. Handing the money back is a payment, and it
 * is a separate posting on the day it actually happens.
 */
export function postCreditNote(args: { memo: string; amountK: Kobo; vatK?: Kobo }): Posting {
  const vatK = args.vatK ?? 0;
  if (args.amountK <= 0 || vatK < 0 || vatK > args.amountK) {
    throw new UnbalancedPostingError(args.memo, args.amountK, vatK);
  }
  const lines: LedgerLine[] = [line('SALES_REVENUE', args.amountK - vatK, 0)];
  if (vatK > 0) lines.push(line('VAT_PAYABLE', vatK, 0));
  lines.push(line('ACCOUNTS_RECEIVABLE', 0, args.amountK));

  const posting = { memo: args.memo, lines };
  assertBalanced(posting);
  return posting;
}

/**
 * Bringing the inventory account to what was actually counted.
 *
 * The books and the shelf drift apart for a reason nothing else can fix. A
 * purchase described in prose ("restocked the shop, 50k") debits INVENTORY
 * and nothing ever credits it, because there is no product for a cost to
 * attach to; a product with no cost sells and takes nothing off the account.
 * Both leave the balance sheet saying the business owns more than it does,
 * and neither is a bug in a write path: they are what happens when a shop
 * tells its books less than it knows.
 *
 * So the instrument is the one an accountant already uses: count the shelf,
 * value it, and put the difference through cost of sales. A shortfall is
 * cost that was incurred and never recorded, which is exactly what COGS is
 * for. A surplus is that same account being given back what it was
 * overcharged.
 *
 * `differenceK` is counted value LESS what the account says. Negative is the
 * ordinary case and the one the drift produces.
 */
export function postStockCount(args: { memo: string; differenceK: number }): Posting {
  if (args.differenceK === 0) throw new RangeError('a count that agrees needs no entry');
  const amountK = Math.abs(args.differenceK);
  const short = args.differenceK < 0;
  const posting: Posting = {
    memo: args.memo,
    lines: short
      ? [line('COGS', amountK, 0), line('INVENTORY', 0, amountK)]
      : [line('INVENTORY', amountK, 0), line('COGS', 0, amountK)],
  };
  assertBalanced(posting);
  return posting;
}

/**
 * What to call each account when a merchant has to choose one.
 *
 * Separate from `ACCOUNTS[k].name`, which is what a statement prints and what
 * an accountant expects to read. A person picking where money went needs the
 * thing they would say out loud: "the bank", not "Bank (Paystack)"; "money
 * customers owe me", not "Accounts Receivable". Both are true, and a dropdown
 * that used the statement's wording would be a dropdown nobody uses.
 */
export const ACCOUNT_PICKER_LABELS: Record<AccountKey, string> = {
  CASH: 'Cash in hand',
  BANK: 'Money in the bank',
  ACCOUNTS_RECEIVABLE: 'Money customers owe you',
  INVENTORY: 'Stock on the shelf',
  ACCOUNTS_PAYABLE: 'Money you owe suppliers',
  VAT_PAYABLE: 'VAT you are holding',
  OWNERS_EQUITY: 'Your own money in the business',
  SALES_REVENUE: 'Sales',
  COGS: 'Cost of goods sold',
  EXPENSES: 'Running costs',
  EQUIPMENT: 'Equipment you own',
  DEPRECIATION: 'Wear on your equipment',
  /* Below the everyday accounts, because a merchant correcting something by
   * hand almost never means either of these. Accumulated depreciation is
   * written by the monthly charge, not by a person, and pointing a journal at
   * it by mistake is how a balance sheet stops adding up. */
  ACCUMULATED_DEPRECIATION: 'Equipment wear recorded so far',
  DISPOSAL_RESULT: 'Money made or lost selling equipment',
  /* Last, and deliberately. A merchant reaches for this list to say where
   * money went, and the settlement account is the one entry there they almost
   * never mean: it is written by the provider, not by them. Ordered by how
   * often a person needs it rather than by account code, which is the reason
   * this map is separate from ACCOUNTS at all. */
  BANK_PAYSTACK: 'Paystack settlements',
};

/**
 * A correction a merchant makes by hand.
 *
 * Every other posting in this file is derived: a sale, a payment, a delivery,
 * a count. That is why the books have stayed right without the merchant
 * having to be an accountant, and it is also the one thing an accountant
 * looking at Rekoda asks for and does not find. Money moved from the till to
 * the bank, an amount that went to the wrong account, an owner putting their
 * own money in: all real, all ordinary, and none of them a sale.
 *
 * Two sides and one amount, rather than a list of lines. A free journal is a
 * loaded gun pointed at the property Rekoda sells, and the shape here makes
 * the failure impossible instead of catching it: with one figure moving
 * between two named accounts there is no arrangement of the inputs that does
 * not balance. What it cannot express is a genuine multi-line journal, which
 * is a real limit and a deliberate one.
 *
 * The accounts are the fixed chart (ADR 0004, amended by 0025 and 0026), so a
 * merchant cannot invent a place to hide a difference.
 */
export function postJournal(args: {
  memo: string;
  amountK: Kobo;
  /** Debited: what gains. */
  intoAccount: AccountKey;
  /** Credited: what gives it up. */
  outOfAccount: AccountKey;
}): Posting {
  if (args.intoAccount === args.outOfAccount) {
    throw new RangeError('an entry into and out of the same account moves nothing');
  }
  const posting: Posting = {
    memo: args.memo,
    lines: [line(args.intoAccount, args.amountK, 0), line(args.outOfAccount, 0, args.amountK)],
  };
  /* Catches a zero or negative amount as well as an imbalance, which the
   * shape above already rules out. */
  assertBalanced(posting);
  return posting;
}

/**
 * What the goods a sale took off the shelf cost.
 *
 * A SECOND posting, written alongside the sale rather than folded into it,
 * and the separation is deliberate. A sale is a fact about money and is known
 * exactly; what the goods cost is an estimate from a costing method and is
 * known only for products the merchant has told Rekoda about. Two postings
 * means a sale whose cost is unknown still records the sale, and an auditor
 * can see revenue and cost as the separate assertions they are.
 */
export function postCostOfSale(args: { memo: string; costK: Kobo }): Posting {
  if (args.costK <= 0) throw new RangeError('a cost of sale is more than nothing');
  const posting: Posting = {
    memo: args.memo,
    lines: [line('COGS', args.costK, 0), line('INVENTORY', 0, args.costK)],
  };
  assertBalanced(posting);
  return posting;
}

/** Reversing posting — the ONLY way to correct: never edit, always reverse. */
export function reversal(original: Posting, memo: string): Posting {
  const posting: Posting = {
    memo,
    lines: original.lines.map((l) => line(l.account, l.creditK, l.debitK)),
  };
  assertBalanced(posting);
  return posting;
}

/* ── trial balance ───────────────────────────────────────────────────────── */

export interface TrialBalanceRow {
  readonly account: AccountKey;
  readonly debitK: Kobo;
  readonly creditK: Kobo;
  /** Natural-sign balance: positive = normal for the account's type. */
  readonly balanceK: Kobo;
}

export function trialBalance(postings: readonly Posting[]): {
  rows: TrialBalanceRow[];
  totalDebitsK: Kobo;
  totalCreditsK: Kobo;
  balanced: boolean;
} {
  const acc = new Map<AccountKey, { d: number; c: number }>();
  for (const p of postings) {
    assertBalanced(p);
    for (const l of p.lines) {
      const a = acc.get(l.account) ?? { d: 0, c: 0 };
      a.d += l.debitK;
      a.c += l.creditK;
      acc.set(l.account, a);
    }
  }
  let totalDebitsK = 0;
  let totalCreditsK = 0;
  const rows: TrialBalanceRow[] = [];
  for (const [account, { d, c }] of acc) {
    totalDebitsK += d;
    totalCreditsK += c;
    const type = ACCOUNTS[account].type;
    const debitNormal = type === 'asset' || type === 'expense';
    rows.push({ account, debitK: d, creditK: c, balanceK: debitNormal ? d - c : c - d });
  }
  rows.sort((x, y) => ACCOUNTS[x.account].code.localeCompare(ACCOUNTS[y.account].code));
  return { rows, totalDebitsK, totalCreditsK, balanced: totalDebitsK === totalCreditsK };
}

/**
 * Buying something the business keeps and uses (ADR 0026).
 *
 * The difference from an expense is not a category, it is which statement the
 * money lands on. An expense reaches the profit and loss now; this reaches the
 * balance sheet and only touches profit later, a month at a time, as the thing
 * is used up. Recording a ₦450,000 generator as an expense reports a loss the
 * business did not make and hides an asset it owns.
 *
 * Paid or owed, like a purchase: a merchant who takes a freezer on credit owes
 * the supplier, and the remainder carries to ACCOUNTS_PAYABLE so the payable
 * ageing and the supplier payment already know what to do with it.
 */
export function postAssetPurchase(args: {
  memo: string;
  costK: Kobo;
  paidK?: Kobo;
  method?: PaymentMethod;
}): Posting {
  const paidK = args.paidK ?? args.costK;
  const owedK = args.costK - paidK;
  if (args.costK <= 0 || paidK < 0 || owedK < 0) {
    throw new UnbalancedPostingError(args.memo, paidK, args.costK);
  }

  const lines: LedgerLine[] = [line('EQUIPMENT', args.costK, 0)];
  if (paidK > 0) lines.push(line(cashOrBank(args.method ?? 'transfer'), 0, paidK));
  if (owedK > 0) lines.push(line('ACCOUNTS_PAYABLE', 0, owedK));

  const posting: Posting = { memo: args.memo, lines };
  assertBalanced(posting);
  return posting;
}

/**
 * One month's wear on the equipment (ADR 0026).
 *
 * The credit goes to ACCUMULATED_DEPRECIATION rather than to EQUIPMENT,
 * because what the business PAID and how much has been USED UP are two facts
 * and an accountant expects both. Netting them would destroy the first, which
 * is the one a lender asks about.
 */
export function postDepreciation(args: { memo: string; amountK: Kobo }): Posting {
  if (args.amountK <= 0) {
    throw new RangeError('a depreciation charge of nothing is not a charge');
  }
  const posting: Posting = {
    memo: args.memo,
    lines: [
      line('DEPRECIATION', args.amountK, 0),
      line('ACCUMULATED_DEPRECIATION', 0, args.amountK),
    ],
  };
  assertBalanced(posting);
  return posting;
}

/**
 * What a month's charge is, in kobo, for one asset.
 *
 * Straight line with no salvage value (ADR 0026): cost divided by useful life
 * in months. The LAST month takes whatever rounding left behind, so an asset
 * always depreciates to exactly its cost and never to a kobo more or less.
 * Charging `round(cost / months)` every month for a ₦100,000 asset over 7
 * months would leave 4 kobo stranded on the balance sheet forever, which is
 * small, permanent, and exactly the kind of thing that makes an accountant
 * stop trusting a system.
 */
export function monthlyDepreciationK(args: {
  costK: Kobo;
  usefulLifeMonths: number;
  monthsCharged: number;
}): Kobo {
  const { costK, usefulLifeMonths, monthsCharged } = args;
  if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths <= 0) {
    throw new RangeError('useful life is a whole number of months, at least one');
  }
  if (monthsCharged < 0 || monthsCharged >= usefulLifeMonths) return 0;

  const perMonth = Math.floor(costK / usefulLifeMonths);
  const isLast = monthsCharged === usefulLifeMonths - 1;
  return isLast ? costK - perMonth * (usefulLifeMonths - 1) : perMonth;
}

/**
 * Selling or scrapping equipment (ADR 0026, amended).
 *
 * Four lines, which is why it could not be expressed as a manual journal: the
 * proceeds come in, the cost comes off, the wear recorded against it comes off
 * with it, and whatever is left over is the gain or the loss.
 *
 * The gain or loss is measured against BOOK VALUE, not against the price
 * paid. A generator bought for ₦450,000, worn down to ₦360,000 and sold for
 * ₦200,000 is a ₦160,000 loss, not a ₦250,000 one: the other ₦90,000 already
 * reached the profit and loss a month at a time, and counting it twice is the
 * mistake this shape makes impossible.
 *
 * Scrapping is the same event with no proceeds, so it needs no separate path:
 * the whole remaining book value becomes the loss.
 */
export function postAssetDisposal(args: {
  memo: string;
  /** What the business paid for it. */
  costK: Kobo;
  /** What has been charged against it so far. */
  accumulatedK: Kobo;
  /** What was received. Zero when it was scrapped rather than sold. */
  proceedsK: Kobo;
  method?: PaymentMethod;
}): Posting {
  if (args.costK <= 0 || args.accumulatedK < 0 || args.proceedsK < 0) {
    throw new RangeError('a disposal needs a cost, and figures that are not negative');
  }
  if (args.accumulatedK > args.costK) {
    throw new RangeError('more wear than the thing cost is not a state the books can reach');
  }

  const lines: LedgerLine[] = [];
  if (args.proceedsK > 0) {
    lines.push(line(cashOrBank(args.method ?? 'transfer'), args.proceedsK, 0));
  }
  /* The wear comes off with the thing it was recorded against. Leaving it
   * behind would strand a credit on the balance sheet under equipment that no
   * longer exists. */
  if (args.accumulatedK > 0) lines.push(line('ACCUMULATED_DEPRECIATION', args.accumulatedK, 0));
  lines.push(line('EQUIPMENT', 0, args.costK));

  const bookValueK = args.costK - args.accumulatedK;
  const resultK = args.proceedsK - bookValueK;
  if (resultK < 0) lines.push(line('DISPOSAL_RESULT', -resultK, 0));
  if (resultK > 0) lines.push(line('DISPOSAL_RESULT', 0, resultK));

  const posting: Posting = { memo: args.memo, lines };
  assertBalanced(posting);
  return posting;
}
