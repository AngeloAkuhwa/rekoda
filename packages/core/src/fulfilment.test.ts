import { describe, expect, it } from 'vitest';
import { earnedForLineMinor, earnedToDateMinor } from './fulfilment.js';
import { RecognitionInvariantViolation } from './recognition.js';

describe('proportional fulfilment (§12.5)', () => {
  it('recognises only the fulfilled proportion, rounding DOWN', () => {
    /* 100,000 over 3 units: one delivered earns 33,333, never 33,334. */
    expect(earnedForLineMinor({ lineTotalMinor: 100_000, quantity: 3, deliveredToDate: 1 })).toBe(
      33_333,
    );
    expect(earnedForLineMinor({ lineTotalMinor: 100_000, quantity: 3, deliveredToDate: 2 })).toBe(
      66_666,
    );
  });

  it('carries the residual: completion earns exactly the total', () => {
    /* The kobo held back at 1/3 and 2/3 posts with the last unit. */
    expect(earnedForLineMinor({ lineTotalMinor: 100_000, quantity: 3, deliveredToDate: 3 })).toBe(
      100_000,
    );
  });

  it('handles fractional quantities at three decimals', () => {
    expect(
      earnedForLineMinor({ lineTotalMinor: 50_000, quantity: 2.5, deliveredToDate: 1.25 }),
    ).toBe(25_000);
  });

  it('never overflows into float error on large amounts', () => {
    const total = 9_007_199_254_740; /* large but real kobo */
    expect(
      earnedForLineMinor({ lineTotalMinor: total, quantity: 7000, deliveredToDate: 7000 }),
    ).toBe(total);
  });

  it('over-delivery is a defect, not extra revenue', () => {
    expect(() =>
      earnedForLineMinor({ lineTotalMinor: 100, quantity: 2, deliveredToDate: 3 }),
    ).toThrow(RecognitionInvariantViolation);
  });

  it('sums across lines', () => {
    expect(
      earnedToDateMinor([
        { lineTotalMinor: 100_000, quantity: 3, deliveredToDate: 1 },
        { lineTotalMinor: 40_000, quantity: 2, deliveredToDate: 2 },
      ]),
    ).toBe(73_333);
  });

  it('the never-more property holds across every step', () => {
    const total = 99_999;
    let previous = 0;
    for (let delivered = 0; delivered <= 7; delivered++) {
      const earned = earnedForLineMinor({
        lineTotalMinor: total,
        quantity: 7,
        deliveredToDate: delivered,
      });
      expect(earned).toBeGreaterThanOrEqual(previous);
      expect(earned).toBeLessThanOrEqual(Math.ceil((total * delivered) / 7));
      previous = earned;
    }
    expect(previous).toBe(total);
  });
});
