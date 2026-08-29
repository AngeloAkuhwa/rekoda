/**
 * The LIVE evaluation run: real models, real money, deliberately outside CI.
 *
 *   ANTHROPIC_API_KEY=... DATABASE_URL=... npx tsx src/ai/eval/run-eval.ts
 *
 * Runs the versioned dataset through the real Interpreter — the same
 * escalation, the same ceilings, the same cost recording as production —
 * against a throwaway eval business, then prints the metric block
 * docs/ai-launch-readiness.md defines gates over. Each case costs
 * provider money; the dataset is small on purpose.
 *
 * Never wire this into CI. A launch gate measured on every push burns a
 * provider budget to reconfirm yesterday's number; the gate is measured
 * before launch and after any model or prompt change, by a person, who
 * then records the result in the launch-readiness report.
 */
import { createDb, identity, quotaRepo, withBusiness } from '@rekoda/db';
import { loadConfig } from '../../config.js';
import { AnthropicTransport } from '../anthropic.transport.js';
import { Interpreter } from '../interpreter.service.js';
import { registerRuntimeModelPrices } from '../model-prices.js';
import { EVAL_CASES, EVAL_DATASET_VERSION } from './dataset.js';
import { runEvalCase, scoreEval, type EvalCaseResult } from './harness.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is required for a live eval');
  registerRuntimeModelPrices(config.aiModelPrices ?? undefined);

  const { db, close } = createDb(process.env['DATABASE_URL']!, { max: 4 });
  const transport = new AnthropicTransport(config.anthropicApiKey);
  const interpreter = new Interpreter(db, config, transport);

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
    const mark = result.correct ? 'ok  ' : 'FAIL';
    console.log(`${mark} ${result.caseId.padEnd(12)} ${result.outcome}`);
  }

  const metrics = scoreEval(EVAL_CASES, results);
  const spend = await withBusiness(db, business.id, (tx) => quotaRepo.usageTotals(tx));

  console.log('\n== eval metrics (dataset v%d) ==', EVAL_DATASET_VERSION);
  console.log(JSON.stringify(metrics, null, 2));
  console.log('\n== provider spend ==');
  console.log(
    `calls: ${spend.calls}  usd micros: ${spend.providerCostMicros}  kobo: ${spend.nairaEquivalentK}`,
  );
  const drafts = results.filter((r) => r.outcome === 'command' && r.correct).length;
  if (drafts > 0) {
    console.log(
      `cost per correct accepted draft: ${Math.round(spend.providerCostMicros / drafts)} usd micros`,
    );
  }

  await close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
