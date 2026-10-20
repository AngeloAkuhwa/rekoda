/**
 * The live run's report and exit status, and the provider it runs (G-07).
 * No provider is called here: the report is pure, and the transport is
 * only constructed, never sent.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, type ApiConfig } from '../../config.js';
import { AnthropicTransport } from '../anthropic.transport.js';
import { OpenAiTransport } from '../openai.transport.js';
import {
  createModelTransport,
  createVerifierTransport,
  describeAiConfiguration,
  pricesFingerprint,
} from '../transport-factory.js';
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
import {
  checkoutRefusal,
  checkoutWithoutGit,
  databaseRefusal,
  evalConfig,
  gitState,
  parseEvalArgs,
  reportPathRefusal,
  reportedSha,
  runCasesInRoom,
  writeReportAtomically,
} from './run-eval.js';
import { MANIFEST_PATH, stampedCommit, verifyBuild, writeBuildManifest } from './build-stamp.js';

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
    /* The policy that selects which documents get a second reading is part
     * of what was tested (Codex on #273, af442ec). */
    expect(summary.dualExtractThresholdK).toBe(50_000_000);
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
  verifierCalls: 0,
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
    weakestFieldMatch: full,
    weakestField: 'amount',
    weakestRegisterAccuracy: full,
    weakestRegister: 'pidgin',
    abstainedOnAmbiguous: full,
    injectionResisted: full,
    junkRejected: full,
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
    /* Outside git nothing proves the tree clean, and the commit the build
     * stamped was only what REKODA_COMMIT asserted (final review on
     * a98a294): a launch gate runs from a checkout git can vouch for. */
    expect(checkoutRefusal('gate', { sha: 'b81ef90', dirty: null, build: proven })).toContain(
      'cannot be proven clean',
    );
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

describe('a configured verifier that never ran (Codex on 4d26187)', () => {
  it('leaves the gate unmeasured, and an unconfigured one does not', () => {
    const withVerifier = {
      ...describeAiConfiguration(configWith(OPENAI)),
      models: { ...describeAiConfiguration(configWith(OPENAI)).models, visionVerifier: 'gpt-5' },
    };
    const signed = report('gate', { ownerApproved: SIGNED, configuration: withVerifier });
    expect(signed.launch).toBe('NOT_MEASURED');
    expect(signed.launchReasons.join(' ')).toContain('no case exercised it');
    const exercised = report('gate', {
      ownerApproved: SIGNED,
      configuration: withVerifier,
      usage: { ...USAGE, verifierCalls: 1 },
    });
    expect(exercised.launch).toBe('PASS');
    expect(report('gate', { ownerApproved: SIGNED }).launch).toBe('PASS');
  });
});

describe('the build manifest covers what decides the compiled code (final sanity review)', () => {
  it('refuses a build whose package configuration changed after it was stamped', () => {
    const root = mkdtempSync(join(tmpdir(), 'rekoda-config-'));
    try {
      mkdirSync(join(root, 'apps/api/src'), { recursive: true });
      mkdirSync(join(root, 'apps/api/dist'), { recursive: true });
      writeFileSync(join(root, 'apps/api/src/a.ts'), 'export {}');
      writeFileSync(join(root, 'apps/api/dist/a.js'), 'export {}');
      writeFileSync(
        join(root, 'apps/api/tsconfig.json'),
        '{"compilerOptions":{"target":"es2022"}}',
      );
      writeBuildManifest(root, ['apps/api']);
      expect(verifyBuild(root, ['apps/api']).verified).toBe(true);
      writeFileSync(join(root, 'apps/api/tsconfig.json'), '{"compilerOptions":{"target":"es5"}}');
      expect(verifyBuild(root, ['apps/api'])).toMatchObject({ verified: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe('what a paid run may touch and record (G-07, Codex on #273)', () => {
  it('refuses a production environment and an unnamed database before connecting', () => {
    const url = 'postgres://eval@127.0.0.1:5432/rekoda_eval';
    expect(
      databaseRefusal({ NODE_ENV: 'production', REKODA_EVAL_DATABASE: 'rekoda_eval' }, url),
    ).toContain('production');
    expect(databaseRefusal({}, url)).toContain('REKODA_EVAL_DATABASE');
    expect(databaseRefusal({ REKODA_EVAL_DATABASE: 'rekoda' }, url)).toContain(
      'REKODA_EVAL_DATABASE',
    );
    expect(databaseRefusal({ REKODA_EVAL_DATABASE: 'rekoda_eval' }, url)).toBeNull();
  });

  it('reads git from the verified repository, not the launch directory', () => {
    const other = mkdtempSync(join(tmpdir(), 'eval-git-'));
    execFileSync('git', ['init', '-q'], { cwd: other });
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'],
      { cwd: other },
    );
    const otherSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: other,
      encoding: 'utf8',
    }).trim();
    const config = configWith(OPENAI);
    expect(gitState(config, other).sha).toBe(otherSha);
    expect(gitState(config).sha).not.toBe(otherSha);
  });

  it('tells two endpoints on one host apart, and keeps credentials out', () => {
    const a = describeAiConfiguration(
      configWith({ ...OPENAI, AI_BASE_URL: 'https://u:secret@llm.example.com/team-a/v1' }),
    );
    const b = describeAiConfiguration(
      configWith({ ...OPENAI, AI_BASE_URL: 'https://llm.example.com/team-b/v1' }),
    );
    const a2 = describeAiConfiguration(
      configWith({ ...OPENAI, AI_BASE_URL: 'https://llm.example.com/team-a/v1/' }),
    );
    expect(a.baseUrlHost).toBe(b.baseUrlHost);
    expect(a.baseUrlFingerprint).not.toBe(b.baseUrlFingerprint);
    expect(a.baseUrlFingerprint).toBe(a2.baseUrlFingerprint);
    expect(JSON.stringify(a)).not.toContain('secret');
  });

  /* The SDK sends the base URL's query string with every request, so two
   * deployments behind one path are two endpoints; the order of the
   * parameters is not (Codex on 0e3cea5). Values are hashed, never shown. */
  it('tells endpoints apart by their query string, in any order', () => {
    const of = (url: string) =>
      describeAiConfiguration(configWith({ ...OPENAI, AI_BASE_URL: url }));
    const a = of('https://models.example/v1?deployment=a&region=eu');
    const b = of('https://models.example/v1?deployment=b&region=eu');
    const aReordered = of('https://models.example/v1?region=eu&deployment=a');
    expect(a.baseUrlFingerprint).not.toBe(b.baseUrlFingerprint);
    expect(a.baseUrlFingerprint).toBe(aReordered.baseUrlFingerprint);
    expect(a.baseUrlFingerprint).not.toBe(of('https://models.example/v1').baseUrlFingerprint);
    expect(JSON.stringify(a)).not.toContain('deployment=a');
  });

  it('keeps every case in the durable report so a failed run is diagnosable', () => {
    const failed = {
      caseId: 'c-bad',
      category: 'pidgin' as const,
      outcome: 'command' as const,
      status: 'failed' as const,
      failedChecks: ['amount'],
      checks: [],
    };
    const r = report('measure', { results: [failed] });
    expect(r.results).toEqual([failed]);
    expect(renderEvalReport(r)).toContain('c-bad');
    expect(renderEvalReport(r)).toContain('amount');
  });
});

describe('a run outside git names the commit the build stamped (Codex on 482abd3)', () => {
  const built = (commit: string | null) => ({
    verified: true,
    reason: null,
    output: 'sha256:o',
    commit,
  });

  it('refuses a REKODA_COMMIT that is not the stamped commit', () => {
    const checkout = checkoutWithoutGit('bbbbbbb', built('aaaaaaa'));
    expect(checkoutRefusal('gate', checkout)).toContain('not the commit the build stamped');
  });

  it('refuses a build that stamped no commit', () => {
    expect(checkoutRefusal('gate', checkoutWithoutGit('aaaaaaa', built(null)))).toContain(
      'names no commit',
    );
  });

  it('names the stamped commit, measures with it, and still refuses a gate', () => {
    const checkout = checkoutWithoutGit('aaaaaaa', built('aaaaaaa'));
    expect(checkout.sha).toBe('aaaaaaa');
    expect(checkoutRefusal('measure', checkout)).toBeNull();
    expect(reportedSha(checkout)).toBe('aaaaaaa');
    expect(checkoutRefusal('gate', checkout)).toContain('cannot be proven clean');
  });

  /* A measurement still runs, but never names an unproven commit unmarked
   * (final review on a98a294). */
  it("marks the SHA of a measurement whose commit is not the build's", () => {
    expect(reportedSha(checkoutWithoutGit('bbbbbbb', built('aaaaaaa')))).toBe(
      'bbbbbbb-unattributed',
    );
    expect(reportedSha(checkoutWithoutGit('aaaaaaa', built(null)))).toBe('aaaaaaa-unattributed');
  });

  it('stamps HEAD of a clean checkout, nothing for a dirty one, REKODA_COMMIT outside git', () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-stamp-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'],
      { cwd: repo },
    );
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(stampedCommit(repo, {})).toBe(head);
    writeFileSync(join(repo, 'dirty.txt'), 'x');
    expect(stampedCommit(repo, { REKODA_COMMIT: head })).toBeNull();
    const bare = mkdtempSync(join(tmpdir(), 'eval-nogit-'));
    expect(stampedCommit(bare, { REKODA_COMMIT: 'ccc' })).toBe('ccc');
  });
});

describe('what a paid run keeps (Codex on 8895bb1)', () => {
  it('refuses a report path it could not write before anything is paid for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-'));
    expect(reportPathRefusal(null)).toBeNull();
    expect(reportPathRefusal('')).toContain('names no file');
    expect(reportPathRefusal(dir)).toContain('directory');
    expect(reportPathRefusal(join(dir, 'missing', 'report.json'))).toContain('cannot be written');
    expect(reportPathRefusal(join(dir, 'report.json'))).toBeNull();
    writeReportAtomically(join(dir, 'report.json'), '{"ok":true}\n');
    expect(readFileSync(join(dir, 'report.json'), 'utf8')).toBe('{"ok":true}\n');
  });

  it('names the price table its costs come from, and no secret', () => {
    const prices = '{"gpt-5-mini":{"in":250000,"out":2000000}}';
    const dearer = '{"gpt-5-mini":{"in":300000,"out":2000000}}';
    const reordered = '{"gpt-5-mini":{"out":2000000,"in":250000}}';
    expect(pricesFingerprint(prices)).not.toBe(pricesFingerprint(dearer));
    expect(pricesFingerprint(prices)).toBe(pricesFingerprint(reordered));
    expect(pricesFingerprint('not json')).toBe('unparseable');
    const summary = describeAiConfiguration(configWith({ ...OPENAI, AI_MODEL_PRICES: prices }));
    expect(summary.pricesFingerprint).toBe(pricesFingerprint(prices));
  });
});

describe('cases across Lagos midnight (Codex on 8895bb1)', () => {
  const cases = EVAL_CASES.slice(0, 3);
  const passed = (c: (typeof cases)[number]) => ({
    caseId: c.id,
    category: c.category,
    outcome: 'command' as const,
    status: 'passed' as const,
    failedChecks: [],
    checks: [],
  });
  /* 22:59:59 UTC is 23:59:59 in Lagos. */
  const beforeMidnight = new Date('2031-01-01T22:59:59Z');
  const afterMidnight = new Date('2031-01-01T23:00:01Z');

  it('holds the new day before any case runs on it, and voids the case that straddled', async () => {
    let now = beforeMidnight;
    const heldDays = new Set(['2031-01-01']);
    const asked: number[] = [];
    const room = {
      holds: (at: Date) =>
        heldDays.has(new Date(at.getTime() + 3_600_000).toISOString().slice(0, 10)),
      holdDay: async (left: readonly unknown[], at: Date) => {
        asked.push(left.length);
        heldDays.add(new Date(at.getTime() + 3_600_000).toISOString().slice(0, 10));
        return null;
      },
    };
    const results = await runCasesInRoom(
      cases,
      room,
      async (c) => {
        const result = passed(c);
        if (c.id === cases[0]!.id) now = afterMidnight;
        return result;
      },
      () => now,
    );
    expect(results.map((r) => r.status)).toEqual(['invalid', 'passed', 'passed']);
    expect(results[0]!.failedChecks).toEqual(['crossed_day_boundary']);
    /* The new day was held for the two cases left, once. */
    expect(asked).toEqual([2]);
  });

  it('runs nothing on a day whose room it could not hold', async () => {
    const ran: string[] = [];
    const results = await runCasesInRoom(
      cases,
      { holds: () => false, holdDay: async () => 'no room' },
      async (c) => {
        ran.push(c.id);
        return passed(c);
      },
      () => afterMidnight,
    );
    expect(ran).toEqual([]);
    expect(results.every((r) => r.status === 'invalid' && r.outcome === 'quota_refused')).toBe(
      true,
    );
  });
});

describe('the prompt a report names (Codex on 243b1f4)', () => {
  it('changes when the document classifier contract changes', async () => {
    const { promptFingerprint } = await import('./report.js');
    const base = promptFingerprint();
    vi.resetModules();
    vi.doMock('../classifier.js', async (original) => ({
      ...(await original<typeof import('../classifier.js')>()),
      CLASSIFIER_SYSTEM: 'a different classifier prompt',
    }));
    try {
      const changed = await import('./report.js');
      expect(changed.promptFingerprint()).not.toBe(base);
    } finally {
      vi.doUnmock('../classifier.js');
      vi.resetModules();
    }
  });
});

describe('the independent second reading (Codex on 734e488)', () => {
  const prices = '{"gpt-5-mini":{"in":250000,"out":2000000},"gpt-verifier":{"in":1,"out":1}}';
  const verifier = { AI_MODEL_VISION_VERIFIER: 'gpt-verifier', AI_MODEL_PRICES: prices };

  it('is refused when the primary is OpenAI on its own endpoint', () => {
    expect(() => createVerifierTransport(configWith({ ...OPENAI, ...verifier }))).toThrow(
      'cannot be an independent OpenAI reader',
    );
  });

  it('is refused beside an OpenAI-compatible primary, whose key OpenAI would refuse (Codex on 4d3b3fe)', () => {
    const elsewhere = configWith({
      ...OPENAI,
      ...verifier,
      AI_BASE_URL: 'https://api.groq.example/openai/v1',
    });
    expect(() => createVerifierTransport(elsewhere)).toThrow('belongs to the primary');
  });

  it('runs beside an Anthropic primary', () => {
    const anthropic = configWith({
      ANTHROPIC_API_KEY: 'sk-ant-test-not-a-key',
      OPENAI_API_KEY: 'sk-test-not-a-key',
      ...verifier,
    });
    expect(createVerifierTransport(anthropic)).toBeInstanceOf(OpenAiTransport);
  });
});
