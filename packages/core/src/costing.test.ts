import { describe, expect, it } from 'vitest';
import { costOfQuantityK, weightedAverageCostK } from './costing.js';

const K = (naira: number) => naira * 100;

describe('what the stock cost', () => {
  it('takes the first delivery as the average, because there is nothing to weight against', () => {
    expect(
      weightedAverageCostK({ onHand: 0, averageCostK: null, arriving: 10, costK: K(50_000) }),
    ).toBe(K(5_000));
  });

  it('moves the average towards a dearer delivery, in proportion', () => {
    /* 10 held at ₦5,000 plus 10 arriving at ₦7,000 is ₦120,000 over 20. */
    expect(
      weightedAverageCostK({
        onHand: 10,
        averageCostK: K(5_000),
        arriving: 10,
        costK: K(70_000),
      }),
    ).toBe(K(6_000));
  });

  /**
   * A negative count means the shelf and the books already disagree.
   * Weighting a delivery against a negative holding produces a cost per unit
   * that is not the cost of anything, and can come out below zero.
   */
  it('treats a count below zero as nothing held rather than as debt', () => {
    expect(
      weightedAverageCostK({
        onHand: -5,
        averageCostK: K(5_000),
        arriving: 10,
        costK: K(70_000),
      }),
    ).toBe(K(7_000));
  });

  /* A known count with no known cost is the state every product starts in.
   * Weighting against an unknown would be inventing a history. */
  it('ignores a holding it knows no cost for', () => {
    expect(
      weightedAverageCostK({ onHand: 100, averageCostK: null, arriving: 10, costK: K(70_000) }),
    ).toBe(K(7_000));
  });

  it('stays a whole number of kobo', () => {
    const average = weightedAverageCostK({
      onHand: 3,
      averageCostK: 1_000,
      arriving: 4,
      costK: 3_001,
    });
    expect(Number.isInteger(average)).toBe(true);
  });

  it('refuses a delivery of nothing, and one that cost less than nothing', () => {
    expect(() =>
      weightedAverageCostK({ onHand: 1, averageCostK: 1, arriving: 0, costK: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      weightedAverageCostK({ onHand: 1, averageCostK: 1, arriving: 1, costK: -1 }),
    ).toThrow(RangeError);
  });
});

describe('the cost of what left the shelf', () => {
  it('multiplies the average by what went', () => {
    expect(costOfQuantityK(K(5_000), 3)).toBe(K(15_000));
  });

  /**
   * Null is a real state and not a failure. A merchant who has never said
   * what something cost them has not given Rekoda a cost to report, and
   * inventing one would put a made-up figure into a profit calculation.
   */
  it('says nothing rather than guessing when no cost is known', () => {
    expect(costOfQuantityK(null, 3)).toBeNull();
    expect(costOfQuantityK(K(5_000), 0)).toBeNull();
  });
});
