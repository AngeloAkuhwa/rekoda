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
});
