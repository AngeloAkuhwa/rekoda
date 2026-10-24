import { describe, expect, it } from 'vitest';
import { checkBillingEmail } from './billing-email.js';

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
