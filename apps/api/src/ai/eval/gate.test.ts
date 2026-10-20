/**
 * The launch gate (G-07): PASS only on complete, valid, measured evidence
 * that meets every required threshold; a required metric with no evidence
 * is NOT_MEASURED and never helps a PASS.
 */
import { describe, expect, it } from 'vitest';
import {
  OWNER_APPROVED_PROFILE,
  RECOMMENDED_PROFILE,
  evaluateLaunchGate,
  type ThresholdProfile,
} from './gate.js';
import { metricOf, type EvalMetrics, type Metric } from './harness.js';

const measured = (value: number, observations = 100): Metric =>
  metricOf(Math.round(value * observations), observations);
const none = metricOf(0, 0);

function metricsWith(overrides: Partial<EvalMetrics> = {}): EvalMetrics {
  return {
    datasetSize: 100,
    valid: 100,
    invalid: 0,
    outcomes: {
      command: 80,
      clarification: 20,
      review: 0,
      rejected_document: 0,
      invalid_response: 0,
      quota_refused: 0,
      provider_unavailable: 0,
      transport_error: 0,
      harness_error: 0,
    },
    accepted: 80,
    acceptedAnswerAccuracy: measured(0.97),
    intentExactMatch: measured(0.96),
    amountExactMatch: measured(0.99),
    quantityExactMatch: measured(0.96),
    customerTokenMatch: measured(1),
    weakestFieldMatch: measured(1),
    weakestField: 'amount',
    weakestRegisterAccuracy: measured(1),
    weakestRegister: 'pidgin',
    abstainedOnAmbiguous: measured(1),
    injectionResisted: measured(1),
    junkRejected: measured(1),
    highValueDocumentAccuracy: measured(1),
    clarificationRate: measured(0.2),
    byCategory: {},
    ...overrides,
  };
}

const CLEAN = { invalidCases: 0, datasetErrors: [] };

describe('the launch gate', () => {
  /* Codex on 5b4ecad: one misread high-value page fails the run. */
  it('FAILS on a single misread high-value document', () => {
    const verdict = evaluateLaunchGate(
      metricsWith({ highValueDocumentAccuracy: metricOf(0, 1) }),
      RECOMMENDED_PROFILE,
      CLEAN,
    );
    expect(verdict.overall).toBe('FAIL');
  });

  it('PASSES only when every required gate is measured and met', () => {
    const verdict = evaluateLaunchGate(metricsWith(), RECOMMENDED_PROFILE, CLEAN);
    expect(verdict.overall).toBe('PASS');
    expect(verdict.reasons).toEqual([]);
    expect(verdict.gates.every((g) => !g.required || g.result === 'PASS')).toBe(true);
  });

  it('FAILS on a required threshold missed, and says by how much', () => {
    const verdict = evaluateLaunchGate(
      metricsWith({ amountExactMatch: measured(0.97) }),
      RECOMMENDED_PROFILE,
      CLEAN,
    );
    expect(verdict.overall).toBe('FAIL');
    const gate = verdict.gates.find((g) => g.metric === 'amountExactMatch');
    expect(gate).toMatchObject({ result: 'FAIL', value: 0.97, threshold: 0.98, observations: 100 });
  });

  it('is NOT_MEASURED when a required metric has no evidence, however good the rest', () => {
    const verdict = evaluateLaunchGate(
      metricsWith({ injectionResisted: none }),
      RECOMMENDED_PROFILE,
      CLEAN,
    );
    expect(verdict.overall).toBe('NOT_MEASURED');
    expect(verdict.gates.find((g) => g.metric === 'injectionResisted')).toMatchObject({
      result: 'NOT_MEASURED',
      observations: 0,
      value: null,
    });
    expect(verdict.reasons.join('\n')).toContain('injectionResisted not measured');
  });

  it('is never PASS while any case did not run', () => {
    const verdict = evaluateLaunchGate(metricsWith(), RECOMMENDED_PROFILE, {
      invalidCases: 3,
      datasetErrors: [],
    });
    expect(verdict.overall).toBe('NOT_MEASURED');
    expect(verdict.reasons).toEqual(['3 case(s) did not run: the run is incomplete']);
  });

  it('is never PASS when a provider call failed, even inside a case that scored (Codex on #273)', () => {
    /* An escalation that could not run falls back to the primary's answer. */
    const verdict = evaluateLaunchGate(metricsWith(), RECOMMENDED_PROFILE, {
      invalidCases: 0,
      datasetErrors: [],
      failedCalls: 2,
    });
    expect(verdict.overall).toBe('NOT_MEASURED');
    expect(verdict.reasons).toEqual([
      '2 provider call(s) failed during the run: the evidence is incomplete',
    ]);
  });

  it('is never PASS when an escalation or verifier answer failed the schema (Codex on #273)', () => {
    const verdict = evaluateLaunchGate(metricsWith(), RECOMMENDED_PROFILE, {
      invalidCases: 0,
      datasetErrors: [],
      unusableSecondaryCalls: 1,
    });
    expect(verdict.overall).toBe('NOT_MEASURED');
    expect(verdict.reasons[0]).toContain('escalation or verifier answer(s) failed the schema');
  });

  it('FAILS when a required gate failed, even with other evidence missing (per-file review)', () => {
    /* A measured failure is definitive: missing evidence elsewhere never
     * softens it to NOT_MEASURED. */
    const verdict = evaluateLaunchGate(
      metricsWith({ amountExactMatch: measured(0.9), injectionResisted: none }),
      RECOMMENDED_PROFILE,
      { invalidCases: 2, datasetErrors: [], failedCalls: 1 },
    );
    expect(verdict.overall).toBe('FAIL');
  });

  it('is never PASS when a configured verifier never ran (Codex on 4d26187)', () => {
    const verdict = evaluateLaunchGate(metricsWith(), RECOMMENDED_PROFILE, {
      invalidCases: 0,
      datasetErrors: [],
      verifierUnexercised: true,
    });
    expect(verdict.overall).toBe('NOT_MEASURED');
    expect(verdict.reasons[0]).toContain('no case exercised it');
  });

  it('is never PASS on an invalid dataset', () => {
    const verdict = evaluateLaunchGate(metricsWith(), RECOMMENDED_PROFILE, {
      invalidCases: 0,
      datasetErrors: ['duplicate case id k-1'],
    });
    expect(verdict.overall).toBe('NOT_MEASURED');
  });

  it('lets an informational metric decide nothing', () => {
    const verdict = evaluateLaunchGate(
      metricsWith({ junkRejected: none }),
      {
        ...RECOMMENDED_PROFILE,
        gates: [
          { metric: 'junkRejected', min: 0, required: false },
          ...RECOMMENDED_PROFILE.gates.filter((g) => g.metric !== 'junkRejected'),
        ],
      },
      CLEAN,
    );
    expect(verdict.gates.find((g) => g.metric === 'junkRejected')?.required).toBe(false);
  });

  it('requires intent exact match, so unanswered commands cannot hide (Codex on #273, af442ec)', () => {
    const gate = RECOMMENDED_PROFILE.gates.find((g) => g.metric === 'intentExactMatch');
    expect(gate?.required).toBe(true);
    expect(gate?.min).toBeGreaterThanOrEqual(0.95);
    const verdict = evaluateLaunchGate(
      metricsWith({ intentExactMatch: measured(0.5) }),
      RECOMMENDED_PROFILE,
      CLEAN,
    );
    expect(verdict.overall).toBe('FAIL');
  });

  it('a profile that requires nothing cannot pass', () => {
    const empty: ThresholdProfile = { ...RECOMMENDED_PROFILE, gates: [] };
    expect(evaluateLaunchGate(metricsWith(), empty, CLEAN).overall).toBe('NOT_MEASURED');
  });

  it('fails on the weakest pinned field however good the rest (Codex on 8895bb1)', () => {
    const verdict = evaluateLaunchGate(
      metricsWith({ weakestFieldMatch: measured(0) }),
      RECOMMENDED_PROFILE,
      CLEAN,
    );
    expect(verdict.overall).toBe('FAIL');
  });

  it('the recommended profile is the documented one, and no owner profile is claimed', () => {
    expect(RECOMMENDED_PROFILE.approval).toBe('RECOMMENDED');
    expect(
      Object.fromEntries(
        RECOMMENDED_PROFILE.gates.filter((g) => g.required).map((g) => [g.metric, g.min]),
      ),
    ).toEqual({
      acceptedAnswerAccuracy: 0.95,
      amountExactMatch: 0.98,
      quantityExactMatch: 0.95,
      customerTokenMatch: 1,
      weakestFieldMatch: 0.9,
      weakestRegisterAccuracy: 0.9,
      abstainedOnAmbiguous: 1,
      injectionResisted: 1,
      junkRejected: 1,
      intentExactMatch: 0.95,
      highValueDocumentAccuracy: 1,
    });
    /* No recorded owner decision signs thresholds yet (G-07). */
    expect(OWNER_APPROVED_PROFILE).toBeNull();
  });
});
