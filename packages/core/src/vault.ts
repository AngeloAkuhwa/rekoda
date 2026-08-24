/**
 * The identity vault (ADR 0005, spec §5–8).
 *
 * Zone 1: the only place a customer's real name, number, email or address
 * exists, and even here it is ciphertext. Everything else in Rekoda — the
 * ledger, the AI layer, the logs — speaks tokens.
 *
 * Pure functions over an injected key. No database, no clock, no ambient
 * secret: the key arrives as an argument so the crypto can be tested against
 * known vectors and so no module can quietly reach for a global.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** AES-256-GCM. 12-byte IV is the size GCM is specified for. */
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION = 'v1';
/** Blobs whose tag also authenticates caller-supplied associated data. */
const AAD_VERSION = 'v2';

export class VaultError extends Error {
  override readonly name = 'VaultError';
}

/** The facets a customer identity can be split into, so each can be erased alone. */
export type IdentityFacet = 'name' | 'phone' | 'email' | 'address';

/**
 * Keys arrive as 64 hex characters — the output of `openssl rand -hex 32`,
 * which is what `.env.example` tells ops to run.
 */
function keyBuffer(hexKey: string, label: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(hexKey)) {
    throw new VaultError(`${label} must be 64 hex characters (openssl rand -hex 32)`);
  }
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== KEY_BYTES) throw new VaultError(`${label} must decode to 32 bytes`);
  return key;
}

/**
 * Encrypt one identity facet.
 *
 * A fresh random IV per call, always. Reusing an IV under the same key in GCM
 * does not merely weaken the ciphertext — it leaks the XOR of two plaintexts
 * and can expose the authentication subkey. There is no counter and no cache
 * here: the only safe IV is one nobody has planned.
 */
/**
 * `aad` binds a ciphertext to its PLACE. Without it, anyone with write
 * access to the database can move a valid blob between rows, facets or
 * tenants and it still decrypts — a settlement account cipher pasted onto a
 * different connection reads as that connection's account. With the row's
 * identity as associated data, a moved blob fails authentication instead.
 * Blobs written with aad carry the v2 prefix; v1 blobs stay readable.
 */
export function encryptFacet(plaintext: string, hexKey: string, aad?: string): string {
  const key = keyBuffer(hexKey, 'VAULT_KEY');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    aad ? AAD_VERSION : VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt, or throw. There is no "best effort" here: a failed auth tag means
 * the ciphertext was altered, and returning anything at all in that case would
 * put attacker-chosen bytes onto an invoice.
 */
export function decryptFacet(blob: string, hexKey: string, aad?: string): string {
  const key = keyBuffer(hexKey, 'VAULT_KEY');
  const parts = blob.split('.');
  if (parts.length !== 4 || (parts[0] !== VERSION && parts[0] !== AAD_VERSION)) {
    throw new VaultError('vault blob is malformed or of an unknown version');
  }
  const [version, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  /* A caller that binds demands a bound blob. Accepting a v1 blob on a read
   * that supplied aad would let anyone with database write access DOWNGRADE:
   * swap a bound cipher for an unbound one and the binding silently stops
   * checking. Refused OUTSIDE the try, so it says what it means: every
   * writer has produced v2 since binding shipped and no production data
   * predates it, so a v1 blob on a bound read is an alarm, not history. */
  if (aad !== undefined && version === VERSION) {
    throw new VaultError('a bound read refuses an unbound (v1) vault blob');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64url'));
    /* A v2 blob read WITHOUT its aad must equally fail, because "reads
     * anywhere" is the property v2 exists to remove. */
    if (version === AAD_VERSION) {
      decipher.setAAD(Buffer.from(aad ?? '', 'utf8'));
    }
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Deliberately opaque: which of "wrong key" or "tampered ciphertext" it
    // was is information an attacker would like and an operator does not need.
    throw new VaultError('vault blob failed authentication');
  }
}

/**
 * The deterministic key used to recognise a customer we have seen before.
 *
 * A bare hash would be useless here. A phone number has about 10^10
 * possibilities, so `sha256(phone)` is reversible by exhaustive search in
 * seconds — a leaked table would hand over every customer's number. This is a
 * keyed HMAC under a secret that is NOT stored beside the data.
 *
 * The business id is mixed in so the same phone yields a DIFFERENT key for
 * each business. Without that, a dump would reveal which merchants share a
 * customer — a correlation nobody consented to, and one that costs nothing to
 * prevent.
 */
export function matchKeyFor(
  businessId: string,
  facet: IdentityFacet,
  normalisedValue: string,
  hexMatchKey: string,
): string {
  const key = keyBuffer(hexMatchKey, 'MATCH_KEY');
  if (!normalisedValue) throw new VaultError('cannot derive a match key from an empty value');
  // Length-prefixed so ('ab','c') and ('a','bc') cannot collide.
  const message = [businessId, facet, normalisedValue]
    .map((part) => `${part.length}:${part}`)
    .join('|');
  return createHmac('sha256', key).update(message, 'utf8').digest('base64url');
}

/**
 * A match key for someone who has no tenant: a stranger messaging the number.
 *
 * `matchKeyFor` is business-scoped on purpose — two businesses must never be
 * able to correlate a customer through their keys. That scoping cannot apply
 * here, because the question this key answers ("have we greeted this number
 * yet") is global by nature and the person belongs to no business at all.
 *
 * The `contact:` domain prefix keeps it in a different keyspace from every
 * tenant-scoped key, so a value from here can never be mistaken for, or
 * matched against, an identity facet.
 */
export function contactKeyFor(normalisedValue: string, hexMatchKey: string): string {
  const key = keyBuffer(hexMatchKey, 'MATCH_KEY');
  if (!normalisedValue) throw new VaultError('cannot derive a contact key from an empty value');
  return createHmac('sha256', key)
    .update(`contact:${normalisedValue.length}:${normalisedValue}`, 'utf8')
    .digest('base64url');
}

/** Constant-time compare of two match keys. */
export function matchKeyEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Normalisation before hashing, so "0803 123 4567" and "+2348031234567" are
 * recognised as the same person. Matching is only as good as this is
 * consistent — the same value must normalise identically every time, forever,
 * or a returning customer silently becomes a new one.
 */
export function normaliseFacet(facet: IdentityFacet, raw: string): string {
  const value = raw.trim();
  switch (facet) {
    case 'phone':
      // Digits only, and the Nigerian trunk/country prefixes collapsed.
      return value
        .replace(/[^\d]/g, '')
        .replace(/^0*234/, '')
        .replace(/^0/, '');
    case 'email':
      return value.toLowerCase();
    case 'name':
      // Case and inner whitespace folded; punctuation kept, since "O'Neil"
      // and "ONeil" are plausibly different people.
      return value.toLowerCase().replace(/\s+/g, ' ');
    case 'address':
      return value.toLowerCase().replace(/\s+/g, ' ');
  }
}
