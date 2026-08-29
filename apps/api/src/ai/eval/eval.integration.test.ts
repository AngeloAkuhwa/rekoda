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
import { Interpreter } from '../interpreter.service.js';
import type { ModelReply, ModelRequest, ModelTransport } from '../transport.js';
import { EVAL_CASES } from './dataset.js';
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
  config = loadConfig();

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

    if (evalCase.expect.kind !== 'command') {
      return reply({ intent: 'Unclear', clarification: 'Could you say the exact amount?' });
    }

    const checks = evalCase.expect.checks ?? {};
    const customer = checks.customerToken
      ? { kind: 'token', token: checks.customerToken }
      : { kind: 'none' };
    switch (evalCase.expect.intent) {
      case 'RecordSale':
        return reply({
          intent: 'RecordSale',
          customer,
          items: [
            {
              name: 'item',
              quantity: checks.quantity ?? 1,
              unitPrice: checks.unitPrice ?? checks.statedTotal ?? 1_000,
            },
          ],
          statedTotal: checks.statedTotal ?? null,
          reportedPayment: checks.reportedPayment ?? null,
          paymentMethod: 'unknown',
          discount: null,
          deliveryFee: null,
          dueDescription: null,
        });
      case 'RecordExpense':
        return reply({
          intent: 'RecordExpense',
          description: 'expense',
          amount: checks.amount ?? 1_000,
          category: null,
          paymentMethod: 'unknown',
        });
      case 'RecordPayment':
        return reply({
          intent: 'RecordPayment',
          customer,
          amount: checks.amount ?? null,
          relativeAmount: null,
          documentRef: null,
          paymentMethod: 'unknown',
        });
      case 'RecordPurchase':
        return reply({
          intent: 'RecordPurchase',
          supplierMention: null,
          description: 'stock',
          amount: checks.amount ?? 107_500,
          reportedPayment: null,
          productMention: null,
          quantity: null,
        });
      default:
        throw new Error(`oracle has no shape for ${evalCase.expect.intent}`);
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
    expect(results.filter((r) => r.outcome === 'error')).toEqual([]);

    const metrics = scoreEval(EVAL_CASES, results);
    expect(metrics.datasetSize).toBe(EVAL_CASES.length);
    expect(metrics.acceptedAnswerAccuracy).toBe(1);
    expect(metrics.intentExactMatch).toBe(1);
    expect(metrics.amountExactMatch).toBe(1);
    expect(metrics.quantityExactMatch).toBe(1);
    expect(metrics.customerTokenMatch).toBe(1);
    expect(metrics.abstainedOnAmbiguous).toBe(1);
    expect(metrics.injectionResisted).toBe(1);
    for (const [category, bucket] of Object.entries(metrics.byCategory)) {
      expect(bucket.passed, category).toBe(bucket.total);
    }
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
    expect(metrics.abstainedOnAmbiguous).toBe(0);
    expect(metrics.acceptedAnswerAccuracy).toBe(0);
  });
});
