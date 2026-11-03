// Unit tests for billing.ts. Split by concern; the rest of this suite is in billing.test.ts.
import { describe, expect, it } from 'vitest';
import {
  ADD_ON_PACKS,
  addMonth,
  addInterval,
  annualPriceK,
  addOnPack,
  attemptReference,
  billingState,
  chargeReferenceOf,
  isStandardMonthlyCycle,
  MAX_CHECKOUT_ATTEMPTS,
  SUBSCRIPTION_REFERENCE_PATTERN,
  subscriptionReference,
  upgradeProrationEligibility,
  EXTRA_SEAT_PRICE_K,
  packsFor,
  planChangeCharge,
  planChangeKind,
  unappliedChargeDueAt,
  unappliedChargeOverdue,
} from './billing.js';
import { isConsumable, PLAN_PRICES_K } from './allowances.js';

const at = (iso: string) => new Date(iso);

describe('unappliedChargeDueAt (OD-30): end of the next business day, Lagos time', () => {
  const due = (iso: string) => unappliedChargeDueAt(new Date(iso)).toISOString();
  it('a Monday exception is due end of Tuesday', () => {
    expect(due('2026-10-19T09:00:00Z')).toBe('2026-10-20T22:59:59.999Z');
  });
  it('a Wednesday exception is due end of Thursday', () => {
    expect(due('2026-10-21T13:20:00Z')).toBe('2026-10-22T22:59:59.999Z');
  });
  it('Friday, Saturday and Sunday exceptions are due end of Monday', () => {
    expect(due('2026-10-23T10:00:00Z')).toBe('2026-10-26T22:59:59.999Z');
    expect(due('2026-10-24T10:00:00Z')).toBe('2026-10-26T22:59:59.999Z');
    expect(due('2026-10-25T10:00:00Z')).toBe('2026-10-26T22:59:59.999Z');
  });
  it('uses the Lagos calendar day: 23:30 UTC Thursday is already Friday in Lagos', () => {
    expect(due('2026-10-22T23:30:00Z')).toBe('2026-10-26T22:59:59.999Z');
  });
  it('is overdue only after the deadline', () => {
    const made = new Date('2026-10-21T13:20:00Z');
    expect(unappliedChargeOverdue(made, new Date('2026-10-22T22:59:59.000Z'))).toBe(false);
    expect(unappliedChargeOverdue(made, new Date('2026-10-22T23:00:00.000Z'))).toBe(true);
  });
});

describe('unappliedChargeDueAt: boundaries (OD-30)', () => {
  const due = (iso: string) => unappliedChargeDueAt(new Date(iso)).toISOString();
  it('crosses a month end: Saturday 31 October is due end of Monday 2 November', () => {
    expect(due('2026-10-31T10:00:00Z')).toBe('2026-11-02T22:59:59.999Z');
  });
  it('the Lagos day boundary on a Friday: 22:59:59.999Z is still Friday, 23:00:00Z is Saturday', () => {
    // Both land on the next business day, Monday, but only after a Lagos weekend check.
    expect(due('2026-10-23T22:59:59.999Z')).toBe('2026-10-26T22:59:59.999Z');
    expect(due('2026-10-23T23:00:00.000Z')).toBe('2026-10-26T22:59:59.999Z');
  });
  it('Thursday 22:59:59.999Z is due Friday; Thursday 23:00:00Z (already Friday in Lagos) is due Monday', () => {
    expect(due('2026-10-22T22:59:59.999Z')).toBe('2026-10-23T22:59:59.999Z');
    expect(due('2026-10-22T23:00:00.000Z')).toBe('2026-10-26T22:59:59.999Z');
  });
  it('is not overdue at the exact deadline instant, overdue one millisecond later', () => {
    const created = new Date('2026-10-19T08:00:00Z');
    const deadline = unappliedChargeDueAt(created);
    expect(unappliedChargeOverdue(created, deadline)).toBe(false);
    expect(unappliedChargeOverdue(created, new Date(deadline.getTime() + 1))).toBe(true);
  });
});

describe('isStandardMonthlyCycle (OWN-33, G-115)', () => {
  const start = new Date('2026-03-05T09:00:00Z');
  it('accepts a calendar month of any length', () => {
    expect(isStandardMonthlyCycle(start, addMonth(start))).toBe(true);
    const feb = new Date('2026-02-01T09:00:00Z');
    expect(isStandardMonthlyCycle(feb, addMonth(feb))).toBe(true); // 28 days
    const jan = new Date('2026-01-31T09:00:00Z');
    expect(isStandardMonthlyCycle(jan, addMonth(jan))).toBe(true);
  });
  it('refuses a one-year, a multi-month and a one-week arrangement', () => {
    expect(isStandardMonthlyCycle(start, new Date('2027-03-05T09:00:00Z'))).toBe(false);
    expect(isStandardMonthlyCycle(start, addMonth(addMonth(start)))).toBe(false);
    expect(isStandardMonthlyCycle(start, new Date('2026-03-12T09:00:00Z'))).toBe(false);
  });
});

describe('upgradeProrationEligibility (OWN-33, G-115 Option B)', () => {
  const start = new Date('2026-09-01T00:00:00Z');
  const month = new Date('2026-10-01T00:00:00Z');
  const year = new Date('2027-09-01T00:00:00Z');

  it('prorates only a provider-bought standard month', () => {
    expect(
      upgradeProrationEligibility({
        origin: 'provider',
        cycleStartedAt: start,
        planExpiresAt: month,
      }),
    ).toBe('automatic');
  });

  it.each([
    ['an operator 30-day cycle', 'operator', start, month],
    ['an operator annual cycle', 'operator', start, year],
    ['an unknown origin', null, start, month],
    ['a provider cycle that is not a month', 'provider', start, year],
    ['a provider cycle with no start', 'provider', null, month],
    ['a provider cycle with no expiry', 'provider', start, null],
  ] as const)('sends %s to support review', (_label, origin, cycleStartedAt, planExpiresAt) => {
    expect(upgradeProrationEligibility({ origin, cycleStartedAt, planExpiresAt })).toBe(
      'support_review',
    );
  });
});

describe('annual billing (OWN-40, G-110)', () => {
  it('renews an annual cycle on the same Lagos day twelve months on', () => {
    expect(addInterval(at('2026-08-12T09:00:00Z'), 'annual').toISOString()).toBe(
      '2027-08-12T09:00:00.000Z',
    );
  });

  it('a monthly interval is exactly addMonth', () => {
    const from = at('2026-01-31T09:00:00Z');
    expect(addInterval(from, 'monthly', 31).toISOString()).toBe(addMonth(from, 31).toISOString());
  });

  it('29 February renews on 28 February in a common year and returns to the 29th', () => {
    const leap = at('2028-02-29T09:00:00Z');
    const next = addInterval(leap, 'annual', 29);
    expect(next.toISOString()).toBe('2029-02-28T09:00:00.000Z');
    expect(addInterval(next, 'annual', 29).toISOString()).toBe('2030-02-28T09:00:00.000Z');
    expect(addInterval(at('2031-02-28T09:00:00Z'), 'annual', 29).toISOString()).toBe(
      '2032-02-29T09:00:00.000Z',
    );
  });

  it('an annual cycle is never a standard monthly cycle, so it is never prorated automatically', () => {
    const start = at('2026-08-12T09:00:00Z');
    expect(isStandardMonthlyCycle(start, addInterval(start, 'annual'))).toBe(false);
  });

  it('prices a year at ten months, in whole kobo', () => {
    expect(annualPriceK(990_000)).toBe(9_900_000);
    expect(annualPriceK(1_990_000)).toBe(19_900_000);
    expect(annualPriceK(2_990_000)).toBe(29_900_000);
    expect(annualPriceK(0)).toBe(0);
  });
});

describe('annual pricing never leaks into a plan comparison (OWN-40, review of #340)', () => {
  it('a downgrade on the constant-price path stays a downgrade when the cycle is annual', () => {
    const now = at('2026-11-02T09:00:00Z');
    const charge = planChangeCharge({
      from: 'complete',
      to: 'chat',
      cycleStart: at('2026-08-01T09:00:00Z'),
      renewsAt: at('2027-08-01T09:00:00Z'),
      now,
      interval: 'annual',
    });
    expect(charge.kind).toBe('downgrade');
    expect(charge.amountK).toBe(0);
  });

  it('a first purchase on the constant-price path is still priced at ten months', () => {
    const now = at('2026-11-02T09:00:00Z');
    const charge = planChangeCharge({
      from: 'trial',
      to: 'chat',
      cycleStart: now,
      renewsAt: now,
      now,
      interval: 'annual',
    });
    expect(charge).toMatchObject({
      kind: 'first_purchase',
      amountK: annualPriceK(PLAN_PRICES_K.chat),
    });
  });
});

describe('checkout attempt references (G-102, OWN-50)', () => {
  const charge = 'RKD-SUB-20261024-ABCDEF';

  it('keeps the first attempt on the charge reference itself, so existing links and events still match', () => {
    expect(attemptReference(charge, 1)).toBe(charge);
  });

  it('gives every replacement attempt its own provider reference', () => {
    expect(attemptReference(charge, 2)).toBe('RKD-SUB-20261024-ABCDEF-R2');
    expect(attemptReference(charge, MAX_CHECKOUT_ATTEMPTS)).toBe('RKD-SUB-20261024-ABCDEF-R20');
    const all = Array.from({ length: MAX_CHECKOUT_ATTEMPTS }, (_, i) =>
      attemptReference(charge, i + 1),
    );
    expect(new Set(all).size).toBe(MAX_CHECKOUT_ATTEMPTS);
  });

  it('refuses an attempt number outside 1..MAX', () => {
    expect(() => attemptReference(charge, 0)).toThrow();
    expect(() => attemptReference(charge, MAX_CHECKOUT_ATTEMPTS + 1)).toThrow();
    expect(() => attemptReference(charge, 1.5)).toThrow();
  });

  it('recognises every attempt reference as a subscription reference, and nothing else', () => {
    for (let n = 1; n <= MAX_CHECKOUT_ATTEMPTS; n += 1) {
      expect(SUBSCRIPTION_REFERENCE_PATTERN.test(attemptReference(charge, n))).toBe(true);
    }
    for (const bad of [
      `${charge}-R1`,
      `${charge}-R0`,
      `${charge}-R21`,
      `${charge}-R02`,
      `${charge}-r2`,
      `${charge}-R2-R3`,
      `${charge}-R`,
      `${charge}X`,
      'RKD-INV-20261024-ABCDEF-R2',
    ]) {
      expect(SUBSCRIPTION_REFERENCE_PATTERN.test(bad)).toBe(false);
    }
  });

  it('maps any attempt reference back to the charge it belongs to', () => {
    for (let n = 1; n <= MAX_CHECKOUT_ATTEMPTS; n += 1) {
      expect(chargeReferenceOf(attemptReference(charge, n))).toBe(charge);
    }
  });

  it('works on a reference minted by the real generator', () => {
    const minted = subscriptionReference(new Date('2026-10-24T10:00:00Z'), (n) =>
      Uint8Array.from({ length: n }, (_, i) => i * 7),
    );
    expect(SUBSCRIPTION_REFERENCE_PATTERN.test(minted)).toBe(true);
    expect(chargeReferenceOf(attemptReference(minted, 3))).toBe(minted);
  });
});
