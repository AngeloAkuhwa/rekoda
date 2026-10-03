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

/** Words that introduce a document number, in any case. */
const REFERENCE_WORDS: ReadonlySet<string> = new Set([
  'INV',
  'INVOICE',
  'RCPT',
  'RCP',
  'RECEIPT',
  'REF',
  'REFERENCE',
  'NO',
  'NUMBER',
  'BILL',
  'DOC',
  'DOCUMENT',
  'ORDER',
  'PO',
]);

/**
 * An explicit supplier document reference, as its SIGNIFICANT DIGITS, or
 * null when what was given is not certainly one (fresh review of #262). One
 * number written two ways is one reference: "2231", "INV-2231" and "#2231"
 * are "2231"; "EMK-0041" and "EMK-00-41" are "41". If in doubt the side has NO reference,
 * which never proves anything. Never a reference: an amount ("100k",
 * "N100000"), a date ("12/09/2026"), a name with digits ("Ada 07"), a
 * phone or account number (ten digits or more), or fewer than two
 * significant digits. Only digits are ever returned, so a name is never
 * stored.
 */
export function normalisePurchaseReference(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.normalize('NFKC').trim();
  if (!text || text.length > 40) return null;
  /* An amount: a currency mark, or a k / m / naira suffix. */
  if (/^(?:₦|NGN|N)\s*[\d,.]+$/iu.test(text) || /^[\d,.]+\s*(?:k|m|naira)$/iu.test(text)) {
    return null;
  }
  /* A date, whole or partial, separated or compact (Codex review). */
  if (/^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/u.test(text)) return null;
  /* An explicit document marker is required (Codex review): a reference
   * word ("INV", "receipt", "No."), a "#", or upper-case letters written
   * into the number ("EMK-0041"). Bare digits ("2231", "125,000.00",
   * "20261002") are in doubt, and a side in doubt has no reference. */
  const marked =
    text.includes('#') ||
    text
      .split(/[\s#:,]+/u)
      .some(
        (token) =>
          REFERENCE_WORDS.has(token.replace(/\.$/u, '').toUpperCase()) ||
          /^\p{Lu}+[\d/.-]*\d/u.test(token),
      );
  if (!marked) return null;
  /* Whatever marks it, the number itself is never an amount or a date. */
  const numberPart = text
    .split(/[\s#:]+/u)
    .filter((token) => !REFERENCE_WORDS.has(token.replace(/\.$/u, '').toUpperCase()))
    .join(' ')
    .trim();
  if (
    /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(numberPart) ||
    /^\d+\.\d{1,2}$/u.test(numberPart) ||
    /^\d{1,4}[/.-]\d{1,2}(?:[/.-]\d{1,4})?$/u.test(numberPart) ||
    /^\d{1,2}[/.-]\d{4}$/u.test(numberPart) ||
    /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/u.test(numberPart)
  ) {
    return null;
  }
  const digitRuns = text.match(/\d+/gu) ?? [];
  /* Ten digits or more in all, however they are grouped, is a phone or an
   * account number ("0803-123-4567", a NUBAN with spaces), never a
   * document reference (Codex review). */
  if (digitRuns.length === 0 || digitRuns.join('').length >= 10) return null;
  for (const token of text.split(/[\s#:,]+/u).filter(Boolean)) {
    if (/^[\p{L}.]+$/u.test(token)) {
      /* A word on its own must introduce the number, never name someone. */
      if (!REFERENCE_WORDS.has(token.replace(/\.$/u, '').toUpperCase())) return null;
      continue;
    }
    if (!/^[\p{L}\d/.-]+$/u.test(token)) return null;
    /* Letters inside a number are a written prefix ("EMK-0041"): upper
     * case and short, or a reference word. "Ada12" is a name. */
    for (const letters of token.match(/\p{L}+/gu) ?? []) {
      const known = REFERENCE_WORDS.has(letters.toUpperCase());
      if (!known && (letters !== letters.toUpperCase() || letters.length > 4)) return null;
    }
  }
  /* Its digits WITHOUT ZEROS (Codex review): padding and separators carry
   * no identity, and "EMK-0041", "EMK 41" and "EMK-00-41" must be one
   * reference. Dropping every zero can only make two different numbers
   * look alike (a question asked), never one number look like two (a
   * duplicate booked), which is the direction OD-23 D3 asks for. */
  const significant = digitRuns.join('').replace(/0/gu, '');
  return significant.length >= 2 ? significant : null;
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
  if (a.reference && b.reference && a.reference !== b.reference) return true;
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
