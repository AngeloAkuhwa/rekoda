/**
 * The separated tax calculator (spec §13; PR-079). The claims: the
 * arithmetic matches the checkout breakdown's rounding to the kobo, a
 * non-taxable treatment answers zero whatever rate rides along, and a
 * point policy whose moment has not happened answers null — never an
 * invented date.
 */
import { describe, expect, it } from 'vitest';
import { calculateTax, taxPointFor } from './tax.js';

describe('calculateTax (§13)', () => {
  it('computes Nigerian VAT with half-up rounding on the last kobo', () => {
    /* ₦100,000 at 7.5%: ₦7,500 exactly. */
    expect(calculateTax({ basisMinor: 10_000_000, rateBps: 750, treatment: 'TAXABLE' })).toBe(
      750_000,
    );
    /* 67 kobo at 7.5% is 5.025 kobo: rounds half-up to 5. */
    expect(calculateTax({ basisMinor: 67, rateBps: 750, treatment: 'TAXABLE' })).toBe(5);
    /* 66 kobo at 7.5% is 4.95: rounds to 5 as well — half-up, not floor. */
    expect(calculateTax({ basisMinor: 66, rateBps: 750, treatment: 'TAXABLE' })).toBe(5);
  });

  it('answers zero for every treatment that charges nothing, whatever the rate', () => {
    for (const treatment of ['ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE'] as const) {
      expect(calculateTax({ basisMinor: 10_000_000, rateBps: 750, treatment })).toBe(0);
    }
  });

  it('refuses a fractional or negative basis — money here is integer kobo or nothing', () => {
    expect(() => calculateTax({ basisMinor: 100.5, rateBps: 750, treatment: 'TAXABLE' })).toThrow();
    expect(() => calculateTax({ basisMinor: -1, rateBps: 750, treatment: 'TAXABLE' })).toThrow();
    expect(() =>
      calculateTax({ basisMinor: 1_000, rateBps: -750, treatment: 'TAXABLE' }),
    ).toThrow();
  });
});

describe('taxPointFor (§13): WHEN, never invented', () => {
  const issued = new Date('2026-08-27T10:00:00Z');
  const paid = new Date('2026-08-29T09:00:00Z');

  it('each policy picks its own moment', () => {
    expect(taxPointFor('ON_INVOICE_ISSUE', { issuedAt: issued, paidAt: paid })).toBe(issued);
    expect(taxPointFor('ON_PAYMENT_RECEIPT', { issuedAt: issued, paidAt: paid })).toBe(paid);
    expect(taxPointFor('ON_FULFILMENT', { issuedAt: issued, fulfilledAt: paid })).toBe(paid);
  });

  it('a moment that has not happened is null — the tax point has not occurred', () => {
    expect(taxPointFor('ON_PAYMENT_RECEIPT', { issuedAt: issued, paidAt: null })).toBeNull();
    expect(taxPointFor('ON_FULFILMENT', { issuedAt: issued })).toBeNull();
  });
});
