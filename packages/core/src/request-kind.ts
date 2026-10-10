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
const NUMBER_WORDS = /\b(hundred|thousand|million|billion|naira)\b/;

/**
 * Calendar dates and spans: a period, never money (Codex P2). "10 October
 * 2026", "October 10th", "10/10/2026", "the 5th", "last 7 days".
 */
const DATES = new RegExp(
  [
    '\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b',
    '\\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\s+\\d{1,2}(?:st|nd|rd|th)?\\b',
    /* A real day and month, slashed ("10/10", "10/10/2026") or dashed with a
     * year ("10-10-2026"): never "5.5", "2-3" or "15/20", which are figures. */
    '\\b(?:0?[1-9]|[12]\\d|3[01])\\/(?:0?[1-9]|1[0-2])(?:\\/\\d{2,4})?\\b',
    '\\b(?:0?[1-9]|[12]\\d|3[01])-(?:0?[1-9]|1[0-2])-\\d{2,4}\\b',
    '\\b\\d{1,2}(?:st|nd|rd|th)\\b',
    '\\b(?:last|past|next)\\s+\\d{1,3}\\s+(?:days?|weeks?|months?|years?)\\b',
  ].join('|'),
  'g',
);

function hasFigure(raw: string): boolean {
  const text = raw.replace(DATES, ' ');
  if (text.includes('₦') || NUMBER_WORDS.test(text)) return true;
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
 * The privacy gateway's tokens (`CUSTOMER_7K2`, `PHONE_1`, `EMAIL_1`,
 * `ACCOUNT_1`): a name or a contact, never an amount. Read as the word
 * "customer", so the digits inside a token are never mistaken for money, and
 * a token that is the subject ("CUSTOMER_7K2 has paid") keeps its place
 * instead of letting the next word ("has") open a question.
 */
const VAULT_TOKEN = /\b(?:CUSTOMER|PHONE|EMAIL|ACCOUNT)_[A-Z0-9]+\b(?:['’]s)?/g;

export function requestKind(raw: string): RequestKind {
  const text = raw
    .replace(VAULT_TOKEN, ' customer ')
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
  const parts = body
    .split(/(?<!\d),|,(?!\d)|\s+(?:and|but|then|also|plus)\s+/i)
    .filter((part) => part.trim().length > 0);
  return parts.slice(1).some(saysSomethingOfItsOwn) ? 'unknown' : 'read';
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
function saysSomethingOfItsOwn(part: string): boolean {
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
const COMPARISON_FILTER =
  /\b(?:(?:more|less|greater|bigger|higher|lower|fewer)\s+than|over|above|under|below|exceeding|at\s+(?:least|most))\s+(?:₦\s*)?\d|\d[\d,.]*\s*k?\s+(?:and|or)\s+(?:above|more|over|below|less|under)\b/;

/** Records that can be listed: the plural forms. */
const LISTED_RECORDS = new Set([
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
const READ_VERBS = new Set(['show', 'list', 'export', 'send', 'give', 'tell', 'download', 'print']);

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
      .match(/[\p{L}\p{N}']+/gu) ?? []
  )
    .map((w) => w.replace(/'s$/, ''))
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
  /* "record of sales", "log of payments": the records, not an instruction
   * to make one (Codex P2). Read as "report". */
  if (['record', 'records', 'log'].includes(words[0] ?? '') && words[1] === 'of') {
    words.splice(0, 2, 'report');
    if (words.length === 1) return 'read';
  }

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
  const describes = (i: number) =>
    asks &&
    CHANGE_PARTICIPLES.has(words[i]!) &&
    words
      .slice(0, i)
      .some((w) => READ_VERBS.has(w) || (!AUXILIARIES.has(w) && !QUESTION_OPENERS.has(w)));
  if (words.some((w, i) => CHANGE_VERBS.has(w) && !describes(i))) return 'unknown';

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
    const filters = COMPARISON_FILTER.test(text);
    if (figure && !filters && (trade || recordNoun || topic)) return 'unknown';
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
  if (figure || !onlyBooksWords(words)) return 'unknown';
  /* "CUSTOMER_7K2 owes me", "she owed me": someone stating a debt, which
   * may be a credit sale to record, not a question about one (Codex P2).
   * "how much do Ada and Chidi owe" asks, and is a question above. */
  if (words.some((w) => SUBJECTS.has(w)) && words.some((w) => w === 'owes' || w === 'owed')) {
    return 'unknown';
  }
  if (topic) return 'read';
  if (recordNoun && (period || summary)) return 'read';
  /* "sales", "expenses" alone: the list, not one record. */
  if (words.length === 1 && BARE_LISTS.has(words[0]!)) return 'read';
  return 'unknown';
}

const BARE_LISTS = new Set(['sales', 'expenses', 'purchases', 'payments', 'invoices']);

/** A question by its opening, not by a trailing question mark. */
function opensAQuestion(words: readonly string[]): boolean {
  const first = words[0]!;
  /* In Nigerian English "do invoice for Ada" means make one. */
  if (first === 'do') return ['i', 'we', 'you', 'they', 'customer'].includes(words[1] ?? '');
  if (QUESTION_OPENERS.has(first)) return true;
  /* "can I see…", "could we get…"; "can you…" only before a read verb
   * ("can you show me sales?"), never before work ("can you reverse…"). */
  if (first === 'can' || first === 'could') {
    if (words[1] === 'i' || words[1] === 'we') return true;
    if (words[1] === 'you' && READ_VERBS.has(words[2] ?? '')) return true;
  }
  /* "export sales to Excel", "download the sales report" (Codex P2). */
  if (first === 'export' || first === 'download' || first === 'print') return true;
  /* "send me the P&L", "give me sales today", "send my records for March". */
  return (
    (first === 'send' || first === 'give' || first === 'get') &&
    (words[1] === 'me' || words[1] === 'my' || words[1] === 'our')
  );
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
      isYear(w) ||
      /* A number left over once the figure check passed is a date's. */
      /^\d+$/.test(w),
  );
}
