/**
 * Reading a bank statement a merchant downloaded from their own bank.
 *
 * Pure, and deliberately so: no database, no model, no network. A statement
 * is somebody's financial history in a text file, and the parsing of it
 * should be something a test can hold entirely in its hand.
 *
 * Nigerian banks do not agree on a format. GTB, Zenith, Access, UBA and
 * First Bank all export different headers, different date orders, and
 * disagree about whether money in and money out are two columns or one
 * signed one. So nothing here is hard-coded to a bank: columns are found by
 * what they are called, and the date order is inferred from the whole file
 * rather than assumed.
 *
 * Narrations are carried through untouched and are never sent to a model.
 * They are what makes a line matchable to an invoice, and they are also the
 * one field in a statement that carries somebody's name.
 */
import { createHash } from 'node:crypto';

/** One movement, as the bank reports it. */
export interface BankStatementLine {
  /** The day the bank posted it, `YYYY-MM-DD`. */
  readonly postedOn: string;
  /** Signed integer kobo. Positive is money INTO the account. */
  readonly amountK: number;
  /** The bank's own words. Stored, shown to the merchant, never modelled. */
  readonly narration: string;
  /** The bank's reference, when it publishes one. */
  readonly bankRef: string | null;
  /** Which row of the file this came from, so a skipped row can be named. */
  readonly row: number;
}

export interface SkippedRow {
  readonly row: number;
  readonly why: 'no_date' | 'no_amount' | 'zero_amount';
}

export type ParsedStatement =
  | {
      readonly ok: true;
      readonly lines: readonly BankStatementLine[];
      readonly skipped: readonly SkippedRow[];
      /**
       * How the day and month were read. `ambiguous` means every date in the
       * file could be read either way and Nigerian order was assumed, which
       * is worth telling a merchant rather than deciding silently.
       */
      readonly dateOrder: 'day_first' | 'month_first' | 'ambiguous';
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'empty'
        | 'no_header'
        | 'no_date_column'
        | 'no_amount_column'
        | 'mixed_date_order'
        | 'no_rows';
    };

/* Header words, lower-cased and stripped of punctuation. Ordered so the more
 * specific match wins: "value date" is a date, "date posted" is a date, and
 * "transaction type" must never be read as a transaction amount. */
const DATE_WORDS = ['transdate', 'transactiondate', 'valuedate', 'postingdate', 'postdate', 'date'];
const DEBIT_WORDS = ['debit', 'withdrawal', 'withdrawals', 'moneyout', 'dr', 'paidout'];
const CREDIT_WORDS = ['credit', 'lodgement', 'lodgment', 'deposit', 'moneyin', 'cr', 'paidin'];
const AMOUNT_WORDS = ['amount', 'transactionamount', 'value'];
const NARRATION_WORDS = [
  'narration',
  'description',
  'remarks',
  'details',
  'particulars',
  'transactiondetails',
  'reference',
];
const REF_WORDS = ['reference', 'ref', 'transactionref', 'transactionreference', 'chequeno'];

const normalise = (header: string): string => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The first column whose name matches one of these words.
 *
 * Exact first, then containing, so "Transaction Date (Value)" still counts as
 * a date. The containing pass ignores short words on purpose: "description"
 * contains "cr", so a two-letter abbreviation matched loosely would claim the
 * narration column as the credit column and every amount would read as
 * unparseable text. Abbreviations have to be named exactly or not at all.
 */
const LOOSE_MATCH_FROM = 4;

function findColumn(headers: readonly string[], words: readonly string[]): number {
  const cells = headers.map(normalise);
  for (const word of words) {
    const at = cells.indexOf(word);
    if (at >= 0) return at;
  }
  for (const word of words) {
    if (word.length < LOOSE_MATCH_FROM) continue;
    const at = cells.findIndex((c) => c.includes(word));
    if (at >= 0) return at;
  }
  return -1;
}

/**
 * Split one CSV line, honouring quotes.
 *
 * Narrations contain commas constantly ("TRF FROM ADEBAYO O, LAGOS"), so a
 * naive split on comma tears them in half and shifts every later column.
 */
function splitRow(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  out.push(cell.trim());
  return out;
}

/** Comma unless another separator appears more often on the header row. */
function detectDelimiter(lines: readonly string[]): string {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const line of lines.slice(0, 20)) {
    for (const d of candidates) {
      const n = line.split(d).length - 1;
      if (n > bestCount) {
        bestCount = n;
        best = d;
      }
    }
  }
  return best;
}

/**
 * A bank statement rarely starts at its header. Account name, address, a
 * period, and a blank line or two come first, so the header is found by
 * looking for the first row that names a date column and something to read
 * an amount from.
 */
function findHeaderRow(rows: readonly string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const row = rows[i]!;
    if (findColumn(row, DATE_WORDS) < 0) continue;
    const hasAmount =
      findColumn(row, AMOUNT_WORDS) >= 0 ||
      findColumn(row, DEBIT_WORDS) >= 0 ||
      findColumn(row, CREDIT_WORDS) >= 0;
    if (hasAmount) return i;
  }
  return -1;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

interface RawDate {
  readonly a: number;
  readonly b: number;
  readonly year: number;
  /** True when the month was spelled out, so nothing has to be inferred. */
  readonly named: boolean;
}

/** Pull the three parts out without deciding which of `a`/`b` is the day. */
function rawDate(text: string): RawDate | null {
  const t = text.trim();
  if (t === '') return null;

  /* ISO first: unambiguous, and what an export from a modern system uses. */
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return { a: Number(iso[3]), b: Number(iso[2]), year: Number(iso[1]), named: true };

  /* A spelled month settles it: 15-Aug-2026, 15 Aug 2026, Aug 15 2026. */
  const named = /^(\d{1,2})[-/\s]([a-zA-Z]{3,})[-/\s](\d{2,4})/.exec(t);
  if (named) {
    const month = MONTHS[named[2]!.slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    return { a: Number(named[1]), b: month, year: fullYear(Number(named[3])), named: true };
  }
  const namedFirst = /^([a-zA-Z]{3,})[-/\s](\d{1,2})[,\s]+(\d{2,4})/.exec(t);
  if (namedFirst) {
    const month = MONTHS[namedFirst[1]!.slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    return {
      a: Number(namedFirst[2]),
      b: month,
      year: fullYear(Number(namedFirst[3])),
      named: true,
    };
  }

  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(t);
  if (numeric) {
    return {
      a: Number(numeric[1]),
      b: Number(numeric[2]),
      year: fullYear(Number(numeric[3])),
      named: false,
    };
  }
  return null;
}

const fullYear = (n: number): number => (n >= 100 ? n : n >= 70 ? 1900 + n : 2000 + n);

const pad = (n: number): string => String(n).padStart(2, '0');

function isRealDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * Money as a statement prints it, which is not how a person says it.
 *
 * Deliberately not `parseAmountText`: that one accepts "50k" because a
 * merchant speaks it, and a bank statement never does. Accepting shorthand
 * here would mean a corrupted cell could parse as a plausible figure.
 *
 * Handles thousands separators, a currency symbol, a trailing or leading
 * minus, accountants' parentheses, and a trailing CR/DR marker.
 */
export function parseStatementAmountK(text: string): number | null {
  let t = String(text ?? '').trim();
  if (t === '') return null;

  let sign = 1;
  const marker = /\b(cr|dr)\b\.?$/i.exec(t);
  if (marker) {
    if (marker[1]!.toLowerCase() === 'dr') sign = -1;
    t = t.slice(0, marker.index).trim();
  }
  if (/^\(.*\)$/.test(t)) {
    sign = -sign;
    t = t.slice(1, -1).trim();
  }
  if (t.startsWith('-')) {
    sign = -sign;
    t = t.slice(1).trim();
  } else if (t.startsWith('+')) {
    t = t.slice(1).trim();
  }

  t = t.replace(/[₦NGN$£€\s]/gi, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;

  const [naira, fraction = ''] = t.split('.');
  const kobo = Number(naira) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(kobo) ? sign * kobo : null;
}

export function parseBankStatement(csv: string): ParsedStatement {
  const text = String(csv ?? '').replace(/^﻿/, '');
  /* Blank lines are dropped but their positions are not. A merchant told a
   * row was skipped has to be able to find that row in the file they
   * uploaded, and a statement is full of blank separators. */
  const kept = text
    .split(/\r?\n/)
    .map((line, i) => ({ line, at: i + 1 }))
    .filter((r) => r.line.trim() !== '');
  if (kept.length === 0) return { ok: false, reason: 'empty' };

  const delimiter = detectDelimiter(kept.map((r) => r.line));
  const rows = kept.map((r) => splitRow(r.line, delimiter));

  const headerAt = findHeaderRow(rows);
  if (headerAt < 0) {
    /* A header is recognised by naming BOTH a date and something to read an
     * amount from, because one signal alone matches preamble too easily. So a
     * file missing only the amount column looks headerless, and telling a
     * merchant that would send them looking for the wrong problem. Second
     * pass, date alone, purely to name the real fault. */
    const dateOnlyAt = rows.findIndex((row) => findColumn(row, DATE_WORDS) >= 0);
    return { ok: false, reason: dateOnlyAt >= 0 ? 'no_amount_column' : 'no_header' };
  }
  const headers = rows[headerAt]!;

  const dateAt = findColumn(headers, DATE_WORDS);
  if (dateAt < 0) return { ok: false, reason: 'no_date_column' };

  const debitAt = findColumn(headers, DEBIT_WORDS);
  const creditAt = findColumn(headers, CREDIT_WORDS);
  const amountAt = findColumn(headers, AMOUNT_WORDS);
  if (debitAt < 0 && creditAt < 0 && amountAt < 0) {
    return { ok: false, reason: 'no_amount_column' };
  }

  const narrationAt = findColumn(headers, NARRATION_WORDS);
  const refAt = findColumn(headers, REF_WORDS);

  const body = rows.slice(headerAt + 1);
  const bodyLineNumbers = kept.slice(headerAt + 1).map((r) => r.at);

  /**
   * Which of the two numbers is the day, decided by the whole file.
   *
   * One row cannot tell 03/04 apart, but a file usually can: a single row
   * with a first part above twelve proves day-first, and one with a second
   * part above twelve proves month-first. A file containing both is not a
   * date format anybody can read, and importing it would silently move
   * money into the wrong months.
   */
  let dayFirst = false;
  let monthFirst = false;
  for (const row of body) {
    const raw = rawDate(row[dateAt] ?? '');
    if (!raw || raw.named) continue;
    if (raw.a > 12) dayFirst = true;
    if (raw.b > 12) monthFirst = true;
  }
  if (dayFirst && monthFirst) return { ok: false, reason: 'mixed_date_order' };
  /* Nigerian banks write day first, so that is the assumption when a file
   * cannot settle it. Reported back rather than hidden. */
  const dateOrder = dayFirst ? 'day_first' : monthFirst ? 'month_first' : 'ambiguous';

  const lines: BankStatementLine[] = [];
  const skipped: SkippedRow[] = [];

  body.forEach((row, i) => {
    const rowNumber = bodyLineNumbers[i]!;
    const raw = rawDate(row[dateAt] ?? '');
    if (!raw) {
      /* Trailing totals, page footers and blank separators all land here. */
      skipped.push({ row: rowNumber, why: 'no_date' });
      return;
    }
    const [day, month] = raw.named || dateOrder !== 'month_first' ? [raw.a, raw.b] : [raw.b, raw.a];
    if (!isRealDay(raw.year, month, day)) {
      skipped.push({ row: rowNumber, why: 'no_date' });
      return;
    }

    const amountK = readAmount(row, { debitAt, creditAt, amountAt });
    if (amountK === null) {
      skipped.push({ row: rowNumber, why: 'no_amount' });
      return;
    }
    if (amountK === 0) {
      skipped.push({ row: rowNumber, why: 'zero_amount' });
      return;
    }

    const narration = (narrationAt >= 0 ? (row[narrationAt] ?? '') : '').trim();
    const ref = refAt >= 0 && refAt !== narrationAt ? (row[refAt] ?? '').trim() : '';
    lines.push({
      postedOn: `${raw.year}-${pad(month)}-${pad(day)}`,
      amountK,
      narration,
      bankRef: ref === '' ? null : ref,
      row: rowNumber,
    });
  });

  if (lines.length === 0) return { ok: false, reason: 'no_rows' };
  return { ok: true, lines, skipped, dateOrder };
}

/**
 * Money in is positive, money out is negative, however the bank said it.
 *
 * Two columns are read as two columns; a single amount column is read with
 * its own sign. When a file has both, the two columns win: a bank that
 * publishes separate debit and credit columns has already told us the
 * direction, and its amount column is usually unsigned.
 */
function readAmount(
  row: readonly string[],
  at: { debitAt: number; creditAt: number; amountAt: number },
): number | null {
  if (at.debitAt >= 0 || at.creditAt >= 0) {
    const debit = at.debitAt >= 0 ? parseStatementAmountK(row[at.debitAt] ?? '') : null;
    const credit = at.creditAt >= 0 ? parseStatementAmountK(row[at.creditAt] ?? '') : null;
    if (debit === null && credit === null) return null;
    return (credit ?? 0) - Math.abs(debit ?? 0);
  }
  return at.amountAt >= 0 ? parseStatementAmountK(row[at.amountAt] ?? '') : null;
}

/**
 * A stable key for one statement line, so re-uploading a statement does not
 * duplicate it.
 *
 * Merchants re-upload constantly: last month's file again, or a new one
 * overlapping the last by two weeks. Without a key every overlap doubles the
 * lines, and the reconciliation gets further from the truth with each upload,
 * which is the opposite of what importing is for.
 *
 * `occurrence` is the part that is easy to get wrong. Two identical charges
 * on the same day are two real charges, and a key built from the line's
 * contents alone would collapse them into one and lose the merchant's money.
 * So identical lines within a file are numbered, and the number is part of
 * the key: the same file uploaded twice produces the same numbers, while two
 * genuine twins both survive.
 *
 * Fields are joined with a character no bank narration contains, so a
 * narration ending in a digit cannot run into the amount beside it and make
 * two different lines look like one.
 */
const SEP = String.fromCharCode(31);

export function fingerprintLines<T extends BankStatementLine>(
  lines: readonly T[],
): readonly (T & { fingerprint: string })[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const body = [line.postedOn, String(line.amountK), line.narration, line.bankRef ?? ''].join(
      SEP,
    );
    const occurrence = (seen.get(body) ?? 0) + 1;
    seen.set(body, occurrence);
    return {
      ...line,
      fingerprint: createHash('sha256')
        .update(body + SEP + occurrence, 'utf8')
        .digest('hex')
        .slice(0, 32),
    };
  });
}
