/**
 * The scope of a correction's words (OD-67 Option B, OD-76 Option A; owner rulings OWN-103(3) and
 * OWN-107): a figure's sense comes from its own sentence, a count or price that names an item binds
 * to that item's line, a purchase's stock arrival and a sale's stated total change only when named.
 * Split from `gates-unnamed-figures.test.ts` by concern (CodeRabbit on #437 at 156621f).
 */
import { describe, expect, it } from 'vitest';
import {
  correctionHoldsOtherFigures,
  draftFigures,
  replacedFiguresFit,
  unnamedFiguresChanged,
} from './gates.js';

describe('replacedFiguresFit: a figure is read within its own sentence', () => {
  const sale = {
    intent: 'RecordSale',
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    discount: 2_000,
  };

  /* CodeRabbit on #437 at 156621f (gates.ts:856): "discount" in the sentence before made the 3 money. */
  it('reads "4 pcs not 3" as a count after a sentence about the discount', () => {
    expect(
      replacedFiguresFit(
        'No, discount should be 5k. Quantity should be 4 pcs not 3.',
        draftFigures(sale),
      ),
    ).toBe(true);
  });

  it('still refuses a count in place of a price in the same sentence', () => {
    expect(replacedFiguresFit('No, price should be 4 pcs not 3', draftFigures(sale))).toBe(false);
  });
});

describe('unnamedFiguresChanged: a figure that names an item binds to its line', () => {
  const two = {
    intent: 'RecordSale',
    items: [
      { name: 'wig', quantity: 3, unitPrice: 50_000 },
      { name: 'cap', quantity: 3, unitPrice: 50_000 },
    ],
  };
  const withLines = (wig: object, cap: object) => ({
    ...two,
    items: [
      { ...two.items[0], ...wig },
      { ...two.items[1], ...cap },
    ],
  });

  /* CodeRabbit on #437 at 156621f (gates.ts:997): "4 caps" is a count, never a ₦4 price. */
  it('never reads an item count as the price it authorises', () => {
    const caps = { intent: 'RecordSale', items: [{ name: 'cap', quantity: 3, unitPrice: 3 }] };
    expect(
      unnamedFiguresChanged('No, make it 4 caps', caps, {
        ...caps,
        items: [{ name: 'cap', quantity: 3, unitPrice: 4 }],
      }),
    ).toBe(true);
    expect(
      unnamedFiguresChanged('No, make it 4 caps', caps, {
        ...caps,
        items: [{ name: 'cap', quantity: 4, unitPrice: 3 }],
      }),
    ).toBe(false);
  });

  /* CodeRabbit on #437 at 156621f (gates.ts:1011): the price pair named for wigs never moves the caps. */
  it('binds a named unit-price change to the item it names', () => {
    expect(
      unnamedFiguresChanged(
        'No, price 60k wigs not 50k',
        two,
        withLines({}, { unitPrice: 60_000 }),
      ),
    ).toBe(true);
    expect(
      unnamedFiguresChanged(
        'No, price 60k wigs not 50k',
        two,
        withLines({ unitPrice: 60_000 }, {}),
      ),
    ).toBe(false);
  });
});

describe('unnamedFiguresChanged: a purchase keeps its stock arrival', () => {
  const purchase = {
    intent: 'RecordPurchase',
    description: 'caps',
    amount: 50_000,
    productMention: 'cap',
    quantity: 3,
  };

  /* CodeRabbit on #437 at 156621f (gates.ts:1127): an amount correction never drops "Adding to stock: 3 cap". */
  it('asks when the reading drops the arrival the preview showed', () => {
    expect(
      unnamedFiguresChanged('No, amount 60k not 50k', purchase, {
        ...purchase,
        amount: 60_000,
        productMention: null,
      }),
    ).toBe(true);
  });

  it('accepts the amount change that keeps the arrival', () => {
    expect(
      unnamedFiguresChanged('No, amount 60k not 50k', purchase, { ...purchase, amount: 60_000 }),
    ).toBe(false);
  });
});

describe('unnamedFiguresChanged: a stated total is kept when nothing it follows from changed', () => {
  const sale = {
    intent: 'RecordSale',
    items: [{ name: 'wig', quantity: 3, unitPrice: 10_000 }],
    statedTotal: 29_900,
    reportedPayment: 5_000,
  };

  /* CodeRabbit on #437 at 156621f (gates.ts:1241): a payment-only correction never raises the total. */
  it('asks when a payment correction also overwrites the stated total', () => {
    expect(
      unnamedFiguresChanged('No, paid 4k not 5k', sale, {
        ...sale,
        reportedPayment: 4_000,
        statedTotal: 30_000,
      }),
    ).toBe(true);
  });

  it('accepts the payment change that keeps the stated total', () => {
    expect(
      unnamedFiguresChanged('No, paid 4k not 5k', sale, { ...sale, reportedPayment: 4_000 }),
    ).toBe(false);
  });

  it('still lets a stated total follow a named change to its lines', () => {
    expect(
      unnamedFiguresChanged('No, 4 not 3', sale, {
        ...sale,
        items: [{ name: 'wig', quantity: 4, unitPrice: 10_000 }],
        statedTotal: 40_000,
      }),
    ).toBe(false);
  });
});

describe('correctionHoldsOtherFigures: a correction mixed with another record', () => {
  const sale = {
    intent: 'RecordSale',
    customer: { kind: 'none' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
  };
  const four = {
    ...sale,
    items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
    statedTotal: 200_000,
  };

  /* CodeRabbit on #437 at 156621f (meta-correction-ambiguous:259): the 2 bags at 10k are another sale. */
  it('finds a figure neither the waiting draft nor the reading holds', () => {
    expect(
      correctionHoldsOtherFigures('No, 4 not 3. Sold 2 bags at 10k to someone else', sale, four),
    ).toBe(true);
  });

  /* Independent review of #437 at b51fc0c: a reading that folds the other sale in holds its 2 and
   * its 10k, so they were taken as accounted for and the two sales merged into one preview. */
  const merged = {
    ...sale,
    items: [
      { name: 'wig', quantity: 4, unitPrice: 50_000 },
      { name: 'bag', quantity: 2, unitPrice: 10_000 },
    ],
    statedTotal: 220_000,
  };
  it.each([
    'No, 4 not 3. Sold 2 bags at 10k to someone else',
    'No, 4 not 3. I sold 2 bags at 10k too',
    'No, 4 not 3! And bought 2 bags at 10k',
  ])('%j with a reading that took the other record in is still asked about', (text) => {
    expect(correctionHoldsOtherFigures(text, sale, merged)).toBe(true);
  });

  it.each(['No, 4 not 3 and add 2 bags at 10k', 'No, I sold 4 not 3, plus 2 bags at 10k'])(
    '%j adds a line inside the correction itself, which is no other record',
    (text) => {
      expect(correctionHoldsOtherFigures(text, sale, merged)).toBe(false);
    },
  );

  it('a later record sentence without an added line is no other record', () => {
    expect(correctionHoldsOtherFigures('No, 4 not 3. Sold them yesterday', sale, four)).toBe(false);
  });

  it.each(['No, 4 not 3', 'No, 4 not 3, 50k each', 'No, 4 not 3. Total 200k', 'make it 4'])(
    '%j holds only the correction and figures the preview showed',
    (text) => {
      expect(correctionHoldsOtherFigures(text, sale, four)).toBe(false);
    },
  );
});
