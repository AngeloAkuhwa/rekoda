import { describe, expect, it } from 'vitest';
import {
  applyPayment,
  computeMoney,
  computeMoneyFromKobo,
  computeVat,
  formatKobo,
  fromKobo,
  isBalanced,
  parseAmountText,
  toKobo,
} from './money.js';

describe('kobo conversion', () => {
  // 100,001 assertions: a property sweep, not a unit test. On a loaded CI
  // runner it has been measured past vitest's 5s default, so it carries its
  // own budget.
  it('round-trips exactly for every 10-kobo step across ₦0–₦10,000', { timeout: 30_000 }, () => {
    for (let k = 0; k <= 1_000_000; k += 10) {
      expect(toKobo(fromKobo(k))).toBe(k);
    }
  });

  it('kills the classic float bugs', () => {
    expect(toKobo(0.1 + 0.2)).toBe(30);
    expect(toKobo(19.99)).toBe(1999);
    expect(toKobo(1999.99)).toBe(199_999);
  });
});

describe('parseAmountText — Nigerian shorthand', () => {
  it.each([
    ['20k', 20_000],
    ['1.5m', 1_500_000],
    ['₦450,000', 450_000],
    ['300', 300],
    ['2.5k', 2_500],
  ])('parses %s → %d', (input, expected) => {
    expect(parseAmountText(input)).toBe(expected);
  });

  it('rejects garbage instead of truncating it', () => {
    for (const bad of ['1.2.3', '5.', 'abc', '-40k', '', 'k']) {
      expect(parseAmountText(bad)).toBeNull();
    }
  });
});

describe('computeMoney — the document equation', () => {
  it('subtotal − discount + fees + vat = total, to the kobo', () => {
    const b = computeMoney({
      items: [
        { name: 'Silk dress', quantity: 2, unitPriceNaira: 20_000 },
        { name: 'Handbag', quantity: 1, unitPriceNaira: 25_000 },
      ],
      discountNaira: 5_000,
      deliveryFeeNaira: 2_000,
      vatAmountNaira: 0,
      amountPaidNaira: 40_000,
    });
    expect(b.subtotalK).toBe(6_500_000);
    expect(b.totalK).toBe(6_200_000);
    expect(b.balanceDueK).toBe(2_200_000);
    expect(isBalanced(b)).toBe(true);
  });

  it('flags a stated total that disagrees by >1% and >₦50 — never silently fixes', () => {
    const b = computeMoney({
      items: [{ name: 'Wig', quantity: 3, unitPriceNaira: 50_000 }],
      statedTotalNaira: 100_000, // items say 150k
    });
    expect(b.mismatch).toBe(true);
    expect(b.impliedDiscountK).toBe(5_000_000);
    expect(isBalanced(b)).toBe(false);
  });

  it('accepts a stated total within tolerance as authoritative', () => {
    const b = computeMoney({
      items: [{ name: 'Service', quantity: 1, unitPriceNaira: 100_000 }],
      statedTotalNaira: 99_960, // ₦40 off — inside the ₦50 tolerance
    });
    expect(b.mismatch).toBe(false);
    expect(b.totalK).toBe(9_996_000);
    expect(isBalanced(b)).toBe(true);
  });

  /**
   * This replaces a test called "caps amountPaid at total", which asserted —
   * and therefore protected — the bug. Its stated reason was that a prepayment
   * must not fabricate a negative balance, which is true and is still true
   * here: the balance floors at zero. What it got wrong was throwing the
   * excess away to achieve that.
   */
  it('records an overpayment instead of quietly swallowing it', () => {
    const b = computeMoney({
      items: [{ name: 'Bag', quantity: 1, unitPriceNaira: 100_000 }],
      amountPaidNaira: 150_000,
    });
    // Sold for ₦100k, she paid ₦150k. All three facts survive.
    expect(b.totalK).toBe(10_000_000);
    expect(b.amountPaidK).toBe(15_000_000);
    expect(b.overpaymentK).toBe(5_000_000);
    // Still not a negative debt — the original concern, handled properly.
    expect(b.balanceDueK).toBe(0);
    // The invariant that ties the three together.
    expect(b.totalK - b.amountPaidK).toBe(b.balanceDueK - b.overpaymentK);
  });

  it('reports no overpayment on an ordinary part-payment', () => {
    const b = computeMoney({
      items: [{ name: 'Bag', quantity: 1, unitPriceNaira: 100_000 }],
      amountPaidNaira: 40_000,
    });
    expect(b.overpaymentK).toBe(0);
    expect(b.balanceDueK).toBe(6_000_000);
    expect(b.totalK - b.amountPaidK).toBe(b.balanceDueK - b.overpaymentK);
  });

  it('agrees with applyPayment about what counts as an overpayment', () => {
    // The two used to disagree about the same event: one clamped, the other
    // refused. They still differ in what they DO — a draft records, a ledger
    // mutation refuses — but they must never differ on whether it happened.
    const b = computeMoney({
      items: [{ name: 'Bag', quantity: 1, unitPriceNaira: 100_000 }],
      amountPaidNaira: 150_000,
    });
    const applied = applyPayment(0, b.totalK, 15_000_000);
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.excessK).toBe(b.overpaymentK);
  });
});

describe('computeVat — code computes tax, never AI', () => {
  it('inclusive: never inflates the quoted price', () => {
    const { vatK, totalK, taxableK } = computeVat(4_000_000, 7.5, true);
    expect(totalK).toBe(4_000_000); // customer pays what was quoted
    expect(vatK).toBe(279_070); // 40,000 × 7.5/107.5 → ₦2,790.70
    expect(taxableK + vatK).toBe(totalK);
  });

  it('exclusive: adds on top', () => {
    const { vatK, totalK } = computeVat(4_000_000, 7.5, false);
    expect(vatK).toBe(300_000);
    expect(totalK).toBe(4_300_000);
  });

  it('zero rate is a no-op', () => {
    expect(computeVat(123_45, 0, true)).toEqual({ vatK: 0, totalK: 12_345, taxableK: 12_345 });
  });

  it('inclusive VAT identity holds across a sweep of amounts and rates', () => {
    for (let naira = 1; naira <= 5_000_000; naira += 37_777) {
      for (const rate of [5, 7.5, 10, 15]) {
        const base = naira * 100;
        const { vatK, totalK, taxableK } = computeVat(base, rate, true);
        expect(totalK).toBe(base);
        expect(taxableK + vatK).toBe(totalK);
        expect(vatK).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('applyPayment', () => {
  it('partial then final settles exactly', () => {
    const p1 = applyPayment(0, 15_000_000, 10_000_000);
    expect(p1).toMatchObject({ ok: true, paymentStatus: 'partial', balanceDueK: 5_000_000 });
    if (!p1.ok) throw new Error('unreachable');
    const p2 = applyPayment(p1.amountPaidK, 15_000_000, 5_000_000);
    expect(p2).toMatchObject({ ok: true, paymentStatus: 'paid', balanceDueK: 0 });
  });

  it('overpayment is refused with the exact excess, never silently kept', () => {
    const r = applyPayment(10_000_000, 15_000_000, 6_000_000);
    expect(r).toEqual({ ok: false, reason: 'overpayment', excessK: 1_000_000 });
  });
});

describe('formatKobo', () => {
  it('formats for humans at the edge only', () => {
    expect(formatKobo(12_345_678_900)).toBe('₦123,456,789');
    expect(formatKobo(199_999)).toBe('₦1,999.99');
    expect(formatKobo(-5_000)).toBe('-₦50');
  });
});

describe('computeMoneyFromKobo', () => {
  it('answers exactly what the naira door answers, for the same document', () => {
    const fromKobo_ = computeMoneyFromKobo({
      items: [
        { name: 'Bag of rice', quantity: 2, unitPriceK: 4_500_000 },
        { name: 'Groundnut oil', quantity: 3, unitPriceK: 780_050 },
      ],
      discountK: 100_000,
      deliveryFeeK: 250_000,
      vatK: 67_500,
      amountPaidK: 5_000_000,
    });
    const fromNaira = computeMoney({
      items: [
        { name: 'Bag of rice', quantity: 2, unitPriceNaira: 45_000 },
        { name: 'Groundnut oil', quantity: 3, unitPriceNaira: 7_800.5 },
      ],
      discountNaira: 1_000,
      deliveryFeeNaira: 2_500,
      vatAmountNaira: 675,
      amountPaidNaira: 50_000,
    });
    expect(fromKobo_).toEqual(fromNaira);
  });

  it('loses nothing on the way through naira, at every kobo of a wide range', () => {
    /* The conversion is only safe because k -> k/100 -> round(*100) is the
     * identity. This is the assertion the whole kobo door rests on, and it
     * is cheaper to check than to reason about. */
    for (let k = 0; k <= 2_000_000; k += 7) {
      expect(
        computeMoneyFromKobo({ items: [{ name: 'x', quantity: 1, unitPriceK: k }] }).totalK,
      ).toBe(k);
    }
  });

  it('keeps an overpayment visible rather than capping it', () => {
    const block = computeMoneyFromKobo({
      items: [{ name: 'Crate', quantity: 1, unitPriceK: 1_000_000 }],
      amountPaidK: 1_500_000,
    });
    expect(block).toMatchObject({ totalK: 1_000_000, balanceDueK: 0, overpaymentK: 500_000 });
  });
});
