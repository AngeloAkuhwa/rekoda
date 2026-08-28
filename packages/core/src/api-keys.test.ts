import { describe, expect, it } from 'vitest';
import {
  API_KEY_PREFIX,
  issueApiKey,
  parseApiKey,
  rateWindowStart,
  retryAfterSeconds,
  shouldTouch,
  validateApiKey,
} from './api-keys.js';
import { hashSecret, type RandomSource } from './identity.js';

/** Deterministic bytes, so a token's shape is testable without a fixture. */
const counting: RandomSource = (n) => Buffer.from(Array.from({ length: n }, (_, i) => i % 256));

const live = { expiresAt: null, revokedAt: null, applicationStatus: 'active' };

describe('minting', () => {
  it('produces a recognisable prefix and a hash of the whole token', () => {
    const issued = issueApiKey(counting);
    expect(issued.prefix.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(issued.token.startsWith(issued.prefix)).toBe(true);
    expect(issued.tokenHash).toBe(hashSecret(issued.token));
  });

  it('never repeats a token across mints', () => {
    const tokens = new Set(
      Array.from({ length: 50 }, () => issueApiKey((n) => Buffer.from(cryptoBytes(n))).token),
    );
    expect(tokens.size).toBe(50);
  });
});

describe('parsing', () => {
  it('accepts a token it minted and recovers its prefix', () => {
    const issued = issueApiKey(counting);
    const parsed = parseApiKey(issued.token);
    expect(parsed).toEqual({ prefix: issued.prefix, tokenHash: issued.tokenHash });
  });

  it('refuses anything that is not shaped like a key, without hashing it', () => {
    for (const bad of [
      '',
      'rk_live_',
      'rk_live_zzzzzzzz_' + 'a'.repeat(64),
      'rk_test_00010203_' + 'a'.repeat(64),
      issueApiKey(counting).token.slice(0, -1),
      issueApiKey(counting).token + 'a',
      'Bearer ' + issueApiKey(counting).token,
    ]) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });
});

describe('validity', () => {
  const now = new Date('2026-08-28T10:00:00Z');

  it('passes a live key on an active application', () => {
    expect(validateApiKey(live, now)).toEqual({ status: 'valid' });
  });

  it('refuses a revoked key, and says revoked even after it would have expired', () => {
    const revoked = {
      ...live,
      revokedAt: new Date('2026-08-01T00:00:00Z'),
      expiresAt: new Date('2026-08-02T00:00:00Z'),
    };
    expect(validateApiKey(revoked, now)).toEqual({ status: 'revoked' });
  });

  it('refuses a key at the instant it expires, not a second later', () => {
    expect(validateApiKey({ ...live, expiresAt: now }, now)).toEqual({ status: 'expired' });
    expect(validateApiKey({ ...live, expiresAt: new Date(now.getTime() + 1) }, now)).toEqual({
      status: 'valid',
    });
  });

  it('refuses every key of a disabled application', () => {
    expect(validateApiKey({ ...live, applicationStatus: 'disabled' }, now)).toEqual({
      status: 'application_disabled',
    });
  });
});

describe('the rate window', () => {
  it('is the minute the moment falls in', () => {
    expect(rateWindowStart(new Date('2026-08-28T10:07:59.999Z')).toISOString()).toBe(
      '2026-08-28T10:07:00.000Z',
    );
    expect(rateWindowStart(new Date('2026-08-28T10:08:00.000Z')).toISOString()).toBe(
      '2026-08-28T10:08:00.000Z',
    );
  });

  it('never tells a refused caller to retry in zero seconds', () => {
    expect(retryAfterSeconds(new Date('2026-08-28T10:07:00.000Z'))).toBe(60);
    expect(retryAfterSeconds(new Date('2026-08-28T10:07:59.500Z'))).toBe(1);
  });
});

describe('last used', () => {
  const now = new Date('2026-08-28T10:00:00Z');

  it('writes when it has never been written', () => {
    expect(shouldTouch(null, now)).toBe(true);
  });

  it('holds the write inside the minute and takes it after', () => {
    expect(shouldTouch(new Date(now.getTime() - 59_000), now)).toBe(false);
    expect(shouldTouch(new Date(now.getTime() - 60_000), now)).toBe(true);
  });
});

function cryptoBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
