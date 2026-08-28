import { describe, expect, it } from 'vitest';
import { estateCount, estateMargin, margin, payingCount } from './margin.js';
import { PLAN_PRICES_K, periodBefore, planPriceK } from './allowances.js';

/* The constants stay tested while they stand as the pre-BL2 rollback path.
 * Nothing in margin.ts reads them any more: the caller prices each merchant
 * from the plan catalogue and hands the figure in. */
describe('plan prices', () => {
  it('match the published pricing model', () => {
    expect(PLAN_PRICES_K.chat).toBe(990_000);
    expect(PLAN_PRICES_K.integrate).toBe(1_990_000);
    expect(PLAN_PRICES_K.complete).toBe(2_990_000);
  });

  it('charge nothing for a trial, because nothing is charged for a trial', () => {
    expect(PLAN_PRICES_K.trial).toBe(0);
    expect(PLAN_PRICES_K.expired).toBe(0);
  });

  it('treat an unknown plan as earning nothing rather than guessing', () => {
    expect(planPriceK('enterprise')).toBe(0);
  });
});

describe('margin', () => {
  it('is revenue less cost, in kobo', () => {
    const m = margin({ revenueK: 990_000, costK: 99_700 });
    expect(m.revenueK).toBe(990_000);
    expect(m.costK).toBe(99_700);
    expect(m.marginK).toBe(890_300);
  });

  it('reports the cost ratio in basis points', () => {
    expect(margin({ revenueK: 990_000, costK: 99_000 }).costRatioBp).toBe(1_000);
    expect(margin({ revenueK: 990_000, costK: 297_000 }).costRatioBp).toBe(3_000);
  });

  it('goes negative when a merchant costs more than they pay', () => {
    const m = margin({ revenueK: 990_000, costK: 1_200_000 });
    expect(m.marginK).toBe(-210_000);
    expect(m.costRatioBp).toBeGreaterThan(10_000);
  });

  it('leaves the ratio undefined for a trial rather than printing infinity', () => {
    const m = margin({ revenueK: 0, costK: 80_000 });
    expect(m.revenueK).toBe(0);
    expect(m.marginK).toBe(-80_000);
    expect(m.costRatioBp).toBeNull();
  });

  it('refuses a negative cost, and a negative revenue', () => {
    expect(margin({ revenueK: 990_000, costK: -5_000 }).costK).toBe(0);
    expect(margin({ revenueK: -1, costK: 0 }).revenueK).toBe(0);
  });
});

describe('estateMargin', () => {
  it('prices a census whose revenue the catalogue already summed', () => {
    const total = estateMargin(
      [
        { plan: 'chat', businesses: 3, paying: 3, revenueK: 990_000 * 3 },
        { plan: 'complete', businesses: 1, paying: 1, revenueK: 2_990_000 },
        { plan: 'trial', businesses: 5, paying: 0, revenueK: 0 },
      ],
      550_000,
    );
    expect(total.revenueK).toBe(990_000 * 3 + 2_990_000);
    expect(total.costK).toBe(550_000);
    expect(total.marginK).toBe(990_000 * 3 + 2_990_000 - 550_000);
  });

  it('carries two prices inside one plan, which is what grandfathering means', () => {
    /* Two chat merchants: one pinned at the launch price, one sold the
     * repriced version. A census keyed on plan alone could not say this. */
    const total = estateMargin(
      [{ plan: 'chat', businesses: 2, paying: 2, revenueK: 990_000 + 1_490_000 }],
      0,
    );
    expect(total.revenueK).toBe(2_480_000);
  });

  it('counts trial cost against the estate, because somebody pays for it', () => {
    const total = estateMargin([{ plan: 'trial', businesses: 4, paying: 0, revenueK: 0 }], 90_000);
    expect(total.revenueK).toBe(0);
    expect(total.costK).toBe(90_000);
    expect(total.marginK).toBe(-90_000);
    expect(total.costRatioBp).toBeNull();
  });

  it('is zero over an empty estate rather than NaN', () => {
    expect(estateMargin([], 0)).toEqual({
      revenueK: 0,
      costK: 0,
      marginK: 0,
      costRatioBp: null,
    });
  });
});

describe('counting the estate', () => {
  const census = [
    { plan: 'chat', businesses: 3, paying: 3, revenueK: 990_000 * 3 },
    { plan: 'trial', businesses: 7, paying: 0, revenueK: 0 },
    { plan: 'expired', businesses: 2, paying: 0, revenueK: 0 },
  ];

  it('counts everybody', () => {
    expect(estateCount(census)).toBe(12);
  });

  it('counts only the ones the catalogue prices above zero', () => {
    expect(payingCount(census)).toBe(3);
  });

  it('does not count an expired trial as paying', () => {
    expect(payingCount([{ plan: 'expired', businesses: 9, paying: 0, revenueK: 0 }])).toBe(0);
  });
});

describe('periodBefore', () => {
  it('steps back one month', () => {
    expect(periodBefore('2026-08')).toBe('2026-07');
  });

  it('rolls back across a year without anybody reasoning about it', () => {
    expect(periodBefore('2026-01')).toBe('2025-12');
  });

  it('keeps two digits, because the label is compared as a string', () => {
    expect(periodBefore('2026-11')).toBe('2026-10');
    expect(periodBefore('2026-10')).toBe('2026-09');
  });
});
