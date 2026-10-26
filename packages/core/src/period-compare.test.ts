/**
 * Period comparisons (N2, OWN-44). A percentage is only worth printing where
 * it is mathematically valid, and a period that follows another is only worth
 * comparing when both are drawn by code somebody can read.
 */
import { describe, expect, it } from 'vitest';
import { resolveCustomRange, resolvePeriod } from './periods.js';
import { changeOf, comparePeriods, previousWindow, type WindowFigures } from './period-compare.js';

const lagosDate = (at: Date) => new Date(at.getTime() + 3_600_000).toISOString().slice(0, 10);
const NOW = new Date('2026-10-26T10:00:00Z');

describe('resolveCustomRange', () => {
  it('draws Lagos day boundaries, inclusive of the last instant of the end day', () => {
    const r = resolveCustomRange('2026-10-01', '2026-10-07', NOW);
    if (!r.ok) throw new Error(r.reason);
    expect(lagosDate(r.range.from)).toBe('2026-10-01');
    expect(lagosDate(r.range.to)).toBe('2026-10-07');
    expect(r.range.to.getTime() - r.range.from.getTime()).toBe(7 * 86_400_000 - 1);
  });

  it('accepts a single day', () => {
    const r = resolveCustomRange('2026-10-05', '2026-10-05', NOW);
    expect(r.ok).toBe(true);
  });

  it.each([
    ['2026-13-01', '2026-13-05', 'bad_date'],
    ['2026-02-30', '2026-03-05', 'bad_date'],
    ['26-10-01', '2026-10-05', 'bad_date'],
    ['2026-10-07', '2026-10-01', 'end_before_start'],
    ['2027-01-01', '2027-01-05', 'starts_in_future'],
    ['2024-01-01', '2026-10-05', 'too_long'],
  ])('refuses %s to %s as %s', (from, to, reason) => {
    const r = resolveCustomRange(from, to, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });

  it('stops a range that runs past today at the end of today, and says so', () => {
    const r = resolveCustomRange('2026-10-20', '2026-11-30', NOW);
    if (!r.ok) throw new Error(r.reason);
    expect(lagosDate(r.range.to)).toBe('2026-10-26');
    expect(r.clampedToToday).toBe(true);
  });
});

describe('previousWindow', () => {
  it('is the equal-length span immediately before, with no gap or overlap', () => {
    const r = resolveCustomRange('2026-10-08', '2026-10-14', NOW);
    if (!r.ok) throw new Error(r.reason);
    const prev = previousWindow(r.range);
    expect(lagosDate(prev.from)).toBe('2026-10-01');
    expect(lagosDate(prev.to)).toBe('2026-10-07');
    expect(prev.to.getTime() + 1).toBe(r.range.from.getTime());
    expect(prev.to.getTime() - prev.from.getTime()).toBe(
      r.range.to.getTime() - r.range.from.getTime(),
    );
  });

  it('puts a whole calendar month against the previous calendar month, not 30 days', () => {
    const r = resolveCustomRange('2026-03-01', '2026-03-31', new Date('2026-04-10T10:00:00Z'));
    if (!r.ok) throw new Error(r.reason);
    const prev = previousWindow(r.range);
    expect(lagosDate(prev.from)).toBe('2026-02-01');
    expect(lagosDate(prev.to)).toBe('2026-02-28');
  });

  it('puts last_month against the month before it', () => {
    const last = resolvePeriod('last_month', NOW);
    const prev = previousWindow(last);
    expect(lagosDate(prev.from)).toBe('2026-08-01');
    expect(lagosDate(prev.to)).toBe('2026-08-31');
  });
});

describe('changeOf', () => {
  it('gives the absolute change and a percentage when the base is positive', () => {
    expect(changeOf(15_000, 10_000)).toEqual({ absoluteK: 5_000, percent: 50 });
    expect(changeOf(7_500, 10_000)).toEqual({ absoluteK: -2_500, percent: -25 });
  });

  it('rounds the percentage to one decimal place with integer arithmetic', () => {
    expect(changeOf(10_001, 30_000)).toEqual({ absoluteK: -19_999, percent: -66.7 });
  });

  it('has no percentage when there was nothing to compare against', () => {
    expect(changeOf(5_000, 0)).toEqual({ absoluteK: 5_000, percent: null });
    expect(changeOf(0, 0)).toEqual({ absoluteK: 0, percent: null });
  });

  it('shows a fall to nothing as -100%', () => {
    expect(changeOf(0, 8_000)).toEqual({ absoluteK: -8_000, percent: -100 });
  });
});

describe('comparePeriods', () => {
  const figures = (over: Partial<WindowFigures> = {}): WindowFigures => ({
    salesK: 0,
    invoices: 0,
    creditedK: 0,
    moneyInK: 0,
    refundedK: 0,
    moneyOutK: 0,
    expenses: 0,
    ...over,
  });

  it('keeps recorded sales, credit notes, cash collected, refunds and spending distinct', () => {
    const c = comparePeriods(
      figures({ salesK: 900, creditedK: 100, moneyInK: 700, refundedK: 50, moneyOutK: 300 }),
      figures({ salesK: 600, creditedK: 0, moneyInK: 500, refundedK: 0, moneyOutK: 400 }),
    );
    expect(c.sales.current).toBe(900);
    expect(c.credited.current).toBe(100);
    expect(c.collected.current).toBe(700);
    expect(c.refunded.current).toBe(50);
    expect(c.spent.current).toBe(300);
    expect(c.sales.change).toEqual({ absoluteK: 300, percent: 50 });
    expect(c.spent.change).toEqual({ absoluteK: -100, percent: -25 });
  });

  it('computes money in minus money out as cash movement, never as profit', () => {
    const c = comparePeriods(
      figures({ moneyInK: 700, refundedK: 50, moneyOutK: 300 }),
      figures({ moneyInK: 500, moneyOutK: 400 }),
    );
    expect(c.cashMovement.current).toBe(350);
    expect(c.cashMovement.previous).toBe(100);
    expect(c).not.toHaveProperty('profit');
  });

  it('gives no percentage for cash movement when the earlier period was zero or negative', () => {
    const negative = comparePeriods(figures({ moneyInK: 100 }), figures({ moneyOutK: 400 }));
    expect(negative.cashMovement.change.absoluteK).toBe(500);
    expect(negative.cashMovement.change.percent).toBeNull();
    const zero = comparePeriods(figures({ moneyInK: 100 }), figures());
    expect(zero.cashMovement.change.percent).toBeNull();
  });

  it('flags an empty earlier period so the reply can say there is nothing to compare', () => {
    const c = comparePeriods(figures({ salesK: 500 }), figures());
    expect(c.previousIsEmpty).toBe(true);
    expect(c.sales.change.percent).toBeNull();
    expect(comparePeriods(figures({ salesK: 500 }), figures({ salesK: 100 })).previousIsEmpty).toBe(
      false,
    );
  });
});
