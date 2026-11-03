import { describe, expect, it } from 'vitest';
import { chargeGate, paystackKeyKind } from './paystack-key.js';

/*
 * §47 (ADR 0024, OWN-70, 3 Nov 2026): REKODA_PAYSTACK_PLATFORM_CONFIRMED means the
 * written Paystack platform confirmation was received. It is required for every live-key charge and
 * is irrelevant to a test key, whose money is never real. A key Rekoda does not recognise is neither:
 * it fails closed.
 */
describe('paystackKeyKind', () => {
  it('reads Paystack test and live secret keys by their exact prefix', () => {
    expect(paystackKeyKind('sk_test_abc123')).toBe('test');
    expect(paystackKeyKind('sk_live_abc123')).toBe('live');
  });

  it('calls an empty key missing', () => {
    expect(paystackKeyKind('')).toBe('missing');
  });

  it('never reads an unfamiliar shape as test or live', () => {
    for (const key of [
      'sk_live',
      'sk_livex123',
      'sk_test',
      'sk_testx123',
      'sk_test_',
      'sk_live_',
      'pk_test_abc123',
      'pk_live_abc123',
      ' sk_test_abc123',
      'sk_test_abc 123',
      'SK_LIVE_abc123',
      'garbage',
    ]) {
      expect(paystackKeyKind(key), key).toBe('unrecognised');
    }
  });
});

describe('chargeGate', () => {
  const gate = (paystackSecretKey: string, paystackPlatformConfirmed: boolean) =>
    chargeGate({ paystackSecretKey, paystackPlatformConfirmed });

  it('lets a test key open a charge whether or not §47 is confirmed', () => {
    expect(gate('sk_test_x', false)).toEqual({ ok: true, kind: 'test' });
    expect(gate('sk_test_x', true)).toEqual({ ok: true, kind: 'test' });
  });

  it('refuses a live key until §47 is confirmed', () => {
    expect(gate('sk_live_x', false)).toEqual({
      ok: false,
      reason: 'awaiting_platform_confirmation',
    });
  });

  it('lets a live key open a charge once §47 is confirmed', () => {
    expect(gate('sk_live_x', true)).toEqual({ ok: true, kind: 'live' });
  });

  it('fails closed for a missing or unrecognised key, whatever the flag says', () => {
    for (const key of ['', 'sk_livex', 'pk_live_x', 'garbage']) {
      for (const confirmed of [false, true]) {
        expect(gate(key, confirmed), `${key}/${confirmed}`).toEqual({
          ok: false,
          reason: 'payments_not_configured',
        });
      }
    }
  });
});
