/**
 * The live run's report and exit status, and the provider it runs (G-07).
 * No provider is called here: the report is pure, and the transport is
 * only constructed, never sent.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, type ApiConfig } from '../../config.js';
import { AnthropicTransport } from '../anthropic.transport.js';
import { OpenAiTransport } from '../openai.transport.js';
import { createModelTransport, describeAiConfiguration } from '../transport-factory.js';
import { RECOMMENDED_PROFILE, type ThresholdProfile } from './gate.js';
import { metricOf, type EvalMetrics } from './harness.js';
import {
  MEASUREMENT_ONLY,
  buildEvalReport,
  exitCodeFor,
  profileFor,
  renderEvalReport,
  type UsageSummary,
} from './report.js';
import { EVAL_CASES } from './dataset.js';
import { checkoutRefusal, evalConfig, parseEvalArgs, reportedSha } from './run-eval.js';
import { MANIFEST_PATH, verifyBuild, writeBuildManifest } from './build-stamp.js';

function configWith(env: Record<string, string>): ApiConfig {
  const saved = { ...process.env };
  try {
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'AI_BASE_URL']) {
      delete process.env[key];
    }
    Object.assign(process.env, {
      DATABASE_URL: 'postgres://eval@127.0.0.1:1/eval',
      OTP_PEPPER: randomBytes(24).toString('hex'),
      REKODA_API_SECRET: randomBytes(24).toString('hex'),
      VAULT_KEY: randomBytes(32).toString('hex'),
      MATCH_KEY: randomBytes(32).toString('hex'),
      ...env,
    });
    return loadConfig();
  } finally {
    process.env = saved;
  }
}

const OPENAI = {
  AI_PROVIDER: 'openai',
  OPENAI_API_KEY: 'sk-test-not-a-key',
  AI_MODEL_DEFAULT: 'gpt-5-mini',
  AI_MODEL_CLASSIFIER: 'gpt-5-mini',
  AI_MODEL_VISION: 'gpt-5-mini',
  AI_MODEL_ESCALATION: 'gpt-5',
  AI_MODEL_PRICES:
    '{"gpt-5-mini":{"in":250000,"out":2000000,"cacheRead":25000},"gpt-5":{"in":1250000,"out":10000000,"cacheRead":125000}}',
};

describe('the provider an evaluation runs (G-07)', () => {
  it('is the configured one: OpenAI configured, OpenAI evaluated', () => {
    expect(createModelTransport(configWith(OPENAI))).toBeInstanceOf(OpenAiTransport);
  });

  it('is Anthropic when Anthropic is configured', () => {
    const config = configWith({ ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key' });
    expect(createModelTransport(config)).toBeInstanceOf(AnthropicTransport);
  });

  it('is never built by the runner itself, so it cannot drift from production', () => {
    /* On main the runner constructed AnthropicTransport directly and
     * refused a deployment configured for OpenAI. */
    const runner = readFileSync(new URL('./run-eval.ts', import.meta.url), 'utf8');
    expect(runner).not.toMatch(/new (Anthropic|OpenAi)Transport\(/);
    expect(runner).toContain('createModelTransport(config)');
  });

  it('names every model by role, and no secret', () => {
    const summary = describeAiConfiguration(
      configWith({ ...OPENAI, AI_BASE_URL: 'https://user:pw@llm.example.com/v1' }),
    );
    expect(summary).toMatchObject({
      provider: 'openai',
      baseUrlHost: 'llm.example.com',
      keyPresent: { openai: true, anthropic: false },
      models: { interpreter: 'gpt-5-mini', classifier: 'gpt-5-mini', escalation: 'gpt-5' },
    });
    const printed = JSON.stringify(summary);
    expect(printed).not.toContain('sk-test');
    expect(printed).not.toContain('pw@');
  });
});

const USAGE: UsageSummary = {
  providerCalls: 90,
  interpreterCalls: 80,
  escalationCalls: 8,
  failedCalls: 0,
  unusableSecondaryCalls: 0,
  classifierCalls: 0,
  unpricedCalls: 0,
  inputTokens: 120_000,
  outputTokens: 9_000,
  cacheReadTokens: 100_000,
  cacheWriteTokens: 0,
  providerCostMicros: 400_000,
};

function metrics(overrides: Partial<EvalMetrics> = {}): EvalMetrics {
  const full = metricOf(10, 10);
  return {
    datasetSize: 10,
    valid: 10,
    invalid: 0,
    outcomes: {
      command: 8,
      clarification: 2,
      review: 0,
      rejected_document: 0,
      invalid_response: 0,
      quota_refused: 0,
      provider_unavailable: 0,
      transport_error: 0,
      harness_error: 0,
    },
    accepted: 8,
    acceptedAnswerAccuracy: full,
    intentExactMatch: full,
    amountExactMatch: full,
    quantityExactMatch: full,
    customerTokenMatch: full,
    abstainedOnAmbiguous: full,
    injectionResisted: full,
    clarificationRate: metricOf(2, 10),
    byCategory: { pidgin: { total: 10, passed: 10, failed: 0, invalid: 0 } },
    ...overrides,
  };
}

const report = (mode: 'measure' | 'gate', extra: Record<string, unknown> = {}) =>
  buildEvalReport({
    mode,
    timestamp: '2026-10-19T00:00:00.000Z',
    gitSha: 'abc123',
    dataset: { version: 2, size: 10, fingerprint: 'sha256:x', errors: [] },
    configuration: describeAiConfiguration(configWith(OPENAI)),
    metrics: metrics(),
    results: Array.from({ length: 8 }, (_, i) => ({
      caseId: `c${i}`,
      category: 'pidgin' as const,
      outcome: 'command' as const,
      status: 'passed' as const,
      failedChecks: [],
      checks: [],
    })),
    usage: USAGE,
    ...extra,
  });

const SIGNED: ThresholdProfile = {
  ...RECOMMENDED_PROFILE,
  id: 'signed',
  approval: 'OWNER_APPROVED',
};

describe('the evaluation report (G-07)', () => {
  it('a measurement run says so, and is never a launch pass', () => {
    const r = report('measure');
    expect(r.launch).toBe('NOT_A_LAUNCH_RUN');
    expect(r.label).toBe(MEASUREMENT_ONLY);
    const text = renderEvalReport(r);
    expect(text).toContain(MEASUREMENT_ONLY);
    expect(text).not.toMatch(/LAUNCH GATE: PASS/);
    expect(exitCodeFor(r)).toBe(0);
  });

  it('a gate run with no owner-approved profile is NOT_MEASURED and exits non-zero', () => {
    const r = report('gate');
    expect(r.launch).toBe('NOT_MEASURED');
    expect(r.launchReasons[0]).toContain('no owner-approved threshold profile');
    expect(exitCodeFor(r)).toBe(1);
    expect(profileFor('gate').profile).toBeNull();
  });

  it('a gate run passes only against a signed profile with complete evidence', () => {
    expect(exitCodeFor(report('gate', { ownerApproved: SIGNED }))).toBe(0);
    const failing = report('gate', {
      ownerApproved: SIGNED,
      metrics: metrics({ amountExactMatch: metricOf(9, 10) }),
    });
    expect(failing.launch).toBe('FAIL');
    expect(exitCodeFor(failing)).toBe(1);
    const unmeasured = report('gate', {
      ownerApproved: SIGNED,
      metrics: metrics({ abstainedOnAmbiguous: metricOf(0, 0) }),
    });
    expect(unmeasured.launch).toBe('NOT_MEASURED');
    expect(exitCodeFor(unmeasured)).toBe(1);
    const incomplete = report('gate', { ownerApproved: SIGNED, metrics: metrics({ invalid: 1 }) });
    expect(exitCodeFor(incomplete)).toBe(1);
  });

  it('an invalid dataset exits non-zero in either mode', () => {
    const bad = { version: 2, size: 10, fingerprint: 'sha256:x', errors: ['duplicate case id a'] };
    expect(exitCodeFor(report('measure', { dataset: bad }))).toBe(1);
    expect(exitCodeFor(report('gate', { ownerApproved: SIGNED, dataset: bad }))).toBe(1);
  });

  it('carries what was tested, what it scored and what it cost', () => {
    const r = report('measure');
    expect(r).toMatchObject({
      gitSha: 'abc123',
      dataset: { version: 2, size: 10, fingerprint: 'sha256:x' },
      configuration: { provider: 'openai', models: { interpreter: 'gpt-5-mini' } },
      escalationRate: { value: 0.1, observations: 80 },
      costPerCorrectAcceptedDraftMicros: 50_000,
    });
    expect(r.promptFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    const text = renderEvalReport(r);
    for (const line of [
      'accepted-answer accuracy',
      'amount exact match',
      'quantity exact match',
      'customer-token match',
      'ambiguity safety',
      'injection resistance',
      'escalation rate',
      'cache read 100000',
      'provider cost      400000 USD micros',
      'interpreter=gpt-5-mini',
    ]) {
      expect(text).toContain(line);
    }
    expect(text).not.toContain('sk-test');
  });

  it('prints a metric with no evidence as NOT_MEASURED, never as a number', () => {
    const r = report('measure', { metrics: metrics({ injectionResisted: metricOf(0, 0) }) });
    expect(renderEvalReport(r)).toContain('injection resistance       NOT_MEASURED');
  });

  it('counts no Query answer as a draft in the cost per correct draft (Codex on #273)', () => {
    const queries = Array.from({ length: 4 }, (_, i) => ({
      caseId: `q${i}`,
      category: 'query_period' as const,
      outcome: 'command' as const,
      status: 'passed' as const,
      failedChecks: [],
      checks: [],
      intent: 'Query',
    }));
    expect(report('measure', { results: queries }).costPerCorrectAcceptedDraftMicros).toBeNull();
    const drafts = queries.map((q, i) => (i < 2 ? { ...q, intent: 'RecordSale' } : q));
    expect(report('measure', { results: drafts }).costPerCorrectAcceptedDraftMicros).toBe(200_000);
  });

  it('has no cost per correct draft when nothing correct was accepted', () => {
    expect(report('measure', { results: [] }).costPerCorrectAcceptedDraftMicros).toBeNull();
  });
});

describe('the checkout a run is attributed to (G-07, Codex on #273)', () => {
  const proven = { verified: true, reason: null, output: 'sha256:abc' };
  const clean = { sha: 'abc123', dirty: false, build: proven };

  it('refuses a launch-gate run from a dirty checkout, and only that', () => {
    expect(checkoutRefusal('gate', { ...clean, dirty: true })).toContain('uncommitted changes');
    expect(checkoutRefusal('gate', clean)).toBeNull();
    /* An image has no git: its built commit (REKODA_COMMIT) names the run. */
    expect(checkoutRefusal('gate', { sha: 'b81ef90', dirty: null, build: proven })).toBeNull();
    expect(checkoutRefusal('measure', { ...clean, dirty: true })).toBeNull();
  });

  it('refuses a launch-gate run whose compiled code is not proven to be the commit', () => {
    const unproven = {
      verified: false,
      reason: 'a compiled file changed after the build; run pnpm turbo build --force',
      output: 'sha256:def',
    };
    expect(checkoutRefusal('gate', { ...clean, build: unproven })).toContain(
      'a compiled file changed after the build',
    );
    /* A measurement runs, and says so in the SHA it reports. */
    expect(checkoutRefusal('measure', { ...clean, build: unproven })).toBeNull();
    expect(reportedSha({ ...clean, build: unproven })).toBe('abc123-unverified-build');
    expect(reportedSha({ ...clean, dirty: true })).toBe('abc123-dirty');
    expect(reportedSha(clean)).toBe('abc123');
  });

  it('refuses a launch-gate run no commit identifies', () => {
    expect(checkoutRefusal('gate', { sha: 'unknown', dirty: null, build: proven })).toContain(
      'no commit identifies this build',
    );
  });
});

describe('which code a gate run executed, proven by the build manifest (Codex on #273)', () => {
  const root = mkdtempSync(join(tmpdir(), 'rekoda-build-'));
  const put = (path: string, body: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const packages = ['apps/api', 'packages/core'];
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('verifies a build against the manifest it stamped, and refuses every way it can drift', () => {
    put('apps/api/src/a.ts', 'export const a = 1;');
    put('apps/api/dist/a.js', 'export const a = 1;');
    put('packages/core/src/b.ts', 'export const b = 1;');
    put('packages/core/dist/b.js', 'export const b = 1;');

    /* No manifest: nothing proven. */
    expect(verifyBuild(root, packages)).toMatchObject({ verified: false });

    writeBuildManifest(root, packages);
    expect(readFileSync(join(root, MANIFEST_PATH), 'utf8')).toContain('sha256:');
    expect(verifyBuild(root, packages)).toMatchObject({ verified: true, reason: null });

    /* A compiled file edited by hand after the build: refused, whatever its time. */
    put('packages/core/dist/b.js', 'export const b = 2;');
    expect(verifyBuild(root, packages)).toMatchObject({
      verified: false,
      reason: expect.stringContaining('a compiled file changed after the build'),
    });
    put('packages/core/dist/b.js', 'export const b = 1;');
    expect(verifyBuild(root, packages).verified).toBe(true);

    /* Source changed, or another commit checked out, after the build: refused. */
    put('packages/core/src/b.ts', 'export const b = 3;');
    expect(verifyBuild(root, packages)).toMatchObject({
      verified: false,
      reason: expect.stringContaining('the source changed after it was built'),
    });
  });
});

describe('the runner arguments (G-07)', () => {
  it('defaults to measurement, and refuses an argument it does not know', () => {
    expect(parseEvalArgs([])).toEqual({ mode: 'measure', plan: false, json: null });
    expect(parseEvalArgs(['--mode=gate', '--plan', '--json=r.json'])).toEqual({
      mode: 'gate',
      plan: true,
      json: 'r.json',
    });
    expect(() => parseEvalArgs(['--mode=launch'])).toThrow('unknown argument');
  });
});

describe('the evaluation configuration (G-07)', () => {
  it('gives the eval tenant room for every case and leaves the global ceiling alone', () => {
    const config = configWith(OPENAI);
    /* A page can make four calls (classifier, interpreter, escalation,
     * verifier); typed text two (final review). */
    const documents = EVAL_CASES.filter((c) => c.source === 'document_text').length;
    const run = evalConfig(config, EVAL_CASES);
    expect(run.aiCallsPerBusinessPerDay).toBe(
      Math.max(
        config.aiCallsPerBusinessPerDay,
        documents * 4 + (EVAL_CASES.length - documents) * 2,
      ),
    );
    expect(run.aiCallsGlobalPerDay).toBe(config.aiCallsGlobalPerDay);
    expect(run.aiProvider).toBe(config.aiProvider);
    expect(run.aiModelDefault).toBe(config.aiModelDefault);
  });
});

describe('a run with a failed provider call (G-07, Codex on #273)', () => {
  it('cannot pass the gate even when every case scored', () => {
    const r = report('gate', { ownerApproved: SIGNED, usage: { ...USAGE, failedCalls: 1 } });
    expect(r.launch).toBe('NOT_MEASURED');
    expect(exitCodeFor(r)).toBe(1);
  });
});
