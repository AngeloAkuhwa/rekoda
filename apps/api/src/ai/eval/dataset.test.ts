/**
 * The dataset's own integrity: the properties that must hold for every
 * case ANYONE adds, enforced here rather than in review (G-07).
 */
import { describe, expect, it } from 'vitest';
import { detectStructuralPii } from '@rekoda/core/privacy';
import {
  EVAL_BEHAVIOURS,
  EVAL_CASES,
  EVAL_CATEGORIES,
  EVAL_DATASET_VERSION,
  EVAL_REGISTERS,
  datasetFingerprint,
  registerOf,
  validateDataset,
  type EvalCase,
} from './dataset.js';

describe('the evaluation dataset', () => {
  it('passes its own integrity check', () => {
    expect(validateDataset(EVAL_CASES)).toEqual([]);
  });

  it('is version 2 and larger than the v1 set it extends', () => {
    expect(EVAL_DATASET_VERSION).toBe(2);
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(75);
  });

  it('is de-identified: no case carries structural PII', () => {
    /* The dataset is committed to the repository, so it must already be
     * what the interpreter sees AFTER the gateway: tokens, never a phone
     * number or account number. The same detector the interpreter fails
     * closed on guards the fixtures. */
    for (const evalCase of EVAL_CASES) {
      expect(detectStructuralPii(evalCase.input), evalCase.id).toEqual([]);
    }
  });

  it('covers every category, register and behaviour', () => {
    const categories = new Set(EVAL_CASES.map((c) => c.category));
    for (const category of EVAL_CATEGORIES) expect(categories.has(category), category).toBe(true);
    const registers = new Set(EVAL_CASES.map(registerOf));
    for (const register of EVAL_REGISTERS) expect(registers.has(register), register).toBe(true);
    const covered = new Set(EVAL_CASES.flatMap((c) => c.covers));
    for (const behaviour of EVAL_BEHAVIOURS) expect(covered.has(behaviour), behaviour).toBe(true);
  });

  it('pins the safety categories with real cases', () => {
    expect(EVAL_CASES.filter((c) => c.expect.kind === 'refusal').length).toBeGreaterThanOrEqual(4);
    expect(
      EVAL_CASES.filter((c) => c.expect.kind === 'clarification').length,
    ).toBeGreaterThanOrEqual(5);
  });
});

describe('the integrity check catches a broken dataset (G-07)', () => {
  const first = EVAL_CASES[0]!;
  const withCase = (evalCase: EvalCase) => [...EVAL_CASES, evalCase];

  it('a duplicate id', () => {
    expect(validateDataset(withCase({ ...first }))).toContain(`duplicate case id ${first.id}`);
  });

  it('a required category with no case', () => {
    const without = EVAL_CASES.filter((c) => c.category !== 'adversarial_injection');
    expect(validateDataset(without)).toContain('category adversarial_injection has no case');
  });

  it('a safety category with too few cases', () => {
    const without = EVAL_CASES.filter((c) => c.expect.kind !== 'refusal');
    expect(validateDataset(without).join('\n')).toContain('refusal cases: 0');
  });

  it('a malformed expectation', () => {
    const errors = validateDataset(
      withCase({
        ...first,
        id: 'broken',
        expect: { kind: 'command', intent: '', checks: { amount: Number.NaN } },
      }),
    );
    expect(errors).toContain('broken: command expectation without an intent');
    expect(errors).toContain('broken: amount is not a number');
    expect(
      validateDataset(
        withCase({ ...first, id: 'empty', expect: { kind: 'refusal', forbiddenNumbers: [] } }),
      ),
    ).toContain('empty: refusal forbids nothing');
  });

  it('an expected token the input never names', () => {
    expect(
      validateDataset(
        withCase({
          ...first,
          id: 'ghost',
          input: 'sold 2 wigs',
          expect: {
            kind: 'command',
            intent: 'RecordSale',
            checks: { customerToken: 'CUSTOMER_ZZ' },
          },
        }),
      ),
    ).toContain('ghost: expected customer token is not in the input');
  });

  it('a fixture leaking a raw phone number, named by kind and never repeated', () => {
    const errors = validateDataset(
      withCase({ ...first, id: 'leak', input: 'call 08031234567 about the wigs' }),
    );
    expect(errors).toContain('leak: structural PII in input (phone)');
    expect(errors.join('\n')).not.toContain('08031234567');
  });

  it('a missing version', () => {
    expect(validateDataset(EVAL_CASES, 0)).toContain('dataset version missing');
  });
});

describe('the dataset fingerprint (G-07)', () => {
  it('is stable for the same dataset and changes with any case', () => {
    expect(datasetFingerprint()).toBe(datasetFingerprint(EVAL_CASES, EVAL_DATASET_VERSION));
    expect(datasetFingerprint()).toMatch(/^sha256:[0-9a-f]{64}$/);
    const changed = EVAL_CASES.map((c, i) => (i === 0 ? { ...c, input: `${c.input}.` } : c));
    expect(datasetFingerprint(changed)).not.toBe(datasetFingerprint());
    expect(datasetFingerprint(EVAL_CASES, 3)).not.toBe(datasetFingerprint());
  });

  it('does not depend on the order keys were written in', () => {
    const reordered = EVAL_CASES.map((c) => ({
      expect: c.expect,
      input: c.input,
      covers: c.covers,
      source: c.source,
      category: c.category,
      id: c.id,
      ...(c.register ? { register: c.register } : {}),
    }));
    expect(datasetFingerprint(reordered)).toBe(datasetFingerprint());
  });
});
