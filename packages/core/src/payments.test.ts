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
  estimateProviderFeeMinor,
  isTerminalIntentStatus,
  judgeProviderPayment,
  paymentReference,
  PAYMENT_REFERENCE_PATTERN,
  splitFees,
  type ExpectedPayment,
  capabilityBlockers,
  resolvePaymentProvider,
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

describe('the provider resolver (§17, §18; PR-068)', () => {
  /**
   * A platform capability on its three axes (PR-119). `open()` is the
   * everyday case; a closed axis is named individually, because that is
   * the whole reason the axes are separate.
   */
  const cap = (
    providerType: string,
    axes: {
      technicalSupport?: boolean;
      commercialApproval?: boolean;
      complianceApproval?: boolean;
      technicalNote?: string;
      commercialNote?: string;
      complianceNote?: string;
    } = {},
  ) => {
    const technicalSupport = axes.technicalSupport ?? true;
    const commercialApproval = axes.commercialApproval ?? true;
    const complianceApproval = axes.complianceApproval ?? true;
    return {
      providerType,
      capability: 'COLLECT' as const,
      technicalSupport,
      commercialApproval,
      complianceApproval,
      technicalNote: axes.technicalNote ?? null,
      commercialNote: axes.commercialNote ?? null,
      complianceNote: axes.complianceNote ?? null,
      /* The database generates this; here it is derived the same way, and
       * the test below proves the resolver reads it rather than guessing. */
      productionEnabled: technicalSupport && commercialApproval && complianceApproval,
    };
  };
  const conn = (
    connectionId: string,
    providerType: string,
    productionEnabled: boolean,
    connectedAtMs = 0,
  ) => ({ connectionId, providerType, productionEnabled, connectedAtMs });

  it('picks from capability and compliance, never a hardcoded default', () => {
    const outcome = resolvePaymentProvider(
      'COLLECT',
      [conn('c-mono', 'mono', true, 1), conn('c-pst', 'paystack', true, 2)],
      [
        cap('paystack'),
        cap('mono', {
          commercialApproval: false,
          commercialNote: 'OPEN COMMERCIAL: Mono production terms',
        }),
      ],
    );
    /* Mono is OLDER but blocked at the platform — capability decides. */
    expect(outcome).toEqual({ resolved: true, connectionId: 'c-pst', providerType: 'paystack' });
  });

  it('refuses with the blocker BY NAME when no capable provider remains', () => {
    const outcome = resolvePaymentProvider(
      'COLLECT',
      [conn('c-mono', 'mono', true)],
      [
        cap('mono', {
          commercialApproval: false,
          commercialNote: 'OPEN COMMERCIAL: Mono production terms',
        }),
      ],
    );
    expect(outcome).toEqual({
      resolved: false,
      reason: 'no_capable_provider',
      detail: ['OPEN COMMERCIAL: Mono production terms'],
    });
  });

  it("refuses when the merchant's own axes do not derive production-enabled", () => {
    const outcome = resolvePaymentProvider(
      'COLLECT',
      [conn('c-pst', 'paystack', false)],
      [cap('paystack')],
    );
    expect(outcome).toEqual({
      resolved: false,
      reason: 'not_production_enabled',
      providerTypes: ['paystack'],
    });
  });

  it('a working sandbox is one axis, and one axis never opens production', () => {
    /* The owner's sentence of 28 Aug 2026, as a property: "do not let
     * sandbox works turn that boolean on". Passing tests set
     * `technicalSupport`; production still needs two more signatures, and
     * the refusal names both of the people who have not given theirs. */
    const sandboxOnly = cap('kuda', {
      commercialApproval: false,
      commercialNote: 'OPEN COMMERCIAL: Kuda production commercial terms',
      complianceApproval: false,
      complianceNote: 'OPEN COMPLIANCE: Kuda regulatory approval',
    });
    expect(sandboxOnly.technicalSupport).toBe(true);
    expect(sandboxOnly.productionEnabled).toBe(false);

    const outcome = resolvePaymentProvider(
      'COLLECT',
      [conn('c-kuda', 'kuda', true)],
      [sandboxOnly],
    );
    expect(outcome).toEqual({
      resolved: false,
      reason: 'no_capable_provider',
      detail: [
        'OPEN COMMERCIAL: Kuda production commercial terms',
        'OPEN COMPLIANCE: Kuda regulatory approval',
      ],
    });
  });

  it('names every closed axis, because a merchant told one at a time waits twice', () => {
    expect(capabilityBlockers(cap('paystack'))).toEqual([]);
    expect(
      capabilityBlockers(
        cap('mono', { commercialApproval: false, commercialNote: 'terms unsigned' }),
      ),
    ).toEqual(['terms unsigned']);
    expect(
      capabilityBlockers(
        cap('nobody', {
          technicalSupport: false,
          commercialApproval: false,
          complianceApproval: false,
        }),
      ),
    ).toEqual([
      'nobody: no adapter',
      'nobody: no commercial approval',
      'nobody: no compliance approval',
    ]);
  });

  it('no connection is its own refusal, and seniority breaks a tie deterministically', () => {
    expect(resolvePaymentProvider('COLLECT', [], [cap('paystack')])).toEqual({
      resolved: false,
      reason: 'no_connection',
    });
    const tie = resolvePaymentProvider(
      'COLLECT',
      [conn('c-new', 'paystack', true, 200), conn('c-old', 'paystack', true, 100)],
      [cap('paystack')],
    );
    expect(tie).toEqual({ resolved: true, connectionId: 'c-old', providerType: 'paystack' });
  });
});

describe('estimateProviderFeeMinor (§19.1, §24; PR-072)', () => {
  /* Paystack's local-card pricing as the schedule observes it:
   * 1.5% + N100, capped N2,000, the N100 waived below N2,500. */
  const localCard = {
    percentPpm: 15_000,
    flatMinor: 10_000,
    capMinor: 200_000,
    waiveFlatUnderMinor: 250_000,
  };

  it('derives percentage plus flat from the observation', () => {
    /* N100,000: 1.5% is N1,500, plus the N100 flat. */
    expect(estimateProviderFeeMinor(localCard, 10_000_000)).toBe(160_000);
  });

  it('caps the WHOLE fee, not just the percentage', () => {
    /* N1,000,000: 1.5% alone is N15,000; the card says N2,000 and stops. */
    expect(estimateProviderFeeMinor(localCard, 100_000_000)).toBe(200_000);
  });

  it('waives the flat part below the threshold, and only below it', () => {
    /* N2,000 is under N2,500: percentage only. */
    expect(estimateProviderFeeMinor(localCard, 200_000)).toBe(3_000);
    /* N2,500 exactly is NOT under the threshold: the flat fee applies. */
    expect(estimateProviderFeeMinor(localCard, 250_000)).toBe(13_750);
  });

  it('rounds the percentage UP — every cost modelled at or above market', () => {
    /* 1 kobo at 1.5% is 0.015 kobo; the estimate says 1, never 0. */
    expect(estimateProviderFeeMinor({ ...localCard, waiveFlatUnderMinor: null }, 1)).toBe(10_001);
  });

  it('an uncapped rate is honoured as uncapped', () => {
    expect(
      estimateProviderFeeMinor(
        { percentPpm: 10_000, flatMinor: 0, capMinor: null, waiveFlatUnderMinor: null },
        100_000_000,
      ),
    ).toBe(1_000_000);
  });

  it('the transfer card: 1% capped N300', () => {
    const transfer = {
      percentPpm: 10_000,
      flatMinor: 0,
      capMinor: 30_000,
      waiveFlatUnderMinor: null,
    };
    expect(estimateProviderFeeMinor(transfer, 2_000_000)).toBe(20_000);
    expect(estimateProviderFeeMinor(transfer, 5_000_000)).toBe(30_000);
  });
});
