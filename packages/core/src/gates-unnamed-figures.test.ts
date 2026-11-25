/**
 * `unnamedFiguresChanged`: a correction may change only the financial figures the merchant names
 * (OD-76 Option A, owner ruling OWN-107). Split from `gates-correction.test.ts` by concern.
 */
import { describe, expect, it } from 'vitest';
import { unnamedFiguresChanged } from './gates.js';

/* OD-76 Option A (owner ruling OWN-107): a correction may change only the figures it names. */
describe('unnamedFiguresChanged', () => {
  const sale = {
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    reportedPayment: 100_000,
  };
  const four = { ...sale, items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }] };

  it.each([
    ['No, 4 not 3', four, false],
    ['No, 4 not 3', { ...four, reportedPayment: 0 }, true],
    ['No, 4 not 3', { ...four, items: [{ name: 'wig', quantity: 4, unitPrice: 40_000 }] }, true],
    ['No, 4 not 3', { ...four, discount: 5_000 }, true],
    ['she paid 120k not 100k', { ...sale, reportedPayment: 120_000 }, false],
    [
      'no, 40k each not 50k',
      { ...sale, items: [{ name: 'wig', quantity: 3, unitPrice: 40_000 }] },
      false,
    ],
  ] as const)('%s, reading %j: %s', (text, reading, expected) => {
    expect(unnamedFiguresChanged(text, sale, reading)).toBe(expected);
  });

  /* Codex on #437 at 0bf9298: a stated total follows from the lines; a recased line is checked. */
  it.each([
    ['an unnamed stated total that does not follow', { ...four, statedTotal: 199_000 }, true],
    ['a stated total that follows from the lines', { ...four, statedTotal: 200_000 }, false],
    [
      'a recased item at a new price',
      { ...four, items: [{ name: 'Wig', quantity: 4, unitPrice: 40_000 }] },
      true,
    ],
    [
      'a recased item at the same price',
      { ...four, items: [{ name: 'Wig ', quantity: 4, unitPrice: 50_000 }] },
      false,
    ],
    [
      'a renamed only line at a new price',
      { ...four, items: [{ name: 'weave', quantity: 4, unitPrice: 40_000 }] },
      true,
    ],
    ['a dropped priced line', { ...four, items: [] }, true],
  ] as const)('%s', (_, reading, expected) => {
    expect(unnamedFiguresChanged('No, 4 not 3', { ...sale, statedTotal: 150_000 }, reading)).toBe(
      expected,
    );
  });

  /* Codex on #437 at c5392f0: lines are matched one to one, so two lines alike but for case are both checked. */
  it('checks each of two lines that differ only by case', () => {
    const two = {
      items: [
        { name: 'wig', quantity: 3, unitPrice: 50_000 },
        { name: 'Wig', quantity: 1, unitPrice: 50_000 },
      ],
    };
    const read = {
      items: [
        { name: 'wig', quantity: 4, unitPrice: 50_000 },
        { name: 'Wig', quantity: 1, unitPrice: 40_000 },
      ],
    };
    expect(unnamedFiguresChanged('No, 4 not 3', two, read)).toBe(true);
    expect(
      unnamedFiguresChanged('No, 4 not 3', two, {
        items: [read.items[0]!, { ...read.items[1]!, unitPrice: 50_000 }],
      }),
    ).toBe(false);
  });

  it('judges an expense amount the same way', () => {
    const fuel = { description: 'fuel', amount: 5_000 };
    expect(unnamedFiguresChanged('no, 6k not 5k', fuel, { ...fuel, amount: 6_000 })).toBe(false);
    expect(
      unnamedFiguresChanged('it was diesel, not petrol', fuel, { ...fuel, amount: 6_000 }),
    ).toBe(true);
  });

  /* CodeRabbit on #437 at c5392f0: each figure the merchant names answers for one change only, in
   * its own sense, and a quantity or total the correction does not name is not changed unasked. */
  describe('CodeRabbit on #437 at c5392f0', () => {
    it('does not let a named unit price excuse a payment change of the same amount', () => {
      const one = { items: [{ name: 'wig', quantity: 1, unitPrice: 40_000 }], reportedPayment: 0 };
      const priced = { ...one, items: [{ name: 'wig', quantity: 1, unitPrice: 50_000 }] };
      expect(unnamedFiguresChanged('no, price 50k not 40k', one, priced)).toBe(false);
      expect(
        unnamedFiguresChanged('no, price 50k not 40k', one, { ...priced, reportedPayment: 50_000 }),
      ).toBe(true);
      expect(
        unnamedFiguresChanged('price 50k not 40k, she paid 50k', one, {
          ...priced,
          reportedPayment: 50_000,
        }),
      ).toBe(false);
    });

    it('does not read a quantity correction as naming a price of the same figure', () => {
      const cheap = { items: [{ name: 'sweet', quantity: 3, unitPrice: 3 }] };
      expect(
        unnamedFiguresChanged('No, 4 not 3', cheap, {
          items: [{ name: 'sweet', quantity: 4, unitPrice: 4 }],
        }),
      ).toBe(true);
      expect(
        unnamedFiguresChanged('No, 4 not 3', cheap, {
          items: [{ name: 'sweet', quantity: 4, unitPrice: 3 }],
        }),
      ).toBe(false);
    });

    it('reads a purchase with no payment as paid in full', () => {
      const bought = { intent: 'RecordPurchase', description: 'wigs', amount: 50_000, quantity: 3 };
      expect(
        unnamedFiguresChanged('No, 4 not 3', bought, {
          ...bought,
          quantity: 4,
          reportedPayment: 0,
        }),
      ).toBe(true);
      expect(unnamedFiguresChanged('No, 4 not 3', bought, { ...bought, quantity: 4 })).toBe(false);
      expect(unnamedFiguresChanged('no, 60k not 50k', bought, { ...bought, amount: 60_000 })).toBe(
        false,
      );
    });

    it('refuses a price correction that also changes a quantity nobody named', () => {
      expect(
        unnamedFiguresChanged('no, 60k each not 50k', sale, {
          ...sale,
          items: [{ name: 'wig', quantity: 4, unitPrice: 60_000 }],
        }),
      ).toBe(true);
      expect(
        unnamedFiguresChanged('no, 60k each not 50k', sale, {
          ...sale,
          items: [{ name: 'wig', quantity: 3, unitPrice: 60_000 }],
        }),
      ).toBe(false);
    });

    it('refuses a reading that drops a stated total the lines do not compute', () => {
      const stated = { ...sale, statedTotal: 149_000 };
      expect(
        unnamedFiguresChanged('she paid 120k not 100k', stated, {
          ...sale,
          reportedPayment: 120_000,
        }),
      ).toBe(true);
      expect(
        unnamedFiguresChanged(
          'she paid 120k not 100k',
          { ...sale, statedTotal: 150_000 },
          { ...sale, reportedPayment: 120_000 },
        ),
      ).toBe(false);
    });

    it('checks the price of a line the reading adds', () => {
      expect(
        unnamedFiguresChanged('No, 4 not 3', sale, {
          ...four,
          items: [...four.items, { name: 'cap', quantity: 1, unitPrice: 10_000 }],
        }),
      ).toBe(true);
    });
  });
});
