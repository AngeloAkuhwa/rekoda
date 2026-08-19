/**
 * The Payment Hub's domain rules (docs/payments-v1.md).
 *
 * The two rules that carry real money risk get the adversarial attention: the
 * judgement (§21 — ₦90,000 must never mark a ₦100,000 invoice paid) and the
 * fee split (§15 — a processor fee must never inflate revenue). Both are the
 * kind of bug that looks like profit until an accountant finds it.
 */
import { describe, expect, it } from 'vitest';
import {
  isTerminalIntentStatus,
  judgeProviderPayment,
  paymentReference,
  PAYMENT_REFERENCE_PATTERN,
  splitFees,
  type ExpectedPayment,
} from './payments.js';

const EXPECTED: ExpectedPayment = {
  reference: 'RKD-PAY-20260819-A83F92',
  amountK: 10_000_000, // ₦100,000
  currency: 'NGN',
};

const reported = (overrides: Partial<Parameters<typeof judgeProviderPayment>[1]> = {}) => ({
  reference: EXPECTED.reference,
  amountK: EXPECTED.amountK,
  currency: 'NGN',
  succeeded: true,
  ...overrides,
});

describe('judging a provider payment (§21–22)', () => {
  it('confirms an exact match as matched', () => {
    expect(judgeProviderPayment(EXPECTED, reported())).toEqual({
      verdict: 'confirmed',
      amountK: 10_000_000,
      reconciliation: 'matched',
    });
  });

  it('NEVER lets ₦90,000 mark a ₦100,000 invoice paid', () => {
    /**
     * The spec's own scenario. The transfer is real — the merchant's bank
     * statement shows it — so the payment confirms; but it confirms as
     * partial_match, and it is the reconciliation state, not the confirmation,
     * that decides whether an invoice becomes PAID.
     */
    const judgement = judgeProviderPayment(EXPECTED, reported({ amountK: 9_000_000 }));
    expect(judgement).toEqual({
      verdict: 'confirmed',
      amountK: 9_000_000,
      reconciliation: 'partial_match',
    });
  });

  it('confirms an overpayment as overpaid rather than rounding it away', () => {
    // Same principle as the money engine: an overpayment is a real event with
    // a real meaning, surfaced for a human, never silently clamped.
    expect(judgeProviderPayment(EXPECTED, reported({ amountK: 12_000_000 }))).toEqual({
      verdict: 'confirmed',
      amountK: 12_000_000,
      reconciliation: 'overpaid',
    });
  });

  it('rejects an event the provider itself did not call successful', () => {
    expect(judgeProviderPayment(EXPECTED, reported({ succeeded: false }))).toEqual({
      verdict: 'rejected',
      reason: 'provider_not_success',
    });
  });

  it('rejects a reference that is not ours — whatever the amount says', () => {
    // The right amount under the wrong reference is somebody else's money.
    expect(
      judgeProviderPayment(EXPECTED, reported({ reference: 'RKD-PAY-20260819-ZZZZZZ' })),
    ).toEqual({ verdict: 'rejected', reason: 'reference_mismatch' });
  });

  it('rejects a currency mismatch instead of comparing raw numbers', () => {
    // 10_000_000 subunits of USD is not 10_000_000 kobo. Comparing the bare
    // integers would confirm a hundred-fold error as "matched".
    expect(judgeProviderPayment(EXPECTED, reported({ currency: 'USD' }))).toEqual({
      verdict: 'rejected',
      reason: 'currency_mismatch',
    });
  });

  it('treats currency case-insensitively — ngn is NGN, not a mismatch', () => {
    expect(judgeProviderPayment(EXPECTED, reported({ currency: 'ngn' })).verdict).toBe('confirmed');
  });

  it.each([0, -5_000, 10.5, Number.NaN])(
    'rejects a non-positive or fractional amount: %p',
    (amountK) => {
      expect(judgeProviderPayment(EXPECTED, reported({ amountK })).verdict).toBe('rejected');
    },
  );
});

describe('the fee split (§15) — fees never distort revenue', () => {
  const INVOICE = 10_000_000; // ₦100,000
  const FEE = 30_000; // ₦300

  it('books the spec`s own example correctly', () => {
    // ₦100,000 invoice, ₦300 customer charge → ₦100,300 paid, ₦100,000 revenue.
    const split = splitFees({
      invoiceAmountK: INVOICE,
      providerFeeK: FEE,
      policy: 'customer_bearing',
    });
    expect(split.revenueK).toBe(10_000_000);
    expect(split.customerPaysK).toBe(10_030_000);
    expect(split.merchantSettlementK).toBe(10_000_000);
  });

  it('holds revenue at the invoice amount under EVERY policy', () => {
    for (const policy of ['customer_bearing', 'merchant_bearing', 'platform_bearing'] as const) {
      const split = splitFees({ invoiceAmountK: INVOICE, providerFeeK: FEE, policy });
      // The invariant this function exists for. Whoever bears the fee, the
      // sale did not get bigger.
      expect(split.revenueK).toBe(INVOICE);
    }
  });

  it('takes a merchant-borne fee out of settlement, not out of the sale', () => {
    const split = splitFees({
      invoiceAmountK: INVOICE,
      providerFeeK: FEE,
      policy: 'merchant_bearing',
    });
    expect(split.customerPaysK).toBe(INVOICE);
    expect(split.merchantSettlementK).toBe(9_970_000);
  });

  it('makes Rekoda absorb the provider fee under platform_bearing', () => {
    const split = splitFees({
      invoiceAmountK: INVOICE,
      providerFeeK: FEE,
      policy: 'platform_bearing',
    });
    expect(split.merchantSettlementK).toBe(INVOICE);
    expect(split.platformAbsorbsK).toBe(FEE);
  });

  it('refuses floats and negatives — money here is integer kobo or nothing', () => {
    expect(() =>
      splitFees({ invoiceAmountK: 100.5, providerFeeK: 0, policy: 'customer_bearing' }),
    ).toThrow();
    expect(() =>
      splitFees({ invoiceAmountK: 1_000, providerFeeK: -1, policy: 'customer_bearing' }),
    ).toThrow();
  });
});

describe('the Rekoda reference (§9)', () => {
  const fixedRandom = (n: number) => new Uint8Array(n).fill(7);

  it('has the documented shape, with the mint date inside it', () => {
    const ref = paymentReference(new Date('2026-08-19T23:59:00Z'), fixedRandom);
    expect(ref).toMatch(PAYMENT_REFERENCE_PATTERN);
    expect(ref.startsWith('RKD-PAY-20260819-')).toBe(true);
  });

  it('never emits the ambiguous letters I, L, O, U', () => {
    // These references get read to a bank's support line over the phone.
    const bytes = new Uint8Array(256).map((_, i) => i);
    let cursor = 0;
    const walkingRandom = (n: number) => bytes.slice(cursor, (cursor += n));
    for (let i = 0; i < 40; i++) {
      const suffix = paymentReference(new Date(), walkingRandom).slice(-6);
      expect(suffix).not.toMatch(/[ILOU]/);
    }
  });

  it('leans on the database for uniqueness, not on luck being cheap', () => {
    // Same random source twice → same reference. Uniqueness is the unique
    // index's job; this documents that the generator makes no such promise.
    const a = paymentReference(new Date('2026-08-19T10:00:00Z'), fixedRandom);
    const b = paymentReference(new Date('2026-08-19T10:00:00Z'), fixedRandom);
    expect(a).toBe(b);
  });
});

describe('terminal intents', () => {
  it.each(['succeeded', 'failed', 'expired', 'cancelled'] as const)(
    '%s accepts no further transitions',
    (status) => {
      // A webhook arriving after expiry must not resurrect an intent.
      expect(isTerminalIntentStatus(status)).toBe(true);
    },
  );

  it.each(['created', 'awaiting_provider', 'awaiting_customer', 'processing'] as const)(
    '%s is still live',
    (status) => {
      expect(isTerminalIntentStatus(status)).toBe(false);
    },
  );
});
