/**
 * Turning what a merchant said into a date somebody gets chased on.
 *
 * These are the assertions that keep the resolver deterministic. The model
 * reports the phrase; this decides the day, and the day decides whether a
 * real customer appears on an overdue list.
 */
import { describe, expect, it } from 'vitest';
import { ageBucket, daysOverdue, isOverdue, resolveDueDate } from './due-dates.js';

/* A Wednesday, 13:00 UTC = 14:00 Lagos. Every relative phrase below is read
 * against this instant. */
const WEDNESDAY = new Date('2026-08-19T13:00:00Z');

/** The Lagos calendar date a resolved due date lands on. */
const lagosDate = (at: Date | null) =>
  at === null ? null : new Date(at.getTime() + 3_600_000).toISOString().slice(0, 10);

describe('phrases that name a day', () => {
  it('resolves today and tomorrow', () => {
    expect(lagosDate(resolveDueDate('today', WEDNESDAY))).toBe('2026-08-19');
    expect(lagosDate(resolveDueDate('tomorrow', WEDNESDAY))).toBe('2026-08-20');
  });

  it('takes a weekday later this week as this week', () => {
    expect(lagosDate(resolveDueDate('she will pay on Friday', WEDNESDAY))).toBe('2026-08-21');
  });

  /**
   * A day already gone means NEXT week. On a Wednesday, "Tuesday" is six days
   * away; reading it as two days ago would put the invoice overdue the moment
   * it was issued.
   */
  it('takes a weekday already past as next week', () => {
    expect(lagosDate(resolveDueDate('tuesday', WEDNESDAY))).toBe('2026-08-25');
  });

  it('takes today, named, as today', () => {
    expect(lagosDate(resolveDueDate('wednesday', WEDNESDAY))).toBe('2026-08-19');
  });

  it('lets "next" push past this week', () => {
    expect(lagosDate(resolveDueDate('next friday', WEDNESDAY))).toBe('2026-08-28');
  });

  it('understands the shortenings merchants actually type', () => {
    expect(lagosDate(resolveDueDate('fri', WEDNESDAY))).toBe('2026-08-21');
    expect(lagosDate(resolveDueDate('thurs', WEDNESDAY))).toBe('2026-08-20');
  });
});

describe('phrases that name a term', () => {
  it('counts days', () => {
    expect(lagosDate(resolveDueDate('in 7 days', WEDNESDAY))).toBe('2026-08-26');
    expect(lagosDate(resolveDueDate('within 30 days', WEDNESDAY))).toBe('2026-09-18');
  });

  it('counts weeks and months', () => {
    expect(lagosDate(resolveDueDate('2 weeks', WEDNESDAY))).toBe('2026-09-02');
    expect(lagosDate(resolveDueDate('next week', WEDNESDAY))).toBe('2026-08-26');
    expect(lagosDate(resolveDueDate('1 month', WEDNESDAY))).toBe('2026-09-30');
  });

  it('resolves end of month to the last day, whatever length it is', () => {
    expect(lagosDate(resolveDueDate('end of the month', WEDNESDAY))).toBe('2026-08-31');
    const february = new Date('2027-02-10T09:00:00Z');
    expect(lagosDate(resolveDueDate('month end', february))).toBe('2027-02-28');
  });

  /**
   * A bare number is an AMOUNT far more often than a term in a sentence about
   * money. Requiring the unit is what stops "50" becoming fifty days.
   */
  it('refuses a bare number with no unit', () => {
    expect(resolveDueDate('30', WEDNESDAY)).toBeNull();
  });
});

describe('phrases that name nothing', () => {
  /**
   * Null is a real answer and the common one. An invoice with no due date is
   * honest; a guessed one puts a real customer on an overdue list for a
   * deadline nobody agreed to.
   */
  it('returns null rather than guessing', () => {
    expect(resolveDueDate('when she can', WEDNESDAY)).toBeNull();
    expect(resolveDueDate('after her salary', WEDNESDAY)).toBeNull();
    expect(resolveDueDate('', WEDNESDAY)).toBeNull();
    expect(resolveDueDate(null, WEDNESDAY)).toBeNull();
    expect(resolveDueDate(undefined, WEDNESDAY)).toBeNull();
  });
});

describe('the end of the day, not the start', () => {
  /**
   * "Pay on Friday" is a promise about Friday, not Friday morning. Chasing
   * somebody at 09:00 on the day they said they would pay is how a bookkeeper
   * loses a customer.
   */
  it('is not overdue during the day it is due', () => {
    const due = resolveDueDate('friday', WEDNESDAY)!;
    const fridayMorning = new Date('2026-08-21T08:00:00Z');
    expect(isOverdue(due, 5_000_000, fridayMorning)).toBe(false);
  });

  it('is overdue the next morning', () => {
    const due = resolveDueDate('friday', WEDNESDAY)!;
    const saturdayMorning = new Date('2026-08-22T08:00:00Z');
    expect(isOverdue(due, 5_000_000, saturdayMorning)).toBe(true);
  });
});

describe('what counts as late', () => {
  const due = new Date('2026-08-19T22:59:59.999Z'); // end of 19 Aug in Lagos

  it('is never late with nothing owing', () => {
    expect(isOverdue(due, 0, new Date('2026-10-01T09:00:00Z'))).toBe(false);
    expect(daysOverdue(due, 0, new Date('2026-10-01T09:00:00Z'))).toBe(0);
  });

  it('is never late with no agreed date', () => {
    expect(isOverdue(null, 5_000_000, new Date('2027-01-01T09:00:00Z'))).toBe(false);
  });

  it('counts whole Lagos days late', () => {
    expect(daysOverdue(due, 5_000_000, new Date('2026-08-20T09:00:00Z'))).toBe(1);
    expect(daysOverdue(due, 5_000_000, new Date('2026-09-18T09:00:00Z'))).toBe(30);
  });
});

describe('ageing buckets', () => {
  const due = new Date('2026-08-19T22:59:59.999Z');
  const bucketAt = (iso: string) => ageBucket(due, 5_000_000, new Date(iso));

  it('puts money not yet due in current', () => {
    expect(bucketAt('2026-08-19T09:00:00Z')).toBe('current');
  });

  /* Undated debt is not late — putting it in an ageing bucket would invent a
   * deadline the merchant never set. */
  it('puts undated debt in current, never in a bucket', () => {
    expect(ageBucket(null, 5_000_000, new Date('2027-01-01T09:00:00Z'))).toBe('current');
  });

  it('walks the buckets on their boundaries', () => {
    expect(bucketAt('2026-08-20T09:00:00Z')).toBe('d1_30');
    expect(bucketAt('2026-09-18T09:00:00Z')).toBe('d1_30'); // 30 days
    expect(bucketAt('2026-09-19T09:00:00Z')).toBe('d31_60'); // 31
    expect(bucketAt('2026-10-18T09:00:00Z')).toBe('d31_60'); // 60
    expect(bucketAt('2026-10-19T09:00:00Z')).toBe('d61_90'); // 61
    expect(bucketAt('2026-11-17T09:00:00Z')).toBe('d61_90'); // 90
    expect(bucketAt('2026-11-18T09:00:00Z')).toBe('d90_plus'); // 91
  });
});
