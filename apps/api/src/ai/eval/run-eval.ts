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
import { pathToFileURL } from 'node:url';
import { createDb, identity, sql, withBusiness, type Db } from '@rekoda/db';
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
} from './dataset.js';
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

/** The most provider calls one case can make: interpreter, escalation, verifier. */
const CALLS_PER_CASE = 3;

/**
 * The configuration an evaluation runs: production's, with one change. The
 * per-business daily ceiling is a merchant's allowance, not model
 * behaviour, and at its default (60) it refuses the dataset part way
 * through, leaving cases that did not run. The throwaway eval tenant gets
 * room for every case; the GLOBAL ceiling stays as configured, and a case
 * it refuses is invalid, so the run cannot pass (G-07).
 */
export function evalConfig(config: ApiConfig, cases: number = EVAL_CASES.length): ApiConfig {
  return {
    ...config,
    aiCallsPerBusinessPerDay: Math.max(config.aiCallsPerBusinessPerDay, cases * CALLS_PER_CASE),
  };
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
async function usageOf(db: Db, businessId: string): Promise<UsageSummary> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{
      calls: number;
      interpreter: number;
      escalation: number;
      failed: number;
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
             count(*) FILTER (WHERE usage_type = 'llm_failed')::int AS failed,
             count(*) FILTER (WHERE usage_type = 'llm_call' AND meta->>'priced' = 'false')::int
               AS unpriced,
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
    failedCalls: n(row?.failed),
    unpricedCalls: n(row?.unpriced),
    inputTokens: n(row?.input),
    outputTokens: n(row?.output),
    cacheReadTokens: n(row?.cache_read),
    cacheWriteTokens: n(row?.cache_write),
    providerCostMicros: n(row?.micros),
  };
}

/** The checkout's commit, or the one an image was built from (REKODA_COMMIT). */
function gitSha(config: ApiConfig): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return config.commit;
  }
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

  const transport = createModelTransport(config);
  if (transport instanceof NoTransportConfigured) {
    console.error(`no API key for the configured provider (${config.aiProvider}); nothing run`);
    return 1;
  }
  const { db, close } = createDb(config.databaseUrl, { max: 4 });
  try {
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
      gitSha: gitSha(config),
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
