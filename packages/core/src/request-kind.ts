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
 * small on purpose: it reads verbs and topic words, and notes only whether a
 * figure or a period is present. It extracts no amount, name, item or period;
 * those stay the model's job. Pure; no IO.
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
]);

/**
 * Changing what is already recorded: undoing, clearing, correcting. Not one
 * of these is a question about the books; as the opening word each is an
 * instruction.
 */
const CHANGE_VERBS = new Set([
  'clear',
  'cleared',
  'settle',
  'settled',
  'cancel',
  'cancelled',
  'canceled',
  'delete',
  'deleted',
  'remove',
  'removed',
  'reverse',
  'reversed',
  'void',
  'voided',
  'refund',
  'refunded',
  'update',
  'updated',
  'change',
  'changed',
  'edit',
  'correct',
  'corrected',
  'adjust',
  'adjusted',
  'set',
  'reduce',
  'reduced',
  'increase',
  'increased',
  'mark',
  'marked',
  'reconcile',
  'reconciled',
  'return',
  'returned',
  'write',
  'wrote',
]);

/** Words that only join books words: "the sales for this month so far". */
const JOINING_WORDS = new Set([
  'my',
  'our',
  'the',
  'a',
  'an',
  'for',
  'this',
  'that',
  'last',
  'past',
  'of',
  'in',
  'on',
  'at',
  'all',
  'so',
  'far',
  'to',
  'from',
  'by',
  'me',
  'i',
  'we',
  'us',
  'list',
  'current',
  'still',
  'now',
  'and',
  'with',
  'per',
  'each',
  'every',
  'up',
  'date',
  'account',
  'accounts',
  'customer',
  'customers',
  'supplier',
  'suppliers',
  'bank',
  'business',
  'money',
  'wey',
  'dey',
  'who',
  'which',
  'till',
  'until',
  'overall',
  'full',
  'sheet',
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
  'overdue',
  'unmatched',
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
  'invoice',
  'invoices',
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
  'yearly',
  'daily',
  'quarter',
  'quarterly',
  'q1',
  'q2',
  'q3',
  'q4',
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
  /* Digits glued to a letter ("q3") name something, not an amount. */
  for (const match of text.matchAll(/(?<![a-z])\d[\d,.]*\s*(k|m|naira|ngn)?/g)) {
    const digits = match[0].replace(/[^\d]/g, '');
    const isYear = /^(19|20)\d\d$/.test(digits) && !match[1];
    if (!isYear) return true;
  }
  return false;
}

function startsWith(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((w, i) => words[i] === w);
}

/**
 * The privacy gateway's tokens (`CUSTOMER_7K2`, `PHONE_1`, `EMAIL_1`): a name
 * or a contact, never an amount. Blanked before reading, so the digits inside
 * a token are never mistaken for money (this reads the tokenised text).
 */
const VAULT_TOKEN = /\b[A-Z]+_[A-Z0-9]+\b/g;

export function requestKind(raw: string): RequestKind {
  const text = raw
    .replace(VAULT_TOKEN, ' ')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length === 0) return 'unknown';
  const asksAQuestion = text.endsWith('?');
  const all = (
    text
      .replace(/p&l/g, 'pnl')
      .replace(/cash flow/g, 'cashflow')
      .match(/[\p{L}\p{N}']+/gu) ?? []
  ).map((w) => w.replace(/'s$/, ''));
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

  /* A change to what is already recorded ("clear Ada's debt", "reverse the
   * last sale") is a write when it is the instruction, and otherwise could
   * be one ("Ada settled her balance", "how do I delete a sale?"). */
  if (CHANGE_VERBS.has(words[0]!)) return 'write';
  if (words.some((w) => CHANGE_VERBS.has(w))) return 'unknown';

  const figure = hasFigure(text);
  const trade = words.some((w) => TRADE_VERBS.has(w));
  const topic = words.some((w) => BOOK_TOPICS.has(w));
  const recordNoun = words.some((w) => RECORD_NOUNS.has(w));
  const summary = words.some((w) => SUMMARY_WORDS.has(w));
  const period = words.some((w) => PERIODS.has(w) || isYear(w));

  /* A question, by its opening words, about the books reads: "how much did
   * we sell?", "who paid me this month?", "can I see sales?". One that also
   * carries a figure beside trade ("did Ada pay 20k?") may be a record asked
   * as a question, and one about nothing on the books ("what is this?") is
   * not a books question: both stay unknown. A question mark alone opens
   * nothing: "sold rice to Ada?" is held to the statement rules below. */
  if (opensAQuestion(words)) {
    if (figure && (trade || recordNoun)) return 'unknown';
    return trade || topic || recordNoun ? 'read' : 'unknown';
  }

  /* Trade with a figure is a record: "sold rice 5k", "Ada paid me 20k".
   * Without one it is a summary only when nothing else is said ("total sold
   * this month"); "sold rice to Ada" could be either. */
  if (trade) {
    if (figure) return 'write';
    return summary && onlyBooksWords(words) ? 'read' : 'unknown';
  }

  /* No trade verb, and not a question. A figure beside anything ("Ada 20k",
   * "expense 5k fuel") could be a record. Otherwise it reads only when
   * every word is about the books ("my debtors", "sales this month", "total
   * expenses"): "expense today fuel" says something more, and stays
   * unknown. */
  if (figure || !onlyBooksWords(words)) return 'unknown';
  if (topic) return 'read';
  if (recordNoun && (period || summary)) return 'read';
  return 'unknown';
}

/** A question by its opening, not by a trailing question mark. */
function opensAQuestion(words: readonly string[]): boolean {
  const first = words[0]!;
  if (QUESTION_OPENERS.has(first)) return true;
  /* "can I see…", "could we get…", never "can you…": that asks for work. */
  if ((first === 'can' || first === 'could') && (words[1] === 'i' || words[1] === 'we')) {
    return true;
  }
  /* "send me the P&L", "give me sales today". */
  return (first === 'send' || first === 'give' || first === 'get') && words[1] === 'me';
}

function isYear(word: string): boolean {
  return /^(19|20)\d\d$/.test(word);
}

/** Every word is a books word, a period, or a word that joins them. */
function onlyBooksWords(words: readonly string[]): boolean {
  return words.every(
    (w) =>
      BOOK_TOPICS.has(w) ||
      RECORD_NOUNS.has(w) ||
      PERIODS.has(w) ||
      SUMMARY_WORDS.has(w) ||
      TRADE_VERBS.has(w) ||
      JOINING_WORDS.has(w) ||
      isYear(w),
  );
}
