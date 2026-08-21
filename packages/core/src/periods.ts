/**
 * "This week" as a pair of instants.
 *
 * The model reports which period a merchant MEANT; this decides what that
 * period is, for the same reason core resolves due dates and computes money:
 * a figure in a reply is only trustworthy if the window it came from was
 * chosen by code somebody can read.
 *
 * Lagos throughout, and the boundaries are the ones a merchant would draw.
 * "Today" at 00:30 Lagos is the day that just started, not the UTC day that
 * is still running.
 */

const LAGOS_OFFSET_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type PeriodName = 'today' | 'week' | 'month';

export interface DateRange {
  /** Inclusive. */
  readonly from: Date;
  /** Inclusive, and the last instant of the day, not its start. */
  readonly to: Date;
  /** How to name it in a reply, in the merchant's words. */
  readonly label: string;
}

/**
 * The window a named period covers, ending now.
 *
 * "Week" is the last seven days rather than the calendar week starting
 * Monday. A merchant asking on Wednesday what they sold this week means the
 * last few days of trading, and a calendar week would answer with two days
 * and call it a week.
 *
 * "Month" is the CALENDAR month, because that one is a boundary merchants
 * genuinely keep: rent, salaries and the meter all reset on it.
 */
export function resolvePeriod(name: PeriodName, now: Date): DateRange {
  const endOfToday = new Date(lagosMidnight(now) + DAY_MS - 1);

  if (name === 'today') {
    return { from: new Date(lagosMidnight(now)), to: endOfToday, label: 'today' };
  }

  if (name === 'week') {
    return {
      from: new Date(lagosMidnight(now) - 6 * DAY_MS),
      to: endOfToday,
      label: 'the last 7 days',
    };
  }

  const lagos = new Date(now.getTime() + LAGOS_OFFSET_MS);
  const firstOfMonth = Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), 1) - LAGOS_OFFSET_MS;
  return {
    from: new Date(firstOfMonth),
    to: endOfToday,
    label: lagos.toLocaleDateString('en-NG', { month: 'long', timeZone: 'UTC' }),
  };
}

/** Midnight in Lagos, as a UTC epoch, for the Lagos day `at` falls in. */
function lagosMidnight(at: Date): number {
  const shifted = at.getTime() + LAGOS_OFFSET_MS;
  return shifted - (shifted % DAY_MS) - LAGOS_OFFSET_MS;
}
