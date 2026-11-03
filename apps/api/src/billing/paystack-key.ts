/**
 * Which Paystack world a platform secret key belongs to, and whether a Rekoda charge may be opened
 * with it (spec §47, ADR 0024; OWN-70, 3 Nov 2026).
 *
 * `REKODA_PAYSTACK_PLATFORM_CONFIRMED` means one thing: the written Paystack platform-model
 * confirmation has been received. It therefore gates every LIVE-key charge, and is irrelevant to a
 * TEST key, whose money is never real. A key that is missing, or of a shape Rekoda does not
 * recognise, opens nothing: it fails closed, whatever the flag says.
 *
 * Paystack secret keys are `sk_test_…` or `sk_live_…`. The prefix is matched exactly, so `sk_livex`
 * or a public `pk_…` key is unrecognised rather than read as one or the other.
 */
export type PaystackKeyKind = 'test' | 'live' | 'missing' | 'unrecognised';

const TEST_KEY = /^sk_test_\S+$/;
const LIVE_KEY = /^sk_live_\S+$/;

export function paystackKeyKind(key: string): PaystackKeyKind {
  if (key === '') return 'missing';
  if (TEST_KEY.test(key)) return 'test';
  if (LIVE_KEY.test(key)) return 'live';
  return 'unrecognised';
}

export type ChargeGate =
  | { ok: true; kind: 'test' | 'live' }
  | { ok: false; reason: 'payments_not_configured' | 'awaiting_platform_confirmation' };

/** Decides, before any charge row or provider call exists, whether a Rekoda charge may proceed. */
export function chargeGate(config: {
  paystackSecretKey: string;
  paystackPlatformConfirmed: boolean;
}): ChargeGate {
  const kind = paystackKeyKind(config.paystackSecretKey);
  if (kind === 'test') return { ok: true, kind };
  if (kind === 'live') {
    return config.paystackPlatformConfirmed
      ? { ok: true, kind }
      : { ok: false, reason: 'awaiting_platform_confirmation' };
  }
  return { ok: false, reason: 'payments_not_configured' };
}
