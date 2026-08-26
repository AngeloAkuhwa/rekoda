import { describe, expect, it } from 'vitest';
import {
  PLAN_ALLOWANCES,
  UNIT_SCALE,
  USAGE_UNITS,
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
    expect(allowanceFor('platinum-unlimited', 'AI_ACTIONS')).toBe(PLAN_ALLOWANCES.trial.AI_ACTIONS);
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
    const chatUnits = ['AI_ACTIONS', 'VOICE_MINUTES', 'DOCUMENTS_UNDERSTOOD'] as const;
    const integrateUnits = ['CATALOGUE_ORDERS'] as const;

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
        PLAN_ALLOWANCES[here].DOCUMENT_GENERATION,
        `${here} documents >= ${below}`,
      ).toBeGreaterThanOrEqual(PLAN_ALLOWANCES[below].DOCUMENT_GENERATION);
    }
  });

  /**
   * The consequence of the same decision, pinned so it cannot drift back by
   * accident: an Integrate plan carries no capacity for the half it does not
   * hold. Capacity the gate refuses is capacity the pricing page must not
   * promise.
   */
  it('gives the Integrate plan no merchant-side capacity', () => {
    expect(PLAN_ALLOWANCES.integrate.AI_ACTIONS).toBe(0);
    expect(PLAN_ALLOWANCES.integrate.VOICE_MINUTES).toBe(0);
    expect(PLAN_ALLOWANCES.integrate.DOCUMENTS_UNDERSTOOD).toBe(0);
    /* But it must still be able to issue the invoice and receipt a customer
     * order produces, or Integrate cannot do its own job. */
    expect(PLAN_ALLOWANCES.integrate.DOCUMENT_GENERATION).toBeGreaterThan(0);
    expect(PLAN_ALLOWANCES.integrate.CATALOGUE_ORDERS).toBeGreaterThan(0);
  });

  /** And the Chat plan holds no customer-side capacity, for the same reason. */
  it('gives the Chat plan no order capacity', () => {
    expect(PLAN_ALLOWANCES.chat.CATALOGUE_ORDERS).toBe(0);
  });

  /**
   * The vocabulary is the canonical seventeen (spec 4.2), not the five the
   * meter started with. Pinned by name rather than by count, because a
   * renamed unit and a missing unit are different bugs and only the list
   * catches both.
   */
  it('meters the canonical seventeen', () => {
    expect([...USAGE_UNITS].sort()).toEqual(
      [
        'AI_ACTIONS',
        'API_APPLICATIONS',
        'API_REQUEST_UNITS',
        'ACCOUNTANT_USERS',
        'AUTH_INTL_TEMPLATE',
        'AUTH_TEMPLATE',
        'CATALOGUE_ORDERS',
        'DOCUMENTS_UNDERSTOOD',
        'DOCUMENT_GENERATION',
        'FINANCIAL_ACCOUNT_CONNECTIONS',
        'MARKETING_TEMPLATE',
        'PAYMENT_CONNECTIONS',
        'REPORT_EXPORTS',
        'SERVICE_MESSAGE',
        'UTILITY_TEMPLATE',
        'VOICE_MINUTES',
        'WEBHOOK_DELIVERIES',
      ].sort(),
    );
  });

  it('gives every unit a plan figure and a counting scale', () => {
    for (const unit of USAGE_UNITS) {
      expect(UNIT_SCALE[unit], `${unit} scale`).toBeGreaterThan(0);
      for (const [name, plan] of Object.entries(PLAN_ALLOWANCES)) {
        expect(Number.isInteger(plan[unit]), `${name}.${unit}`).toBe(true);
      }
    }
  });

  /**
   * The one unit whose merchant word and countable increment differ. The
   * plan table says sixty minutes, which is what the pricing page quotes;
   * the meter is handed three thousand six hundred, which is what a voice
   * note is measured in. Getting this backwards would sell a merchant a
   * minute of voice a month, so it is pinned in both directions.
   */
  it('sells voice in minutes and counts it in seconds', () => {
    expect(PLAN_ALLOWANCES.chat.VOICE_MINUTES).toBe(60);
    expect(allowanceFor('chat', 'VOICE_MINUTES')).toBe(3_600);
    expect(UNIT_SCALE.VOICE_MINUTES).toBe(60);
  });

  /** Everything else is counted exactly as it is named. */
  it('counts every other unit one for one', () => {
    for (const unit of USAGE_UNITS) {
      if (unit === 'VOICE_MINUTES') continue;
      expect(UNIT_SCALE[unit], `${unit} is not scaled`).toBe(1);
      expect(allowanceFor('complete', unit)).toBe(PLAN_ALLOWANCES.complete[unit]);
    }
  });

  /**
   * The twelve units nothing consumes yet are sold by nobody. A number here
   * would be capacity on the pricing page that no code path can spend; the
   * PR that wires each consumer sets its figure at the same time.
   */
  it('sells nothing it cannot yet deliver', () => {
    const live = [
      'AI_ACTIONS',
      'VOICE_MINUTES',
      'DOCUMENT_GENERATION',
      'DOCUMENTS_UNDERSTOOD',
      'CATALOGUE_ORDERS',
    ] as const;
    for (const unit of USAGE_UNITS) {
      if ((live as readonly string[]).includes(unit)) continue;
      for (const [name, plan] of Object.entries(PLAN_ALLOWANCES)) {
        expect(plan[unit], `${name} sells ${unit}`).toBe(0);
      }
    }
  });

  /**
   * The convention, pinned rather than commented. Reading zero as unlimited
   * is a billing bug that looks like generosity until the invoice arrives,
   * and it is the kind of thing a later refactor introduces by accident.
   */
  it('treats zero as zero and never as unlimited', () => {
    expect(allowanceFor('expired', 'AI_ACTIONS')).toBe(0);
    expect(allowanceFor('chat', 'CATALOGUE_ORDERS')).toBe(0);
    for (const plan of Object.values(PLAN_ALLOWANCES)) {
      for (const value of Object.values(plan)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
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
