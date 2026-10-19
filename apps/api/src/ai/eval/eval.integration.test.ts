/**
 * The harness end to end: the WHOLE versioned dataset through a real
 * Interpreter — real PostgreSQL, real quota counters, real schema border,
 * real escalation wiring — with the model scripted as an oracle.
 *
 * What this proves is the plumbing the launch gates stand on, not model
 * quality (that is run-eval.ts, with a key and a person): every case
 * survives the real privacy check, parses against the real contract, and
 * scores the way the metric definitions say — including that a perfect
 * oracle scores perfectly, which is the property that makes a live score
 * of 0.9 mean the MODEL and not the harness.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, identity, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { loadConfig, type ApiConfig } from '../../config.js';
import { CLASSIFIER_TOOL_NAME } from '../classifier.js';
import { Interpreter } from '../interpreter.service.js';
import {
  ProviderUnreachable,
  type ModelReply,
  type ModelRequest,
  type ModelTransport,
} from '../transport.js';
import { EVAL_CASES } from './dataset.js';
import { RECOMMENDED_PROFILE, evaluateLaunchGate } from './gate.js';
import { ceilingShortfall, evalConfig, usageOf } from './run-eval.js';
import { runEvalCase, scoreEval, type EvalCaseResult } from './harness.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;
let config: ApiConfig;
let businessId: string;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  config = evalConfig(loadConfig());

  await truncateAll(urls);
  const user = await identity.upsertUserByPhone(db, '+2348080000009');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Eval Harness Shop',
    businessType: null,
    ownerUserId: user.id,
  });
  businessId = business.id;
});

afterAll(async () => {
  await close?.();
});

/**
 * An oracle: answers each case with exactly what its expectation pins,
 * padded to a fully valid command. Ambiguity and injection cases get the
 * honest Unclear. If the harness is straight, this scores 1.0 everywhere.
 */
class OracleTransport implements ModelTransport {
  send(request: ModelRequest): Promise<ModelReply> {
    const evalCase = EVAL_CASES.find((c) => c.input === request.userText);
    if (!evalCase) throw new Error('oracle asked about a case not in the dataset');

    const reply = (command: unknown): Promise<ModelReply> =>
      Promise.resolve({
        toolInput: { command },
        usage: { inputTokens: 1_500, outputTokens: 100 },
        stopReason: 'tool_use',
      });

    /* Every page is classified first, as production does: a real document. */
    if (request.toolName === CLASSIFIER_TOOL_NAME) {
      return Promise.resolve({
        toolInput: { type: 'receipt' },
        usage: { inputTokens: 300, outputTokens: 5 },
        stopReason: 'tool_use',
      });
    }
    /* A refusal case with a legitimate reading is answered with it, so every
     * `allowed` reading is proven to score through the real interpreter;
     * without one, and for ambiguity, the honest Unclear (final review). */
    const target =
      evalCase.expect.kind === 'command'
        ? evalCase.expect
        : evalCase.expect.kind === 'refusal'
          ? (evalCase.expect.allowed?.[0] ?? null)
          : null;
    if (!target) {
      return reply({ intent: 'Unclear', clarification: 'Could you say the exact amount?' });
    }

    const checks = target.checks ?? {};
    const customer = checks.customerToken
      ? { kind: 'token', token: checks.customerToken }
      : { kind: 'none' };
    switch (target.intent) {
      case 'RecordSale': {
        const items = checks.items
          ? checks.items.map((line) => ({ ...line }))
          : [
              {
                name: checks.product ?? 'item',
                quantity: checks.quantity ?? 1,
                unitPrice: checks.unitPrice ?? checks.statedTotal ?? 1_000,
              },
            ];
        const total = items.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
        return reply({
          intent: 'RecordSale',
          customer,
          items,
          statedTotal: checks.statedTotal ?? null,
          reportedPayment: checks.paidInFull ? total : (checks.reportedPayment ?? null),
          paymentMethod: checks.paymentMethod ?? 'unknown',
          discount: null,
          deliveryFee: null,
          dueDescription: null,
        });
      }
      case 'RecordExpense':
        return reply({
          intent: 'RecordExpense',
          description: 'expense',
          amount: checks.amount ?? 1_000,
          category: null,
          paymentMethod: checks.paymentMethod ?? 'unknown',
        });
      case 'RecordPayment':
        return reply({
          intent: 'RecordPayment',
          customer,
          amount: checks.amount ?? null,
          relativeAmount: checks.relativeAmount ?? null,
          documentRef: null,
          paymentMethod: checks.paymentMethod ?? 'unknown',
        });
      case 'RecordPurchase':
        return reply({
          intent: 'RecordPurchase',
          supplierMention: checks.supplierMention ?? null,
          description: 'stock',
          amount: checks.amount ?? 107_500,
          reportedPayment: checks.unpaid ? 0 : (checks.reportedPayment ?? null),
          ...(checks.paymentMethod ? { paymentMethod: checks.paymentMethod } : {}),
          productMention: checks.product ?? (checks.quantity ? 'stock' : null),
          quantity: checks.quantity ?? null,
        });
      case 'Query':
        return reply({
          intent: 'Query',
          topic: checks.topic ?? 'sales_summary',
          customer: checks.customerToken ? customer : null,
          period: checks.period ?? null,
          periodText: checks.periodText ?? null,
          format: 'chat',
        });
      default:
        throw new Error(`oracle has no shape for ${target.intent}`);
    }
  }
}

describe('the dataset through the real interpreter', () => {
  it('a perfect oracle scores perfectly, through every real gate', async () => {
    const interpreter = new Interpreter(db, config, new OracleTransport());

    const results: EvalCaseResult[] = [];
    for (const evalCase of EVAL_CASES) {
      results.push(await runEvalCase(interpreter, businessId, evalCase));
    }

    /* No case may die on the way IN: a dataset input that trips the
     * privacy fail-close or the schema border is a broken fixture, and a
     * broken fixture makes every live score a lie. */
    expect(results.filter((r) => r.status !== 'passed')).toEqual([]);

    const metrics = scoreEval(EVAL_CASES, results);
    expect(metrics.datasetSize).toBe(EVAL_CASES.length);
    expect(metrics.invalid).toBe(0);
    for (const metric of [
      metrics.acceptedAnswerAccuracy,
      metrics.intentExactMatch,
      metrics.amountExactMatch,
      metrics.quantityExactMatch,
      metrics.customerTokenMatch,
      metrics.abstainedOnAmbiguous,
      metrics.injectionResisted,
    ]) {
      /* Measured on real evidence, and perfect. */
      expect(metric.status).toBe('MEASURED');
      expect(metric.value).toBe(1);
      expect(metric.observations).toBeGreaterThan(0);
    }
    for (const [category, bucket] of Object.entries(metrics.byCategory)) {
      expect(bucket.passed, category).toBe(bucket.total);
    }
    expect(
      evaluateLaunchGate(metrics, RECOMMENDED_PROFILE, { invalidCases: 0, datasetErrors: [] })
        .overall,
    ).toBe('PASS');
  });

  it('a guessing model is caught: ambiguity answered with a command fails the gate', async () => {
    /* The anti-oracle: answers EVERYTHING with a confident sale. The
     * harness must score its confidence as the failure it is. */
    const guesser: ModelTransport = {
      send: () =>
        Promise.resolve({
          toolInput: {
            command: {
              intent: 'RecordSale',
              customer: { kind: 'none' },
              items: [{ name: 'guess', quantity: 1, unitPrice: 5_000 }],
              statedTotal: null,
              reportedPayment: null,
              paymentMethod: 'unknown',
              discount: null,
              deliveryFee: null,
              dueDescription: null,
            },
          },
          usage: { inputTokens: 1_500, outputTokens: 100 },
          stopReason: 'tool_use',
        }),
    };
    const interpreter = new Interpreter(db, config, guesser);

    const ambiguous = EVAL_CASES.filter((c) => c.expect.kind === 'clarification');
    const results: EvalCaseResult[] = [];
    for (const evalCase of ambiguous) {
      results.push(await runEvalCase(interpreter, businessId, evalCase));
    }

    const metrics = scoreEval(ambiguous, results);
    expect(metrics.abstainedOnAmbiguous).toMatchObject({ status: 'MEASURED', value: 0 });
    expect(metrics.acceptedAnswerAccuracy.value).toBe(0);
  });

  it('a provider outage proves nothing: every case invalid, no gate passes (G-07)', async () => {
    const down: ModelTransport = {
      send: () => Promise.reject(new ProviderUnreachable('anthropic 503')),
    };
    const interpreter = new Interpreter(db, config, down);

    const results: EvalCaseResult[] = [];
    for (const evalCase of EVAL_CASES) {
      results.push(await runEvalCase(interpreter, businessId, evalCase));
    }

    expect(results.every((r) => r.status === 'invalid')).toBe(true);
    const metrics = scoreEval(EVAL_CASES, results);
    expect(metrics.abstainedOnAmbiguous.status).toBe('NOT_MEASURED');
    expect(metrics.injectionResisted.status).toBe('NOT_MEASURED');
    const verdict = evaluateLaunchGate(metrics, RECOMMENDED_PROFILE, {
      invalidCases: metrics.invalid,
      datasetErrors: [],
    });
    expect(verdict.overall).toBe('NOT_MEASURED');
  });

  /* Codex on #273: failed attempts are recorded unpriced, and the report
   * must say the cost is understated rather than show it complete. */
  it('counts failed provider attempts as unpriced in the run report', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348080000010');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Eval Usage Shop',
      businessType: null,
      ownerUserId: user.id,
    });
    const down: ModelTransport = {
      send: () => Promise.reject(new ProviderUnreachable('anthropic 503')),
    };
    const interpreter = new Interpreter(db, config, down);
    for (const evalCase of EVAL_CASES.slice(0, 3)) {
      await runEvalCase(interpreter, business.id, evalCase);
    }
    const usage = await usageOf(db, business.id);
    expect(usage.failedCalls).toBe(3);
    expect(usage.unpricedCalls).toBe(3);
  });
});

describe('the room a live run needs (G-07, Codex on #273)', () => {
  it('refuses a run the global ceiling would cut short, and allows one it would not', async () => {
    expect(
      await ceilingShortfall(db, { ...config, aiCallsGlobalPerDay: 10 }, EVAL_CASES),
    ).toContain('the global AI ceiling leaves');
    expect(
      await ceilingShortfall(db, { ...config, aiCallsGlobalPerDay: 1_000_000 }, EVAL_CASES),
    ).toBeNull();
  });
});
