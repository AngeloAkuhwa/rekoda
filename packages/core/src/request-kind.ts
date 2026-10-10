/**
 * Is a free-form message asking to READ the books or to CHANGE them (G-57)?
 *
 * Only the model can say what a sentence means in full: which customer, which
 * items, how much. Authorisation needs far less. A member who may not change
 * the books (an accountant, spec §35) must be refused BEFORE an allowance unit
 * is taken or a provider is paid (spec §4.3, rules 2 to 4), and that needs only
 * one fact the model used to be asked for: is this a question, or a record?
 *
 * Three answers, and the third is deliberate (OWN-25):
 *
 *  - `write`: known state-changing grammar ("sold rice 5k", "record a sale
 *    of 50k cash", "Ada paid me 20k", "I spent 20k on fuel").
 *  - `read`: known books-question grammar, about what the model's `Query`
 *    answers: sales, expenses, who owes, a customer's or a supplier's
 *    balance, what is unreconciled, a report ("how much did we sell this
 *    month?", "who paid me this month?", "show sales for today").
 *  - `unknown`: everything else ("Ada 20k", "rice and beans for Chidi").
 *    Never guessed into one or the other, and never fuzzily: a write read as
 *    a question is the leak this exists to close, so a sentence that could
 *    be either stays unknown.
 *
 * This decides nothing about WHO may do what. It names the kind of request;
 * the caller's role rule (`mayTransact`) decides whether that member may make
 * it, and the model's structured intent is still checked afterwards. Kept
 * small on purpose: it reads verbs and topic words, never amounts, names,
 * items or periods, which stay the model's job. Pure; no IO.
 */

export type RequestKind = 'read' | 'write' | 'unknown';

/** Politeness at the start that carries no meaning (as in the router). */
const OPENING_FILLERS = new Set([
  'abeg',
  'please',
  'pls',
  'plz',
  'kindly',
  'biko',
  'oya',
  'hi',
  'hello',
  'hey',
  'sir',
  'ma',
  'boss',
  'rekoda',
]);

/** Asking Rekoda to record something, said as an instruction. */
const RECORD_INSTRUCTIONS = new Set([
  'record',
  'add',
  'log',
  'enter',
  'book',
  'create',
  'issue',
  'raise',
  'register',
  'input',
  'capture',
  'save',
]);

/** How an instruction is softened before it is given: "can you record…". */
const ASKING_OPENERS: readonly (readonly string[])[] = [
  ['can', 'you'],
  ['could', 'you'],
  ['will', 'you'],
  ['would', 'you'],
  ['help', 'me'],
  ['i', 'want', 'to'],
  ['i', 'wan'],
  ['make', 'you'],
];

/** A question about the books, by its first word. */
const QUESTION_OPENERS = new Set([
  'how',
  'what',
  'whats',
  "what's",
  'who',
  'whom',
  'whose',
  'which',
  'when',
  'where',
  'why',
  'did',
  'do',
  'does',
  'is',
  'are',
  'was',
  'were',
  'has',
  'have',
  'show',
  'list',
  'tell',
  'wetin',
  'any',
  'can',
  'could',
]);

/** Trade happening: a sale, a purchase, money in or out. */
const TRADE_VERBS = new Set([
  'sold',
  'sell',
  'sells',
  'selling',
  'bought',
  'buy',
  'buys',
  'purchased',
  'paid',
  'pay',
  'pays',
  'received',
  'receive',
  'collected',
  'collect',
  'spent',
  'spend',
  'restocked',
  'restock',
  'ordered',
  'damaged',
  'spoilt',
  'spoiled',
]);

/**
 * What a question about the books is about (the model's `Query` topics),
 * where the word itself asks: nobody records a "debtors".
 */
const BOOK_TOPICS = new Set([
  'revenue',
  'income',
  'turnover',
  'profit',
  'profits',
  'loss',
  'pnl',
  'spending',
  'debt',
  'debts',
  'debtor',
  'debtors',
  'owe',
  'owes',
  'owing',
  'owed',
  'outstanding',
  'unpaid',
  'balance',
  'balances',
  'receivable',
  'receivables',
  'payable',
  'payables',
  'creditors',
  'unreconciled',
  'reconcile',
  'reconciliation',
  'report',
  'reports',
  'statement',
  'statements',
  'summary',
  'ledger',
  'cashflow',
]);

/**
 * Words that name a record as readily as a question about records: "sales
 * this month" asks, "sale rice" records. Read only beside a period.
 */
const RECORD_NOUNS = new Set([
  'sale',
  'sales',
  'expense',
  'expenses',
  'purchase',
  'purchases',
  'payment',
  'payments',
  'costs',
]);

const PERIODS = new Set([
  'today',
  'yesterday',
  'week',
  'weekly',
  'month',
  'monthly',
  'year',
  'quarter',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]);

/** Words that make a sentence about trade a summary of it: "total sold". */
const SUMMARY_WORDS = new Set(['total', 'summary', 'report', 'altogether']);

/**
 * A figure: digits, or a naira sign. A bare year ("2026") is a period, not
 * money, unless it carries a multiplier ("2026k").
 */
function hasFigure(text: string): boolean {
  if (text.includes('₦')) return true;
  for (const match of text.matchAll(/\d[\d,.]*\s*(k|m|naira|ngn)?/g)) {
    const digits = match[0].replace(/[^\d]/g, '');
    const isYear = /^(19|20)\d\d$/.test(digits) && !match[1];
    if (!isYear) return true;
  }
  return false;
}

function startsWith(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((w, i) => words[i] === w);
}

export function requestKind(raw: string): RequestKind {
  const text = raw.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  if (text.length === 0) return 'unknown';
  const asksAQuestion = text.endsWith('?');
  const all = text.replace(/p&l/g, 'pnl').match(/[\p{L}\p{N}']+/gu) ?? [];
  let start = 0;
  while (start < all.length - 1 && OPENING_FILLERS.has(all[start]!)) start += 1;
  const words = all.slice(start);
  if (words.length === 0) return 'unknown';

  /* An instruction to record, plain or softened, is a write even when it
   * ends in a question mark: "can you add a 5k sale?" asks for a record. */
  if (RECORD_INSTRUCTIONS.has(words[0]!)) return 'write';
  for (const opener of ASKING_OPENERS) {
    if (startsWith(words, opener) && RECORD_INSTRUCTIONS.has(words[opener.length] ?? '')) {
      return 'write';
    }
  }

  const figure = hasFigure(text);
  const trade = words.some((w) => TRADE_VERBS.has(w));
  const topic = words.some((w) => BOOK_TOPICS.has(w));
  const recordNoun = words.some((w) => RECORD_NOUNS.has(w));

  /* A question about the books reads: "how much did we sell?", "who paid me
   * this month?". One that also carries a figure beside trade ("did Ada pay
   * 20k?", "is it ok I sold rice 5k?") may be a record asked as a question,
   * and a question about nothing on the books ("what is this?") is not a
   * books question: both stay unknown. */
  if (asksAQuestion || QUESTION_OPENERS.has(words[0]!)) {
    if (figure && (trade || recordNoun)) return 'unknown';
    return trade || topic || recordNoun ? 'read' : 'unknown';
  }

  /* Trade with a figure is a record: "sold rice 5k", "Ada paid me 20k".
   * Without one it is a record or a summary: "total sold this month" says
   * which; "sold rice to Ada" does not. */
  if (trade) {
    if (figure) return 'write';
    return words.some((w) => SUMMARY_WORDS.has(w)) ? 'read' : 'unknown';
  }

  /* No trade verb. A figure beside anything ("Ada 20k", "expense 5k fuel")
   * could be a record. */
  if (figure) return 'unknown';
  if (topic) return 'read';
  if (recordNoun && words.some((w) => PERIODS.has(w))) return 'read';
  return 'unknown';
}
