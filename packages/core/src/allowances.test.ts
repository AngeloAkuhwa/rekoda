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

  /**
   * SUPERSEDED as a single monotonic ladder by the owner decision of 26 Aug
   * 2026: `integrate` holds REKODA_INTEGRATE and not REKODA_CHAT, so the
   * merchant-side units it used to carry are capacity for a capability the
   * gate now refuses. Chat and Integrate are two ladders that meet at
   * Complete, not one line through three plans.
   *
   * The invariant that survives, and matters more: WITHIN a capability, a
   * bigger plan never carries less. A merchant who buys up never loses
   * something they were using inside the half they keep.
   */
  it('never walks backwards within a capability', () => {
    const chatUnits = ['messages', 'voice_seconds', 'documents_understood'] as const;
    const integrateUnits = ['orders'] as const;

    for (const unit of chatUnits) {
      expect(PLAN_ALLOWANCES.complete[unit], `complete ${unit} >= chat`).toBeGreaterThanOrEqual(
        PLAN_ALLOWANCES.chat[unit],
      );
    }
    for (const unit of integrateUnits) {
      expect(
        PLAN_ALLOWANCES.complete[unit],
        `complete ${unit} >= integrate`,
      ).toBeGreaterThanOrEqual(PLAN_ALLOWANCES.integrate[unit]);
    }
    /* Document GENERATION is neither half's alone: it is what turns a sale
     * into an invoice, whoever made the sale. It climbs the whole ladder. */
    for (const [below, here] of [
      ['chat', 'integrate'],
      ['integrate', 'complete'],
    ] as const) {
      expect(
        PLAN_ALLOWANCES[here].documents,
        `${here} documents >= ${below}`,
      ).toBeGreaterThanOrEqual(PLAN_ALLOWANCES[below].documents);
    }
  });

  /**
   * The consequence of the same decision, pinned so it cannot drift back by
   * accident: an Integrate plan carries no capacity for the half it does not
   * hold. Capacity the gate refuses is capacity the pricing page must not
   * promise.
   */
  it('gives the Integrate plan no merchant-side capacity', () => {
    expect(PLAN_ALLOWANCES.integrate.messages).toBe(0);
    expect(PLAN_ALLOWANCES.integrate.voice_seconds).toBe(0);
    expect(PLAN_ALLOWANCES.integrate.documents_understood).toBe(0);
    /* But it must still be able to issue the invoice and receipt a customer
     * order produces, or Integrate cannot do its own job. */
    expect(PLAN_ALLOWANCES.integrate.documents).toBeGreaterThan(0);
    expect(PLAN_ALLOWANCES.integrate.orders).toBeGreaterThan(0);
  });

  /** And the Chat plan holds no customer-side capacity, for the same reason. */
  it('gives the Chat plan no order capacity', () => {
    expect(PLAN_ALLOWANCES.chat.orders).toBe(0);
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
