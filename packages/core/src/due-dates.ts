/**
 * Turning "she will pay on Friday" into a date.
 *
 * The model already captures the PHRASE (`dueDescription` on RecordSale) and
 * until now nothing read it: a merchant told us when they expected the money
 * and we threw it away. That is the whole debtors book, discarded at the door.
 *
 * Resolving it is code's job, not the model's, for the same reason arithmetic
 * is: a due date decides when somebody is chased for money, and "what day is
 * Friday" has one right answer that a language model can get subtly wrong on
 * a Sunday. The model reports what was said; this decides what it means.
 *
 * Lagos throughout. A merchant in Kano saying "tomorrow" at 23:30 means the
 * next Lagos day, not the next UTC one, and the hour those disagree is
 * exactly the hour a shop is closing its books.
 */

const LAGOS_OFFSET_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Weekday names as a Nigerian merchant types them, including the shortenings. */
const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/**
 * The date a phrase points at, or null when it points at nothing we can be
 * sure of.
 *
 * Null is a real answer and the common one. "when she can" and "after her
 * salary" are things merchants genuinely say, and an invoice with no due date
 * is honest where a guessed one would put a real customer on an overdue list
 * for a deadline nobody agreed. Everything here resolves to the END of the
 * Lagos day, because "pay on Friday" is not late at 09:00 on Friday.
 */
export function resolveDueDate(phrase: string | null | undefined, now: Date): Date | null {
  if (!phrase) return null;
  const text = phrase.toLowerCase().trim();
  if (!text) return null;

  if (/\b(today|now|immediately|instant)\b/.test(text)) return endOfLagosDay(now, 0);
  if (/\btomorrow\b/.test(text)) return endOfLagosDay(now, 1);

  /* "in 3 days", "3 days", "within 7 days", "7 day". The unit has to be
   * present: a bare "30" in a sentence about money is far more likely to be
   * an amount than a term. */
  const days = text.match(/(\d{1,3})\s*(?:working\s+|business\s+)?days?\b/);
  if (days) return endOfLagosDay(now, Number(days[1]));

  const weeks = text.match(/(\d{1,2})\s*weeks?\b/);
  if (weeks) return endOfLagosDay(now, Number(weeks[1]) * 7);

  const months = text.match(/(\d{1,2})\s*months?\b/);
  if (months) return endOfLagosMonth(now, Number(months[1]));

  if (/\bnext\s+week\b/.test(text)) return endOfLagosDay(now, 7);
  if (/\bnext\s+month\b/.test(text)) return endOfLagosMonth(now, 1);
  if (/\b(end\s+of\s+(the\s+)?month|month\s+end)\b/.test(text)) return endOfLagosMonth(now, 0);
  if (/\b(end\s+of\s+(the\s+)?week|week\s+end|weekend)\b/.test(text)) {
    return nextWeekday(now, 5, /\bnext\b/.test(text));
  }

  for (const [name, index] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name}\\b`).test(text)) {
      return nextWeekday(now, index, /\bnext\b/.test(text));
    }
  }

  return null;
}

/**
 * Is this invoice late, at this instant?
 *
 * Derived, never stored. A stored `overdue` flag is a second source of truth
 * that needs a sweep to maintain and is wrong between sweeps — and the one
 * moment it matters is the moment a merchant looks.
 */
export function isOverdue(dueDate: Date | null, balanceDueK: number, now: Date): boolean {
  if (!dueDate || balanceDueK <= 0) return false;
  return dueDate.getTime() < now.getTime();
}

/** Whole Lagos days a debt has been late. Zero when it is not. */
export function daysOverdue(dueDate: Date | null, balanceDueK: number, now: Date): number {
  if (!isOverdue(dueDate, balanceDueK, now)) return 0;
  return Math.floor((lagosMidnight(now) - lagosMidnight(dueDate!)) / DAY_MS);
}

/**
 * The receivable ageing buckets every accountant expects to see, and the one
 * thing HelloBooks and QuickBooks both put on the front page.
 *
 * `current` is money not yet due AND money with no agreed date: neither is
 * late, and putting undated debt in an ageing bucket would invent a deadline
 * the merchant never set.
 */
export type AgeBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus';

export function ageBucket(dueDate: Date | null, balanceDueK: number, now: Date): AgeBucket {
  const late = daysOverdue(dueDate, balanceDueK, now);
  if (late <= 0) return 'current';
  if (late <= 30) return 'd1_30';
  if (late <= 60) return 'd31_60';
  if (late <= 90) return 'd61_90';
  return 'd90_plus';
}

/** Midnight in Lagos, as a UTC epoch, for the Lagos day `at` falls in. */
function lagosMidnight(at: Date): number {
  const shifted = at.getTime() + LAGOS_OFFSET_MS;
  return shifted - (shifted % DAY_MS) - LAGOS_OFFSET_MS;
}

/**
 * The last instant of a Lagos day, `addDays` from now.
 *
 * End of day rather than start, because "pay on Friday" is a promise about
 * Friday, not about Friday morning. Chasing somebody at 09:00 on the day they
 * said they would pay is how a bookkeeper loses a customer.
 */
function endOfLagosDay(now: Date, addDays: number): Date {
  return new Date(lagosMidnight(now) + (addDays + 1) * DAY_MS - 1);
}

/** The last instant of the Lagos month, `addMonths` from the current one. */
function endOfLagosMonth(now: Date, addMonths: number): Date {
  const lagos = new Date(now.getTime() + LAGOS_OFFSET_MS);
  /* Day 0 of the following month is the last day of this one, which is how
   * February and the 31-day months take care of themselves. */
  const firstOfNext = Date.UTC(
    lagos.getUTCFullYear(),
    lagos.getUTCMonth() + addMonths + 1,
    1,
    0,
    0,
    0,
    0,
  );
  return new Date(firstOfNext - LAGOS_OFFSET_MS - 1);
}

/**
 * The next occurrence of a weekday.
 *
 * Saying a day that has already passed this week means NEXT week: on a
 * Thursday, "Tuesday" is five days away, not two days ago. Today counts as
 * this week's, because a merchant saying "Friday" on Friday morning means
 * today; `next` forces the following one either way.
 */
function nextWeekday(now: Date, weekday: number, forceNext: boolean): Date {
  const todayIndex = new Date(lagosMidnight(now) + LAGOS_OFFSET_MS).getUTCDay();
  let delta = (weekday - todayIndex + 7) % 7;
  if (forceNext) delta += 7;
  return endOfLagosDay(now, delta);
}
