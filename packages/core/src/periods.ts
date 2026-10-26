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

/**
 * `last_month` is the previous CALENDAR month, whole (Build 6): the answer to
 * "Which period?" a merchant most often gives that the model's three named
 * periods could not carry. Same Lagos boundaries as `month`.
 */
export type PeriodName = 'today' | 'week' | 'month' | 'last_month';

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

  if (name === 'last_month') {
    /* Date.UTC rolls month -1 back into December of the year before. */
    const previous = new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth() - 1, 1));
    const month = previous.toLocaleDateString('en-NG', { month: 'long', timeZone: 'UTC' });
    return {
      from: new Date(previous.getTime() - LAGOS_OFFSET_MS),
      /* The last instant before this month began. */
      to: new Date(firstOfMonth - 1),
      /* The year only when it is not this one: "December 2025" in January. */
      label:
        previous.getUTCFullYear() === lagos.getUTCFullYear()
          ? month
          : `${month} ${previous.getUTCFullYear()}`,
    };
  }

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

/** Calendar dates are `YYYY-MM-DD` in the merchant's Lagos day, and nothing else. */
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The longest custom range answered: a year and a leap day. */
export const MAX_CUSTOM_RANGE_DAYS = 366;

export type CustomRangeRefusal = 'bad_date' | 'end_before_start' | 'starts_in_future' | 'too_long';

export type CustomRange =
  | { readonly ok: true; readonly range: DateRange; readonly clampedToToday: boolean }
  | { readonly ok: false; readonly reason: CustomRangeRefusal };

/** The Lagos midnight a `YYYY-MM-DD` names, or null when it is not a real date. */
function lagosDay(ymd: string): number | null {
  const match = YMD.exec(ymd);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = new Date(Date.UTC(year, month - 1, day));
  /* Date.UTC rolls 30 February into March; a real date survives the trip back. */
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  return utc.getTime() - LAGOS_OFFSET_MS;
}

/** "5 Oct 2026", or "1 Oct 2026 to 7 Oct 2026", in the merchant's words. */
export function labelRange(from: Date, to: Date): string {
  const day = (at: Date) =>
    new Date(at.getTime() + LAGOS_OFFSET_MS).toLocaleDateString('en-NG', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const start = day(from);
  const end = day(to);
  return start === end ? start : `${start} to ${end}`;
}

/**
 * A range the merchant named (N2, OWN-44): Lagos days, both ends included.
 *
 * Code draws it, like every other window: the model may report the two dates
 * it understood, never the instants. A range that has not finished is stopped
 * at the end of today and says so, because comparing a half-finished week with
 * a whole one would call a normal week a collapse.
 */
export function resolveCustomRange(fromYmd: string, toYmd: string, now: Date): CustomRange {
  const start = lagosDay(fromYmd);
  const endDay = lagosDay(toYmd);
  if (start === null || endDay === null) return { ok: false, reason: 'bad_date' };
  if (endDay < start) return { ok: false, reason: 'end_before_start' };

  const endOfToday = lagosMidnight(now) + DAY_MS - 1;
  if (start > endOfToday) return { ok: false, reason: 'starts_in_future' };

  let end = endDay + DAY_MS - 1;
  const clampedToToday = end > endOfToday;
  if (clampedToToday) end = endOfToday;

  const days = Math.round((end - start + 1) / DAY_MS);
  if (days > MAX_CUSTOM_RANGE_DAYS) return { ok: false, reason: 'too_long' };

  const from = new Date(start);
  const to = new Date(end);
  return { ok: true, range: { from, to, label: labelRange(from, to) }, clampedToToday };
}
