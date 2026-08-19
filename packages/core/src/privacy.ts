/**
 * The privacy gateway (ADR 0005, spec §5–8).
 *
 * Everything a merchant says passes through here before any of it reaches a
 * model. What leaves is the shape of the sentence with the identities removed:
 *
 *   "Ada Obi bought 3 wigs for 150k, send receipt to ada@mail.com"
 *   → "CUSTOMER_7K2 bought 3 wigs for 150k, send receipt to EMAIL_1"
 *
 * Two rules govern every decision in this file.
 *
 * 1. **Amounts must survive.** Tokenising "150k" would not protect anyone and
 *    would destroy the only thing the model is there to read. So detection is
 *    deliberately conservative about bare digits.
 * 2. **When in doubt about an identifier, tokenise.** A name that survives is
 *    a privacy failure; a product name wrongly tokenised is a clarifying
 *    question. Those costs are not symmetric.
 */

/** A span of the original text that must not leave the vault. */
export interface PiiSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: 'phone' | 'email' | 'account';
  readonly value: string;
}

/**
 * Nigerian mobile numbers, in the shapes people actually type: 08031234567,
 * +234 803 123 4567, 234-803-123-4567. Anchored on the country code or the
 * leading zero so it cannot swallow a price.
 */
const PHONE = /(?:\+?234[\s-]?|0)(?:70|71|80|81|90|91|70)\d(?:[\s-]?\d){7}/g;

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/**
 * NUBAN account numbers are exactly ten digits — and so is a plausible, if
 * large, naira figure. Matching bare ten-digit runs would tokenise money and
 * break every invoice, so an account keyword must be nearby.
 *
 * This is the deliberate gap in the structural pass: an account number typed
 * with no context survives it. The layers after this one (known-customer
 * matching, and the minimisation pass) are what make that acceptable, and it
 * is a far better failure than silently turning ₦1,234,567,890 into a token.
 */
const ACCOUNT_CONTEXT =
  /\b(?:acc(?:oun)?t|acct|a\/c|nuban|transfer\s+to|send\s+to)\b[^\d]{0,20}(\d{10})\b/gi;

/** Everything the structural pass can find, in document order, no overlaps. */
export function detectStructuralPii(text: string): PiiSpan[] {
  const spans: PiiSpan[] = [];
  const push = (start: number, value: string, kind: PiiSpan['kind']) => {
    spans.push({ start, end: start + value.length, kind, value });
  };

  for (const m of text.matchAll(EMAIL)) push(m.index, m[0], 'email');
  for (const m of text.matchAll(PHONE)) push(m.index, m[0], 'phone');
  for (const m of text.matchAll(ACCOUNT_CONTEXT)) {
    const digits = m[1]!;
    push(m.index + m[0].lastIndexOf(digits), digits, 'account');
  }

  // Longest-first at each position, so an email containing digits is never
  // cut in half by a shorter match inside it.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: PiiSpan[] = [];
  let cursor = -1;
  for (const span of spans) {
    if (span.start >= cursor) {
      kept.push(span);
      cursor = span.end;
    }
  }
  return kept;
}

/** Assigns a stable token to a value, so one identity is one token per message. */
export interface TokenAssigner {
  /**
   * Returns the token for this value. Called at most once per distinct value
   * per message; the caller decides whether that means looking up an existing
   * customer or minting a new token.
   */
  (kind: PiiSpan['kind'], value: string): string;
}

export interface TokenisedMessage {
  /** Safe to send to a model. */
  readonly text: string;
  /** token → original value. Never logged, never leaves the authorised layer. */
  readonly tokens: ReadonlyMap<string, string>;
}

/**
 * Replace every detected identity with its token.
 *
 * Repeats collapse: the same number twice in one message gets one token, so
 * the model can see that they refer to the same person, which is information
 * it legitimately needs and which reveals nothing.
 */
export function tokeniseMessage(text: string, assign: TokenAssigner): TokenisedMessage {
  const spans = detectStructuralPii(text);
  const tokens = new Map<string, string>();
  const assigned = new Map<string, string>();

  let out = '';
  let cursor = 0;
  for (const span of spans) {
    const seen = assigned.get(span.value);
    const token = seen ?? assign(span.kind, span.value);
    assigned.set(span.value, token);
    tokens.set(token, span.value);

    out += text.slice(cursor, span.start) + token;
    cursor = span.end;
  }
  out += text.slice(cursor);

  return { text: out, tokens };
}

/**
 * Put the real values back. THE OUTPUT LAYER ONLY.
 *
 * This is the one function in the system that can undo the gateway, which is
 * why it lives beside it rather than somewhere convenient: anything importing
 * it is doing something that needs justifying. It must never be called before
 * writing a log line, and never inside the core.
 */
export function rehydrate(text: string, tokens: ReadonlyMap<string, string>): string {
  let out = text;
  // Longest tokens first: CUSTOMER_1 must not be substituted inside CUSTOMER_12.
  for (const token of [...tokens.keys()].sort((a, b) => b.length - a.length)) {
    out = out.split(token).join(tokens.get(token)!);
  }
  return out;
}

/**
 * Crockford base32 — no I, L, O or U, so a token read aloud down a bad line or
 * copied off a screen cannot become a different one.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type RandomSource = (bytes: number) => Uint8Array;

/**
 * A token for a customer, unique within one business.
 *
 * Uniqueness is enforced by the database, not hoped for here — this generates
 * a candidate and the caller retries on conflict. Three characters is 32,768
 * per business, which is comfortable for a WhatsApp vendor and short enough to
 * stay readable in a preview message.
 */
export function generateCustomerToken(random: RandomSource, length = 3): string {
  let out = '';
  for (const byte of random(length)) out += ALPHABET[byte % ALPHABET.length];
  return `CUSTOMER_${out}`;
}

/** Non-customer facets get a counter, since they are scoped to one message. */
export function sequentialToken(kind: PiiSpan['kind'], index: number): string {
  return `${kind.toUpperCase()}_${index}`;
}

/**
 * A last line of defence for logs.
 *
 * Anything that looks like an identity is blanked, whether or not the gateway
 * saw it. This is not a substitute for tokenising — it is what stops a stack
 * trace or an error message carrying a phone number into the log store.
 */
export function redactForLog(text: string): string {
  return text
    .replace(EMAIL, '[email]')
    .replace(PHONE, '[phone]')
    .replace(/\b\d{10,11}\b/g, '[digits]');
}
