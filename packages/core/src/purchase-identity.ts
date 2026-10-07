/**
 * One real purchase, one financial truth (G-81, OD-23).
 *
 * Decides whether a stock purchase about to be previewed, or about to be
 * booked, may be one that is already waiting or already booked. Pure: no
 * database and no clock; the repository supplies the facts and the instant.
 *
 * The owner's rulings (OD-23, OWN-21), which this file is the whole of:
 *
 *  D1  A purchase already BOOKED counts, as well as a waiting preview.
 *  D2  The window is a rolling 24 hours, from the earlier purchase's time
 *      to the moment the new message reached Rekoda.
 *  D3  Two purchases of the same total (integer kobo) inside the window are
 *      PROVEN SEPARATE, with no question, only by a strong structured
 *      difference carried by BOTH sides. Refined by the owner on 2 Oct 2026:
 *      AN AUTO-CREATED ENTITY IS NOT A CONFIRMED IDENTITY.
 *        - Different explicit supplier document references prove it.
 *        - Different products prove it ONLY when both identities are
 *          trusted: linked to a stable catalogue id (`external_catalogue_id`).
 *          A product row made from chat never counts, however old.
 *        - A supplier row NEVER proves it today: rows are minted from chat
 *          and there is no merchant confirmation flow.
 *      Quantity, raw names, wording, spelling and creation time are never
 *      proof. Anything else is asked about: false uncertainty costs one
 *      clarification, false certainty can double the books.
 *  D4  The same member is protected too. An exact provider replay never
 *      reaches this file (one draft per message); the member's OWN waiting
 *      preview of the same total is replaced (Build 7's rule) rather than
 *      asked about; their own BOOKED purchase is asked about; a D3
 *      difference proceeds.
 *
 * "separate" excuses ONLY the records the question named (fresh review of
 * #262): a question names every record it may be about, and the answer is
 * about exactly those. A record it did not name is asked about.
 */
import { nairaToKobo } from './money.js';

/** D2: how far back a booked purchase is compared, in seconds. */
export const PURCHASE_IDENTITY_WINDOW_SECONDS = 86_400;

/**
 * How long "same or separate" stays answerable, from the moment it is asked.
 * The continuation window (OD-14), so the question and its short answer
 * close together.
 */
export const PURCHASE_QUESTION_SECONDS = 600;

/**
 * Which record a purchase is, as a question names it: its draft, its
 * booking, or both (a chat purchase that was booked has both, and a
 * question that named its waiting draft still names it once it is booked).
 */
export interface RecordRef {
  readonly draftId: string | null;
  readonly expenseId: string | null;
}

export function sameRecord(a: RecordRef, b: RecordRef): boolean {
  return (
    (a.draftId !== null && a.draftId === b.draftId) ||
    (a.expenseId !== null && a.expenseId === b.expenseId)
  );
}

/** A product row, and whether its identity is trusted (catalogue-linked). */
export interface ProductIdentity {
  readonly id: string;
  readonly trusted: boolean;
}

/** What one purchase carries that can tell it apart from another. */
export interface PurchaseFacts {
  /** The total in integer kobo. */
  readonly amountK: number;
  /** When the message that reported it reached Rekoda (or, for a booking
   * with no message, when it was booked). */
  readonly at: Date;
  /** The product row it names or moved, if one exists. */
  readonly product: ProductIdentity | null;
  /** An explicit supplier document reference, normalised, if stated. */
  readonly reference: string | null;
  /** The records a "separate" answer declared this purchase apart from. */
  readonly separateFrom: readonly RecordRef[];
  /** This purchase's own record (nothing yet, for one not yet drafted). */
  readonly self: RecordRef;
}

/** A purchase already waiting for a yes, or already booked. */
export interface PurchaseRecord extends PurchaseFacts {
  /** The draft id (pending), or the expense id (booked). */
  readonly id: string;
  readonly state: 'pending' | 'booked';
  /** When it was booked; null while it waits. */
  readonly bookedAt: Date | null;
  /** The member whose message drafted it; null when Rekoda cannot say. */
  readonly requestedBy: string | null;
  /** The bill a booked purchase on credit raised, if any. */
  readonly billNumber: string | null;
}

/**
 * The kind of supplier document a reference names, from a CLOSED set. Only
 * the kind and the digits are ever stored (ADR 0005): never the letters a
 * merchant or a photo wrote, which can be a name ("TOLU-77").
 */
export type ReferenceKind = 'INV' | 'RCPT' | 'WAYBILL' | 'PO' | 'OTHER';

/** Words that introduce a document number, in any case, and their kind. */
const REFERENCE_WORDS: ReadonlyMap<string, ReferenceKind> = new Map([
  ['INV', 'INV'],
  ['INVOICE', 'INV'],
  ['RCPT', 'RCPT'],
  ['RCP', 'RCPT'],
  ['RECEIPT', 'RCPT'],
  ['WAYBILL', 'WAYBILL'],
  ['WB', 'WAYBILL'],
  ['PO', 'PO'],
  /* A supplier's "order 55" is not the merchant's PO, so it proves nothing
   * against one (final-head review of #262). */
  ['ORDER', 'OTHER'],
  ['REF', 'OTHER'],
  ['REFERENCE', 'OTHER'],
  ['NO', 'OTHER'],
  ['NUMBER', 'OTHER'],
  ['BILL', 'OTHER'],
  ['DOC', 'OTHER'],
  ['DOCUMENT', 'OTHER'],
]);

const KIND_LABEL: Readonly<Record<ReferenceKind, string>> = {
  INV: 'Invoice',
  RCPT: 'Receipt',
  WAYBILL: 'Waybill',
  PO: 'Purchase order',
  OTHER: 'Reference',
};

/** A reference as stored: its kind and its digits, nothing else. */
const STORED = /^(INV|RCPT|WAYBILL|PO|OTHER):(\d+)$/u;

const kindOfWord = (token: string): ReferenceKind | undefined =>
  REFERENCE_WORDS.get(token.replace(/\.$/u, '').toUpperCase());

/**
 * An explicit supplier document reference, as its KIND and its digits, or
 * null when what was given is not certainly one (fresh reviews of #262). If
 * in doubt the side has NO reference, which never proves anything.
 *
 *  - It needs an explicit document marker: a reference word ("invoice",
 *    "receipt", "waybill", "PO", "ref", "No."), a "#", or upper-case
 *    letters written into the number ("EMK-0041"). Bare digits are in doubt.
 *  - The kind comes from the word ("invoice 2231" is an invoice); a "#", a
 *    generic word or a letter prefix is kind OTHER, which never proves two
 *    purchases separate, because its letters are never stored and so two
 *    prefixes cannot be told apart.
 *  - Never a reference: an amount ("100k", "NGN150K", "125,000.00"), the
 *    purchase's own total, a date or a time (whole, partial or compact,
 *    "INV-2026-10-02", "INV 031026", "INV 2026", "INV 10:30"), a phone or
 *    account number (ten digits or more in all), a name with digits written
 *    as a separate word ("Ada 07"), more than one document ("receipt 0041
 *    invoice 2231", "invoice 2231, 2232"), letters after the number, or
 *    fewer than two significant digits.
 *
 * `totalNaira` is the purchase's total when known: a "reference" equal to it
 * is the amount copied into the wrong field.
 */
export function purchaseReference(
  raw: unknown,
  totalNaira?: number | null,
): { readonly kind: ReferenceKind; readonly digits: string } | null {
  if (typeof raw !== 'string') return null;
  /* The stored form skips only the re-parsing: the persistence boundary
   * runs this on model output, which can be written in it ("INV:100000",
   * "INV:20261002"), so every check on the number runs on it too (Codex
   * review of 7f173b6). */
  const stored = STORED.exec(raw);
  if (stored) {
    return checkedNumber(stored[1] as ReferenceKind, stored[2]!, stored[2]!, totalNaira);
  }
  const text = raw.normalize('NFKC').trim();
  if (!text || text.length > 40) return null;
  /* A time, anywhere ("INV 10:30"). */
  if (/\d{1,2}:\d{2}/u.test(text)) return null;
  /* An amount: a currency mark, or a k / m / naira suffix. */
  if (
    /(?:₦|\bNGN|\bN)\s*[\d,.]+[KkMm]?\b/u.test(text) ||
    /\d[\d,.]*\s*(?:k|m|naira)\b/iu.test(text)
  ) {
    return null;
  }
  /* A date, whole or partial, separated or compact. */
  if (/^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/u.test(text)) return null;
  const digitRuns = text.match(/\d+/gu) ?? [];
  if (digitRuns.length === 0 || digitRuns.join('').length >= 10) return null;
  /* Two numbers listed ("invoice 2231, 2232") are two references, never one
   * (final-head review of #262). */
  if (/\d\s*[,;&+]/u.test(text)) return null;

  /* Commas stay inside a token, so "125,000" is seen whole (an amount). */
  const tokens = text
    .split(/[\s#:]+/u)
    .map((token) => token.replace(/,$/u, ''))
    .filter(Boolean);
  let kind: ReferenceKind | null = text.includes('#') ? 'OTHER' : null;
  /* One reference is its marker, THEN its number: letters after a digit
   * start another document ("receipt 0041 invoice 2231", "INV-2231
   * RCPT-41") or a suffix nobody can compare, so the text is in doubt and
   * is no reference at all (final-head review of #262). */
  let seenDigit = false;
  const named = (word: ReferenceKind): boolean => {
    if (kind !== null && kind !== 'OTHER' && word !== 'OTHER' && word !== kind) return false;
    if (kind === null || kind === 'OTHER') kind = word;
    return true;
  };
  for (const token of tokens) {
    if (/^[\p{L}.]+$/u.test(token)) {
      /* A word on its own must introduce the number, never name someone. */
      const word = kindOfWord(token);
      if (!word || seenDigit || !named(word)) return null;
      continue;
    }
    if (!/^[\p{L}\d/.-]+$/u.test(token)) return null;
    /* Letters inside a number are a written prefix ("EMK-0041", "INV-2231"):
     * upper case and short, or a reference word. "Ada12" is a name. */
    for (const run of token.match(/\p{L}+|\d+/gu) ?? []) {
      if (/^\d/u.test(run)) {
        seenDigit = true;
        continue;
      }
      if (seenDigit) return null;
      const word = kindOfWord(run);
      if (word) {
        if (!named(word)) return null;
        continue;
      }
      if (run !== run.toUpperCase() || run.length > 4) return null;
      kind ??= 'OTHER';
    }
  }
  if (kind === null) return null;

  const numberPart = tokens
    .filter((token) => !kindOfWord(token))
    .map((token) => token.replace(/^\p{L}+[-/.]?/u, ''))
    .join(' ')
    .trim();
  return checkedNumber(kind, numberPart, digitRuns.join(''), totalNaira);
}

/**
 * The checks every reference's number meets, parsed or stored: never a
 * phone or account number, an amount, a date or the purchase's own total,
 * and at least two significant digits.
 */
function checkedNumber(
  kind: ReferenceKind,
  numberPart: string,
  digits: string,
  totalNaira: number | null | undefined,
): { readonly kind: ReferenceKind; readonly digits: string } | null {
  /* Ten digits or more in all is a phone or account number. */
  if (digits.length === 0 || digits.length >= 10) return null;
  /* Whatever marks it, the number itself is never an amount or a date. */
  if (
    /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(numberPart) ||
    /^\d+\.\d{1,2}$/u.test(numberPart) ||
    /^\d{1,4}[/.-]\d{1,2}(?:[/.-]\d{1,4})?$/u.test(numberPart) ||
    /^\d{1,2}[/.-]\d{4}$/u.test(numberPart) ||
    /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/u.test(numberPart) ||
    /* Day-first and month-first compact dates too ("03102026"; Codex
     * review of 0e9bf52): a date read off a photo is never a reference. */
    /^(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])(?:19|20)\d{2}$/u.test(numberPart) ||
    /^(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:19|20)\d{2}$/u.test(numberPart)
  ) {
    return null;
  }
  /* A number written as one run of digits is never date-shaped either: a
   * year ("2026"), a year then a short month and day ("2026103"), or a
   * six-digit date with a two-digit year in any order ("031026", "261003").
   * A number the document itself splits ("INV/2026/114") is a numbering
   * scheme, not a date. Erring here only asks a question (final-head review
   * of #262). */
  const compact = numberPart.replace(/\s+/gu, '');
  if (
    /^\d+$/u.test(compact) &&
    (/^(?:19|20)\d{2}$/u.test(compact) ||
      /^(?:19|20)\d{2}(?:[1-9]|1[0-2])(?:[1-9]|[12]\d|3[01])$/u.test(compact) ||
      /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])[1-9]$/u.test(compact) ||
      /^(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])\d{2}$/u.test(compact) ||
      /^(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{2}$/u.test(compact) ||
      /^\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/u.test(compact))
  ) {
    return null;
  }
  /* The purchase's own total copied into the reference. */
  if (totalNaira != null && Number.isFinite(totalNaira)) {
    const asWritten = digits.replace(/^0+/u, '');
    if (
      asWritten === String(Math.round(totalNaira)) ||
      asWritten === String(Math.round(totalNaira * 100))
    ) {
      return null;
    }
  }
  /* At least two significant digits (zeros carry no identity). */
  if (digits.replace(/0/gu, '').length < 2) return null;
  return { kind, digits };
}

/**
 * What two references are compared by: the kind and the digits WITHOUT
 * ZEROS (padding and separators carry no identity: "EMK-0041" is
 * "EMK-00-41"), or null when it is not certainly a reference.
 */
export function normalisePurchaseReference(
  raw: unknown,
  totalNaira?: number | null,
): string | null {
  const ref = purchaseReference(raw, totalNaira);
  return ref ? `${ref.kind}:${ref.digits.replace(/0/gu, '')}` : null;
}

/**
 * What is STORED for a reference: its kind and its digits as written
 * ("INV:2231", "OTHER:0041"), never its letters. Null when it is not
 * certainly a reference.
 */
export function storedPurchaseReference(raw: unknown, totalNaira?: number | null): string | null {
  const ref = purchaseReference(raw, totalNaira);
  return ref ? `${ref.kind}:${ref.digits}` : null;
}

/** How a stored reference is shown (a preview, a bill): "Invoice 2231". */
export function describePurchaseReference(value: unknown): string | null {
  const ref = purchaseReference(value);
  return ref ? `${KIND_LABEL[ref.kind]} ${ref.digits}` : null;
}

/** A stored RecordPurchase command's total in kobo, or null. */
export function purchaseTotalK(command: unknown): number | null {
  const c = command as Record<string, unknown> | null;
  if (!c || c['intent'] !== 'RecordPurchase' || typeof c['amount'] !== 'number') return null;
  if (!Number.isFinite(c['amount']) || c['amount'] <= 0) return null;
  return nairaToKobo(c['amount']);
}

/**
 * D3 (refined): are these two purchases PROVEN to be different ones? Only a
 * different stated reference, or two different TRUSTED products.
 */
export function provenSeparate(a: PurchaseFacts, b: PurchaseFacts): boolean {
  /* References prove it only when both name the SAME KIND of document
   * (invoice with invoice, receipt with receipt) with different numbers: an
   * invoice and the receipt for one purchase carry different numbers. A
   * reference of kind OTHER never proves it (fresh review of #262). */
  const kindOf = (r: string) => r.slice(0, r.indexOf(':'));
  if (
    a.reference &&
    b.reference &&
    kindOf(a.reference) === kindOf(b.reference) &&
    kindOf(a.reference) !== 'OTHER' &&
    a.reference !== b.reference
  ) {
    return true;
  }
  if (a.product?.trusted && b.product?.trusted && a.product.id !== b.product.id) return true;
  return false;
}

/**
 * Whether the merchant already said these are two purchases: one of them was
 * built by "separate" to a question that NAMED the other. Only that pair:
 * never every record that existed when the question was asked.
 */
export function declaredSeparate(a: PurchaseFacts, b: PurchaseFacts): boolean {
  return (
    a.separateFrom.some((named) => sameRecord(named, b.self)) ||
    b.separateFrom.some((named) => sameRecord(named, a.self))
  );
}

/**
 * Every waiting or booked purchase this one may be, booked first, newest
 * first: the same total, inside the window (a booking only; a waiting
 * preview has its own five-minute window), not declared separate, and not
 * proven separate. Empty means nothing to ask.
 */
export function purchaseMatches(
  next: PurchaseFacts,
  records: readonly PurchaseRecord[],
  now: Date,
  /**
   * Which bookings count: by default the 24 hours before `now`. A preview
   * passes no upper bound (the repository bounds it by message ORDER), and
   * the purchase work at the yes counts every booking from 24 hours before
   * the purchase's own message onward, so a retried yes never ages one out.
   */
  bookings: {
    readonly from: Date;
    readonly to: Date | null;
    /**
     * What a booking's age is measured by: the earlier purchase's MESSAGE
     * (D2, the default, at a preview; Codex review), or when it was BOOKED
     * (the purchase work's wider net at the yes).
     */
    readonly by?: 'message' | 'booking';
  } = {
    from: new Date(now.getTime() - PURCHASE_IDENTITY_WINDOW_SECONDS * 1000),
    to: now,
  },
): PurchaseRecord[] {
  const when = (r: PurchaseRecord) => (r.bookedAt ?? r.at).getTime();
  const age = (r: PurchaseRecord) => (bookings.by === 'booking' ? when(r) : r.at.getTime());
  return records
    .filter((r) => r.amountK === next.amountK)
    .filter((r) => {
      if (r.state === 'pending') return true;
      const t = age(r);
      return t > bookings.from.getTime() && (bookings.to === null || t <= bookings.to.getTime());
    })
    .filter((r) => !declaredSeparate(next, r))
    .filter((r) => !provenSeparate(next, r))
    .sort((x, y) => (x.state !== y.state ? (x.state === 'booked' ? -1 : 1) : when(y) - when(x)));
}

/** Who a matching record belongs to, from the asking member's side. */
export type RecordOwner = 'you' | 'another_member' | 'unknown';

export function ownerOf(record: PurchaseRecord, actorId: string | null): RecordOwner {
  if (record.requestedBy === null || actorId === null) return 'unknown';
  return record.requestedBy === actorId ? 'you' : 'another_member';
}

/** The record ref a question names a matching record by. */
export function refOf(record: PurchaseRecord): RecordRef {
  return record.self;
}

/**
 * D4's split, for a new preview by `actorId`:
 *  - `replace`: the member's ONE own waiting preview this one replaces, as
 *    Build 7 replaces their own rebuild (never another member's, and never
 *    one Rekoda cannot attribute: a null requester is never "you");
 *  - `asked`: EVERY other match, which the question names (booked first);
 *    `ask` is the first, the one the question describes in full.
 */
export function purchaseIdentityVerdict(
  matches: readonly PurchaseRecord[],
  actorId: string | null,
): {
  readonly replace: readonly PurchaseRecord[];
  readonly asked: readonly PurchaseRecord[];
  readonly ask: PurchaseRecord | null;
} {
  const own = matches.filter((m) => m.state === 'pending' && ownerOf(m, actorId) === 'you');
  /* One own waiting preview is replaced. Two or more coexist only because
   * something proved them separate, so a resend that matches several is
   * asked about, never allowed to replace them all (Codex review). */
  const replace = own.length === 1 ? own : [];
  const asked = matches.filter((m) => !replace.includes(m));
  return { replace, asked, ask: asked[0] ?? null };
}
