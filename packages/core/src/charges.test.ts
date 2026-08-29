import { describe, expect, it } from 'vitest';
import { computeCheckoutBreakdown, SurchargeNotConfigured } from './charges.js';

describe('the checkout breakdown (§19.1)', () => {
  const items = { label: 'Items', amountMinor: 100_000, taxCode: 'STANDARD_RATE' as const };
  const delivery = { label: 'Delivery', amountMinor: 3_000, taxCode: 'STANDARD_RATE' as const };

  it("the spec's own example: the charge outside the base", () => {
    const out = computeCheckoutBreakdown({
      lines: [items, delivery, { label: 'Payment charge', amountMinor: 1_500, taxCode: null }],
      vatRateBps: 750,
    });
    expect(out.taxableBaseMinor).toBe(103_000);
    expect(out.vatMinor).toBe(7_725);
    expect(out.totalMinor).toBe(112_225);
  });

  it("the spec's other configuration: the charge inside the base — both correct under their own configuration", () => {
    const out = computeCheckoutBreakdown({
      lines: [
        items,
        delivery,
        { label: 'Payment charge', amountMinor: 1_500, taxCode: 'STANDARD_RATE' },
      ],
      vatRateBps: 750,
    });
    expect(out.taxableBaseMinor).toBe(104_500);
    /* 7,837.5 rounds half-up in minor units. */
    expect(out.vatMinor).toBe(7_838);
    expect(out.totalMinor).toBe(112_338);
  });

  it('the base is stated, never inferred: a zero-rated line is in neither the base nor the VAT', () => {
    const out = computeCheckoutBreakdown({
      lines: [items, { label: 'Exported service', amountMinor: 50_000, taxCode: 'ZERO_RATED' }],
      vatRateBps: 750,
    });
    expect(out.taxableBaseMinor).toBe(100_000);
    expect(out.totalMinor).toBe(150_000 + 7_500);
  });

  it('a surcharge the merchant did not configure refuses to exist', () => {
    expect(() =>
      computeCheckoutBreakdown({
        lines: [
          items,
          { label: 'Card surcharge', amountMinor: 500, taxCode: null, type: 'SURCHARGE' },
        ],
        vatRateBps: 750,
      }),
    ).toThrow(SurchargeNotConfigured);
    /* Configured, it exists — the gate is the merchant's choice. */
    const out = computeCheckoutBreakdown({
      lines: [
        items,
        { label: 'Card surcharge', amountMinor: 500, taxCode: null, type: 'SURCHARGE' },
      ],
      vatRateBps: 750,
      surchargeConfigured: true,
    });
    expect(out.totalMinor).toBe(108_000);
  });

  it('no floating point near money: fractional minor units are refused', () => {
    expect(() =>
      computeCheckoutBreakdown({
        lines: [{ label: 'Items', amountMinor: 100.5, taxCode: 'STANDARD_RATE' }],
        vatRateBps: 750,
      }),
    ).toThrow(RangeError);
  });
});
