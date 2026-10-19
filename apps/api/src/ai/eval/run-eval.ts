/**
 * The LIVE evaluation run: real models, real money, deliberately outside CI.
 *
 * From apps/api, after `pnpm --filter @rekoda/api build`, with the SAME
 * AI configuration the deployment runs (AI_PROVIDER, AI_MODEL_*,
 * AI_MODEL_PRICES, the provider key) and a non-production DATABASE_URL:
 *
 *   node dist/ai/eval/run-eval.js --plan            what would run; no calls
 *   node dist/ai/eval/run-eval.js                   measurement only
 *   node dist/ai/eval/run-eval.js --mode=gate       the signed launch gate
 *   node dist/ai/eval/run-eval.js --json=report.json
 *
 * Runs the versioned dataset through the real Interpreter — the provider
 * the configuration names (transport-factory.ts, as the API builds it), the
 * same escalation, ceilings and cost recording as production — against a
 * throwaway eval business, then prints the report docs/ai-launch-readiness.md
 * defines. Each case costs provider money.
 *
 * Exit status is the verdict, not a print: non-zero for an invalid dataset,
 * and in gate mode for anything short of PASS against an owner-approved
 * profile (missing, unmeasured, failed or incomplete).
 *
 * Never wire this into CI. A launch gate measured on every push burns a
 * provider budget to reconfirm yesterday's number.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  createDb,
  identity,
  isEntrypoint,
  quotaRepo,
  sql,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { loadConfig, type ApiConfig } from '../../config.js';
import { Interpreter } from '../interpreter.service.js';
import {
  NoTransportConfigured,
  createModelTransport,
  createVerifierTransport,
  describeAiConfiguration,
} from '../transport-factory.js';
import {
  EVAL_CASES,
  EVAL_DATASET_VERSION,
  datasetFingerprint,
  validateDataset,
  type EvalCase,
} from './dataset.js';
import { REPO_ROOT, verifyBuild, type BuildVerdict } from './build-stamp.js';
import { runEvalCase, scoreEval, type EvalCaseResult } from './harness.js';
import {
  buildEvalReport,
  exitCodeFor,
  profileFor,
  renderEvalReport,
  type EvalMode,
  type EvalReport,
  type UsageSummary,
} from './report.js';

export interface EvalArgs {
  readonly mode: EvalMode;
  readonly plan: boolean;
  readonly json: string | null;
}

export function parseEvalArgs(argv: readonly string[]): EvalArgs {
  let mode: EvalMode = 'measure';
  let plan = false;
  let json: string | null = null;
  for (const arg of argv) {
    if (arg === '--plan') plan = true;
    else if (arg === '--mode=gate') mode = 'gate';
    else if (arg === '--mode=measure') mode = 'measure';
    else if (arg.startsWith('--json=')) json = arg.slice('--json='.length);
    else throw new Error(`unknown argument ${arg}`);
  }
  return { mode, plan, json };
}

/**
 * The most provider calls one case can make: a page is classified, then
 * interpreted, escalated and verified; typed text is interpreted and
 * escalated (final review on #273).
 */
function callsFor(cases: readonly EvalCase[]): number {
  return cases.reduce((sum, c) => sum + (c.source === 'document_text' ? 4 : 2), 0);
}

/**
 * The configuration an evaluation runs: production's, with one change. The
 * per-business daily ceiling is a merchant's allowance, not model
 * behaviour, and at its default (60) it refuses the dataset part way
 * through, leaving cases that did not run. The throwaway eval tenant gets
 * room for every case; the GLOBAL ceiling stays as configured, and a case
 * it refuses is invalid, so the run cannot pass (G-07).
 */
export function evalConfig(config: ApiConfig, cases: readonly EvalCase[] = EVAL_CASES): ApiConfig {
  return {
    ...config,
    aiCallsPerBusinessPerDay: Math.max(config.aiCallsPerBusinessPerDay, callsFor(cases)),
  };
}

/**
 * Whether today's platform-wide ceiling leaves room for every call the run
 * could make. A call it refuses records nothing: a refused escalation falls
 * back to the primary's answer and the case still scores, so a run without
 * the room is refused up front rather than measured short (Codex on #273).
 */
export async function ceilingShortfall(
  db: Db,
  config: ApiConfig,
  cases: readonly EvalCase[] = EVAL_CASES,
): Promise<string | null> {
  const rows = await db.execute<{ calls: number }>(sql`
    SELECT coalesce(sum(calls), 0)::int AS calls FROM ai_global_counters
     WHERE day = ${quotaRepo.lagosDay(new Date())}::date`);
  const used = Number([...rows][0]?.calls ?? 0);
  const needed = callsFor(cases);
  const room = config.aiCallsGlobalPerDay - used;
  return room >= needed
    ? null
    : `the global AI ceiling leaves ${Math.max(0, room)} call(s) today; the run may need ${needed}`;
}

/** What a run would measure, before a single provider call. */
export function planEvalRun(config: ApiConfig, mode: EvalMode) {
  return {
    dataset: {
      version: EVAL_DATASET_VERSION,
      size: EVAL_CASES.length,
      fingerprint: datasetFingerprint(),
      errors: validateDataset(EVAL_CASES),
    },
    configuration: describeAiConfiguration(config),
    profile: profileFor(mode),
  };
}

/** The run's provider calls and tokens, from the usage rows it wrote. */
export async function usageOf(db: Db, businessId: string): Promise<UsageSummary> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{
      calls: number;
      interpreter: number;
      escalation: number;
      classifier: number;
      failed: number;
      unusable_secondary: number;
      unpriced: number;
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      micros: number;
    }>(sql`
      SELECT count(*)::int AS calls,
             count(*) FILTER (WHERE meta->>'role' = 'interpreter')::int AS interpreter,
             count(*) FILTER (WHERE meta->>'role' = 'escalation')::int AS escalation,
             count(*) FILTER (WHERE meta->>'role' = 'classifier')::int AS classifier,
             count(*) FILTER (WHERE usage_type = 'llm_failed')::int AS failed,
             count(*) FILTER (WHERE meta->>'role' IN ('escalation', 'vision_verifier')
                                AND meta->>'schemaValid' = 'false')::int AS unusable_secondary,
             -- Every row with no price, failed attempts included: the
             -- provider may have billed them, so the cost is understated.
             count(*) FILTER (WHERE meta->>'priced' = 'false')::int AS unpriced,
             coalesce(sum((meta->>'inputTokens')::bigint), 0)::bigint AS input,
             coalesce(sum((meta->>'outputTokens')::bigint), 0)::bigint AS output,
             coalesce(sum((meta->>'cacheReadTokens')::bigint), 0)::bigint AS cache_read,
             coalesce(sum((meta->>'cacheWriteTokens')::bigint), 0)::bigint AS cache_write,
             coalesce(sum(provider_cost_micros), 0)::bigint AS micros
        FROM usage_events
       WHERE business_id = ${businessId}::uuid AND usage_type IN ('llm_call', 'llm_failed')`),
  );
  const row = [...rows][0];
  const n = (value: unknown) => Number(value ?? 0);
  return {
    providerCalls: n(row?.calls),
    interpreterCalls: n(row?.interpreter),
    escalationCalls: n(row?.escalation),
    classifierCalls: n(row?.classifier),
    failedCalls: n(row?.failed),
    unusableSecondaryCalls: n(row?.unusable_secondary),
    unpricedCalls: n(row?.unpriced),
    inputTokens: n(row?.input),
    outputTokens: n(row?.output),
    cacheReadTokens: n(row?.cache_read),
    cacheWriteTokens: n(row?.cache_write),
    providerCostMicros: n(row?.micros),
  };
}

/**
 * The commit that ran, whether the checkout matched it, and whether the
 * compiled code is the code that commit builds to (verified against the
 * manifest the build stamped; build-stamp.ts). Outside git (an image) the
 * built commit (REKODA_COMMIT) names the run, and cleanliness is unknown.
 */
function gitState(config: ApiConfig): Checkout {
  const build = verifyBuild(REPO_ROOT);
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
    return { sha, dirty: status.trim().length > 0, build };
  } catch {
    return { sha: config.commit, dirty: null, build };
  }
}

export interface Checkout {
  readonly sha: string;
  readonly dirty: boolean | null;
  /** The compiled code checked against its build manifest. */
  readonly build: BuildVerdict;
}

/**
 * Why a run cannot be attributed to its commit, or null (Codex on #273). A
 * launch-gate run is refused from a dirty checkout, from a build whose
 * source or compiled files no longer match what the build stamped, or with
 * no commit to name; a measurement says so in its SHA instead.
 */
export function checkoutRefusal(mode: EvalMode, checkout: Checkout): string | null {
  if (mode !== 'gate') return null;
  if (checkout.dirty === true) {
    return 'the checkout has uncommitted changes, so its commit is not what would run; commit or stash them';
  }
  if (!checkout.build.verified) {
    return `the compiled code is not proven to be this commit's: ${checkout.build.reason}`;
  }
  if (!checkout.sha || checkout.sha === 'unknown') {
    return 'no commit identifies this build (no git, REKODA_COMMIT unset); a launch report must name one';
  }
  return null;
}

/** The SHA a report names: marked when the checkout or the build is not that commit's. */
export function reportedSha(checkout: Checkout): string {
  return (
    checkout.sha +
    (checkout.dirty ? '-dirty' : '') +
    (checkout.build.verified ? '' : '-unverified-build')
  );
}

async function main(): Promise<number> {
  const args = parseEvalArgs(process.argv.slice(2));
  const config = loadConfig();
  const plan = planEvalRun(config, args.mode);

  if (args.plan) {
    console.log(JSON.stringify(plan, null, 2));
    return plan.dataset.errors.length > 0 || (args.mode === 'gate' && !plan.profile.profile)
      ? 1
      : 0;
  }
  if (plan.dataset.errors.length > 0) {
    console.error(`dataset invalid, nothing run:\n${plan.dataset.errors.join('\n')}`);
    return 1;
  }
  if (args.mode === 'gate' && !plan.profile.profile) {
    console.error(`launch gate refused, nothing run: ${plan.profile.reason}`);
    return 1;
  }

  const checkout = gitState(config);
  const refused = checkoutRefusal(args.mode, checkout);
  if (refused) {
    console.error(`launch gate refused, nothing run: ${refused}`);
    return 1;
  }

  const transport = createModelTransport(config);
  if (transport instanceof NoTransportConfigured) {
    console.error(`no API key for the configured provider (${config.aiProvider}); nothing run`);
    return 1;
  }
  const { db, close } = createDb(config.databaseUrl, { max: 4 });
  try {
    const shortfall = await ceilingShortfall(db, config);
    if (shortfall) {
      console.error(`nothing run: ${shortfall}`);
      return 1;
    }
    const interpreter = new Interpreter(
      db,
      evalConfig(config),
      transport,
      createVerifierTransport(config),
    );

    /* A throwaway tenant so eval usage rows never mix with a merchant's. */
    const user = await identity.upsertUserByPhone(db, '+2340000000001');
    const business = await identity.createBusinessWithOwner(db, {
      name: `eval-run-v${EVAL_DATASET_VERSION}-${Date.now()}`,
      businessType: null,
      ownerUserId: user.id,
    });

    const results: EvalCaseResult[] = [];
    for (const evalCase of EVAL_CASES) {
      const result = await runEvalCase(interpreter, business.id, evalCase);
      results.push(result);
      console.log(`${result.status.padEnd(7)} ${result.caseId.padEnd(26)} ${result.outcome}`);
    }

    const report: EvalReport = buildEvalReport({
      mode: args.mode,
      timestamp: new Date().toISOString(),
      gitSha: reportedSha(checkout),
      buildFingerprint: checkout.build.output,
      dataset: plan.dataset,
      configuration: plan.configuration,
      metrics: scoreEval(EVAL_CASES, results),
      results,
      usage: await usageOf(db, business.id),
    });
    console.log(`\n${renderEvalReport(report)}`);
    if (args.json) writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
    return exitCodeFor(report);
  } finally {
    await close();
  }
}

/* Run only as the entry point: tests import the pieces above. */
/* The shared check: Node names the main module by its real path, and a
 * plain comparison with argv[1] misses a run through a symlink, exiting 0
 * with nothing run (final review on #273). */
if (isEntrypoint(import.meta.url, process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : 'eval run failed');
      process.exitCode = 1;
    },
  );
}
