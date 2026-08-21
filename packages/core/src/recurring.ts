/**
 * When a repeating entry falls due.
 *
 * A merchant's rent, salaries and generator servicing arrive on the same day
 * every month and none of them announce themselves on WhatsApp. Until now the
 * only way they reached the books was the merchant remembering to dictate
 * them, which means the months they were busiest are the months their costs
 * look lowest.
 *
 * Two things make this arithmetic rather than a guess. The first is the 31st:
 * a schedule anchored on it has no February, and a naive "add one month"
 * silently moves it into March, so the shop that pays rent on the 31st gets
 * eleven entries a year and an accountant asking where the twelfth went. The
 * second is Lagos: a due DAY is a calendar day, not an instant, so everything
 * here is a plain `YYYY-MM-DD` and the only place the clock is consulted is
 * turning "now" into "what day is it in Lagos".
 */

const LAGOS_OFFSET_MS = 3_600_000;

/** The Lagos calendar day containing `now`. Lagos is fixed UTC+1, no DST. */
export function lagosDay(now: Date): string {
  return new Date(now.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

/** How many days that month has: 28, 29, 30 or 31. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function parseDay(day: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new RangeError(`not a calendar day: ${day}`);
  return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
}

function format(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

/**
 * The anchor day landing in a given month, clamped to that month's end.
 *
 * A schedule on the 31st falls on 28 February and returns to 31 March: the
 * anchor is remembered, never overwritten by the clamped date, which is why
 * this takes the anchor rather than reading the last due date's day number.
 */
function inMonth(year: number, month: number, anchorDay: number): string {
  return format(year, month, Math.min(anchorDay, daysInMonth(year, month)));
}

/** 1 to 31. Anything else is a schedule that could never fall due. */
/**
 * Midday Lagos on a calendar day.
 *
 * Noon rather than midnight so that nothing about which month an entry lands
 * in turns on an hour: every reader that periods on a timestamp converts to
 * Lagos first, and midday is twelve hours clear of both boundaries.
 *
 * Used by anything that has to date a posting for a day the merchant named
 * rather than for the moment the code ran: the recurring sweep catching up,
 * and the opening balances a business already held.
 */
export function lagosNoon(day: string): Date {
  return new Date(`${day}T12:00:00+01:00`);
}

export function isAnchorDay(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 31;
}

/**
 * The next time this schedule falls due, strictly after `after`.
 *
 * Strictly, because both callers want it that way: creating a schedule on the
 * 1st should not raise an entry that morning for a rent the merchant has
 * almost certainly already paid and possibly already recorded, and a sweep
 * that has just raised today's entry must not leave the row due today.
 */
export function nextDueAfter(after: string, anchorDay: number): string {
  if (!isAnchorDay(anchorDay)) throw new RangeError(`not a day of the month: ${anchorDay}`);
  const from = parseDay(after);

  const thisMonth = inMonth(from.year, from.month, anchorDay);
  if (thisMonth > after) return thisMonth;

  /* `Date.UTC` normalises month 12 into January of the next year, so there is
   * no year rollover to get wrong here. */
  const next = new Date(Date.UTC(from.year, from.month + 1, 1));
  return inMonth(next.getUTCFullYear(), next.getUTCMonth(), anchorDay);
}
