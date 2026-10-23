import { describe, expect, it } from 'vitest';
import { isRateLimitExempt } from './rate-limit-exempt.js';

describe('isRateLimitExempt (G-21)', () => {
  it.each(['/health', '/webhooks/meta', '/webhooks/paystack'])('exempts %s', (path) => {
    expect(isRateLimitExempt(path)).toBe(true);
  });

  it('exempts Meta’s handshake, whose URL carries a query string', () => {
    expect(
      isRateLimitExempt(
        '/webhooks/meta?hub.mode=subscribe&hub.verify_token=abc&hub.challenge=12345',
      ),
    ).toBe(true);
    expect(isRateLimitExempt('/health?probe=1')).toBe(true);
    expect(isRateLimitExempt('/webhooks/paystack?x=1')).toBe(true);
  });

  it.each([
    '/webhooks/meta/extra',
    '/webhooks/meta/',
    '/webhooks/metadata',
    '/health/deep',
    '/v1/auth/me',
    '/v1/auth/me?next=/webhooks/meta',
    '/webhooks',
    '/',
    '',
  ])('still counts %s', (url) => {
    expect(isRateLimitExempt(url)).toBe(false);
  });

  it('counts a request with no URL', () => {
    expect(isRateLimitExempt(undefined)).toBe(false);
  });
});
