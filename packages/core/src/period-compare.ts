/**
 * Period-over-period figures (N2, OWN-44).
 *
 * Pure: the figures come from SQL, the windows from `periods.ts`, and this
 * file only does the arithmetic between them. Recorded sales, credit notes,
 * cash collected, refunds and spending stay distinct measures. There is no
 * profit here and there will not be one: Rekoda does not infer profit where
 * costs are missing, and "money in minus money out" is a cash movement.
 */
import type { DateRange } from './periods.js';
import { labelRange } from './periods.js';

const LAGOS_OFFSET_MS = 3_600_000;

/** The figures one window holds, in kobo. Mirrors the SQL summary. */
export interface WindowFigures {
  readonly salesK: number;
  readonly invoices: number;
  readonly creditedK: number;
  readonly moneyInK: number;
  readonly refundedK: number;
  readonly moneyOutK: number;
  readonly expenses: number;
}

export interface Change {
  /** Current minus previous, in kobo. */
  readonly absoluteK: number;
  /**
   * Percent change to one decimal place, or null where it means nothing: a
   * base of zero (or below) has no percentage, and inventing one would be a
   * number the books did not produce.
   */
  readonly percent: number | null;
}

export interface Measure {
  readonly current: number;
  readonly previous: number;
  readonly change: Change;
}

export interface PeriodComparison {
  /** Invoices issued and not voided, at their face value. */
  readonly sales: Measure;
  /** Credit notes issued: sales taken back, shown beside sales not inside them. */
  readonly credited: Measure;
  /** Money that arrived. */
  readonly collected: Measure;
  /** Money returned to customers. */
  readonly refunded: Measure;
  /** Spending recorded, withdrawn entries excluded. */
  readonly spent: Measure;
  /** Collected, less refunded, less spent. Cash, not profit. */
  readonly cashMovement: Measure;
  /** Nothing at all was recorded in the earlier window. */
  readonly previousIsEmpty: boolean;
}

/** Zero, never minus zero: `toEqual` and a printed "-0%" both notice. */
const clean = (n: number): number => (n === 0 ? 0 : n);

export function changeOf(current: number, previous: number): Change {
  const absoluteK = clean(current - previous);
  const percent = previous > 0 ? clean(Math.round((absoluteK * 1000) / previous) / 10) : null;
  return { absoluteK, percent };
}

const measure = (current: number, previous: number): Measure => ({
  current,
  previous,
  change: changeOf(current, previous),
});

export function comparePeriods(current: WindowFigures, previous: WindowFigures): PeriodComparison {
  const cash = (f: WindowFigures) => f.moneyInK - f.refundedK - f.moneyOutK;
  return {
    sales: measure(current.salesK, previous.salesK),
    credited: measure(current.creditedK, previous.creditedK),
    collected: measure(current.moneyInK, previous.moneyInK),
    refunded: measure(current.refundedK, previous.refundedK),
    spent: measure(current.moneyOutK, previous.moneyOutK),
    cashMovement: measure(cash(current), cash(previous)),
    previousIsEmpty:
      previous.salesK === 0 &&
      previous.invoices === 0 &&
      previous.creditedK === 0 &&
      previous.moneyInK === 0 &&
      previous.refundedK === 0 &&
      previous.moneyOutK === 0 &&
      previous.expenses === 0,
  };
}

/**
 * The window to compare against: the equal-length span immediately before,
 * with no gap and no overlap. A whole Lagos calendar month is the exception,
 * and goes against the previous whole month, because 31 days of March set
 * against "the 31 days before" would straddle February and mean nothing.
 */
export function previousWindow(range: DateRange): DateRange {
  const start = new Date(range.from.getTime() + LAGOS_OFFSET_MS);
  const nextStart = new Date(range.to.getTime() + 1 + LAGOS_OFFSET_MS);
  const wholeMonth =
    start.getUTCDate() === 1 &&
    start.getUTCHours() === 0 &&
    start.getUTCMinutes() === 0 &&
    nextStart.getUTCDate() === 1 &&
    nextStart.getUTCHours() === 0 &&
    nextStart.getUTCMinutes() === 0 &&
    nextStart.getUTCFullYear() * 12 +
      nextStart.getUTCMonth() -
      (start.getUTCFullYear() * 12 + start.getUTCMonth()) ===
      1;

  if (wholeMonth) {
    const from = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1) - LAGOS_OFFSET_MS,
    );
    const to = new Date(range.from.getTime() - 1);
    return { from, to, label: labelRange(from, to) };
  }

  const length = range.to.getTime() - range.from.getTime() + 1;
  const to = new Date(range.from.getTime() - 1);
  const from = new Date(range.from.getTime() - length);
  return { from, to, label: labelRange(from, to) };
}
