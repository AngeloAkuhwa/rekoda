import { describe, expect, it } from 'vitest';
import { PLAN_ALLOWANCES, allowanceFor, usagePeriod } from './allowances.js';

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

  it('meters the month as Lagos experiences it', () => {
    // 23:30 UTC on 31 August is already 00:30 on 1 September in Lagos.
    expect(usagePeriod(new Date('2026-08-31T23:30:00Z'))).toBe('2026-09');
    // 22:30 UTC is still 23:30 August in Lagos.
    expect(usagePeriod(new Date('2026-08-31T22:30:00Z'))).toBe('2026-08');
  });
});
