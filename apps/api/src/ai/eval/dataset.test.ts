/**
 * The dataset's own integrity: the properties that must hold for every
 * case ANYONE adds, enforced here rather than in review.
 */
import { describe, expect, it } from 'vitest';
import { detectStructuralPii } from '@rekoda/core/privacy';
import { EVAL_CASES, EVAL_CATEGORIES } from './dataset.js';

describe('the evaluation dataset', () => {
  it('is de-identified: no case carries structural PII', () => {
    /* The dataset is committed to the repository, so it must already be
     * what the interpreter sees AFTER the gateway: tokens, never a phone
     * number or account number. The same detector the interpreter fails
     * closed on guards the fixtures. */
    for (const evalCase of EVAL_CASES) {
      expect(detectStructuralPii(evalCase.input), evalCase.id).toEqual([]);
    }
  });

  it('has unique ids', () => {
    const ids = EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every category the directive names', () => {
    const covered = new Set(EVAL_CASES.map((c) => c.category));
    for (const category of EVAL_CATEGORIES) {
      expect(covered.has(category), category).toBe(true);
    }
  });

  it('pins the two safety categories with real cases', () => {
    expect(EVAL_CASES.filter((c) => c.expect.kind === 'refusal').length).toBeGreaterThanOrEqual(2);
    expect(
      EVAL_CASES.filter((c) => c.expect.kind === 'clarification').length,
    ).toBeGreaterThanOrEqual(5);
  });

  it('names customers only as tokens', () => {
    for (const evalCase of EVAL_CASES) {
      /* CUSTOMER_* is the gateway's shape. A lowercase name that slips in
       * reads as a real person to whoever audits this file. */
      const mentions = evalCase.input.match(/CUSTOMER_[A-Z0-9]+/g) ?? [];
      for (const mention of mentions) {
        expect(mention).toMatch(/^CUSTOMER_[A-Z0-9]{2,}$/);
      }
    }
  });
});
