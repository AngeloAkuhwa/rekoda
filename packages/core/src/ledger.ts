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
  BANK_PAYSTACK: { code: '1010', name: 'Bank (Paystack)', type: 'asset' },
  ACCOUNTS_RECEIVABLE: { code: '1100', name: 'Accounts Receivable', type: 'asset' },
  INVENTORY: { code: '1200', name: 'Inventory', type: 'asset' },
  ACCOUNTS_PAYABLE: { code: '2000', name: 'Accounts Payable', type: 'liability' },
  VAT_PAYABLE: { code: '2100', name: 'VAT Payable', type: 'liability' },
  OWNERS_EQUITY: { code: '3000', name: "Owner's Equity", type: 'equity' },
  SALES_REVENUE: { code: '4000', name: 'Sales Revenue', type: 'income' },
  COGS: { code: '5000', name: 'Cost of Goods Sold', type: 'expense' },
  EXPENSES: { code: '6000', name: 'Operating Expenses', type: 'expense' },
} as const satisfies Record<string, { code: string; name: string; type: AccountType }>;

export type AccountKey = keyof typeof ACCOUNTS;
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

const cashOrBank = (method: PaymentMethod): AccountKey =>
  method === 'cash' ? 'CASH' : 'BANK_PAYSTACK';

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
