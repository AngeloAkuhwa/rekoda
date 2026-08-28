/**
 * API credentials, as rules (canonical spec §27).
 *
 * Same shape as `identity.ts` and for the same reason: no database, no clock,
 * no framework. Minting, parsing, validity and the rate-limit window are
 * decided here, so what the guard does is fetch a row and ask this file.
 *
 * Lives beside `identity` rather than inside it because the two answer
 * different questions. A session says WHICH PERSON is here and dies with
 * them. An API key says WHICH APPLICATION is here, was registered once, and
 * outlives every sign-in. Conflating them would put a machine credential on
 * the phone-number identity anchor, which is exactly the thing §36 refuses.
 */
import { hashSecret, type RandomSource } from './identity.js';

/**
 * The public half of every token. Deliberately recognisable: a secret
 * scanner, a log-line reviewer and a merchant reading a support ticket
 * should all be able to tell a leaked Rekoda key from a random hex string
 * without asking anybody.
 */
export const API_KEY_PREFIX = 'rk_live_';
/** Bytes of the prefix's random half. Eight hex characters, for display. */
export const API_KEY_PREFIX_BYTES = 4;
/** Bytes of the secret half. The part that actually authenticates. */
export const API_KEY_SECRET_BYTES = 32;

/**
 * Requests per minute a new key gets. Generous enough that no honest
 * integration meets it by accident, small enough that a leaked key cannot
 * drain the estate before anybody notices. A per-key ceiling rather than a
 * per-business one, so one noisy integration cannot spend another's room.
 */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

/**
 * Live keys one application may hold at once.
 *
 * A rotation needs two — the new key working before the old one dies — so
 * this is headroom over the only operation that legitimately needs more than
 * one. It exists because unbounded minting is how a stolen session quietly
 * becomes permanent access: revoking the key that was used tells you nothing
 * about the four the same thief minted on the way out.
 */
export const MAX_LIVE_KEYS_PER_APPLICATION = 5;

/** The rate window. One minute, so a refusal is never far from expiring. */
export const RATE_WINDOW_MS = 60 * 1_000;

export interface IssuedApiKey {
  /** The whole token. It exists here and in one HTTP response, nowhere else. */
  token: string;
  prefix: string;
  tokenHash: string;
}

/** Mint a token: a recognisable prefix, then 32 random bytes of secret. */
export function issueApiKey(random: RandomSource): IssuedApiKey {
  const prefix = API_KEY_PREFIX + Buffer.from(random(API_KEY_PREFIX_BYTES)).toString('hex');
  const secret = Buffer.from(random(API_KEY_SECRET_BYTES)).toString('hex');
  const token = `${prefix}_${secret}`;
  return { token, prefix, tokenHash: hashSecret(token) };
}

const TOKEN_SHAPE = new RegExp(
  `^${API_KEY_PREFIX}[0-9a-f]{${API_KEY_PREFIX_BYTES * 2}}_[0-9a-f]{${API_KEY_SECRET_BYTES * 2}}$`,
);

/**
 * Read a presented token, or refuse it without touching the database.
 *
 * Shape first, hash second. A caller sending a session token, a JWT or a
 * paste of their own password should be turned away by arithmetic — every
 * malformed bearer that reaches the key lookup is a free query, and under a
 * flood that is the query that hurts.
 */
export function parseApiKey(raw: string): { prefix: string; tokenHash: string } | null {
  if (!TOKEN_SHAPE.test(raw)) return null;
  return {
    prefix: raw.slice(0, API_KEY_PREFIX.length + API_KEY_PREFIX_BYTES * 2),
    tokenHash: hashSecret(raw),
  };
}

export interface ApiKeyFacts {
  expiresAt: Date | null;
  revokedAt: Date | null;
  applicationStatus: string;
}

export type ApiKeyResult =
  | { status: 'valid' }
  | { status: 'revoked' }
  | { status: 'expired' }
  | { status: 'application_disabled' };

/**
 * Whether a resolved key may be used right now.
 *
 * Revocation is checked before expiry so a key that was killed and has since
 * aged out still reports the fact somebody killed it — the answer support
 * needs after a leak.
 */
export function validateApiKey(key: ApiKeyFacts, now: Date): ApiKeyResult {
  if (key.revokedAt) return { status: 'revoked' };
  if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) return { status: 'expired' };
  if (key.applicationStatus !== 'active') return { status: 'application_disabled' };
  return { status: 'valid' };
}

/** The minute a moment falls in. The rate counter's key. */
export function rateWindowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / RATE_WINDOW_MS) * RATE_WINDOW_MS);
}

/** Seconds until the current window closes. What a 429 puts in Retry-After. */
export function retryAfterSeconds(now: Date): number {
  const elapsed = now.getTime() - rateWindowStart(now).getTime();
  return Math.max(1, Math.ceil((RATE_WINDOW_MS - elapsed) / 1_000));
}

/**
 * Whether `last_used_at` is stale enough to be worth a write.
 *
 * The same reasoning as the session's rolling expiry: writing the column on
 * every request means a database write per API call and buys nothing, since
 * a key is no more in use for having been touched twice in the same minute.
 * "Last used" to the minute is what the answer is for.
 */
export function shouldTouch(lastUsedAt: Date | null, now: Date): boolean {
  return !lastUsedAt || now.getTime() - lastUsedAt.getTime() >= RATE_WINDOW_MS;
}
