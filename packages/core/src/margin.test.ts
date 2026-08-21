import { describe, expect, it } from 'vitest';
import { estateCount, estateMargin, margin, payingCount } from './margin.js';
import { PLAN_PRICES_K, planPriceK } from './allowances.js';

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
    const m = margin({ plan: 'chat', costK: 99_700 });
    expect(m.revenueK).toBe(990_000);
    expect(m.costK).toBe(99_700);
    expect(m.marginK).toBe(890_300);
  });

  it('reports the cost ratio in basis points', () => {
    expect(margin({ plan: 'chat', costK: 99_000 }).costRatioBp).toBe(1_000);
    expect(margin({ plan: 'chat', costK: 297_000 }).costRatioBp).toBe(3_000);
  });

  it('goes negative when a merchant costs more than they pay', () => {
    const m = margin({ plan: 'chat', costK: 1_200_000 });
    expect(m.marginK).toBe(-210_000);
    expect(m.costRatioBp).toBeGreaterThan(10_000);
  });

  it('leaves the ratio undefined for a trial rather than printing infinity', () => {
    const m = margin({ plan: 'trial', costK: 80_000 });
    expect(m.revenueK).toBe(0);
    expect(m.marginK).toBe(-80_000);
    expect(m.costRatioBp).toBeNull();
  });

  it('refuses a negative cost', () => {
    expect(margin({ plan: 'chat', costK: -5_000 }).costK).toBe(0);
  });
});

describe('estateMargin', () => {
  it('prices a census rather than a page of rows', () => {
    const total = estateMargin(
      [
        { plan: 'chat', businesses: 3 },
        { plan: 'complete', businesses: 1 },
        { plan: 'trial', businesses: 5 },
      ],
      550_000,
    );
    expect(total.revenueK).toBe(990_000 * 3 + 2_990_000);
    expect(total.costK).toBe(550_000);
    expect(total.marginK).toBe(990_000 * 3 + 2_990_000 - 550_000);
  });

  it('counts trial cost against the estate, because somebody pays for it', () => {
    const total = estateMargin([{ plan: 'trial', businesses: 4 }], 90_000);
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

  it('does not lose cost when nobody is on a known plan', () => {
    const total = estateMargin([{ plan: 'enterprise', businesses: 2 }], 40_000);
    expect(total.revenueK).toBe(0);
    expect(total.costK).toBe(40_000);
  });
});

describe('counting the estate', () => {
  const census = [
    { plan: 'chat', businesses: 3 },
    { plan: 'trial', businesses: 7 },
    { plan: 'expired', businesses: 2 },
  ];

  it('counts everybody', () => {
    expect(estateCount(census)).toBe(12);
  });

  it('counts only the ones on a plan that earns something', () => {
    expect(payingCount(census)).toBe(3);
  });

  it('does not count an expired trial as paying', () => {
    expect(payingCount([{ plan: 'expired', businesses: 9 }])).toBe(0);
  });
});
