/**
 * CG5: when a correction is clear enough to keep the customer of the draft it corrects (OWN-100).
 * Beside `gates.test.ts`, which is over the layout limit and may not grow.
 */
import { describe, expect, it } from 'vitest';
import { clearlyCorrects } from './gates.js';

describe('a correction clear enough to keep the draft customer (clearlyCorrects, OWN-100)', () => {
  it.each([
    'No, 4 not 3',
    'No, 4 for Ada, not 3',
    'sorry, 60k each not 50k',
    'no, 60k not 50k',
    '4 not 3',
    'No, 4 not 3.',
    'it was 60k not 50k',
    'the price should be 60k',
    'make it 5',
    '5 wigs instead of 3',
  ])('%j clearly corrects', (text) => {
    expect(clearlyCorrects(text)).toBe(true);
  });

  it.each([
    'Sold 2 bags for 20k, not paid yet',
    'Bola bought 2 shoes, not delivered',
    'Ada bought 3 wigs for 150k',
    'Wait, I also sold 2 bags for 20k',
    'actually, sold 2 bags for 20k',
    'Not paid yet, sold 2 bags for 20k',
    'sorry, Bola bought 2 shoes',
    'Sold 2 bags for 20k not 2 days ago',
    'sold 5 bags, not 2 days late',
    'sold 3 bags at 10k each, not 2 paid',
    'Sold 2 bags for 20k not 2.5 days ago',
    '   ',
  ])('%j does not', (text) => {
    expect(clearlyCorrects(text)).toBe(false);
  });
});
