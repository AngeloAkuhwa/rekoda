import { describe, expect, it } from 'vitest';
import { orderPreview, orderQuestion, priceOrder, type PricedProduct } from './orders.js';

const CATALOGUE: PricedProduct[] = [
  { id: 'p1', name: 'Ankara bale', unitPriceK: 850_000, active: true },
  { id: 'p2', name: 'Head tie', unitPriceK: 250_000, active: true },
  { id: 'p3', name: 'Aso oke set', unitPriceK: null, active: true },
  { id: 'p4', name: 'Lace fabric', unitPriceK: 1_250_000, active: false },
];

describe('priceOrder', () => {
  it('prices from the catalogue and totals in kobo', () => {
    const order = priceOrder([{ name: 'Ankara bale', quantity: 2 }], CATALOGUE);
    expect(order.lines).toEqual([
      {
        productId: 'p1',
        name: 'Ankara bale',
        quantity: 2,
        unitPriceK: 850_000,
        lineTotalK: 1_700_000,
      },
    ]);
    expect(order.totalK).toBe(1_700_000);
  });

  it('matches however the customer capitalised and spaced it', () => {
    const order = priceOrder([{ name: '  ANKARA   BALE ', quantity: 1 }], CATALOGUE);
    expect(order.lines[0]?.productId).toBe('p1');
  });

  /* The document is the shop's, so it carries the shop's word for the thing
   * rather than whatever a customer typed at midnight. */
  it('puts the catalogue name on the line, not the customer wording', () => {
    const order = priceOrder([{ name: 'ankara bale', quantity: 1 }], CATALOGUE);
    expect(order.lines[0]?.name).toBe('Ankara bale');
  });

  it('sums the same product asked for twice onto one line', () => {
    const order = priceOrder(
      [
        { name: 'Ankara bale', quantity: 2 },
        { name: 'ankara bale', quantity: 1 },
      ],
      CATALOGUE,
    );
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0]?.quantity).toBe(3);
    expect(order.lines[0]?.lineTotalK).toBe(2_550_000);
  });

  it('adds up several products', () => {
    const order = priceOrder(
      [
        { name: 'Ankara bale', quantity: 2 },
        { name: 'Head tie', quantity: 3 },
      ],
      CATALOGUE,
    );
    expect(order.totalK).toBe(1_700_000 + 750_000);
  });

  /**
   * A hidden product still prices. Taking something out of the shop stops
   * Rekoda advertising it, not the merchant selling it, and a customer who
   * already knows about it can still ask.
   */
  it('prices a product the merchant has hidden', () => {
    const order = priceOrder([{ name: 'Lace fabric', quantity: 1 }], CATALOGUE);
    expect(order.totalK).toBe(1_250_000);
    expect(order.unknown).toEqual([]);
  });

  it('names what it has never priced, and quotes nothing for it', () => {
    const order = priceOrder(
      [
        { name: 'Aso oke set', quantity: 1 },
        { name: 'Head tie', quantity: 1 },
      ],
      CATALOGUE,
    );
    expect(order.unpriced).toEqual(['Aso oke set']);
    expect(order.lines).toHaveLength(1);
    expect(order.totalK).toBe(250_000);
  });

  it('names what the shop does not sell at all, separately', () => {
    const order = priceOrder([{ name: 'gele', quantity: 1 }], CATALOGUE);
    expect(order.unknown).toEqual(['gele']);
    expect(order.unpriced).toEqual([]);
  });

  it('never matches loosely', () => {
    const order = priceOrder([{ name: 'bale', quantity: 1 }], CATALOGUE);
    expect(order.unknown).toEqual(['bale']);
  });

  /* A fraction of a bale is a parse that went wrong, not an order, and the
   * same rule already guards the sale path's stock movements. */
  it('refuses a fractional or absent quantity rather than rounding it', () => {
    expect(priceOrder([{ name: 'Ankara bale', quantity: 0.5 }], CATALOGUE).unknown).toEqual([
      'Ankara bale',
    ]);
    expect(priceOrder([{ name: 'Ankara bale', quantity: 0 }], CATALOGUE).unknown).toEqual([
      'Ankara bale',
    ]);
  });

  it('does not repeat a name it has already complained about', () => {
    const order = priceOrder(
      [
        { name: 'gele', quantity: 1 },
        { name: 'gele', quantity: 2 },
      ],
      CATALOGUE,
    );
    expect(order.unknown).toEqual(['gele']);
  });

  it('handles a shop with no catalogue at all', () => {
    const order = priceOrder([{ name: 'anything', quantity: 1 }], []);
    expect(order).toMatchObject({ lines: [], unknown: ['anything'], totalK: 0 });
  });
});

describe('orderQuestion', () => {
  it('is silent when everything priced', () => {
    expect(orderQuestion(priceOrder([{ name: 'Head tie', quantity: 1 }], CATALOGUE))).toBeNull();
  });

  /* The fixable one first: a merchant can answer "what should I charge" in a
   * sentence, and a list of two problems gets neither answered. */
  it('asks about the unpriced product before the unknown one', () => {
    const order = priceOrder(
      [
        { name: 'gele', quantity: 1 },
        { name: 'Aso oke set', quantity: 1 },
      ],
      CATALOGUE,
    );
    const question = orderQuestion(order);
    expect(question).toContain('Aso oke set');
    expect(question).not.toContain('gele');
  });

  it('reads as a sentence when several are unpriced', () => {
    const order = { lines: [], unknown: [], unpriced: ['a', 'b', 'c'], totalK: 0 };
    expect(orderQuestion(order)).toContain('a, b and c');
  });

  it('says so when there was nothing to quote', () => {
    expect(orderQuestion({ lines: [], unknown: [], unpriced: [], totalK: 0 })).toContain(
      'could not find anything',
    );
  });
});

describe('orderPreview', () => {
  it('lists every line, the total, and asks for a yes', () => {
    const order = priceOrder(
      [
        { name: 'Ankara bale', quantity: 2 },
        { name: 'Head tie', quantity: 1 },
      ],
      CATALOGUE,
    );
    const preview = orderPreview(order, null);
    expect(preview).toContain('2 × Ankara bale at ₦8,500');
    expect(preview).toContain('1 × Head tie at ₦2,500');
    expect(preview).toContain('*Total: ₦19,500*');
    expect(preview).toContain('Reply *yes*');
  });

  /* It says quote, never sale. Nothing has been bought: the customer asked
   * and the merchant is about to answer. */
  it('never calls a request a sale', () => {
    const preview = orderPreview(priceOrder([{ name: 'Head tie', quantity: 1 }], CATALOGUE), null);
    expect(preview.toLowerCase()).not.toContain('sold');
    expect(preview).toContain('asking for');
  });

  it('echoes what the customer said, when they said something', () => {
    const order = priceOrder([{ name: 'Head tie', quantity: 1 }], CATALOGUE);
    expect(orderPreview(order, 'deliver on Friday')).toContain('They also said: deliver on Friday');
    expect(orderPreview(order, null)).not.toContain('They also said');
  });
});
