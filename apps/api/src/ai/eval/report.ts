/**
 * The live evaluation's report, built and judged without IO (G-07).
 *
 * It answers one question and must never answer it falsely: what exact
 * model and configuration was tested, against what dataset, what did it
 * score, what evidence was missing, what did it cost, and did it satisfy
 * the owner-approved launch gates. A measurement-only run says so on its
 * face and is never a launch PASS.
 */
import { createHash } from 'node:crypto';
import { businessCommandToolSchema } from '@rekoda/contracts';
import {
  CLASSIFIER_SYSTEM,
  CLASSIFIER_TOOL_DESCRIPTION,
  CLASSIFIER_TOOL_NAME,
  CLASSIFIER_TOOL_SCHEMA,
} from '../classifier.js';
import { SYSTEM_PROMPT, TOOL_DESCRIPTION, TOOL_NAME } from '../prompt.js';
import type { AiConfigurationSummary } from '../transport-factory.js';
import {
  OWNER_APPROVED_PROFILE,
  RECOMMENDED_PROFILE,
  evaluateLaunchGate,
  type LaunchVerdict,
  type ThresholdProfile,
} from './gate.js';
import { metricOf, type EvalCaseResult, type EvalMetrics, type Metric } from './harness.js';

/**
 * `gate` judges against the owner-approved profile and exits non-zero on
 * anything short of PASS. `measure` judges against the recommended
 * profile for information only.
 */
export type EvalMode = 'measure' | 'gate';

export const MEASUREMENT_ONLY = 'MEASUREMENT ONLY — NOT A LAUNCH PASS';

/** What the provider was asked for and billed, summed from the run's usage rows. */
export interface UsageSummary {
  /** Every recorded provider call, failed attempts included. */
  readonly providerCalls: number;
  readonly interpreterCalls: number;
  readonly escalationCalls: number;
  /** Attempts that produced nothing usable (recorded unpriced). */
  readonly failedCalls: number;
  /** Escalation or verifier answers that failed the schema. */
  readonly unusableSecondaryCalls: number;
  /** Second-reader calls on high-value documents. */
  readonly verifierCalls: number;
  /** Classifier calls: every document case is classified first, as in production. */
  readonly classifierCalls: number;
  /** Calls recorded with no price for their model: cost is understated. */
  readonly unpricedCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly providerCostMicros: number;
}

export interface EvalReport {
  readonly mode: EvalMode;
  readonly label: string;
  readonly timestamp: string;
  readonly gitSha: string;
  /**
   * The hash of every compiled file that could run, as verified against the
   * build's manifest: the identity of the code measured (build-stamp.ts).
   */
  readonly buildFingerprint: string;
  readonly dataset: {
    readonly version: number;
    readonly size: number;
    readonly fingerprint: string;
    readonly errors: readonly string[];
  };
  readonly configuration: AiConfigurationSummary;
  /** The system prompt, tool name, description and schema, hashed. */
  readonly promptFingerprint: string;
  readonly metrics: EvalMetrics;
  readonly escalationRate: Metric;
  readonly usage: UsageSummary;
  /** Every case, by name: what failed and which checks held. Never a value. */
  readonly results: readonly EvalCaseResult[];
  /** Over correct accepted DRAFTS (never Query answers); null when there are none. */
  readonly costPerCorrectAcceptedDraftMicros: number | null;
  readonly verdict: LaunchVerdict | null;
  /**
   * The launch answer. PASS only in gate mode, against an owner-approved
   * profile, with every required gate measured and met.
   */
  readonly launch: 'PASS' | 'FAIL' | 'NOT_MEASURED' | 'NOT_A_LAUNCH_RUN';
  readonly launchReasons: readonly string[];
}

/** The interpreter's contract and the document classifier's, which decides which pages are read at all. */
export function promptFingerprint(): string {
  const body = JSON.stringify({
    system: SYSTEM_PROMPT,
    tool: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    schema: businessCommandToolSchema(),
    /* A classifier change accepts or rejects pages differently (Codex on 243b1f4). */
    classifier: {
      system: CLASSIFIER_SYSTEM,
      tool: CLASSIFIER_TOOL_NAME,
      description: CLASSIFIER_TOOL_DESCRIPTION,
      schema: CLASSIFIER_TOOL_SCHEMA,
    },
  });
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

/** The profile a mode judges against, or why there is none. */
export function profileFor(
  mode: EvalMode,
  ownerApproved: ThresholdProfile | null = OWNER_APPROVED_PROFILE,
): { profile: ThresholdProfile | null; reason: string | null } {
  if (mode === 'measure') return { profile: RECOMMENDED_PROFILE, reason: null };
  if (!ownerApproved || ownerApproved.approval !== 'OWNER_APPROVED') {
    return {
      profile: null,
      reason:
        'no owner-approved threshold profile exists (docs/REKODA_OWNER_DECISIONS.md); ' +
        'a launch-gate run cannot pass without one',
    };
  }
  return { profile: ownerApproved, reason: null };
}

export function buildEvalReport(input: {
  mode: EvalMode;
  timestamp: string;
  gitSha: string;
  buildFingerprint?: string;
  dataset: EvalReport['dataset'];
  configuration: AiConfigurationSummary;
  metrics: EvalMetrics;
  results: readonly EvalCaseResult[];
  usage: UsageSummary;
  ownerApproved?: ThresholdProfile | null;
}): EvalReport {
  const { mode, metrics, usage } = input;
  const chosen = profileFor(mode, input.ownerApproved ?? OWNER_APPROVED_PROFILE);
  const evidence = {
    invalidCases: metrics.invalid,
    datasetErrors: input.dataset.errors,
    failedCalls: usage.failedCalls,
    unusableSecondaryCalls: usage.unusableSecondaryCalls,
    verifierUnexercised:
      input.configuration.models.visionVerifier !== null && usage.verifierCalls === 0,
  };
  const verdict = chosen.profile ? evaluateLaunchGate(metrics, chosen.profile, evidence) : null;

  let launch: EvalReport['launch'];
  let launchReasons: string[];
  if (mode === 'measure') {
    launch = 'NOT_A_LAUNCH_RUN';
    launchReasons = [MEASUREMENT_ONLY];
  } else if (!verdict) {
    launch = 'NOT_MEASURED';
    launchReasons = [chosen.reason ?? 'no threshold profile'];
  } else {
    launch = verdict.overall;
    launchReasons = [...verdict.reasons];
  }

  /* Drafts only: a Query answers and drafts nothing (Codex on #273). */
  /* A refusal case that resisted is not a checked draft (final review on #273). */
  const correct = input.results.filter(
    (r) =>
      r.outcome === 'command' &&
      r.status === 'passed' &&
      r.intent !== 'Query' &&
      (r.expected === undefined || r.expected === 'command'),
  ).length;

  return {
    mode,
    label: mode === 'measure' ? MEASUREMENT_ONLY : 'LAUNCH GATE',
    timestamp: input.timestamp,
    gitSha: input.gitSha,
    buildFingerprint: input.buildFingerprint ?? 'unknown',
    dataset: input.dataset,
    configuration: input.configuration,
    promptFingerprint: promptFingerprint(),
    metrics,
    escalationRate: metricOf(usage.escalationCalls, usage.interpreterCalls),
    usage,
    results: input.results,
    costPerCorrectAcceptedDraftMicros:
      correct > 0 ? Math.round(usage.providerCostMicros / correct) : null,
    verdict,
    launch,
    launchReasons,
  };
}

/**
 * Zero only for a gate run that PASSED against an owner-approved profile,
 * or a measurement run over a valid dataset in which every case ran and no
 * provider call failed. Everything else is non-zero,
 * so no script can mistake a printed number for a launch pass.
 */
export function exitCodeFor(report: EvalReport): number {
  if (report.dataset.errors.length > 0) return 1;
  /* A measurement whose cases did not run, or whose calls failed, measured
   * nothing it can stand behind: no script may read it as a good run
   * (final review on #273). */
  if (report.mode === 'measure') {
    return report.metrics.invalid > 0 || report.usage.failedCalls > 0 ? 1 : 0;
  }
  return report.launch === 'PASS' && report.verdict?.profile.approval === 'OWNER_APPROVED' ? 0 : 1;
}

const rate = (metric: Metric): string =>
  metric.status === 'NOT_MEASURED' || metric.value === null
    ? 'NOT_MEASURED (0 observations)'
    : `${metric.value.toFixed(3)} (${metric.passed}/${metric.observations})`;

/** The report for a person: every number with the evidence under it. */
export function renderEvalReport(report: EvalReport): string {
  const m = report.metrics;
  const c = report.configuration;
  const lines = [
    `== Rekoda AI evaluation: ${report.label} ==`,
    `timestamp          ${report.timestamp}`,
    `git sha            ${report.gitSha}`,
    `build              ${report.buildFingerprint}`,
    `dataset            v${report.dataset.version}, ${report.dataset.size} cases, ${report.dataset.fingerprint}`,
    ...report.dataset.errors.map((e) => `DATASET ERROR      ${e}`),
    `provider           ${c.provider}${c.baseUrlHost ? ` via ${c.baseUrlHost}` : ''}` +
      (c.baseUrlFingerprint ? ` (${c.baseUrlFingerprint})` : ''),
    `models             interpreter=${c.models.interpreter} classifier=${c.models.classifier} ` +
      `escalation=${c.models.escalation} vision=${c.models.vision} ` +
      `verifier=${c.models.visionVerifier ?? 'off'} transcriber=${c.models.transcriber ?? 'off'}`,
    `prompt             ${report.promptFingerprint}`,
    '',
    `cases              ${m.datasetSize} (ran ${m.valid}, did not run ${m.invalid})`,
    `outcomes           ${Object.entries(m.outcomes)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
    '',
    'category                     total passed failed invalid',
    ...Object.entries(m.byCategory).map(
      ([name, t]) =>
        `${name.padEnd(28)} ${String(t.total).padStart(5)} ${String(t.passed).padStart(6)} ` +
        `${String(t.failed).padStart(6)} ${String(t.invalid).padStart(7)}`,
    ),
    '',
    `accepted-answer accuracy   ${rate(m.acceptedAnswerAccuracy)}`,
    `intent exact match         ${rate(m.intentExactMatch)}`,
    `amount exact match         ${rate(m.amountExactMatch)}`,
    `quantity exact match       ${rate(m.quantityExactMatch)}`,
    `customer-token match       ${rate(m.customerTokenMatch)}`,
    `weakest pinned field       ${rate(m.weakestFieldMatch)}${m.weakestField ? ` (${m.weakestField})` : ''}`,
    `weakest register           ${rate(m.weakestRegisterAccuracy)}${m.weakestRegister ? ` (${m.weakestRegister})` : ''}`,
    `ambiguity safety           ${rate(m.abstainedOnAmbiguous)}`,
    `injection resistance       ${rate(m.injectionResisted)}`,
    `junk rejected              ${rate(m.junkRejected)}`,
    `clarification rate         ${rate(m.clarificationRate)} (informational)`,
    `escalation rate            ${rate(report.escalationRate)} (informational)`,
    '',
    `provider calls     ${report.usage.providerCalls} (interpreter ${report.usage.interpreterCalls}, ` +
      `escalation ${report.usage.escalationCalls}, classifier ${report.usage.classifierCalls}, ` +
      `failed ${report.usage.failedCalls}, unusable secondary ${report.usage.unusableSecondaryCalls}, ` +
      `unpriced ${report.usage.unpricedCalls})`,
    `tokens             input ${report.usage.inputTokens}, output ${report.usage.outputTokens}, ` +
      `cache read ${report.usage.cacheReadTokens}, cache write ${report.usage.cacheWriteTokens}`,
    `provider cost      ${report.usage.providerCostMicros} USD micros` +
      (report.usage.unpricedCalls > 0 ? ' (UNDERSTATED: unpriced calls)' : ''),
    `per correct draft  ${
      report.costPerCorrectAcceptedDraftMicros === null
        ? 'n/a (no correct accepted draft)'
        : `${report.costPerCorrectAcceptedDraftMicros} USD micros`
    }`,
    '',
  ];
  if (report.verdict) {
    lines.push(
      `profile            ${report.verdict.profile.id} (${report.verdict.profile.approval})`,
    );
    for (const gate of report.verdict.gates) {
      lines.push(
        `  ${gate.result.padEnd(12)} ${gate.metric.padEnd(24)} ` +
          `${gate.required ? 'required' : 'informational'}, threshold ${gate.threshold}: ${gate.reason}`,
      );
    }
  }
  if (report.mode === 'measure') {
    lines.push(`recommended profile: ${report.verdict?.overall ?? 'n/a'} — ${MEASUREMENT_ONLY}`);
  } else {
    lines.push(`LAUNCH GATE: ${report.launch}`);
  }
  for (const reason of report.launchReasons) lines.push(`  - ${reason}`);
  const notPassed = report.results.filter((r) => r.status !== 'passed');
  if (notPassed.length > 0) {
    lines.push('', 'cases that did not pass (names only, never values):');
    for (const r of notPassed) {
      lines.push(
        `  ${r.status.padEnd(8)} ${r.caseId} [${r.outcome}] ${r.failedChecks.join(', ') || '-'}`,
      );
    }
  }
  return lines.join('\n');
}
