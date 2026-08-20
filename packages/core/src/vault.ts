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
export function encryptFacet(plaintext: string, hexKey: string): string {
  const key = keyBuffer(hexKey, 'VAULT_KEY');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
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
export function decryptFacet(blob: string, hexKey: string): string {
  const key = keyBuffer(hexKey, 'VAULT_KEY');
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new VaultError('vault blob is malformed or of an unknown version');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64url'));
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
