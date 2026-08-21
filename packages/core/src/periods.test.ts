/**
 * The window a figure came from.
 *
 * A reply saying "you sold ₦40,000 this week" is only as trustworthy as the
 * week it counted, so the boundaries are code somebody can read rather than
 * something the model decided.
 */
import { describe, expect, it } from 'vitest';
import { resolvePeriod } from './periods.js';

/** The Lagos calendar date an instant falls on. */
const lagosDate = (at: Date) => new Date(at.getTime() + 3_600_000).toISOString().slice(0, 10);

describe('today', () => {
  it('is the Lagos day, not the UTC one', () => {
    /* 23:30 UTC is 00:30 the NEXT day in Lagos. A merchant closing their
     * books at half past midnight means the day that just started. */
    const lateNight = new Date('2026-08-19T23:30:00Z');
    const today = resolvePeriod('today', lateNight);
    expect(lagosDate(today.from)).toBe('2026-08-20');
    expect(lagosDate(today.to)).toBe('2026-08-20');
  });

  it('runs to the last instant of the day, not its start', () => {
    const noon = new Date('2026-08-19T11:00:00Z');
    const today = resolvePeriod('today', noon);
    expect(today.to.getTime()).toBeGreaterThan(noon.getTime());
    expect(today.to.getTime() - today.from.getTime()).toBe(86_400_000 - 1);
  });
});

describe('this week', () => {
  /**
   * Seven days back, not the calendar week. A merchant asking on a Wednesday
   * what they sold this week means their last few days of trading; a calendar
   * week would answer with two days and call it a week.
   */
  it('is the last seven days, ending today', () => {
    const wednesday = new Date('2026-08-19T11:00:00Z');
    const week = resolvePeriod('week', wednesday);
    expect(lagosDate(week.from)).toBe('2026-08-13');
    expect(lagosDate(week.to)).toBe('2026-08-19');
  });

  it('covers exactly seven days', () => {
    const week = resolvePeriod('week', new Date('2026-08-19T11:00:00Z'));
    expect(week.to.getTime() - week.from.getTime()).toBe(7 * 86_400_000 - 1);
  });
});

describe('this month', () => {
  /* The calendar month, because that IS a boundary merchants keep: rent,
   * salaries and the allowance meter all reset on it. */
  it('runs from the first of the Lagos month to today', () => {
    const month = resolvePeriod('month', new Date('2026-08-19T11:00:00Z'));
    expect(lagosDate(month.from)).toBe('2026-08-01');
    expect(lagosDate(month.to)).toBe('2026-08-19');
    expect(month.label).toBe('August');
  });

  it('starts on the first even when asked in the small hours of the first', () => {
    // 23:30 UTC on 31 July is 00:30 on 1 August in Lagos.
    const justAfterMidnight = new Date('2026-07-31T23:30:00Z');
    const month = resolvePeriod('month', justAfterMidnight);
    expect(lagosDate(month.from)).toBe('2026-08-01');
    expect(month.label).toBe('August');
  });
});
