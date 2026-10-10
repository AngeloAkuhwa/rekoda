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

/** A courtesy or particle closing a message: "sales today please". */
const TRAILING_FILLERS = new Set([
  'please',
  'pls',
  'plz',
  'abeg',
  'biko',
  'o',
  'oo',
  'sha',
  'abi',
  'na',
  'sir',
  'ma',
  'boss',
  'thanks',
]);

/** Asking for the books by name: "i want the P&L", "may i have the report". */
const WANTING_PREFIXES: readonly (readonly string[])[] = [
  ['i', 'would', 'like'],
  ['i', 'just', 'want'],
  ['i', 'only', 'want'],
  ['i', 'just', 'need'],
  ['i', 'want'],
  ['i', 'need'],
  ['may', 'i', 'have'],
];

/** Asking to see the books: "i want to see my sales", "make i see". */
const SEEING_PREFIXES: readonly (readonly string[])[] = [
  ['i', 'would', 'like', 'to', 'see'],
  ['i', 'would', 'like', 'to', 'know'],
  ['i', 'just', 'want', 'to', 'see'],
  ['i', 'only', 'want', 'to', 'see'],
  ['may', 'i', 'see'],
  ['may', 'i', 'know'],
  ['i', 'want', 'to', 'see'],
  ['i', 'want', 'to', 'know'],
  ['i', 'need', 'to', 'see'],
  ['i', 'need', 'to', 'know'],
  ['let', 'me', 'see'],
  ['let', 'me', 'know'],
  ['make', 'i', 'see'],
  ['make', 'i', 'know'],
  ['i', 'wan', 'see'],
  ['i', 'wan', 'know'],
];

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
  'over',
  'during',
  'within',
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
  /* "how much did we make/earn this month?" reads in a question frame
   * (Codex P2); "made a sale today", "made 50k" stay records (round 24). */
  'make',
  'made',
  'earn',
  'earned',
]);

/**
 * What a question about the books is about (the model's `Query` topics),
 * where the word itself asks: nobody records a "debtors".
 */
const BOOK_TOPICS = new Set([
  'earnings',
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
  'records',
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
  'transactions',
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
  'day',
  'days',
  'weeks',
  'months',
  'years',
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
/** Amounts said in words, as typed or as a transcript renders them. */
const NUMBER_WORDS =
  /\b(hundred|thousand|million|billion|naira|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/;

/**
 * Calendar dates and spans: a period, never money (Codex P2). "10 October
 * 2026", "October 10th", "10/10/2026", "the 5th", "last 7 days".
 */
const DATES = new RegExp(
  [
    /* A range of days in one month (Codex P2): "1 to 5 October", "1 and 5
     * October", "1-5 October". Before the single day, which would leave the
     * first day behind as a figure. */
    '\\b\\d{1,2}(?:st|nd|rd|th)?\\s*(?:to|and|till|until|-|–)\\s*\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b',
    '\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b',
    '\\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\s+\\d{1,2}(?:st|nd|rd|th)?\\b',
    /* A real day and month, slashed ("10/10", "10/10/2026") or dashed with a
     * year ("10-10-2026"): never "5.5", "2-3" or "15/20", which are figures. */
    '\\b(?:0?[1-9]|[12]\\d|3[01])\\/(?:0?[1-9]|1[0-2])(?:\\/\\d{2,4})?\\b',
    '\\b(?:0?[1-9]|[12]\\d|3[01])-(?:0?[1-9]|1[0-2])-\\d{2,4}\\b',
    '\\b\\d{1,2}(?:st|nd|rd|th)\\b',
    /* "for 2 weeks", "over 7 days", "in three months" (Codex P2). */
    '\\b(?:for|in|over|during|within)\\s+(?:the\\s+)?(?:\\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\\s+(?:days?|weeks?|months?|years?)\\b',
    '\\b(?:last|past|next)\\s+(?:\\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\\s+(?:days?|weeks?|months?|years?)\\b',
  ].join('|'),
  'g',
);

function hasFigure(raw: string): boolean {
  const text = raw.replace(DATES, ' ');
  if (text.includes('₦') || NUMBER_WORDS.test(text)) return true;
  /* "paid half", "settled the rest": amounts RecordPayment reads as
   * relativeAmount (Codex P2), but only beside a payment, so "show the rest
   * of my sales" still asks (round 24). */
  if (
    /\b(?:half|remainder|the\s+rest)\b/.test(text) &&
    /\b(?:pa(?:y|ys|id|ying)|settl(?:e|es|ed)|receiv(?:e|es|ed)|collect(?:s|ed)?|clear(?:s|ed)?|balanced?)\b/.test(
      text,
    )
  ) {
    return true;
  }
  /* Digits glued to a letter ("q3") name something, not an amount. */
  for (const match of text.matchAll(/(?<![a-mo-z])\d[\d,.]*\s*(k|m|naira|ngn)?/g)) {
    /* Only a bare four-digit token: "2,026" and "20.26" are amounts. */
    const number = /^\d[\d,.]*/.exec(match[0])![0].replace(/[.,]$/, '');
    const isYear = /^(19|20)\d\d$/.test(number) && !match[1];
    if (!isYear) return true;
  }
  return false;
}

function startsWith(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((w, i) => words[i] === w);
}

/**
 * The privacy gateway's tokens (`CUSTOMER_7K2`, `PHONE_1`, `EMAIL_1`,
 * `ACCOUNT_1`): a name or a contact, never an amount. Read as the word
 * "customer", so the digits inside a token are never mistaken for money, and
 * a token that is the subject ("CUSTOMER_7K2 has paid") keeps its place
 * instead of letting the next word ("has") open a question.
 */
const VAULT_TOKEN = /\b(?:CUSTOMER|PHONE|EMAIL|ACCOUNT)_[A-Z0-9]+\b(?:['’]s)?/g;

/**
 * A phone or email token is someone's contact ("on PHONE_1", "report
 * EMAIL_1", "bcc EMAIL_1": a destination, rounds 25 and 27) unless it is
 * plainly the customer the question is about: the first word, before a
 * books word ("PHONE_1 balance", "PHONE_1 paid"), or after for/of/from/with
 * in a message that sends nothing ("invoices for PHONE_1").
 */
const CONTACT_TOKEN = /\b(PHONE|EMAIL)_[A-Z0-9]+\b((?:['’]s)?)/g;
const SUBJECT_AFTER =
  /^\s*(?:['’]s\b|balances?\b|statements?\b|invoices?\b|sales\b|payments?\b|owes?\b|owed\b|paid\b|pays?\b|bought\b|buys?\b|has\b|have\b|did\b|does\b|is\b|was\b|transactions?\b|debts?\b|account\b)/i;
const SENDS =
  /^\s*(?:(?:please|pls|kindly|can|could|will|would|you|abeg)\s+)*(?:send|give|get|forward|share|export|email|mail|text|whatsapp|tell|download|print)\b/i;

function contactToken(
  token: string,
  kind: string,
  possessive: string,
  at: number,
  whole: string,
): string {
  const before = whole.slice(0, at);
  const after = possessive ? "'s" + whole.slice(at + token.length) : whole.slice(at + token.length);
  /* "on PHONE_1 is fine": a destination first, whatever follows (round 28). */
  if (/\b(?:to|on|via|through|at|cc|bcc|email|mail|phone|number|whatsapp)\s*$/i.test(before)) {
    return ` customer ${kind === 'PHONE' ? 'phone' : 'email'} `;
  }
  const subject =
    before.trim() === '' ||
    SUBJECT_AFTER.test(after) ||
    (/\b(?:for|of|from|with)\s*$/i.test(before) && !SENDS.test(whole));
  if (subject) return ' customer ';
  return ` customer ${kind === 'PHONE' ? 'phone' : 'email'} `;
}

export function requestKind(raw: string): RequestKind {
  const text = raw
    .replace(CONTACT_TOKEN, contactToken)
    .replace(VAULT_TOKEN, ' customer ')
    /* "INV-2026-000004": a document, not an amount (Codex P2). */
    .replace(/\b[a-z]{2,5}-\d{4}-\d{3,}\b/gi, ' invoice ')
    /* P&L and P/L, before "&" or "/" separates anything. */
    .replace(/p\s*[&/]\s*l\b/gi, 'pnl')
    /* "vs." and "Mr." end no sentence. */
    .replace(/\b(mr|mrs|ms|dr|vs|etc|e\.g|i\.e)\./gi, '$1');

  /* The whole message first: "bought rice and beans 5k" is one record, even
   * though "and" would split it below. */
  if (clauseKind(text) === 'write') return 'write';

  /*
   * Then part by part. One WhatsApp message often says two things: "how
   * much did we sell today\nAda paid me", "who owes me? Ada paid me". A new
   * line, sentence punctuation, an emoji, a dash, a colon, "&", "+" or "/"
   * separates SEGMENTS, and each is judged whole. A message reads only when
   * every segment reads; one record makes it a record; anything else is
   * unknown. A segment that only greets or trails ("how are you", "thanks",
   * "this month") is left out, and one the grammar does not know makes the
   * whole message unknown, so a greeting missing from the lists costs a
   * rephrase prompt, never a model call.
   */
  const segments = text
    .split(
      /\n+|\r+|[!?…;。؟]\s*|\.(?!\d)\s*|\s*[-–—]\s+|\s+[-–—]\s*|:(?!\d)|[&+]|(?<!\d)\/|\/(?!\d)|\p{Extended_Pictographic}/u,
    )
    .filter((part) => part.trim().length > 0);
  const kinds = segments.map(segmentKind).filter((kind) => kind !== 'neutral');
  if (kinds.length === 0) return 'unknown';
  if (kinds.includes('write')) return 'write';
  return kinds.every((kind) => kind === 'read') ? 'read' : 'unknown';
}

/**
 * One segment, judged whole: "how much did we sell and spend this month"
 * is one question, and splitting at "and" would lose its frame. Commas and
 * "and" can only make a reading segment unknown, never a write: a later
 * part that states something of its own ("who owes me and Ada paid me",
 * "how much did we sell, I sold rice to Ada") is not part of the question.
 */
function segmentKind(segment: string): RequestKind | 'neutral' {
  let body = segment;
  let whole = clauseKind(segment);
  /* "Good morning, who owes me?", "sales today, thanks": a greeting,
   * courtesy or period set off by a comma is dropped, and what is left is
   * judged. A neutral part holds no name and no money word, so dropping it
   * hides nothing. */
  if (whole === 'unknown') {
    const parts = segment.split(/(?<!\d),|,(?!\d)/);
    while (parts.length > 1 && clauseKind(parts[0]!) === 'neutral') parts.shift();
    while (parts.length > 1 && clauseKind(parts[parts.length - 1]!) === 'neutral') parts.pop();
    const rest = parts.join(',');
    if (rest !== segment && clauseKind(rest) === 'read') {
      body = rest;
      whole = 'read';
    }
  }
  if (whole !== 'read') return whole;
  /* A comparison is a filter, already judged with its figure: taken out
   * first, so "more than one hundred and fifty thousand" is not split. */
  const later: [string, boolean][] = [];
  body
    .replace(COMPARISON_FILTER, ' ')
    .split(/(?<!\d),|,(?!\d)/)
    .forEach((clause, c) =>
      clause.split(/\s+(?:and|but|then|also|plus)\s+/i).forEach((part, a) => {
        /* The first part of each comma clause stands after a comma; the
         * rest continue a list ("fuel and diesel"). */
        if ((c > 0 || a > 0) && part.trim().length > 0) later.push([part, a === 0]);
      }),
    );
  return later.some(([part, afterComma]) => saysSomethingOfItsOwn(part, afterComma))
    ? 'unknown'
    : 'read';
}

/** Someone doing something: the mark of a statement, not a question's tail. */
const SUBJECTS = new Set(['customer', 'he', 'she', 'they', 'i', 'we']);

/** "by customer", "per customer": a breakdown, not a subject. */
const BREAKDOWN_WORDS = new Set(['by', 'per', 'each', 'every', 'which']);

/**
 * A later part of a question that is a statement in its own right: a
 * figure, a change, an instruction, a subject doing trade ("Ada paid me"),
 * or a bare name given as an answer ("…, CUSTOMER_7K2"). "spend this month"
 * (trade first, no subject) and "customer owe" continue the question.
 */
function saysSomethingOfItsOwn(part: string, afterComma: boolean): boolean {
  const lower = part.toLowerCase();
  const words = (lower.match(/[\p{L}\p{N}']+/gu) ?? []).map((w) => w.replace(/'s$/, ''));
  if (words.length === 0) return false;
  if (hasFigure(lower)) return true;
  if (words.some((w) => CHANGE_VERBS.has(w) || RECORD_INSTRUCTIONS.has(w))) return true;
  /* A question of its own ("…, how much do I have to collect?") is still a
   * question. */
  const kind = clauseKind(part);
  if (kind === 'read' || kind === 'neutral') return false;
  /* A name the vault has not met yet stays plain text: "…, Ada sent money",
   * "which customer paid today, Ada" (Codex P2). A capitalised word the
   * grammar does not know is taken as one. */
  if (
    (part.match(/[\p{L}\p{N}']+/gu) ?? []).some(
      (w) => /^\p{Lu}/u.test(w) && !knownWord(w.toLowerCase().replace(/'s$/, '')),
    )
  ) {
    return true;
  }
  /* The same in lower case, as WhatsApp is usually typed: an unknown first
   * word with an unknown word after it ("ada sent money", "bola
   * transferred"), or alone ("…, ada"). "transport this month" continues
   * the question (Codex P2). */
  const [first, second] = words;
  if (first !== undefined && !knownWord(first)) {
    /* Alone only after a comma ("…, ada"): "fuel and diesel" is a list. */
    if (second === undefined ? afterComma : !booksWord(second) && !knownWord(second)) return true;
  }
  if (words.slice(1).some((w) => TRADE_VERBS.has(w))) return true;
  /* A subject of its own: "CUSTOMER_7K2 sent money", "yes she did",
   * "rice to CUSTOMER_7K2" (not "by customer"). */
  if (words.some((w, i) => SUBJECTS.has(w) && !BREAKDOWN_WORDS.has(words[i - 1] ?? ''))) {
    return true;
  }
  /* Trade with an object: "sold rice to…", "bought fuel today". "spend
   * this month" continues the question. */
  if (TRADE_VERBS.has(words[0]!) && words[1] !== undefined && !booksWord(words[1])) return true;
  return words.every((w) => w === 'customer' || NEUTRAL_FUNCTION.has(w));
}

/** Any word this grammar has a meaning for. */
function knownWord(w: string): boolean {
  return (
    booksWord(w) ||
    NEUTRAL_WORDS.has(w) ||
    NEUTRAL_FUNCTION.has(w) ||
    OPENING_FILLERS.has(w) ||
    QUESTION_OPENERS.has(w) ||
    QUESTION_FRAMES.has(w) ||
    TRADE_VERBS.has(w) ||
    CHANGE_VERBS.has(w) ||
    RECORD_INSTRUCTIONS.has(w) ||
    SUBJECTS.has(w) ||
    AUXILIARIES.has(w) ||
    COMPARISONS.has(w) ||
    READ_VERBS.has(w) ||
    OTHER_KNOWN.has(w)
  );
}

/**
 * A comparison that governs a figure: "more than 50k", "over 5k", "50k and
 * above". "paid 20k over transfer" is no filter.
 */
const COMPARISON_FILTER = new RegExp(
  [
    /* "more than 50k", "over ₦5,000", "above N20,000", "at least #10k" */
    String.raw`\b(?:(?:more|less|greater|bigger|higher|lower|fewer)\s+than|over|above|under|below|exceeding|at\s+(?:least|most))\s+(?:(?:[₦#]|n(?=\d))\s*)?\d[\d,.]*(?:\s*(?:k|m|thousand|million|naira)\b){0,2}`,
    /* "more than fifty thousand", "over five hundred naira" */
    String.raw`\b(?:(?:more|less|greater|bigger|higher|lower|fewer)\s+than|over|above|under|below|exceeding|at\s+(?:least|most))\s+(?:(?:a|an|and|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)\s+){0,6}(?:hundred|thousand|million|billion)(?:\s+naira)?\b`,
    /* "more than fifty", "over twenty five" (Codex P2) */
    String.raw`\b(?:(?:more|less|greater|bigger|higher|lower|fewer)\s+than|over|above|under|below|exceeding|at\s+(?:least|most))\s+(?:(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s*){1,3}\b`,
    /* "between 20k and 50k", "from 20k to 50k" (Codex P2) */
    String.raw`\b(?:between|from)\s+(?:(?:[₦#]|n(?=\d))\s*)?\d[\d,.]*(?:\s*(?:k|m|thousand|million|naira)\b)?\s*(?:and|to|-|–)\s*(?:(?:[₦#]|n(?=\d))\s*)?\d[\d,.]*(?:\s*(?:k|m|thousand|million|naira)\b){0,2}`,
    /* "between twenty thousand and fifty thousand" (Codex P2) */
    String.raw`\b(?:between|from)\s+(?:(?:(?:[₦#]|n(?=\d))\s*)?\d[\d,.]*(?:\s*(?:k|m|thousand|million|naira)\b){0,2}|(?:(?:a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\s+){0,4}(?:hundred|thousand|million|billion|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:\s+naira)?\b)\s*(?:and|to|-|–)\s*(?:(?:(?:[₦#]|n(?=\d))\s*)?\d[\d,.]*(?:\s*(?:k|m|thousand|million|naira)\b){0,2}|(?:(?:a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\s+){0,4}(?:hundred|thousand|million|billion|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:\s+naira)?\b)`,
    /* "50k and above", "20,000 or less" */
    String.raw`(?:[₦#]\s*)?\d[\d,.]*\s*(?:k|m)?\s+(?:and|or)\s+(?:above|more|over|below|less|under)\b`,
  ].join('|'),
  'g',
);

/**
 * Is a figure left once every compared figure is taken out? "who owes me
 * more than 50k" leaves none; "did Ada pay 20k over 2 transfers" leaves
 * the 20k, which is still an amount (Codex P2).
 */
function figureBeyondFilters(text: string): boolean {
  return hasFigure(text.replace(COMPARISON_FILTER, ' '));
}

/** Records that can be listed: the plural forms. */
const LISTED_RECORDS = new Set([
  'transactions',
  'sales',
  'payments',
  'invoices',
  'expenses',
  'purchases',
  'orders',
]);

/** Words that join a list to its period: "for the last month so far". */
const PERIOD_JOINERS = new Set([
  'this',
  'last',
  'past',
  'for',
  'in',
  'of',
  'so',
  'far',
  'to',
  'date',
  'all',
]);

/** Ordinary words a trailing part may hold that are not names. */
const OTHER_KNOWN = new Set([
  'asap',
  'quickly',
  'anyone',
  'names',
  'exactly',
  'roughly',
  'sha',
  'abi',
  'o',
  'joor',
  'nna',
  'ehen',
  'pdf',
  'excel',
  'csv',
  'oga',
  'bro',
  'god',
  'bless',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);

/**
 * "get/have the invoice cancelled": get or have, then an object of its own,
 * then the participle closing the phrase. Not "have been", "have I", "have
 * any", "get reversed", or "the list of cancelled invoices", where the
 * participle describes the records that follow it.
 */
function causative(words: readonly string[], i: number): boolean {
  if (LISTED_RECORDS.has(words[i + 1] ?? '')) return false;
  /* From the first word: "have the invoice cancelled" is an instruction. */
  for (let j = 0; j < i - 1; j += 1) {
    if (words[j] !== 'get' && words[j] !== 'have') continue;
    const between = words.slice(j + 1, i);
    /* "have any invoices been (fully) cancelled": a perfect passive, a
     * question, adverbs and "or voided" allowed between (Codex P2). */
    if (perfectPassive(words, i)) continue;
    const next = between[0]!;
    if (!NOT_AN_OBJECT.has(next)) return true;
    /* A quantifier is the object unless the participle follows it straight
     * away: "have any cancelled invoices" asks, "get all the invoices
     * cancelled" requests the change. */
    if (QUANTIFIERS.has(next) && between.length > 1) return true;
  }
  return false;
}

/** "been", then only adverbs or other participles, then the participle. */
function perfectPassive(words: readonly string[], i: number): boolean {
  for (let k = i - 1; k >= 0; k -= 1) {
    const w = words[k]!;
    if (w === 'been') return true;
    if (!PASSIVE_FILLERS.has(w) && !CHANGE_PARTICIPLES.has(w)) return false;
  }
  return false;
}

const PASSIVE_FILLERS = new Set([
  'fully',
  'partially',
  'partly',
  'already',
  'just',
  'recently',
  'really',
  'properly',
  'completely',
  'ever',
  'not',
  'all',
  'or',
  'and',
]);

/**
 * "didn't", "hasn't", "don't" (and "didnt"): the auxiliary they negate, so
 * "didn't CUSTOMER_7K2 pay?" opens a question as "did" does (Codex P2).
 */
function uncontract(w: string): string {
  if (w === "can't" || w === 'cant') return 'can';
  if (w === "won't" || w === 'wont') return 'will';
  const m = /^(did|has|have|do|does|is|are|was|were|could|would|should)n'?t$/.exec(w);
  return m ? m[1]! : w;
}

/** What a report of the books is called. */
/** Instructions that make a document rather than record a fact. */
const MAKING_VERBS = new Set(['create', 'issue', 'raise']);

/** Words that send something INTO a report: "add sale to ledger". */
const DESTINATIONS = new Set(['to', 'in', 'into', 'onto']);

const REPORT_NOUNS = new Set([
  'sheet',
  'report',
  'reports',
  'statement',
  'statements',
  'pnl',
  'summary',
  'ledger',
  'cashflow',
]);

/** Quantifiers, which may stand before an object or before a participle. */
const QUANTIFIERS = new Set(['any', 'some', 'all', 'no']);

/** What follows "have"/"get" when it is not causative. */
const NOT_AN_OBJECT = new Set(['been', 'i', 'we', 'they', 'you', 'any', 'some', 'all', 'no']);

/** Comparisons that make a figure a filter: "more than 50k". */
const COMPARISONS = new Set([
  'more',
  'less',
  'over',
  'under',
  'above',
  'below',
  'than',
  'least',
  'most',
  'exceeding',
  'greater',
  'bigger',
  'higher',
  'lower',
]);

/** Verbs that only ask to see: "can you show me…". */
const READ_VERBS = new Set([
  'show',
  'list',
  'check',
  'export',
  'send',
  'give',
  'tell',
  'download',
  'print',
]);

/** Verbs that only ever send to someone: "can I whatsapp the invoice…". */
const SEND_ONLY_VERBS = new Set(['whatsapp', 'email', 'mail', 'forward', 'share', 'text', 'sms']);

/** Change verbs in the past participle, which can describe records. */
const CHANGE_PARTICIPLES = new Set([
  'cleared',
  'settled',
  'cancelled',
  'canceled',
  'deleted',
  'removed',
  'reversed',
  'voided',
  'refunded',
  'updated',
  'changed',
  'corrected',
  'adjusted',
  'reduced',
  'increased',
  'marked',
  'reconciled',
  'returned',
]);

/** A word a books question is made of. */
function booksWord(w: string): boolean {
  return (
    BOOK_TOPICS.has(w) ||
    RECORD_NOUNS.has(w) ||
    PERIODS.has(w) ||
    SUMMARY_WORDS.has(w) ||
    JOINING_WORDS.has(w) ||
    isYear(w)
  );
}

/** Function words a trailing fragment may hold; never a name or money word. */
const NEUTRAL_FUNCTION = new Set([
  'and',
  'so',
  'me',
  'i',
  'you',
  'the',
  'this',
  'that',
  'last',
  'of',
  'it',
  'all',
  'my',
  'our',
  'for',
  'please',
  'abeg',
]);

/** Words a greeting, a courtesy or a trailing fragment is made of. */
const NEUTRAL_WORDS = new Set([
  'how',
  'far',
  'good',
  'morning',
  'afternoon',
  'evening',
  'are',
  'you',
  'dey',
  'body',
  'na',
  'what',
  'whats',
  'up',
  'wetin',
  'happen',
  'is',
  'it',
  'going',
  'hope',
  'well',
  'thanks',
  'thank',
  'ok',
  'okay',
  'una',
  'much',
  'many',
  'about',
]);

/** Greetings that open like a question ("how", "what", "wetin"). */
const GREETING_PREFIXES: readonly (readonly string[])[] = [
  /* "good morning how much did we sell" (final review C). */
  ['good', 'morning'],
  ['good', 'afternoon'],
  ['good', 'evening'],
  ['good', 'day'],
  ['morning'],
  ['afternoon'],
  ['evening'],
  ['wetin', 'dey', 'happen'],
  ['how', 'are', 'you'],
  ['how', 'you', 'dey'],
  ['how', 'is', 'it', 'going'],
  ['how', 'it', 'going'],
  ['how', 'body'],
  ['how', 'far'],
  ['how', 'na'],
  ['what', 'up'],
  ['whats', 'up'],
];

/** A question that asks about trade asks with one of these. */
const QUESTION_FRAMES = new Set([
  'much',
  'many',
  'who',
  'whom',
  'whose',
  'what',
  'which',
  'wetin',
  'did',
  'does',
  'do',
  'has',
  'have',
  'any',
  'total',
  'list',
  'show',
  'when',
]);

/** "has paid", "did sold": an auxiliary straight onto trade has no subject. */
const AUXILIARIES = new Set(['has', 'have', 'is', 'was', 'were', 'did', 'does', 'do']);

function clauseKind(raw: string): RequestKind | 'neutral' {
  const text = raw.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  const all = (
    text
      .replace(/p&l/g, 'pnl')
      .replace(/cash flow/g, 'cashflow')
      .replace(/\bi'd\b/g, 'i would')
      /* "trial balance": a report the product names (final review C). */
      .replace(/trial balance/g, 'balance')
      .match(/[\p{L}\p{N}']+/gu) ?? []
  )
    .map((w) => uncontract(w.replace(/'s$/, '')))
    .filter((w) => w.length > 0);
  /* Only greetings, courtesies and periods: never a name ("customer") or
   * a money word, which could be the point of the message. */
  if (
    all.every(
      (w) =>
        OPENING_FILLERS.has(w) || NEUTRAL_WORDS.has(w) || NEUTRAL_FUNCTION.has(w) || PERIODS.has(w),
    )
  ) {
    return 'neutral';
  }
  let start = 0;
  for (;;) {
    if (start < all.length - 1 && OPENING_FILLERS.has(all[start]!)) {
      start += 1;
      continue;
    }
    /* "how far", "how are you", "wetin dey happen": greetings, not
     * questions, even run straight into what follows. */
    const greeting = GREETING_PREFIXES.find(
      (prefix) => start + prefix.length < all.length && startsWith(all.slice(start), prefix),
    );
    if (!greeting) break;
    start += greeting.length;
  }
  const words = all.slice(start);
  /* "sales for today please", "P&L pls", "CUSTOMER_7K2 balance abeg": a
   * courtesy or particle at the end, as the router strips (final review C). */
  while (words.length > 1 && TRAILING_FILLERS.has(words[words.length - 1]!)) words.pop();
  /* "i want to see…", "let me see…", "make i see…", "i need the P&L": a
   * request to see the books, read as "show" (final review C). */
  /* Not "i want the sale reversed": a change asked for, not a sight. */
  const asksAChange = words.some(
    (w, i) =>
      CHANGE_PARTICIPLES.has(w) &&
      i > 0 &&
      !['the', 'my', 'our', 'all', 'any', 'see', 'know', 'want', 'need'].includes(words[i - 1]!),
  );
  for (const prefix of SEEING_PREFIXES) {
    if (!asksAChange && words.length > prefix.length && startsWith(words, prefix)) {
      words.splice(0, prefix.length, 'show');
      break;
    }
  }
  /* "i want to check / download / export…": that verb, asked politely. */
  for (const prefix of [
    ['i', 'want', 'to'],
    ['i', 'need', 'to'],
    ['i', 'would', 'like', 'to'],
  ]) {
    const verb = words[prefix.length] ?? '';
    if (startsWith(words, prefix) && ['check', 'download', 'export', 'print'].includes(verb)) {
      words.splice(0, prefix.length);
      break;
    }
  }
  /* "update me on sales", "add up my expenses": a summary asked for, not
   * a change (final review C). */
  if (words[0] === 'update' && (words[1] === 'me' || words[1] === 'us' || words[1] === 'on')) {
    words.splice(0, words[1] === 'on' ? 2 : words[2] === 'on' ? 3 : 2, 'show');
  } else if (
    words[0] === 'add' &&
    words[1] === 'up' &&
    words.length > 2 &&
    !words.some((w) => RECORD_NOUNS.has(w) && !LISTED_RECORDS.has(w))
  ) {
    words.splice(0, 2, 'total');
  }
  const wanting = WANTING_PREFIXES.find((prefix) => startsWith(words, prefix));
  if (
    wanting &&
    !asksAChange &&
    words.length > wanting.length &&
    words[wanting.length] !== 'to' &&
    words
      .slice(wanting.length)
      .every(
        (w) =>
          w === 'list' ||
          (onlyBooksWords([w]) && !TRADE_VERBS.has(w) && !CHANGE_PARTICIPLES.has(w)),
      )
  ) {
    words.splice(0, wanting.length, 'show');
  }
  /* "record of sales", "log of payments": the records, not an instruction
   * to make one (Codex P2). Read as "report". */
  if (['record', 'records', 'log'].includes(words[0] ?? '') && words[1] === 'of') {
    words.splice(0, 2, 'report');
    if (words.length === 1) return 'read';
  }

  /* An instruction to record, plain or softened, is a write even when it
   * ends in a question mark: "can you add a 5k sale?" asks for a record. */
  /* "create a sales report", "issue a statement": making a report of the
   * books is a read, not a record (Codex P2). "issue an invoice" is not. */
  /* Only a verb that MAKES something (create, issue, raise), with the
   * report as its object: "add sale to ledger", "record sales summary" and
   * "record sale in ledger" are records (Codex P2). */
  const reports = (verb: number) => {
    if (!MAKING_VERBS.has(words[verb] ?? '')) return false;
    const object = words.slice(verb + 1);
    const at = object.findIndex((w) => REPORT_NOUNS.has(w));
    return (
      at >= 0 &&
      !object.slice(0, at).some((w) => DESTINATIONS.has(w)) &&
      /* "create sale report", "create a sheet for invoice" name one record;
       * "sales report" names the list. */
      !object.some((w) => RECORD_NOUNS.has(w) && !LISTED_RECORDS.has(w)) &&
      !hasFigure(text) &&
      onlyBooksWords(object)
    );
  };
  if (RECORD_INSTRUCTIONS.has(words[0]!)) return reports(0) ? 'read' : 'write';
  for (const opener of ASKING_OPENERS) {
    if (startsWith(words, opener) && RECORD_INSTRUCTIONS.has(words[opener.length] ?? '')) {
      return reports(opener.length) ? 'read' : 'write';
    }
  }

  /* A change to what is already recorded ("clear Ada's debt", "reverse the
   * last sale") is a write when it is the instruction, and otherwise could
   * be one ("Ada settled her balance", "how do I delete a sale?"). */
  /* "refunded payments this month", "how many invoices were cancelled?":
   * a past participle describing records, not an instruction to change
   * them (Codex P2). The bare instruction ("refund", "cancel") stays one. */
  /* Only before plural records and a period: "cancelled invoices last
   * month" describes; "cancelled the invoice", "cleared CUSTOMER_7K2 debt"
   * is dropped-subject shorthand for a change, and stays one. */
  if (
    words.length > 1 &&
    CHANGE_PARTICIPLES.has(words[0]!) &&
    !hasFigure(text) &&
    words.slice(1).some((w) => LISTED_RECORDS.has(w)) &&
    words.slice(1).every((w) => LISTED_RECORDS.has(w) || PERIODS.has(w) || PERIOD_JOINERS.has(w))
  ) {
    return 'read';
  }
  if (CHANGE_VERBS.has(words[0]!)) return 'write';
  /* Inside a question a participle describes only after a subject of its
   * own ("how many invoices were cancelled", "has CUSTOMER_7K2 settled"),
   * never straight after the opening auxiliary ("have cleared the debt"). */
  const asks = opensAQuestion(words);
  /* The evidence must be a real subject, a record or a read verb, so "have
   * now settled the balance" is a change (Codex P2). "can I get the invoice
   * cancelled" is causative, a request for the change; "which invoices have
   * been cancelled", "do I have any cancelled invoices" and "did the sale get
   * reversed" are questions about what happened. */
  const describes = (i: number) =>
    asks &&
    CHANGE_PARTICIPLES.has(words[i]!) &&
    !causative(words, i) &&
    words
      .slice(0, i)
      .some(
        (w) =>
          READ_VERBS.has(w) ||
          SUBJECTS.has(w) ||
          RECORD_NOUNS.has(w) ||
          LISTED_RECORDS.has(w) ||
          BOOK_TOPICS.has(w),
      );
  if (words.some((w, i) => CHANGE_VERBS.has(w) && !describes(i))) return 'unknown';
  /* "have an invoice made for Ada", "can we have the payment made": a
   * request for a record, as "get … made" is (round 25). */
  if (words.some((w, i) => w === 'made' && causative(words, i))) return 'unknown';

  const figure = hasFigure(text);
  const trade = words.some((w) => TRADE_VERBS.has(w));
  const topic = words.some((w) => BOOK_TOPICS.has(w));
  const recordNoun = words.some((w) => RECORD_NOUNS.has(w));
  const summary = words.some((w) => SUMMARY_WORDS.has(w));
  const period = words.some((w) => PERIODS.has(w) || isYear(w));

  /* "has paid me" with no one between: the subject was dropped ("boss has
   * paid me" once "boss" is read as politeness), so it is no question. */
  if (AUXILIARIES.has(words[0]!) && TRADE_VERBS.has(words[1] ?? '')) return 'unknown';

  /* A question, by its opening words, about the books reads: "how much did
   * we sell?", "who paid me this month?", "can I see sales?". One that also
   * carries a figure ("did Ada pay 20k?") may be a record asked as a
   * question; one about trade without a question frame ("how are you Ada
   * don pay") is a greeting before a record; one about nothing on the books
   * ("what is this?") is not a books question: all stay unknown. A question
   * mark alone does not make a question: "sold rice to Ada?" is held to the
   * statement rules below. */
  if (opensAQuestion(words)) {
    /* "list sales and add rice sale" asks for a record halfway through. */
    if (words.some((w) => RECORD_INSTRUCTIONS.has(w))) return 'unknown';
    /* "who owes me more than 50k": a filter, not an amount (Codex P2). */
    if (figure && figureBeyondFilters(text) && (trade || recordNoun || topic)) return 'unknown';
    /* "who owes me CUSTOMER_7K2 paid": a statement run on (final review A). */
    if (statesTrade(words)) return 'unknown';
    if (trade) return words.some((w) => QUESTION_FRAMES.has(w)) ? 'read' : 'unknown';
    return topic || recordNoun ? 'read' : 'unknown';
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
  /* "my sales", "all my transactions", "sales list": the list, with only a
   * determiner beside it (final review C). */
  const listed = words.filter((w) => !['my', 'our', 'the', 'all', 'list'].includes(w));
  if (!figure && listed.length === 1 && BARE_LISTS.has(listed[0]!)) return 'read';
  if (figure || !onlyBooksWords(words)) return 'unknown';
  /* "CUSTOMER_7K2 owes me", "she owed me": someone stating a debt, which
   * may be a credit sale to record, not a question about one (Codex P2).
   * "how much do Ada and Chidi owe" asks, and is a question above. */
  if (words.some((w) => SUBJECTS.has(w)) && words.some((w) => w === 'owes' || w === 'owed')) {
    return 'unknown';
  }
  if (topic) return 'read';
  if (recordNoun && (period || summary)) return 'read';
  /* "invoices for CUSTOMER_7K2", "CUSTOMER_7K2 payments": one customer's
   * records, plural (final review C). */
  if (words.includes('customer') && words.some((w) => LISTED_RECORDS.has(w))) return 'read';
  /* "sales", "expenses" alone: the list, not one record. */
  if (words.length === 1 && BARE_LISTS.has(words[0]!)) return 'read';
  return 'unknown';
}

/**
 * Does a question run on into someone doing trade, with no comma or "and"
 * between? "who owes me CUSTOMER_7K2 paid", "show sales today ada paid me",
 * "how much did we spend today we paid rent" state a payment after asking
 * (final review A). The subject stays inside the question when a question
 * word, an auxiliary or a determiner leads it: "did CUSTOMER_7K2 pay",
 * "which customer paid", "how much we sell", "what the customer bought".
 */
function statesTrade(words: readonly string[]): boolean {
  for (let i = 2; i < words.length; i += 1) {
    if (!TRADE_VERBS.has(words[i]!) && !CHANGE_PARTICIPLES.has(words[i]!)) continue;
    let s = i - 1;
    /* Auxiliaries, "been", "get", adverbs ("fully") and other participles
     * ("cancelled or voided") stand between a subject and its verb. */
    while (
      s > 0 &&
      (SUBJECT_LINKS.has(words[s]!) ||
        CHANGE_PARTICIPLES.has(words[s]!) ||
        words[s] === 'or' ||
        /^[a-z]{3,}ly$/.test(words[s]!))
    ) {
      s -= 1;
    }
    if (s === 0) continue;
    const subject = words[s]!;
    /* A name or a token; "products sold today" is no one. */
    const person =
      SUBJECTS.has(subject) ||
      (!knownWord(subject) && !(subject.length > 3 && subject.endsWith('s')));
    if (!person) continue;
    /* "what did Mr. CUSTOMER_7K2 pay": a title belongs to the name. */
    let t = s;
    while (t > 0 && TITLES.has(words[t - 1]!)) t -= 1;
    if (t === 0) continue;
    const lead = words[t - 1]!;
    /* "show CUSTOMER_7K2 paid", "let me see Ada pay": a viewing verb does
     * not ask about the subject after it. */
    if (VIEWING_LEADS.has(lead)) return true;
    if (
      AUXILIARIES.has(lead) ||
      QUESTION_FRAMES.has(lead) ||
      /* "show CUSTOMER_7K2 paid", "let me see Ada pay": no question word
       * leads the subject. */
      (QUESTION_OPENERS.has(lead) && lead !== 'show' && lead !== 'list') ||
      SUBJECT_LEADS.has(lead) ||
      /* "expenses we paid", "everything I sold": the merchant's own trade
       * describing the records asked for. */
      ((subject === 'we' || subject === 'i') &&
        (LISTED_RECORDS.has(lead) || RECORD_NOUNS.has(lead) || lead === 'everything'))
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/** Between a subject and its trade verb: "CUSTOMER_7K2 has paid", "don pay". */
const SUBJECT_LINKS = new Set([
  'has',
  'have',
  'had',
  'did',
  'does',
  'do',
  'is',
  'was',
  'were',
  'don',
  'dey',
  'just',
  'already',
  'not',
  'never',
  'also',
  'been',
  'being',
  'get',
  'got',
  'gotten',
]);

/** Verbs that show the books, never ask about who follows them. */
const VIEWING_LEADS = new Set(['show', 'list', 'check', 'see', 'know']);

/** Titles before a name: "Mr. CUSTOMER_7K2", "Mama Chidi". */
const TITLES = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'madam',
  'mama',
  'papa',
  'oga',
  'aunty',
  'auntie',
  'uncle',
  'chief',
  'alhaji',
  'alhaja',
  'mummy',
  'daddy',
]);

/** What keeps a subject inside the question: "the customer", "if she paid". */
const SUBJECT_LEADS = new Set([
  'the',
  'my',
  'our',
  'each',
  'every',
  'all',
  'and',
  'or',
  'if',
  'whether',
  'that',
  'much',
  'many',
  'how',
  'can',
  'could',
  'will',
  'would',
  'should',
  'may',
]);

const BARE_LISTS = new Set([
  'sales',
  'expenses',
  'purchases',
  'payments',
  'invoices',
  'transactions',
]);

/** A question by its opening, not by a trailing question mark. */
function opensAQuestion(words: readonly string[]): boolean {
  const first = words[0]!;
  /* In Nigerian English "do invoice for Ada" means make one. */
  /* "do CUSTOMER_7K2 invoice" makes one too: a question needs a books
   * topic, "have" or trade after it ("do we owe suppliers", "do i have any
   * sale today") (final review A). */
  if (first === 'do') {
    return (
      ['i', 'we', 'you', 'they', 'customer', 'any'].includes(words[1] ?? '') &&
      words
        .slice(2)
        .some((w) => BOOK_TOPICS.has(w) || TRADE_VERBS.has(w) || w === 'have' || w === 'has')
    );
  }
  /* "show CUSTOMER_7K2 her balance" shows the books to someone else, as
   * the "can you show…" form does (round-22 review). */
  if (first === 'show' || first === 'list' || first === 'check') return forTheMerchant(words, 0);
  if (QUESTION_OPENERS.has(first)) return true;
  /* "can I see…", "could we get…"; "can you…" only before a read verb
   * ("can you show me sales?"), never before work ("can you reverse…"). */
  /* "would you show me sales", "will you send me the report" (final review C). */
  if ((first === 'will' || first === 'would') && words[1] === 'you') {
    let k = 2;
    while (OPENING_FILLERS.has(words[k] ?? '')) k += 1;
    return READ_VERBS.has(words[k] ?? '') && forTheMerchant(words, k);
  }
  if (first === 'can' || first === 'could') {
    if (words[1] === 'i' || words[1] === 'we') {
      /* "can I send the invoice to CUSTOMER_7K2", "can I show Ada her
       * balance": the same recipient check as the plain forms (final
       * review D). "can I see…", "can I get…" stay questions. */
      let k = 2;
      while (OPENING_FILLERS.has(words[k] ?? '')) k += 1;
      if (SEND_ONLY_VERBS.has(words[k] ?? '')) return false;
      if (READ_VERBS.has(words[k] ?? '')) return forTheMerchant(words, k);
      return true;
    }
    if (words[1] === 'you') {
      /* "can you please show me…", "could you kindly list…" (Codex P2). */
      let k = 2;
      while (OPENING_FILLERS.has(words[k] ?? '')) k += 1;
      if (READ_VERBS.has(words[k] ?? '')) return forTheMerchant(words, k);
    }
  }
  /* "tell me what I sold", never "tell CUSTOMER_7K2 she owes me" (Codex P2). */
  if (first === 'tell') return words[1] === 'me' || words[1] === 'us';
  /* "export sales to Excel", "download the sales report" (Codex P2). */
  if (first === 'export' || first === 'download' || first === 'print') {
    return forTheMerchant(words, 0);
  }
  /* "send me the P&L", "give me sales today", "send my records for March". */
  if (first === 'send' && reportOnly(words.slice(1))) return forTheMerchant(words, 0);
  return (
    (first === 'send' || first === 'give' || first === 'get') &&
    (words[1] === 'me' || words[1] === 'us' || words[1] === 'my' || words[1] === 'our') &&
    forTheMerchant(words, 0)
  );
}

/**
 * Is a read verb's output for the person asking? "show me my sales", "send
 * me the P&L", "show sales to CUSTOMER_7K2" (a filter) are; "send my
 * invoice to my customer", "send her the invoice", "show CUSTOMER_7K2 her
 * balance", "export sales to the accountant" send the books to someone
 * else, which is not a question about them (rounds 20 to 22). Three roles:
 *
 *  - sending (send, give, get, tell): the asker must be named, after the
 *    verb or as "to me/us", and any "to" must name the asker, a format or
 *    channel ("to my email", "to Excel") or a period;
 *  - delivering (export, download, print): "to" a person is a send;
 *  - viewing (show, list): "to" a person is a send unless it filters the
 *    records or trade before it ("sales to CUSTOMER_7K2").
 *
 * An indirect object is a send in every role: "him/them", a customer or
 * "her" before a determiner, or "my/our/the" + a person-like noun + a
 * determiner ("send my accountant the P&L").
 */
function forTheMerchant(words: readonly string[], verb: number): boolean {
  const v = words[verb]!;
  const at = (k: number) => words[verb + k] ?? '';
  const sending = v === 'send' || v === 'give' || v === 'get' || v === 'tell';
  const viewing = v === 'show' || v === 'list' || v === 'check';

  const toTargets: { at: number; person: boolean; counterparty: boolean; channel: boolean }[] = [];
  for (let i = verb + 1; i < words.length; i += 1) {
    if (words[i] !== 'to') continue;
    let t = words[i + 1] ?? '';
    if (t === 'my' || t === 'our' || t === 'the') t = words[i + 2] ?? '';
    const channel =
      ASKERS_DIRECT.has(words[i + 1] ?? '') ||
      CHANNELS.has(t) ||
      PERIODS.has(t) ||
      RANGE_WORDS.has(t) ||
      /^\d/.test(t);
    toTargets.push({ at: i, person: PEOPLE.has(t), counterparty: COUNTERPARTIES.has(t), channel });
  }

  /* Sending names the asker: "send me…", "send my…", "send it to me". */
  if (sending) {
    const named =
      ASKERS.has(at(1)) || toTargets.some((t) => ASKERS_DIRECT.has(words[t.at + 1] ?? ''));
    /* "send the report", "send the P&L for September": a report with no
     * recipient is only ever for the asker (final review C). Never "send
     * the invoice" or "send the statement", which go to customers. */
    if (!named && !(v === 'send' && toTargets.length === 0 && reportOnly(words.slice(verb + 1)))) {
      return false;
    }
    if ((at(1) === 'my' || at(1) === 'our') && PEOPLE.has(at(2))) return false;
  }

  /* "on customer WhatsApp", "to Ada's email": someone else's channel
   * (round 24). */
  /* "the WhatsApp of Ada", "Ada number" (round 25). */
  for (let j = verb + 1; j < words.length; j += 1) {
    if (!CHANNELS.has(words[j]!) || words[j] === 'date') continue;
    /* "number of sales" counts; "the WhatsApp of Ada" belongs to Ada. */
    if (words[j] === 'number' && words[j + 1] === 'of') continue;
    /* "product line", "line by line": no channel (round 27). */
    const lineByLine =
      (words[j + 1] === 'by' && words[j + 2] === 'line') ||
      (words[j - 1] === 'by' && (words[j - 2] === 'line' || words[j + 1] === undefined));
    if (words[j] === 'line' && (words[j - 1] === 'product' || lineByLine)) continue;
    /* "a pdf of my sales" is a format; "the WhatsApp of Ada" is Ada's. */
    if (words[j + 1] === 'of' && !FORMAT_CHANNELS.has(words[j]!)) return false;
    const owner = words[j - 1] ?? '';
    const mine = words[j - 2] === 'my' || words[j - 2] === 'our';
    /* "the number I gave you", "another WhatsApp": someone else's unless
     * it is "my number", "my other phone", "the shop line" (rounds 26, 27). */
    if (
      (words[j] === 'number' || words[j] === 'line') &&
      owner !== 'my' &&
      owner !== 'our' &&
      !(SOME_OTHER.has(owner) && mine) &&
      !(OWN_CONTACT_WORDS.has(owner) && OWN_CONTACT_LEADS.has(words[j - 2] ?? ''))
    ) {
      return false;
    }
    if (SOME_OTHER.has(owner) && !mine) return false;
    const name =
      !knownWord(owner) &&
      !RANGE_WORDS.has(owner) &&
      !OWN_CHANNEL_WORDS.has(owner) &&
      !(SOME_OTHER.has(owner) && mine) &&
      !/^\d/.test(owner);
    if (PEOPLE.has(owner) || owner === 'his' || owner === 'their' || name) {
      return false;
    }
  }

  /* An indirect object. */
  if (at(1) === 'him' || at(1) === 'them') return false;
  if ((at(1) === 'customer' || at(1) === 'her') && DETERMINERS.has(at(2))) return false;
  /* "show Ada her balance", "show Mama Nkechi his statement": a name the
   * gateway did not tokenise, before a possessive (final review D). */
  let n = 1;
  while (TITLES.has(at(n))) n += 1;
  if ((n > 1 || !knownWord(at(n))) && ['her', 'his', 'their'].includes(at(n + 1))) return false;
  if (['the', 'my', 'our'].includes(at(1)) && PEOPLE.has(at(2)) && DETERMINERS.has(at(3))) {
    return false;
  }

  for (const t of toTargets) {
    if (t.channel) continue;
    const before = words[t.at - 1] ?? '';
    const filters = LISTED_RECORDS.has(before) || TRADE_VERBS.has(before);
    if (sending) return false;
    /* "export payments to suppliers" filters by counterparty (round 25). */
    if (t.person && !(filters && (viewing || t.counterparty))) return false;
  }
  return true;
}

/** Only a report of the books, never one customer's document. */
function reportOnly(object: readonly string[]): boolean {
  return (
    object.length > 0 &&
    object.some(
      (w) =>
        (REPORT_NOUNS.has(w) && w !== 'statement' && w !== 'statements') ||
        LISTED_RECORDS.has(w) ||
        w === 'debtors' ||
        w === 'records',
    ) &&
    object.every(
      (w) =>
        w === 'list' ||
        (onlyBooksWords([w]) &&
          !TRADE_VERBS.has(w) &&
          w !== 'statement' &&
          w !== 'statements' &&
          !(RECORD_NOUNS.has(w) && !LISTED_RECORDS.has(w))),
    )
  );
}

/** Words that name the asker. */
const ASKERS = new Set(['me', 'us', 'my', 'our']);
const ASKERS_DIRECT = new Set(['me', 'us']);

/** What begins an object after an indirect object: "send her THE invoice". */
const DETERMINERS = new Set(['the', 'a', 'an', 'her', 'his', 'their', 'its', 'my', 'our']);

/** People the books might be sent to. */
const PEOPLE = new Set([
  'customer',
  'customers',
  'client',
  'clients',
  'accountant',
  'her',
  'him',
  'them',
  'boss',
  'partner',
  'wife',
  'husband',
  'manager',
  'staff',
  /* Round 25: owners of a channel, and senders' usual recipients. */
  'supplier',
  'suppliers',
  'vendor',
  'vendors',
  'debtor',
  'debtors',
  'creditor',
  'creditors',
  'auditor',
  'oga',
]);

/**
 * Who the merchant pays: "export payments to suppliers" filters. Never a
 * customer: "export sales to my customer" sends the books to them.
 */
const COUNTERPARTIES = new Set([
  'supplier',
  'suppliers',
  'vendor',
  'vendors',
  'creditor',
  'creditors',
]);

/** What may stand before the merchant's own channel: "as PDF", "work email". */
const OWN_CHANNEL_WORDS = new Set([
  'as',
  'in',
  'into',
  'via',
  'by',
  'through',
  'work',
  'office',
  'personal',
  'business',
  'shop',
  'your',
]);

/** What makes a number or line the business's own: "the shop number". */
const OWN_CONTACT_WORDS = new Set(['work', 'office', 'business', 'shop', 'personal']);
/** …and only straight after one of these: "his work number" is his (round 28). */
const OWN_CONTACT_LEADS = new Set([
  'the',
  'my',
  'our',
  'on',
  'to',
  'via',
  'at',
  'through',
  'by',
  'in',
]);

/** A channel that is one of several: the merchant's only after my/our. */
const SOME_OTHER = new Set(['new', 'other', 'another', 'second', 'this', 'that']);

/** Channels that are a file format, never anyone's: "a pdf of my sales". */
const FORMAT_CHANNELS = new Set(['excel', 'pdf', 'csv', 'spreadsheet', 'sheet']);

/** Formats and channels a report may go to: "to my email", "to Excel". */
const CHANNELS = new Set([
  'excel',
  'pdf',
  'csv',
  'spreadsheet',
  'sheet',
  'email',
  'mail',
  'gmail',
  'inbox',
  'whatsapp',
  'phone',
  'number',
  'line',
  'date',
]);

/** Words after "to" that close a range: "Monday to Friday", "to now". */
const RANGE_WORDS = new Set([
  'now',
  'last',
  'this',
  'next',
  'today',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
]);

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
      isYear(w) ||
      /* A number left over once the figure check passed is a date's. */
      /^\d+$/.test(w) ||
      /* So is a cardinal in words ("the last two weeks"). */
      NUMBER_WORDS.test(w),
  );
}
