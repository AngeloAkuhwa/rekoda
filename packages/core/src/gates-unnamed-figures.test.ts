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
    /* A payment's amount is what was paid, so "paid" names it (G-49). */
    const payment = { intent: 'RecordPayment', amount: 180_000 };
    expect(
      unnamedFiguresChanged('no, Ada paid 150k not 180k', payment, { ...payment, amount: 150_000 }),
    ).toBe(false);
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
      /* The preview shows a fractional count whole ("Adding to stock: 3" for 3.5). */
      const fabric = { ...bought, quantity: 3.5 };
      expect(unnamedFiguresChanged('No, 4 pcs not 3', fabric, { ...fabric, quantity: 4 })).toBe(
        false,
      );
      expect(unnamedFiguresChanged('No, 4 pcs not 2', fabric, { ...fabric, quantity: 4 })).toBe(
        true,
      );
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

    /* Codex and CodeRabbit on #437 at 50f1cd9: a figure answers only for the field it was named
     * for, and the figure a correction replaces never answers for a different change. */
    it('binds each named figure to its field and its pair', () => {
      const unpaid = {
        items: [{ name: 'wig', quantity: 1, unitPrice: 40_000 }],
        reportedPayment: 0,
      };
      const repriced = { ...unpaid, items: [{ name: 'wig', quantity: 1, unitPrice: 50_000 }] };
      const text = 'no, the price should be 50k not 40k';
      expect(unnamedFiguresChanged(text, unpaid, { ...repriced, reportedPayment: 40_000 })).toBe(
        true,
      );
      expect(unnamedFiguresChanged(text, unpaid, repriced)).toBe(false);
      expect(
        unnamedFiguresChanged(`${text}, she paid 40k`, unpaid, {
          ...repriced,
          reportedPayment: 40_000,
        }),
      ).toBe(false);
      const paid = {
        items: [{ name: 'wig', quantity: 1, unitPrice: 50_000 }],
        reportedPayment: 50_000,
      };
      const sixty = { ...paid, items: [{ name: 'wig', quantity: 1, unitPrice: 60_000 }] };
      expect(
        unnamedFiguresChanged('no, 60k each not 50k', paid, { ...sixty, reportedPayment: null }),
      ).toBe(true);
      expect(unnamedFiguresChanged('no, 60k each not 50k', paid, sixty)).toBe(false);
      expect(
        unnamedFiguresChanged('she paid 50k not 40k', unpaid, {
          ...unpaid,
          items: [{ name: 'wig', quantity: 1, unitPrice: 50_000 }],
        }),
      ).toBe(true);
    });

    /* Codex on #437 at 63cf5fb and e9b1cb4: a line added or dropped, priced or not, and a stock
     * adjustment's delta are counts the correction must name. */
    it('checks the quantities of added and dropped lines and of a stock delta', () => {
      const text = 'No, price 60k not 50k, 2 caps at 10k';
      const wigs = { name: 'wig', quantity: 3, unitPrice: 60_000 };
      const caps = (quantity: number) => ({ name: 'cap', quantity, unitPrice: 10_000 });
      expect(unnamedFiguresChanged(text, sale, { ...sale, items: [wigs, caps(999)] })).toBe(true);
      expect(unnamedFiguresChanged(text, sale, { ...sale, items: [wigs, caps(2)] })).toBe(false);
      const order = {
        intent: 'RecordOrder',
        items: [
          { name: 'wig', quantity: 3 },
          { name: 'comb', quantity: 2 },
        ],
      };
      const fourWigs = { name: 'wig', quantity: 4 };
      expect(unnamedFiguresChanged('No, 4 not 3', order, { ...order, items: [fourWigs] })).toBe(
        true,
      );
      expect(
        unnamedFiguresChanged('No, 4 not 3', order, {
          ...order,
          items: [fourWigs, { name: 'comb', quantity: 2 }],
        }),
      ).toBe(false);
      const stock = { intent: 'AdjustInventory', productMention: 'wig', quantityDelta: 3 };
      for (const [delta, asked] of [
        [999, true],
        [-4, true],
        [4, false],
      ] as const) {
        expect(
          unnamedFiguresChanged('No, 4 not 3', stock, { ...stock, quantityDelta: delta }),
        ).toBe(asked);
      }
    });

    /* Codex on #437 at 1f99af5: the count a correction replaces never names another line's count. */
    it('pairs a replaced quantity with its replacement', () => {
      const two = {
        items: [
          { name: 'wig', quantity: 3, unitPrice: 50_000 },
          { name: 'cap', quantity: 2, unitPrice: 10_000 },
        ],
      };
      const read = (caps: number) => ({
        items: [
          { name: 'wig', quantity: 4, unitPrice: 50_000 },
          { name: 'cap', quantity: caps, unitPrice: 10_000 },
        ],
      });
      expect(unnamedFiguresChanged('No, 4 not 3', two, read(3))).toBe(true);
      expect(unnamedFiguresChanged('No, 4 not 3', two, read(2))).toBe(false);
    });

    /* Independent review of #437 at 00c0620: a pair answers only for its own change, from the one
     * figure to the other; "not" may point at its figure past a filler word; a replaced figure never
     * names a field falling to nothing unless its clause names that field; and a field word belongs
     * to its own clause. */
    it('never lets a pair answer for another change', () => {
      const two = {
        items: [
          { name: 'wig', quantity: 3, unitPrice: 5_000 },
          { name: 'gel', quantity: 2, unitPrice: 1_000 },
        ],
      };
      expect(
        unnamedFiguresChanged('no, 4 not 3', two, {
          items: [two.items[0]!, { ...two.items[1]!, quantity: 4 }],
        }),
      ).toBe(true);
      const one = { items: [{ name: 'wig', quantity: 1, unitPrice: 40_000 }], reportedPayment: 0 };
      expect(
        unnamedFiguresChanged('no, 50k not 40k', one, { ...one, reportedPayment: 50_000 }),
      ).toBe(true);
      expect(unnamedFiguresChanged('no, 50k not 40k', one, { ...one, discount: 50_000 })).toBe(
        true,
      );
    });

    it.each(['it was 60k not that 50k', 'no, 60k, not the 50k', 'no, 60k instead of the 50k'])(
      'pairs "%s" past its filler word',
      (text) => {
        const one = {
          items: [{ name: 'wig', quantity: 1, unitPrice: 50_000 }],
          reportedPayment: 0,
          discount: 50_000,
        };
        const sixty = { ...one, items: [{ name: 'wig', quantity: 1, unitPrice: 60_000 }] };
        expect(unnamedFiguresChanged(text, one, sixty)).toBe(false);
        expect(unnamedFiguresChanged(text, one, { ...sixty, reportedPayment: 50_000 })).toBe(true);
        expect(unnamedFiguresChanged(text, one, { ...sixty, discount: 0 })).toBe(true);
      },
    );

    it('pairs counts past a filler or a noun, and a replaced count never drops a line', () => {
      const two = {
        items: [
          { name: 'wig', quantity: 3, unitPrice: 5_000 },
          { name: 'gel', quantity: 2, unitPrice: 1_000 },
        ],
      };
      const four = { name: 'wig', quantity: 4, unitPrice: 5_000 };
      expect(
        unnamedFiguresChanged('no, 4, not the 3', two, {
          items: [four, { ...two.items[1]!, quantity: 3 }],
        }),
      ).toBe(true);
      expect(unnamedFiguresChanged('no, 4, not the 3', two, { items: [four, two.items[1]!] })).toBe(
        false,
      );
      const order = {
        intent: 'RecordOrder',
        items: [
          { name: 'wig', quantity: 3 },
          { name: 'comb', quantity: 3 },
        ],
      };
      const wigs = { name: 'wig', quantity: 4 };
      expect(unnamedFiguresChanged('4 wigs not 3', order, { ...order, items: [wigs] })).toBe(true);
      expect(
        unnamedFiguresChanged('4 wigs not 3', order, { ...order, items: [wigs, order.items[1]!] }),
      ).toBe(false);
    });

    it('lets a replaced figure drop only the field its own clause names', () => {
      const discounted = { ...sale, discount: 2_000 };
      expect(
        unnamedFiguresChanged('no discount, not 2k', discounted, { ...sale, discount: 0 }),
      ).toBe(false);
      const fee = { ...sale, deliveryFee: 2_000 };
      expect(unnamedFiguresChanged('no, not 2k', fee, { ...sale, deliveryFee: 0 })).toBe(true);
    });

    it('reads a field word only in its own clause', () => {
      expect(
        unnamedFiguresChanged('no, 2k delivery fee and 5k discount', sale, {
          ...sale,
          deliveryFee: 2_000,
          discount: 5_000,
        }),
      ).toBe(false);
      expect(
        unnamedFiguresChanged('no, 60k each and 5k discount', sale, {
          ...sale,
          items: [{ name: 'wig', quantity: 3, unitPrice: 60_000 }],
          discount: 5_000,
        }),
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
