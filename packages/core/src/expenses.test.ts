import { describe, expect, it } from 'vitest';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  categoriseExpense,
  isExpenseCategory,
  STOCK_CATEGORY,
} from './expenses.js';

const of = (description: string, category?: string | null) =>
  categoriseExpense({ description, ...(category === undefined ? {} : { category }) });

describe('placing an expense', () => {
  it('reads the words a Nigerian shop actually uses', () => {
    expect(of('bought fuel for the generator')).toBe('power');
    expect(of('paid NEPA bill')).toBe('power');
    expect(of('bought units for the prepaid meter')).toBe('power');
    expect(of('keke to the market')).toBe('transport');
    expect(of('paid dispatch rider')).toBe('transport');
    expect(of('bought nylon for packaging')).toBe('supplies');
    expect(of('shop rent for the year')).toBe('rent');
    expect(of("paid the sales girl's salary")).toBe('salaries');
    expect(of('LGA daily ticket')).toBe('fees');
    expect(of('boosted the instagram post')).toBe('marketing');
    expect(of('accountant fee')).toBe('professional');
  });

  /**
   * The two pairs that a naive keyword list gets wrong, and the reason the
   * rule order is written down rather than alphabetical.
   */
  it('tells an electrician from electricity, and a bike repair from a bike', () => {
    expect(of('paid electrician to rewire the shop')).toBe('repairs');
    expect(of('electricity bill')).toBe('power');
    expect(of('repaired the delivery bike')).toBe('repairs');
    expect(of('bike delivery to Yaba')).toBe('transport');
  });

  /* Substring matching would put all three of these somewhere confident and
   * wrong: "gen" inside "genuine", "ads" inside "adsorbent", "due" inside
   * "residue". Each of these is a real word with a category hiding in it. */
  it('does not match inside another word', () => {
    expect(of('genuine leather for the display case')).toBe('other');
    expect(of('adsorbent sachets for the display case')).toBe('other');
    expect(of('residue removal from the tank')).toBe('other');
    expect(of('bought a generator')).toBe('power');
  });

  it('prefers what the model said, and falls back to what the merchant wrote', () => {
    expect(of('paid Musa 20k', 'transport')).toBe('transport');
    expect(of('paid Musa 20k for fuel', 'nonsense the model invented')).toBe('power');
    expect(of('paid Musa 20k')).toBe('other');
  });

  /**
   * The property that lets this run over rows it has already run over: a
   * backfill, a re-import and a double-write must all land in one place.
   */
  it('is idempotent over its own output', () => {
    for (const category of EXPENSE_CATEGORIES) {
      expect(of('anything at all', category)).toBe(category);
    }
  });

  it('never classifies an expense as stock', () => {
    expect(EXPENSE_CATEGORIES).not.toContain(STOCK_CATEGORY);
    expect(of('bought 10 bales of ankara', STOCK_CATEGORY)).not.toBe(STOCK_CATEGORY);
  });

  it('names every category on a statement', () => {
    for (const category of EXPENSE_CATEGORIES) {
      expect(EXPENSE_CATEGORY_LABELS[category]).toMatch(/^[A-Z]/);
    }
    expect(Object.keys(EXPENSE_CATEGORY_LABELS)).toHaveLength(EXPENSE_CATEGORIES.length);
  });

  it('knows what is one of its own', () => {
    expect(isExpenseCategory('rent')).toBe(true);
    expect(isExpenseCategory('Rent')).toBe(false);
    expect(isExpenseCategory(STOCK_CATEGORY)).toBe(false);
    expect(isExpenseCategory(null)).toBe(false);
  });
});
