import { describe, expect, it } from 'vitest';
import {
  InvalidPhoneError,
  MAGIC_LINK_TTL_MS,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  SESSION_TTL_MS,
  generateOtpCode,
  hashOtpCode,
  hashSecret,
  issueMagicLink,
  issueOtp,
  issueSession,
  normaliseParticipant,
  normalisePhone,
  secretMatches,
  validateMagicLink,
  validateSession,
  verifyOtp,
  type RandomSource,
} from './identity.js';

const T0 = new Date('2026-08-19T10:00:00Z');
/** Test pepper — production supplies OTP_PEPPER. */
const PEPPER = 'test-pepper-at-least-thirty-two-chars-long';
const at = (ms: number) => new Date(T0.getTime() + ms);

/** Deterministic, and deliberately includes 250-255 so the rejection path runs. */
const seeded = (bytes: number[]): RandomSource => {
  let i = 0;
  return (n) => Uint8Array.from({ length: n }, () => bytes[i++ % bytes.length]!);
};
const fixed =
  (v: number): RandomSource =>
  (n) =>
    new Uint8Array(n).fill(v);

describe('phone normalisation', () => {
  it('resolves every way a merchant types their number to one identity', () => {
    // If these diverged, one merchant would end up with two businesses.
    for (const input of [
      '08031234567',
      '0803 123 4567',
      '+2348031234567',
      '234 803 123 4567',
      '+234-803-123-4567',
      '8031234567',
      '(0803) 123.4567',
    ]) {
      expect(normalisePhone(input)).toBe('+2348031234567');
    }
  });

  it('handles country code AND trunk prefix together', () => {
    // Regression: stripping only `234` left a leading 0 and threw, so a
    // merchant typing +234 0803 … — extremely common from saved contacts —
    // could not sign up at all.
    expect(normalisePhone('+2340803123 4567')).toBe('+2348031234567');
    expect(normalisePhone('234 0803 123 4567')).toBe('+2348031234567');
  });

  it('handles the 00 international access prefix', () => {
    expect(normalisePhone('002348031234567')).toBe('+2348031234567');
    expect(normalisePhone('00234 0803 123 4567')).toBe('+2348031234567');
  });

  it('accepts the 7/8/9 mobile prefixes', () => {
    expect(normalisePhone('07011111111')).toBe('+2347011111111');
    expect(normalisePhone('09011111111')).toBe('+2349011111111');
  });

  it('rejects what is not a Nigerian mobile number', () => {
    for (const bad of [
      '0801234567', // 9 digits
      '080312345678', // 11 digits
      '06031234567', // landline prefix
      '+447700900000', // not Nigeria
      'not a number',
      '',
    ]) {
      expect(() => normalisePhone(bad)).toThrow(InvalidPhoneError);
    }
  });
});

describe('participant normalisation (Appendix F; PR-060)', () => {
  it('keeps Nigerian numbers on the canonical form, so one person is one hash', () => {
    expect(normaliseParticipant('2348031234567')).toBe('+2348031234567');
    expect(normaliseParticipant('+234 803 123 4567')).toBe('+2348031234567');
    expect(normaliseParticipant('08031234567')).toBe('+2348031234567');
  });

  it("accepts a merchant's INTERNATIONAL customer, which normalisePhone must not", () => {
    expect(normaliseParticipant('447700900123')).toBe('+447700900123');
    expect(normaliseParticipant('+44 7700 900123')).toBe('+447700900123');
    expect(normaliseParticipant('0044 7700 900123')).toBe('+447700900123');
    expect(() => normalisePhone('447700900123')).toThrow(InvalidPhoneError);
  });

  it('refuses what cannot be a wa_id, rather than guessing an identity (F.8)', () => {
    for (const bad of ['', 'not-a-number', '0123', '1234567', '1234567890123456']) {
      expect(() => normaliseParticipant(bad)).toThrow(InvalidPhoneError);
    }
  });
});

describe('OTP code hashing', () => {
  it('is a PEPPERED hmac, not a plain digest — a 10^6 keyspace is trivially reversible', () => {
    // A leaked otp_challenges table must not yield working codes. Without a
    // server-side pepper, exhausting 000000-999999 takes under a second.
    const plain = hashSecret('123456');
    const peppered = hashOtpCode('123456', PEPPER);
    expect(peppered).not.toBe(plain);
    expect(peppered).toHaveLength(64);
  });

  it('produces a different hash under a different pepper', () => {
    expect(hashOtpCode('123456', PEPPER)).not.toBe(
      hashOtpCode('123456', 'another-pepper-at-least-thirty-two-chars'),
    );
  });

  it('refuses a pepper too short to be worth anything', () => {
    expect(() => hashOtpCode('123456', 'short')).toThrow(/at least 32/);
  });
});

describe('secret hashing', () => {
  it('never lets the plaintext be recoverable from what is stored', () => {
    const h = hashSecret('123456');
    expect(h).not.toContain('123456');
    expect(h).toHaveLength(64);
  });

  it('matches the right secret and rejects near-misses', () => {
    const h = hashSecret('123456');
    expect(secretMatches('123456', h)).toBe(true);
    expect(secretMatches('123457', h)).toBe(false);
    expect(secretMatches('12345', h)).toBe(false);
    expect(secretMatches('', h)).toBe(false);
  });

  it('survives a malformed stored hash instead of throwing', () => {
    expect(secretMatches('123456', 'deadbeef')).toBe(false);
    expect(secretMatches('123456', '')).toBe(false);
  });
});

describe('OTP codes', () => {
  it('is the configured length and digits only', () => {
    const code = generateOtpCode(seeded([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(code).toMatch(/^\d{6}$/);
  });

  it('rejects the non-uniform byte tail rather than biasing low digits', () => {
    // 250-255 would map to 0-5 under a naive `% 10`, shrinking the keyspace.
    const code = generateOtpCode(seeded([250, 251, 252, 253, 254, 255, 7]));
    expect(code).toBe('777777');
  });

  it('terminates even when every byte must be rejected before a usable one', () => {
    expect(generateOtpCode(seeded([255, 9]))).toBe('999999');
  });

  it('gives up loudly instead of spinning forever on a useless source', () => {
    // A source yielding only >=250 previously hung the request thread.
    expect(() => generateOtpCode(fixed(255))).toThrow(/no usable bytes/);
  });
});

describe('OTP verification', () => {
  const issue = () => issueOtp('08031234567', seeded([1, 2, 3, 4, 5, 6]), T0, PEPPER);

  it('stores only the hash and normalises the phone', () => {
    const { code, challenge } = issue();
    expect(challenge.codeHash).not.toContain(code);
    expect(challenge.phone).toBe('+2348031234567');
    expect(challenge.expiresAt).toEqual(at(OTP_TTL_MS));
  });

  it('verifies the right code and consumes the challenge', () => {
    const { code, challenge } = issue();
    const r = verifyOtp(challenge, code, at(1_000), PEPPER);
    expect(r.status).toBe('verified');
    if (r.status !== 'verified') throw new Error('unreachable');
    expect(r.challenge.consumedAt).toEqual(at(1_000));
  });

  it('cannot be replayed once consumed', () => {
    const { code, challenge } = issue();
    const first = verifyOtp(challenge, code, at(1_000), PEPPER);
    if (first.status !== 'verified') throw new Error('unreachable');
    expect(verifyOtp(first.challenge, code, at(2_000), PEPPER).status).toBe('already_used');
  });

  it('counts wrong attempts and locks out at the limit', () => {
    const { challenge } = issue();
    let current = challenge;
    for (let i = 1; i <= OTP_MAX_ATTEMPTS; i++) {
      const r = verifyOtp(current, '000000', at(1_000), PEPPER);
      expect(r.status).toBe('wrong_code');
      if (r.status !== 'wrong_code') throw new Error('unreachable');
      expect(r.attemptsLeft).toBe(OTP_MAX_ATTEMPTS - i);
      current = r.challenge;
    }
    expect(verifyOtp(current, '000000', at(1_000), PEPPER).status).toBe('too_many_attempts');
  });

  it('refuses the CORRECT code once the attempt limit is spent', () => {
    // Brute force must not be rescued by finally guessing right.
    const { code, challenge } = issue();
    let current = challenge;
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      const r = verifyOtp(current, '000000', at(1_000), PEPPER);
      if (r.status !== 'wrong_code') throw new Error('unreachable');
      current = r.challenge;
    }
    expect(verifyOtp(current, code, at(1_000), PEPPER).status).toBe('too_many_attempts');
  });

  it('expires exactly on the boundary, not a millisecond later', () => {
    const { code, challenge } = issue();
    expect(verifyOtp(challenge, code, at(OTP_TTL_MS - 1), PEPPER).status).toBe('verified');
    expect(verifyOtp(challenge, code, at(OTP_TTL_MS), PEPPER).status).toBe('expired');
  });

  it('treats a consumed-and-expired challenge as used, never as retryable', () => {
    const { code, challenge } = issue();
    const used = verifyOtp(challenge, code, at(1_000), PEPPER);
    if (used.status !== 'verified') throw new Error('unreachable');
    expect(verifyOtp(used.challenge, code, at(OTP_TTL_MS + 1), PEPPER).status).toBe('already_used');
  });

  it('never mutates the challenge it was given', () => {
    const { challenge } = issue();
    const snapshot = { ...challenge };
    verifyOtp(challenge, '000000', at(1_000), PEPPER);
    expect(challenge).toEqual(snapshot);
  });
});

describe('magic links', () => {
  it('stores only the hash, and the token is URL-safe', () => {
    const { token, link } = issueMagicLink(fixed(7), T0);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(link.tokenHash).not.toContain(token);
    expect(link.expiresAt).toEqual(at(MAGIC_LINK_TTL_MS));
  });

  it('is single-use — the second exchange is dead', () => {
    const { token, link } = issueMagicLink(fixed(7), T0);
    const first = validateMagicLink(link, token, at(1_000));
    expect(first.status).toBe('valid');
    if (first.status !== 'valid') throw new Error('unreachable');
    expect(validateMagicLink(first.link, token, at(2_000)).status).toBe('already_used');
  });

  it('expires on the boundary', () => {
    const { token, link } = issueMagicLink(fixed(7), T0);
    expect(validateMagicLink(link, token, at(MAGIC_LINK_TTL_MS - 1)).status).toBe('valid');
    expect(validateMagicLink(link, token, at(MAGIC_LINK_TTL_MS)).status).toBe('expired');
  });

  it('does not distinguish a wrong token from a used one', () => {
    // Telling an attacker "that token exists but is spent" is free information.
    const { link } = issueMagicLink(fixed(7), T0);
    expect(validateMagicLink(link, 'not-the-token', at(1_000)).status).toBe('already_used');
  });
});

describe('sessions', () => {
  it('stores only the hash', () => {
    const { token, session } = issueSession(fixed(3), T0);
    expect(session.tokenHash).not.toContain(token);
    expect(session.expiresAt).toEqual(at(SESSION_TTL_MS));
  });

  it('rolls the expiry forward on every valid use', () => {
    const { token, session } = issueSession(fixed(3), T0);
    const r = validateSession(session, token, at(1_000));
    if (r.status !== 'valid') throw new Error('unreachable');
    expect(r.session.expiresAt).toEqual(at(1_000 + SESSION_TTL_MS));
  });

  it('refuses a revoked session even while it is otherwise fresh', () => {
    const { token, session } = issueSession(fixed(3), T0);
    const revoked = { ...session, revokedAt: at(500) };
    expect(validateSession(revoked, token, at(1_000)).status).toBe('revoked');
  });

  it('cannot be resurrected by the rolling refresh once revoked', () => {
    const { token, session } = issueSession(fixed(3), T0);
    const revoked = { ...session, revokedAt: at(500) };
    const r = validateSession(revoked, token, at(SESSION_TTL_MS));
    expect(r.status).toBe('revoked');
  });

  it('expires on the boundary', () => {
    const { token, session } = issueSession(fixed(3), T0);
    expect(validateSession(session, token, at(SESSION_TTL_MS - 1)).status).toBe('valid');
    expect(validateSession(session, token, at(SESSION_TTL_MS)).status).toBe('expired');
  });

  it('rejects a token that is not this session', () => {
    const { session } = issueSession(fixed(3), T0);
    expect(validateSession(session, 'someone-elses-cookie', at(1_000)).status).toBe('unknown');
  });
});
