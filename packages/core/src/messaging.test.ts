/**
 * The rate card, pinned against docs/pricing-model.md.
 *
 * These numbers decide plan margin and nothing in the running system will
 * ever contradict them out loud: a wrong rate produces a plausible cost
 * report that is quietly wrong for a month. So they are asserted against the
 * document they came from, including the ratio spec §24 uses to justify
 * metering the categories apart in the first place.
 */
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_CATEGORIES,
  MESSAGE_COST_MICROS,
  authTemplateCategory,
  messageCostK,
} from './messaging.js';
import { USAGE_UNITS } from './allowances.js';

/** The planning FX of docs/pricing-model.md, held at a ~7.7% buffer. */
const PLANNING_FX = 1_450;

describe('what an outbound message costs', () => {
  it('is one of the canonical metered units, every one of them', () => {
    for (const category of MESSAGE_CATEGORIES) {
      expect(USAGE_UNITS, `${category} is a metered unit`).toContain(category);
    }
    expect(MESSAGE_CATEGORIES).toHaveLength(5);
  });

  it('prices each category at the researched figure', () => {
    expect(MESSAGE_COST_MICROS.SERVICE_MESSAGE).toBe(0);
    expect(MESSAGE_COST_MICROS.UTILITY_TEMPLATE).toBe(6_700);
    expect(MESSAGE_COST_MICROS.AUTH_TEMPLATE).toBe(14_500);
    expect(MESSAGE_COST_MICROS.AUTH_INTL_TEMPLATE).toBe(75_000);
    expect(MESSAGE_COST_MICROS.MARKETING_TEMPLATE).toBe(51_600);
  });

  /** The naira column of the external cost stack, to the kobo. */
  it('converts to the naira figures the cost stack publishes', () => {
    expect(messageCostK(MESSAGE_COST_MICROS.UTILITY_TEMPLATE, PLANNING_FX)).toBe(972);
    expect(messageCostK(MESSAGE_COST_MICROS.AUTH_TEMPLATE, PLANNING_FX)).toBe(2_103);
    expect(messageCostK(MESSAGE_COST_MICROS.MARKETING_TEMPLATE, PLANNING_FX)).toBe(7_482);
    expect(messageCostK(MESSAGE_COST_MICROS.SERVICE_MESSAGE, PLANNING_FX)).toBe(0);
  });

  /**
   * Spec §24's own justification for separating the categories. If this ratio
   * ever collapses toward one, the separation stops earning its complexity
   * and the specification should be told rather than the code quietly
   * carrying five buckets that all cost the same.
   */
  it('keeps marketing roughly eightfold utility, which is why they are apart', () => {
    const ratio = MESSAGE_COST_MICROS.MARKETING_TEMPLATE / MESSAGE_COST_MICROS.UTILITY_TEMPLATE;
    expect(ratio).toBeGreaterThan(7);
    expect(ratio).toBeLessThan(9);
  });

  /**
   * The launch requirement of docs/pricing-model.md, made arithmetic: a WABA
   * registered outside Nigeria pays over five times as much for the same
   * sign-in code.
   */
  it('charges a WABA registered outside Nigeria five times over for one code', () => {
    expect(authTemplateCategory(true)).toBe('AUTH_TEMPLATE');
    expect(authTemplateCategory(false)).toBe('AUTH_INTL_TEMPLATE');

    const domestic = MESSAGE_COST_MICROS[authTemplateCategory(true)];
    const abroad = MESSAGE_COST_MICROS[authTemplateCategory(false)];
    expect(abroad / domestic).toBeGreaterThan(5);
  });
});
