import { describe, expect, it } from 'vitest';
import {
  PLAN_ALLOWANCES,
  SEATS_PER_PLAN,
  allowanceFor,
  seatsFor,
  usagePeriod,
} from './allowances.js';

describe('plan allowances (docs/metering-v1.md)', () => {
  it('gives every plan a number for every unit — no unit escapes the meter', () => {
    for (const plan of Object.values(PLAN_ALLOWANCES)) {
      for (const value of Object.values(plan)) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('treats an unknown plan as TRIAL — the safe direction is stingy', () => {
    // A corrupted or future plan value must never mean "unlimited".
    expect(allowanceFor('platinum-unlimited', 'messages')).toBe(PLAN_ALLOWANCES.trial.messages);
  });

  it('the paid ladder never walks backwards — a bigger plan never carries less of anything', () => {
    /* The bug this pins: Integrate once had ZERO voice while cheaper Chat
     * had an hour, so a merchant who upgraded lost a feature they were
     * using. Every unit must be monotonic up the paid ladder, so a plan
     * change is only ever an addition. */
    const ladder = ['chat', 'integrate', 'complete'] as const;
    for (let i = 1; i < ladder.length; i++) {
      const below = PLAN_ALLOWANCES[ladder[i - 1]!];
      const here = PLAN_ALLOWANCES[ladder[i]!];
      for (const unit of Object.keys(below) as (keyof typeof below)[]) {
        expect(here[unit], `${ladder[i]} ${unit} >= ${ladder[i - 1]}`).toBeGreaterThanOrEqual(
          below[unit],
        );
      }
    }
  });

  it('seats climb the paid ladder, expire to zero, and treat the unknown as trial', () => {
    expect(SEATS_PER_PLAN.chat).toBeLessThanOrEqual(SEATS_PER_PLAN.integrate);
    expect(SEATS_PER_PLAN.integrate).toBeLessThanOrEqual(SEATS_PER_PLAN.complete);
    expect(SEATS_PER_PLAN.expired).toBe(0);
    expect(seatsFor('platinum-unlimited')).toBe(SEATS_PER_PLAN.trial);
  });

  it('meters the month as Lagos experiences it', () => {
    // 23:30 UTC on 31 August is already 00:30 on 1 September in Lagos.
    expect(usagePeriod(new Date('2026-08-31T23:30:00Z'))).toBe('2026-09');
    // 22:30 UTC is still 23:30 August in Lagos.
    expect(usagePeriod(new Date('2026-08-31T22:30:00Z'))).toBe('2026-08');
  });
});
