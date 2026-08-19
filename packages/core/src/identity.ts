/**
 * Passwordless identity rules (spec §36, MASTER-PLAN 5.2.2).
 *
 * Pure domain logic — no database, no clock, no randomness of its own. The
 * caller supplies `now` and a `RandomSource`, which is what makes every rule
 * below deterministically testable, including the ones that exist purely to
 * resist attack.
 *
 * What is deliberately NOT here: sending anything. Delivery is IO and belongs
 * to the channel layer.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Injected so tests are deterministic. In production: `crypto.randomBytes`. */
export type RandomSource = (bytes: number) => Uint8Array;

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60 * 1_000; // 10 minutes
export const OTP_MAX_ATTEMPTS = 5;
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1_000; // 15 minutes
export const MAGIC_LINK_BYTES = 32;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000; // 30 days, rolling

/* ────────────────────────────── phone ────────────────────────────── */

export class InvalidPhoneError extends Error {}

/**
 * Normalise a Nigerian mobile number to E.164.
 *
 * Merchants type these every way imaginable: `08031234567`, `234 803 123 4567`,
 * `+234-803-123-4567`. They must all resolve to ONE identity, or a merchant
 * ends up with two businesses and a split ledger.
 */
export function normalisePhone(input: string): string {
  const digits = input.replace(/[\s()\-.]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) throw new InvalidPhoneError(`not a phone number: ${input}`);

  let national: string;
  if (digits.startsWith('234')) national = digits.slice(3);
  else if (digits.startsWith('0')) national = digits.slice(1);
  else national = digits;

  // Nigerian mobile national significant numbers are 10 digits, leading 7/8/9.
  if (!/^[789]\d{9}$/.test(national)) {
    throw new InvalidPhoneError(`not a Nigerian mobile number: ${input}`);
  }
  return `+234${national}`;
}

/* ────────────────────────────── hashing ──────────────────────────── */

/**
 * Codes and tokens are stored ONLY as hashes. A database dump must never hand
 * anyone a working credential.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time compare — a fast `!==` leaks the code one character at a time. */
export function secretMatches(candidate: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(candidate), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ────────────────────────────── OTP ──────────────────────────────── */

export interface OtpChallenge {
  phone: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface IssuedOtp {
  /** Sent to the merchant. Never persisted. */
  code: string;
  challenge: OtpChallenge;
}

/**
 * Uniform across the digit range — `% 10` on a raw byte would bias 0–5,
 * shrinking the effective keyspace.
 */
export function generateOtpCode(random: RandomSource, length = OTP_LENGTH): string {
  let out = '';
  while (out.length < length) {
    for (const byte of random(length)) {
      if (byte >= 250) continue; // reject the non-uniform tail
      out += String(byte % 10);
      if (out.length === length) break;
    }
  }
  return out;
}

export function issueOtp(phone: string, random: RandomSource, now: Date): IssuedOtp {
  const normalised = normalisePhone(phone);
  const code = generateOtpCode(random);
  return {
    code,
    challenge: {
      phone: normalised,
      codeHash: hashSecret(code),
      attempts: 0,
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
      consumedAt: null,
    },
  };
}

export type OtpResult =
  | { status: 'verified'; challenge: OtpChallenge }
  | { status: 'wrong_code'; challenge: OtpChallenge; attemptsLeft: number }
  | { status: 'expired' }
  | { status: 'too_many_attempts' }
  | { status: 'already_used' };

/**
 * Never throws and never mutates its input — returns the next state, which the
 * caller persists in the same transaction that read it.
 *
 * Order matters: already-used before expiry before attempts, so a consumed
 * challenge can never be replayed by waiting for a different branch.
 */
export function verifyOtp(challenge: OtpChallenge, code: string, now: Date): OtpResult {
  if (challenge.consumedAt) return { status: 'already_used' };
  if (now >= challenge.expiresAt) return { status: 'expired' };
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) return { status: 'too_many_attempts' };

  if (secretMatches(code, challenge.codeHash)) {
    return { status: 'verified', challenge: { ...challenge, consumedAt: now } };
  }

  const attempts = challenge.attempts + 1;
  return {
    status: 'wrong_code',
    challenge: { ...challenge, attempts },
    attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - attempts),
  };
}

/* ─────────────────────────── magic links ─────────────────────────── */

export interface MagicLink {
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface IssuedMagicLink {
  /** Goes in the URL, exists only in the WhatsApp message. Never persisted. */
  token: string;
  link: MagicLink;
}

export function issueMagicLink(random: RandomSource, now: Date): IssuedMagicLink {
  const token = Buffer.from(random(MAGIC_LINK_BYTES)).toString('base64url');
  return {
    token,
    link: {
      tokenHash: hashSecret(token),
      expiresAt: new Date(now.getTime() + MAGIC_LINK_TTL_MS),
      usedAt: null,
    },
  };
}

export type MagicLinkResult =
  { status: 'valid'; link: MagicLink } | { status: 'expired' } | { status: 'already_used' };

/** Single use. A link that has been exchanged for a session is dead forever. */
export function validateMagicLink(link: MagicLink, token: string, now: Date): MagicLinkResult {
  if (link.usedAt) return { status: 'already_used' };
  if (now >= link.expiresAt) return { status: 'expired' };
  if (!secretMatches(token, link.tokenHash)) return { status: 'already_used' };
  return { status: 'valid', link: { ...link, usedAt: now } };
}

/* ───────────────────────────── sessions ──────────────────────────── */

export interface Session {
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface IssuedSession {
  /** The cookie value. Never persisted. */
  token: string;
  session: Session;
}

export function issueSession(random: RandomSource, now: Date): IssuedSession {
  const token = Buffer.from(random(MAGIC_LINK_BYTES)).toString('base64url');
  return {
    token,
    session: {
      tokenHash: hashSecret(token),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      revokedAt: null,
    },
  };
}

export type SessionResult =
  | { status: 'valid'; session: Session }
  | { status: 'expired' }
  | { status: 'revoked' }
  | { status: 'unknown' };

/**
 * Rolling expiry: every valid use pushes the deadline out, so an active
 * merchant is never logged out mid-sale. Revocation is checked first — a
 * revoked session must not be resurrected by the refresh.
 */
export function validateSession(session: Session, token: string, now: Date): SessionResult {
  if (session.revokedAt) return { status: 'revoked' };
  if (now >= session.expiresAt) return { status: 'expired' };
  if (!secretMatches(token, session.tokenHash)) return { status: 'unknown' };
  return {
    status: 'valid',
    session: { ...session, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) },
  };
}
