/**
 * The privacy gateway's STRUCTURAL pass (ADR 0005, spec §5–8).
 *
 * Everything a merchant says passes through the gateway before any of it
 * reaches a model, and protection comes in two layers. This file is the
 * structural layer: it finds what has a recognisable shape — phone numbers,
 * emails, account numbers in context — with no database and no key.
 *
 *   "Ada bought 3 wigs for 150k, send receipt to ada@mail.com"
 *   → "Ada bought 3 wigs for 150k, send receipt to EMAIL_1"
 *
 * Names have no shape, so they are the second layer's job, in the gateway
 * service that holds the vault: every customer name Rekoda has been TOLD
 * (a confirmed sale, a resolved mention) is matched against the message and
 * replaced with that customer's token. A brand-new name reaches the model
 * exactly once — nothing knew it yet — comes back as a mention, is stored
 * encrypted with a token from that moment, and is caught by the known-name
 * pass ever after. No raw name is ever persisted along the way.
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
/**
 * The tokenisation policy the gateway currently enforces, recorded on every
 * AI usage row (spec Appendix C.4 observability): a reader of last month's
 * telemetry must be able to say which rules were in force when a text was
 * declared safe, without archaeology through git history.
 */
export const PRIVACY_POLICY_VERSION = 'tokenise-v1';

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

/** One identity the merchant typed for a token, and its normalised form. */
export interface TypedFacet {
  readonly facet: 'name' | 'phone' | 'email';
  readonly value: string;
  /** Normalised, so one number typed two ways is shown once. */
  readonly key: string;
}

const DISPLAY_ORDER = { name: 0, phone: 1, email: 2 } as const;

/**
 * What a token reads as in a reply, when the merchant named one customer by
 * more than one facet in one message (G-60).
 *
 * Every distinct facet they typed, name first, then phones, then emails, each
 * in the order typed, its spacing folded: "Ada Obi (08031234567)". Never one
 * facet standing in for another, and never decided by which pass happened to
 * run last.
 */
export function displayOf(typed: readonly TypedFacet[]): string {
  const seen = new Set<string>();
  const shown = [...typed]
    .map((t, i) => ({ ...t, i }))
    .sort((a, b) => DISPLAY_ORDER[a.facet] - DISPLAY_ORDER[b.facet] || a.i - b.i)
    .filter((t) => {
      const id = `${t.facet}:${t.key}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((t) => t.value.trim().replace(/\s+/g, ' '));
  const [first, ...rest] = shown;
  return rest.length > 0 ? `${first} (${rest.join(', ')})` : (first ?? '');
}

/** Every placeholder shape this pipeline writes: CUSTOMER_X81, PHONE_1, ACCOUNT_2. */
/* At its real length (CUSTOMER_ and three characters, PHONE_1, ACCOUNT_2),
 * so a pasted token never swallows letters glued after it ("CUSTOMER_ZZ9ADA"). */
const TOKEN_SHAPE = /\b(?:CUSTOMER_[0-9A-Z]{3}|(?:PHONE|EMAIL|ACCOUNT)_\d+)/g;

/**
 * The spans of `text` that are tokens, and so opaque to every later pass
 * (G-60): each token this message was given, wherever it stands, and anything
 * shaped like one that is not part of such a token, such as a token the
 * merchant pasted back from a preview. A shape never runs past a real token
 * into the letters glued after it ("CUSTOMER_X81ADA" keeps "ADA" readable).
 */
export function protectedSpans(
  text: string,
  tokens: Iterable<string>,
): Array<{ start: number; end: number }> {
  const exact: Array<{ start: number; end: number }> = [];
  for (const token of tokens) {
    for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + token.length)) {
      exact.push({ start: at, end: at + token.length });
    }
  }
  const shaped: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(TOKEN_SHAPE)) {
    const span = { start: m.index, end: m.index + m[0].length };
    if (!exact.some((e) => span.start < e.end && e.start < span.end)) shaped.push(span);
  }
  return [...exact, ...shaped].sort((a, b) => a.start - b.start);
}

/** The stretches of `text` between its tokens, which alone may hold a name. */
export function openSegments(
  text: string,
  tokens: Iterable<string>,
): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const span of protectedSpans(text, tokens)) {
    if (span.start > cursor) segments.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (cursor < text.length) segments.push({ start: cursor, end: text.length });
  return segments;
}

/**
 * The clitics after which a name still ends ("Ada'll", "Obi's"), a closed
 * list the gateway's known-name pass uses too. "'t" is not one ("don't").
 */
export const CLITIC_SUFFIXES = ['s', 'll', 'd', 've', 're', 'm'] as const;

/**
 * Replace `phrase` with `replacement` wherever it stands as whole words in
 * the text between tokens: case and spacing folded ("Ada   Obi"), and never
 * inside a token ("CUSTOMER_ADA" is not "Ada"). For a name the model resolved
 * after the message was stored (G-60).
 */
export function replaceOutsideTokens(
  text: string,
  phrase: string,
  replacement: string,
  tokens: Iterable<string>,
): string {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return text;
  const body = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  /* Whole words: not inside a longer word, and not the stem of a joined
   * word ("don't", "Mary-Ann"), though the stems the gateway takes still end
   * one: a clitic ("'s", "'ll", "'d", "'ve", "'re", "'m") or a figure ("-2"). */
  const letter = '[\\p{L}\\p{M}\\p{N}]';
  const clitic = `(?:${CLITIC_SUFFIXES.join('|')})(?!${letter})`;
  const pattern = new RegExp(
    `(?<!${letter}|${letter}['’-])${body}(?!${letter})(?!['’](?!${clitic})${letter})(?!-(?!\\d+(?!${letter}))${letter})`,
    'giu',
  );
  let out = '';
  let cursor = 0;
  for (const segment of openSegments(text, tokens)) {
    out += text.slice(cursor, segment.start);
    out += text.slice(segment.start, segment.end).replace(pattern, replacement);
    cursor = segment.end;
  }
  return out + text.slice(cursor);
}

/**
 * The first `length` code units of `text`, never ending on half of a
 * character made of two (an emoji): a lone surrogate is not text a
 * messaging provider will deliver.
 */
export function sliceWhole(text: string, length: number): string {
  const cut = text.slice(0, Math.max(0, length));
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
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
  const pattern = tokenPattern(tokens);
  /* One pass: a value put back is never read again, so a typed value that
   * spells another token stays as typed (G-60). */
  return pattern ? text.replace(pattern, (token) => tokens.get(token) ?? token) : text;
}

/** Every token, longest first, so CUSTOMER_1 never matches inside CUSTOMER_12. */
function tokenPattern(tokens: ReadonlyMap<string, string>): RegExp | null {
  if (tokens.size === 0) return null;
  const alternatives = [...tokens.keys()]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(alternatives.join('|'), 'g');
}

/**
 * The tokenised text to send so that both it and what leaves once
 * rehydrated are at most `max` characters (G-60). A display can be far
 * longer than its token, so a reply that fits in tokens need not fit in
 * people, and this is the ONLY cut a reply with tokens gets: never through a
 * token, never through a customer's identity, marked with an ellipsis. The
 * stored record is this text, so it says exactly what was sent. When even the
 * first identity cannot fit, it is kept whole and the sender's own backstop
 * shortens what leaves; that needs a single display of ~900 characters.
 */
export function fitRehydrated(
  text: string,
  tokens: ReadonlyMap<string, string>,
  max: number,
): string {
  if (text.length <= max && rehydrate(text, tokens).length <= max) return text;
  const pattern = tokenPattern(tokens);
  const budget = max - 1;
  const chunks: Array<{ raw: string; shown: string; token: boolean }> = [];
  let cursor = 0;
  for (const m of pattern ? text.matchAll(pattern) : []) {
    if (m.index > cursor) {
      const literal = text.slice(cursor, m.index);
      chunks.push({ raw: literal, shown: literal, token: false });
    }
    chunks.push({ raw: m[0], shown: tokens.get(m[0]) ?? m[0], token: true });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) {
    const literal = text.slice(cursor);
    chunks.push({ raw: literal, shown: literal, token: false });
  }
  let kept = '';
  let raw = 0;
  let shown = 0;
  for (const chunk of chunks) {
    if (raw + chunk.raw.length <= budget && shown + chunk.shown.length <= budget) {
      kept += chunk.raw;
      raw += chunk.raw.length;
      shown += chunk.shown.length;
      continue;
    }
    if (!chunk.token) kept += sliceWhole(chunk.raw, Math.min(budget - raw, budget - shown));
    else if (kept.trim() === '') kept += chunk.raw;
    break;
  }
  return `${kept.trimEnd()}…`;
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
