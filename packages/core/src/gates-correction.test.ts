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
    'make it ₦60,000',
    /* N for naira, as merchants type it (independent review of 4536d82). */
    'the price should be N60,000',
    'make it N60k',
    'change it to 4',
    'no, it should be 4 wigs',
    '5 wigs instead of 3',
    'no, 60k instead of 50k',
    /* Currency as merchants type it. */
    'no, make it 60,000',
    'should be ₦ 60,000',
    'make it 60.5k',
    'no, 60k not 50k!',
    'make it 20k',
    'no, the balance should be 10k',
    'make it 5 wigs',
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
    /* "should be", "make it" or "change it to" without a figure says no replacement figure
     * (CodeRabbit on #437 at c712b1e). */
    'Sold 2 bags for 20k, not paid yet; should be delivered tomorrow',
    'Sold 2 bags for 20k, make it quick',
    'Bola bought 2 shoes, change it to Friday delivery',
    /* A figure that is a time, or wording inside a whole new sale, replaces nothing in the
     * waiting draft (owner review of #437 at 49f2586). */
    'Sold 2 bags for 20k, make it 5pm delivery.',
    'Sold 3 wigs for 90k, delivery should be 2pm.',
    'Sold 2 bags for 20k instead of going home.',
    'Sold 3 wigs for 90k; change it to 4pm delivery.',
    'make it 5pm',
    'should be 2 days',
    'change it to 4:30',
    'make it the 5th',
    'instead of going home',
    'Wait, also sold 3 wigs for 90k, make it 4',
    'I sold 2 bags for N20k rather than 3',
    'sold 2 bags at 10k, make it 3',
    /* A correction mixed with a new sale, and a currency the gate does not read: asked about. */
    'No, 4 not 3, and I also sold 2 bags for 20k',
    'No, 4 not 3. Sold 2 bags at 10k to someone else',
    'make it NGN 60000',
    /* A figure or comparison that changes no field of the draft (CodeRabbit on #437 at 49f2586). */
    'Sold 2 bags for 20k; deliver by bike rather than car',
    'deliver by bike rather than car',
    'No, delivery should be 2 days',
    'balance should be 10k by Friday',
    'make it 5 wigs and 2 bags for Bola',
    'Bola bought 2 shoes for 30k, should be 2',
    '   ',
  ])('%j does not', (text) => {
    expect(clearlyCorrects(text)).toBe(false);
  });
});
