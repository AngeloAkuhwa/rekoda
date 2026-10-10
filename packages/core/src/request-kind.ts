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
/** Amounts said in words, as typed or as a transcript renders them. */
const NUMBER_WORDS = /\b(hundred|thousand|million|billion|naira)\b/;

function hasFigure(text: string): boolean {
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
    /* Before "&" separates anything. */
    .replace(/p\s*&\s*l\b/gi, 'pnl')
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
    if (figure && (trade || recordNoun || topic)) return 'unknown';
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
