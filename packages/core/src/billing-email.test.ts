import { describe, expect, it } from 'vitest';
import {
  BILLING_EMAIL_VERIFICATION,
  billingEmailConfirmationLink,
  checkBillingEmail,
  maskBillingEmail,
} from './billing-email.js';

describe('checkBillingEmail (G-102, OWN-39)', () => {
  it('keeps a normal address, trimmed and lower-cased', () => {
    expect(checkBillingEmail('  Ada.Fashion+bills@Example.NG ')).toEqual({
      ok: true,
      email: 'ada.fashion+bills@example.ng',
    });
  });

  it.each([
    '',
    'ada',
    'ada@',
    '@example.ng',
    'ada@example',
    'ada@@example.ng',
    'a b@example.ng',
    'ada..lee@example.ng',
    '.ada@example.ng',
    'ada.@example.ng',
    'ada@-example.ng',
    'ada@example..ng',
    'ada@example.n',
    'ada@example.123',
    'ada@exa_mple.ng',
  ])('refuses %j as invalid', (raw) => {
    expect(checkBillingEmail(raw)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses an address past the RFC length limits', () => {
    expect(checkBillingEmail(`${'a'.repeat(65)}@example.ng`)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(checkBillingEmail(`a@${'b'.repeat(250)}.ng`)).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });

  it.each(['support@rekoda.app', 'Billing@REKODA.NG', 'x@mail.rekoda.com'])(
    'refuses %s: it is one of Rekoda’s own domains',
    (raw) => {
      expect(checkBillingEmail(raw)).toEqual({ ok: false, reason: 'reserved' });
    },
  );

  it('does not mistake a lookalike domain for ours', () => {
    expect(checkBillingEmail('ada@notrekoda.app').ok).toBe(true);
    expect(checkBillingEmail('ada@rekoda.app.example.com').ok).toBe(true);
  });
});

describe('proving the mailbox (G-102 slice 2b, OWN-51)', () => {
  it('keeps the rules tight enough to be a proof', () => {
    expect(BILLING_EMAIL_VERIFICATION.ttlMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect(BILLING_EMAIL_VERIFICATION.cooldownMs).toBeGreaterThan(0);
    expect(BILLING_EMAIL_VERIFICATION.maxPerHour).toBeGreaterThan(0);
  });

  it.each([
    ['ada@shop.example.ng', 'a**@shop.example.ng'],
    ['a@shop.example.ng', 'a@shop.example.ng'],
    ['ab@x.io', 'a*@x.io'],
    ['averyveryverylonglocalpart@example.ng', 'a********@example.ng'],
  ])('masks %s as %s', (raw, masked) => {
    expect(maskBillingEmail(raw)).toBe(masked);
  });

  it('never reveals more of the local part than its first character', () => {
    const masked = maskBillingEmail('secret.person@example.ng');
    expect(masked).not.toContain('secret');
    expect(masked.startsWith('s')).toBe(true);
    expect(maskBillingEmail('not-an-address')).toBe('***');
  });

  it('puts the token in the fragment, which a browser never sends to a server', () => {
    const link = billingEmailConfirmationLink('https://app.example.ng/', 'abc-DEF_123');
    expect(link).toBe('https://app.example.ng/app/billing/confirm-email#token=abc-DEF_123');
    expect(new URL(link).search).toBe('');
    expect(new URL(link).hash).toContain('abc-DEF_123');
  });

  it('encodes a token that is not URL-safe rather than splitting the link', () => {
    const link = billingEmailConfirmationLink('https://app.example.ng', 'a b&c=d');
    expect(link.endsWith('#token=a%20b%26c%3Dd')).toBe(true);
  });
});
