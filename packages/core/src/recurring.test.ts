import { describe, expect, it } from 'vitest';
import { isAnchorDay, lagosDay, nextDueAfter, raiseDayFor } from './recurring.js';

describe('lagosDay', () => {
  it('reads 23:30 UTC as the next Lagos day', () => {
    expect(lagosDay(new Date('2026-03-10T23:30:00Z'))).toBe('2026-03-11');
  });

  it('reads midday as the day a merchant would call it', () => {
    expect(lagosDay(new Date('2026-03-10T12:00:00Z'))).toBe('2026-03-10');
  });
});

describe('nextDueAfter', () => {
  it('moves to the same day next month', () => {
    expect(nextDueAfter('2026-03-05', 5)).toBe('2026-04-05');
  });

  it('reaches this month when the anchor is still ahead', () => {
    expect(nextDueAfter('2026-03-01', 15)).toBe('2026-03-15');
  });

  it('never returns the day it was asked about', () => {
    expect(nextDueAfter('2026-03-15', 15)).toBe('2026-04-15');
  });

  /* The whole reason this function exists. A naive `setMonth` on 31 January
   * lands on 3 March, which is a rent entry in the wrong month and a February
   * with no rent in it at all. */
  it('clamps the 31st to the end of February and comes back out', () => {
    expect(nextDueAfter('2026-01-31', 31)).toBe('2026-02-28');
    expect(nextDueAfter('2026-02-28', 31)).toBe('2026-03-31');
    expect(nextDueAfter('2026-03-31', 31)).toBe('2026-04-30');
    expect(nextDueAfter('2026-04-30', 31)).toBe('2026-05-31');
  });

  it('knows February has 29 days in a leap year', () => {
    expect(nextDueAfter('2028-01-31', 31)).toBe('2028-02-29');
  });

  it('rolls the year over', () => {
    expect(nextDueAfter('2026-12-20', 20)).toBe('2027-01-20');
  });

  it('refuses a day of the month that does not exist', () => {
    expect(() => nextDueAfter('2026-03-01', 32)).toThrow(RangeError);
    expect(() => nextDueAfter('2026-03-01', 0)).toThrow(RangeError);
  });

  it('refuses anything that is not a calendar day', () => {
    expect(() => nextDueAfter('5 March', 5)).toThrow(RangeError);
  });
});

describe('raiseDayFor', () => {
  it('keeps the due day when nothing is closed', () => {
    expect(raiseDayFor('2026-05-01', null)).toBe('2026-05-01');
  });

  it('keeps the due day when it falls after the closed months', () => {
    expect(raiseDayFor('2026-05-01', '2026-04')).toBe('2026-05-01');
    expect(raiseDayFor('2026-05-31', '2026-04')).toBe('2026-05-31');
  });

  /* The wedge this exists to prevent: rent fell due in a month the books
   * have since closed, and dating it there is a posting the kernel refuses
   * forever. It lands on day one of the first open month instead. */
  it('moves a due day inside a closed month to the first open day', () => {
    expect(raiseDayFor('2026-04-15', '2026-04')).toBe('2026-05-01');
    expect(raiseDayFor('2026-02-28', '2026-04')).toBe('2026-05-01');
  });

  it('rolls the year over when December is the last closed month', () => {
    expect(raiseDayFor('2026-11-30', '2026-12')).toBe('2027-01-01');
  });

  it('refuses a watermark that is not a calendar month', () => {
    expect(() => raiseDayFor('2026-04-15', 'April')).toThrow(RangeError);
  });
});

describe('isAnchorDay', () => {
  it('accepts 1 through 31 and nothing else', () => {
    expect(isAnchorDay(1)).toBe(true);
    expect(isAnchorDay(31)).toBe(true);
    expect(isAnchorDay(0)).toBe(false);
    expect(isAnchorDay(32)).toBe(false);
    expect(isAnchorDay(15.5)).toBe(false);
  });
});
