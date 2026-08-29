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
  META_COST_SCHEDULE,
  authTemplateCategory,
  costRatio,
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
   * Spec §24's own justification for separating the categories, checked
   * against the rates rather than against a number somebody typed.
   *
   * The ratio is DERIVED. Writing "5.2x" or "8x" into the codebase would
   * create a figure that keeps its value after the rates it described have
   * moved, which is the quiet way a cost model starts lying.
   */
  it('keeps marketing roughly eightfold utility, which is why they are apart', () => {
    const ratio = costRatio('MARKETING_TEMPLATE', 'UTILITY_TEMPLATE');
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThan(7);
    expect(ratio!).toBeLessThan(9);
  });

  it('carries the rate card it was computed from, so a report can name it', () => {
    expect(META_COST_SCHEDULE.version).toBe('meta-ng-2026-08');
    expect(META_COST_SCHEDULE.effectiveFrom).toBe('2026-08-24');
    expect(MESSAGE_COST_MICROS).toBe(META_COST_SCHEDULE.micros);
  });

  /**
   * A ratio recomputes against whatever schedule it is handed, which is the
   * whole reason it is a function. A repricing moves it; nobody edits a
   * constant, and no stale multiple outlives the rates behind it.
   */
  it('moves with the schedule instead of outliving it', () => {
    const reprice = {
      ...META_COST_SCHEDULE,
      version: 'hypothetical',
      micros: { ...META_COST_SCHEDULE.micros, MARKETING_TEMPLATE: 13_400 },
    };
    expect(costRatio('MARKETING_TEMPLATE', 'UTILITY_TEMPLATE', reprice)).toBe(2);
  });

  /* Service messages are free today, and a ratio against zero is not a big
   * number, it is not a number. Null says so rather than returning Infinity
   * into a cost report. */
  it('refuses to divide by a free category', () => {
    expect(costRatio('UTILITY_TEMPLATE', 'SERVICE_MESSAGE')).toBeNull();
  });

  /**
   * The launch requirement of docs/pricing-model.md, made arithmetic: a WABA
   * registered outside Nigeria pays over five times as much for the same
   * sign-in code.
   */
  it('charges a WABA registered outside Nigeria five times over for one code', () => {
    expect(authTemplateCategory(true)).toBe('AUTH_TEMPLATE');
    expect(authTemplateCategory(false)).toBe('AUTH_INTL_TEMPLATE');

    const overcharge = costRatio(authTemplateCategory(false), authTemplateCategory(true));
    expect(overcharge).not.toBeNull();
    expect(overcharge!).toBeGreaterThan(5);
  });
});
