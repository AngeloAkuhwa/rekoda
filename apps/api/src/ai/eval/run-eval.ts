/**
 * The LIVE evaluation run: real models, real money, deliberately outside CI.
 *
 * From apps/api, after `pnpm eval:build` (repository root), with the SAME
 * AI configuration the deployment runs (AI_PROVIDER, AI_MODEL_*,
 * AI_MODEL_PRICES, the provider key) and a non-production DATABASE_URL,
 * with REKODA_EVAL_DATABASE set to that database's name (refused otherwise,
 * and always refused when NODE_ENV is production):
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
import { accessSync, constants, existsSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  createDb,
  identity,
  isEntrypoint,
  quotaRepo,
  sql,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { isProductionEnv, loadConfig, type ApiConfig } from '../../config.js';
import { Interpreter } from '../interpreter.service.js';
import type { ModelTransport } from '../transport.js';
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
import { invalidCase, runEvalCase, scoreEval, type EvalCaseResult } from './harness.js';
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
 * Why the report cannot be written where `--json` names, or null. Checked
 * before any room is held or any provider is paid, so a paid run never ends
 * without the report it was asked for (Codex on 8895bb1).
 */
export function reportPathRefusal(path: string | null): string | null {
  if (path === null) return null;
  if (path.trim() === '') return '--json names no file';
  const target = resolve(path);
  try {
    if (statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
      return `--json names a directory (${target})`;
    }
    accessSync(dirname(target), constants.W_OK);
    if (existsSync(target)) accessSync(target, constants.W_OK);
  } catch {
    return `the report cannot be written to ${target}`;
  }
  return null;
}

/** Whole or not at all: a reader never sees half a report. */
export function writeReportAtomically(path: string, body: string): void {
  const target = resolve(path);
  const partial = `${target}.partial-${process.pid}`;
  writeFileSync(partial, body);
  renameSync(partial, target);
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
 * room for every case. The GLOBAL ceiling is shared, so the run holds its
 * room on it up front (reserveGlobalRoom) rather than raising it (G-07).
 */
export function evalConfig(config: ApiConfig, cases: readonly EvalCase[] = EVAL_CASES): ApiConfig {
  return {
    ...config,
    aiCallsPerBusinessPerDay: Math.max(config.aiCallsPerBusinessPerDay, callsFor(cases)),
  };
}

/** The room a run holds on the platform-wide ceiling, day by day, until it gives it back. */
export interface GlobalRoom {
  /**
   * The interpreter's configuration. Its global ceiling is raised by what
   * the run holds on the CURRENT Lagos day, and by nothing on a day it holds
   * no room, so no call ever spends room that was not held for it.
   */
  readonly config: ApiConfig;
  /** Whether the run holds room on the day of `at`. */
  readonly holds: (at: Date) => boolean;
  /** Holds room for `cases` on the day of `at`; a refusal when it does not fit. */
  readonly holdDay: (cases: readonly EvalCase[], at: Date) => Promise<string | null>;
  /** Gives every held day's room back; safe to call more than once. */
  readonly release: () => Promise<void>;
}

/**
 * Holds every call the run could make on today's platform-wide ceiling, in
 * one atomic step, or refuses the run (Codex on #273). A snapshot is not
 * enough: two runs could each see the room and then spend each other's,
 * and a refused escalation or verifier call records nothing, so the case
 * would still score on the primary's answer. Holding `needed` on the
 * shared counter and raising only this interpreter's ceiling by the same
 * `needed` means nobody else can take the run's room, the run cannot take
 * anyone else's beyond what it holds, and a second run that does not fit
 * is refused before a single call. The raise follows the day the room was
 * held on (Codex on 8895bb1): after Lagos midnight the run must hold the
 * new day's room before it spends any (`runCasesInRoom`).
 */
export async function reserveGlobalRoom(
  db: Db,
  config: ApiConfig,
  cases: readonly EvalCase[] = EVAL_CASES,
  at: Date = new Date(),
  clock: () => Date = () => new Date(),
): Promise<GlobalRoom | string> {
  const limit = config.aiCallsGlobalPerDay;
  const held = new Map<string, number>();

  const holdDay = async (forCases: readonly EvalCase[], when: Date): Promise<string | null> => {
    const day = quotaRepo.lagosDay(when);
    if (held.has(day)) return null;
    const needed = callsFor(forCases);
    const refusal = (room: number) =>
      `the global AI ceiling leaves ${Math.max(0, room)} call(s) on ${day}; the run may need ${needed}`;
    if (needed > limit) return refusal(limit);
    const rows = await db.execute<{ calls: number }>(sql`
      INSERT INTO ai_global_counters (day, calls)
      VALUES (${day}::date, ${needed})
      ON CONFLICT (day) DO UPDATE
        SET calls = ai_global_counters.calls + ${needed}
        WHERE ai_global_counters.calls + ${needed} <= ${limit}
      RETURNING calls`);
    if ([...rows].length === 0) {
      const now = await db.execute<{ calls: number }>(sql`
        SELECT calls FROM ai_global_counters WHERE day = ${day}::date`);
      return refusal(limit - Number([...now][0]?.calls ?? 0));
    }
    held.set(day, needed);
    return null;
  };

  const first = await holdDay(cases, at);
  if (first) return first;

  const runConfig: ApiConfig = { ...config };
  Object.defineProperty(runConfig, 'aiCallsGlobalPerDay', {
    enumerable: true,
    get: () => limit + (held.get(quotaRepo.lagosDay(clock())) ?? 0),
  });
  return {
    config: runConfig,
    holds: (when) => held.has(quotaRepo.lagosDay(when)),
    holdDay,
    release: async () => {
      const days = [...held.entries()];
      held.clear();
      for (const [day, needed] of days) {
        await db.execute(sql`
          UPDATE ai_global_counters SET calls = greatest(0, calls - ${needed})
           WHERE day = ${day}::date`);
      }
    },
  };
}

/**
 * Runs the cases inside the room the run holds. Before each case the
 * current day must be held; after Lagos midnight the run holds the new
 * day's room for the cases left, and if that does not fit they did not
 * run. A case that started on one day and finished on the next is invalid:
 * a call it made after midnight may have been refused unheld, and a refused
 * escalation leaves no trace in the answer (Codex on 8895bb1).
 */
export async function runCasesInRoom(
  cases: readonly EvalCase[],
  room: Pick<GlobalRoom, 'holds' | 'holdDay'>,
  runCase: (evalCase: EvalCase) => Promise<EvalCaseResult>,
  clock: () => Date = () => new Date(),
  onResult: (result: EvalCaseResult) => void = () => {},
): Promise<EvalCaseResult[]> {
  const results: EvalCaseResult[] = [];
  for (const [index, evalCase] of cases.entries()) {
    const start = clock();
    let result: EvalCaseResult;
    const refused = room.holds(start) ? null : await room.holdDay(cases.slice(index), start);
    if (refused) {
      result = invalidCase(evalCase, 'quota_refused', 'day_room_refused');
    } else {
      result = await runCase(evalCase);
      if (quotaRepo.lagosDay(clock()) !== quotaRepo.lagosDay(start)) {
        result = invalidCase(evalCase, 'quota_refused', 'crossed_day_boundary');
      }
    }
    results.push(result);
    onResult(result);
  }
  return results;
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
      verifier: number;
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
             count(*) FILTER (WHERE meta->>'role' = 'vision_verifier')::int AS verifier,
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
    verifierCalls: n(row?.verifier),
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
 * built commit (REKODA_COMMIT) names the run, cleanliness is unknown, and
 * gate mode refuses it (checkoutRefusal).
 */
export function gitState(config: ApiConfig, root: string = REPO_ROOT): Checkout {
  const build = verifyBuild(REPO_ROOT);
  try {
    /* The tree the build fingerprint covers, wherever the runner was launched
     * from (Codex on #273). */
    const git = { encoding: 'utf8', cwd: root } as const;
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], git).trim();
    const status = execFileSync('git', ['status', '--porcelain'], git);
    return { sha, dirty: status.trim().length > 0, build };
  } catch {
    return checkoutWithoutGit(config.commit, build);
  }
}

/**
 * Outside git, the commit a run names must be the one the build stamped
 * into its manifest: REKODA_COMMIT alone proves nothing about the source
 * that was built (Codex on #273).
 */
export function checkoutWithoutGit(given: string, build: BuildVerdict): Checkout {
  const stamped = build.commit ?? null;
  if (!stamped) {
    return {
      sha: given,
      dirty: null,
      build,
      unattributed: 'the build names no commit in its manifest; rebuild with pnpm eval:build',
    };
  }
  if (given !== stamped) {
    return {
      sha: given,
      dirty: null,
      build,
      unattributed: `REKODA_COMMIT (${given}) is not the commit the build stamped (${stamped})`,
    };
  }
  return { sha: stamped, dirty: null, build };
}

/**
 * Why this database may not be used, or null. The run writes a synthetic
 * tenant and consumes the global AI ceiling, so it never runs in a
 * production environment and needs the operator to name the database it
 * is allowed to write to (Codex on #273).
 */
export function databaseRefusal(env: NodeJS.ProcessEnv, databaseUrl: string): string | null {
  if (isProductionEnv(env)) {
    return 'NODE_ENV is production; the evaluation writes to its database and never runs there';
  }
  let name: string;
  try {
    name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  } catch {
    return 'DATABASE_URL does not parse; nothing run';
  }
  if (!name || env.REKODA_EVAL_DATABASE !== name) {
    return 'set REKODA_EVAL_DATABASE to the name of the non-production database this run may write to';
  }
  return null;
}

export interface Checkout {
  readonly sha: string;
  readonly dirty: boolean | null;
  /** The compiled code checked against its build manifest. */
  readonly build: BuildVerdict;
  /** Outside git: why the named commit is not proven to be the build's. */
  readonly unattributed?: string;
}

/**
 * Why a run cannot be attributed to its commit, or null (Codex on #273). A
 * launch-gate run is refused from a dirty checkout or one git cannot vouch
 * for, from a build whose source or compiled files no longer match what the
 * build stamped, or with no commit to name; a measurement says so in its
 * SHA instead.
 */
export function checkoutRefusal(mode: EvalMode, checkout: Checkout): string | null {
  if (mode !== 'gate') return null;
  if (checkout.dirty === true) {
    return 'the checkout has uncommitted changes, so its commit is not what would run; commit or stash them';
  }
  if (!checkout.build.verified) {
    return `the compiled code is not proven to be this commit's: ${checkout.build.reason}`;
  }
  if (checkout.unattributed) {
    return `the commit is not proven to be the build's: ${checkout.unattributed}`;
  }
  if (!checkout.sha || checkout.sha === 'unknown') {
    return 'no commit identifies this build (no git, REKODA_COMMIT unset); a launch report must name one';
  }
  /* Outside git (or with git failing) nothing proves the tree clean, and the
   * commit the build stamped was only what REKODA_COMMIT asserted (final
   * review on a98a294). A measurement runs and says so; a gate does not. */
  if (checkout.dirty !== false) {
    return 'the checkout cannot be proven clean (git is absent or failed); run the launch gate from a git checkout';
  }
  return null;
}

/** The SHA a report names: marked when the checkout or the build is not that commit's. */
export function reportedSha(checkout: Checkout): string {
  return (
    checkout.sha +
    (checkout.dirty ? '-dirty' : '') +
    (checkout.build.verified ? '' : '-unverified-build') +
    (checkout.unattributed ? '-unattributed' : '')
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

  const unwritable = reportPathRefusal(args.json);
  if (unwritable) {
    console.error(`nothing run: ${unwritable}`);
    return 1;
  }

  const transport = createModelTransport(config);
  if (transport instanceof NoTransportConfigured) {
    console.error(`no API key for the configured provider (${config.aiProvider}); nothing run`);
    return 1;
  }
  const unsafeDb = databaseRefusal(process.env, config.databaseUrl);
  if (unsafeDb) {
    console.error(`nothing run: ${unsafeDb}`);
    return 1;
  }
  const { db, close } = createDb(config.databaseUrl, { max: 4 });
  try {
    const room = await reserveGlobalRoom(db, evalConfig(config));
    if (typeof room === 'string') {
      console.error(`nothing run: ${room}`);
      return 1;
    }
    try {
      return await runReserved(db, room, transport, args, plan, checkout);
    } finally {
      await room.release();
    }
  } finally {
    await close();
  }
}

/** The run itself, inside the global room it holds. */
async function runReserved(
  db: Db,
  room: GlobalRoom,
  transport: ModelTransport,
  args: ReturnType<typeof parseEvalArgs>,
  plan: ReturnType<typeof planEvalRun>,
  checkout: Checkout,
): Promise<number> {
  const interpreter = new Interpreter(
    db,
    room.config,
    transport,
    createVerifierTransport(room.config),
  );

  /* A throwaway tenant so eval usage rows never mix with a merchant's. */
  const user = await identity.upsertUserByPhone(db, '+2340000000001');
  const business = await identity.createBusinessWithOwner(db, {
    name: `eval-run-v${EVAL_DATASET_VERSION}-${Date.now()}`,
    businessType: null,
    ownerUserId: user.id,
  });

  const results = await runCasesInRoom(
    EVAL_CASES,
    room,
    (evalCase) => runEvalCase(interpreter, business.id, evalCase),
    () => new Date(),
    (result) =>
      console.log(`${result.status.padEnd(7)} ${result.caseId.padEnd(26)} ${result.outcome}`),
  );

  const report: EvalReport = buildEvalReport({
    mode: args.mode,
    timestamp: new Date().toISOString(),
    gitSha: reportedSha(checkout),
    buildFingerprint: checkout.build.output,
    dataset: plan.dataset,
    configuration: plan.configuration,
    metrics: scoreEval(EVAL_CASES, results, {
      dualExtractThresholdK: plan.configuration.dualExtractThresholdK,
    }),
    results,
    usage: await usageOf(db, business.id),
  });
  console.log(`\n${renderEvalReport(report)}`);
  if (args.json) writeReportAtomically(args.json, `${JSON.stringify(report, null, 2)}\n`);
  return exitCodeFor(report);
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
