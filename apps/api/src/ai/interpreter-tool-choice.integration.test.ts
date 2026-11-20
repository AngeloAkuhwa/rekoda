/**
 * The interpreter under tool_choice `auto` (G-134, staging 20 Nov 2026).
 *
 * Claude Sonnet 5.5 and Opus 5.5 refuse a forced tool choice with a 400, so
 * the transport asks for the tool with `auto`. That makes "the model answered
 * without the tool" and "the model declined" reachable outcomes, and each
 * must end the same honest way: no command from free text, one bounded
 * escalation at most, every call on its own usage row, the slot handed back
 * only when no provider call was billed, and nothing written to the books.
 *
 * The transport is scripted (the shapes the real one returns are pinned in
 * anthropic-tool-call.test.ts); everything else is real: PostgreSQL, quota counters,
 * the schema border.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, quotaRepo, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { Interpreter } from './interpreter.service.js';
import { StubTransport } from './transport.stub.js';
import { ProviderUnreachable, type ModelReply } from './transport.js';
import { loadConfig, type ApiConfig } from '../config.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;
let config: ApiConfig;

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
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(): Promise<string> {
  const user = await identity.upsertUserByPhone(db, '+2348080000001');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const A_SALE = {
  intent: 'RecordSale',
  customer: { kind: 'token', token: 'CUSTOMER_7K2' },
  items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
  statedTotal: 150_000,
  reportedPayment: 100_000,
  paymentMethod: 'transfer',
  discount: null,
  deliveryFee: null,
  dueDescription: null,
};

const USAGE = { inputTokens: 1_800, outputTokens: 120 };
const GOOD: ModelReply = { toolInput: { command: A_SALE }, usage: USAGE, stopReason: 'tool_use' };
const GARBAGE: ModelReply = {
  toolInput: { command: { intent: 'Nonsense' } },
  usage: USAGE,
  stopReason: 'tool_use',
};
const TRUNCATED: ModelReply = { toolInput: null, usage: USAGE, stopReason: 'max_tokens' };

/**
 * Row counts of every public table, read as the owner. The owner must bypass
 * RLS for a count to mean anything (asserted below). Every table in the
 * database is counted, so this needs the database to itself: CI runs
 * integration files one at a time; a second suite against the same database
 * at the same moment makes it fail, never pass.
 */
async function tableCounts(): Promise<Map<string, number>> {
  const owner = createDb(urls.owner, { max: 1 });
  try {
    const rows = await owner.db.execute<{ name: string; n: number }>(sql`
      SELECT table_name AS name,
             (xpath('/row/n/text()', query_to_xml(
                format('SELECT count(*) AS n FROM public.%I', table_name), false, true, '')))[1]::text::int AS n
        FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    return new Map([...rows].map((r) => [r.name, Number(r.n)]));
  } finally {
    await owner.close();
  }
}

/** The tables whose row counts changed between two snapshots. */
function changedTables(before: Map<string, number>, after: Map<string, number>): string[] {
  return [...after.keys()].filter((name) => before.get(name) !== after.get(name)).sort();
}

/**
 * What an interpretation may write: its usage rows, Rekoda's own provider-cost
 * telemetry derived from them (`platform_cost_events`, never the merchant's
 * books) and its quota counters.
 */
const AI_ACCOUNTING_TABLES = [
  'ai_global_counters',
  'ai_quota_counters',
  'platform_cost_events',
  'usage_events',
];

const PROSE: ModelReply = {
  toolInput: null,
  usage: { inputTokens: 1_800, outputTokens: 40 },
  stopReason: 'end_turn',
};
const REFUSED: ModelReply = {
  toolInput: null,
  usage: { inputTokens: 1_800, outputTokens: 5 },
  stopReason: 'refusal',
  refusalCategory: 'general_harms',
};
const CONTEXT_FULL: ModelReply = {
  toolInput: null,
  usage: USAGE,
  stopReason: 'model_context_window_exceeded',
};

async function metasOf(businessId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ usage_type: string; meta: Record<string, unknown> }>(
      sql`SELECT usage_type, meta FROM usage_events WHERE business_id = ${businessId}::uuid ORDER BY created_at`,
    ),
  );
  return [...rows].map((r) => ({ usageType: r.usage_type, ...r.meta }));
}

describe('an answer without the tool, under tool_choice auto', () => {
  it('escalates ONCE to the escalation model and uses its command, never the prose', async () => {
    const businessId = await seedBusiness();
    const transport = new StubTransport([PROSE, GOOD]);

    const result = await new Interpreter(db, config, transport).interpret(
      businessId,
      'CUSTOMER_7K2 bought 3 wigs for 150k',
    );

    expect(result).toMatchObject({ outcome: 'command', command: { intent: 'RecordSale' } });
    expect(transport.requests.map((r) => r.model)).toEqual([
      config.aiModelDefault,
      config.aiModelEscalation,
    ]);
    const metas = await metasOf(businessId);
    expect(metas).toHaveLength(2);
    expect(metas[0]).toMatchObject({
      usageType: 'llm_call',
      role: 'interpreter',
      stopReason: 'end_turn',
      schemaValid: false,
    });
    expect(metas[1]).toMatchObject({
      usageType: 'llm_call',
      role: 'escalation',
      escalationReason: 'no_tool_call',
      schemaValid: true,
    });
    // Two provider calls were made, so two slots are spent: neither is refunded.
    expect(await withBusiness(db, businessId, (tx) => quotaRepo.callsToday(tx, businessId))).toBe(
      2,
    );
  });

  it('answers unusable when the escalation answers in prose too, without a third call', async () => {
    const businessId = await seedBusiness();
    const transport = new StubTransport([PROSE, PROSE, GOOD]);

    const result = await new Interpreter(db, config, transport).interpret(businessId, 'hello?');

    expect(result).toMatchObject({ outcome: 'unusable' });
    expect(transport.requests).toHaveLength(2);
  });
});

describe('a refusal, under tool_choice auto', () => {
  it('escalates once with the reason "refusal" and keeps the category, never the explanation', async () => {
    const businessId = await seedBusiness();
    const transport = new StubTransport([REFUSED, GOOD]);

    const result = await new Interpreter(db, config, transport).interpret(
      businessId,
      'CUSTOMER_7K2 bought 3 wigs for 150k',
    );

    expect(result).toMatchObject({ outcome: 'command' });
    const metas = await metasOf(businessId);
    expect(metas[0]).toMatchObject({
      role: 'interpreter',
      stopReason: 'refusal',
      refusalCategory: 'general_harms',
      schemaValid: false,
    });
    expect(metas[1]).toMatchObject({ role: 'escalation', escalationReason: 'refusal' });
  });

  it('answers unusable when the escalation refuses as well', async () => {
    const businessId = await seedBusiness();
    const transport = new StubTransport([REFUSED, REFUSED]);

    const result = await new Interpreter(db, config, transport).interpret(businessId, 'something');

    expect(result).toMatchObject({ outcome: 'unusable' });
    expect(transport.requests).toHaveLength(2);
  });
});

describe('an incomplete answer, under tool_choice auto', () => {
  it('does NOT escalate a full context window: the same message fills the same window', async () => {
    const businessId = await seedBusiness();
    const transport = new StubTransport([CONTEXT_FULL, GOOD]);

    const result = await new Interpreter(db, config, transport).interpret(businessId, 'long');

    expect(result).toMatchObject({ outcome: 'unusable' });
    expect(transport.requests).toHaveLength(1);
  });
});

describe('room to answer after thinking (review of bd9c5b3)', () => {
  /* Claude Sonnet 5.5 thinks by default and Opus 5.5 cannot stop thinking;
   * the thinking shares max_tokens with the tool call, and a cut-off answer
   * is unusable without escalation. The ceiling is billed only for what is
   * produced, so it is set with room to spare, the same for every model. */
  it('asks every command reading with a ceiling well above the command itself', async () => {
    const businessId = await seedBusiness();
    const transport = new StubTransport([GARBAGE, GOOD]);
    await new Interpreter(db, config, transport).interpret(businessId, 'CUSTOMER_7K2 bought wigs');

    expect(transport.requests.map((r) => r.maxTokens)).toEqual([4_096, 4_096]);
  });

  it('gives the classifier room too, so a thinking classifier model is not cut off every time', async () => {
    const businessId = await seedBusiness();
    const transport = new StubTransport([
      { toolInput: { type: 'receipt' }, usage: USAGE, stopReason: 'tool_use' },
    ]);
    await new Interpreter(db, config, transport).classifyDocument(businessId, 'TOTAL 5,000');

    expect(transport.requests.map((r) => r.maxTokens)).toEqual([1_024]);
  });

  it('a classification cut off at the ceiling fails open to unsure: what the ceiling prevents', async () => {
    const businessId = await seedBusiness();
    const transport = new StubTransport([
      { toolInput: null, usage: USAGE, stopReason: 'max_tokens' },
    ]);

    expect(
      await new Interpreter(db, config, transport).classifyDocument(businessId, 'TOTAL 5,000'),
    ).toBe('unsure');
  });
});

describe('the provider refusing the request itself (the staging 400)', () => {
  it('is unavailable, escalates nothing, hands the slot back and records the error type', async () => {
    const businessId = await seedBusiness();
    const transport = StubTransport.failing(
      new ProviderUnreachable('anthropic 400: invalid_request_error'),
    );

    const result = await new Interpreter(db, config, transport).interpret(
      businessId,
      'CUSTOMER_7K2 bought 3 wigs for 150k',
    );

    expect(result).toMatchObject({
      outcome: 'unavailable',
      failure: 'provider_unreachable',
      reason: 'anthropic 400: invalid_request_error',
    });
    /* The escalation model would refuse the same request: escalating a 400
     * spends a second slot to reproduce it. */
    expect(transport.requests).toHaveLength(1);
    expect(await withBusiness(db, businessId, (tx) => quotaRepo.callsToday(tx, businessId))).toBe(
      0,
    );
    expect(await metasOf(businessId)).toEqual([
      expect.objectContaining({
        usageType: 'llm_failed',
        role: 'interpreter',
        priced: false,
        reason: 'anthropic 400: invalid_request_error',
      }),
    ]);
  });
});

describe('what an interpretation writes, whatever the model answered', () => {
  const cases: Array<[string, Array<ModelReply | Error>]> = [
    ['a valid command', [GOOD]],
    ['prose, then a command', [PROSE, GOOD]],
    ['invalid tool input twice', [GARBAGE, GARBAGE]],
    ['a refusal twice', [REFUSED, REFUSED]],
    ['a truncated answer', [TRUNCATED]],
    ['a provider 400', [new ProviderUnreachable('anthropic 400: invalid_request_error')]],
  ];

  it('counts as a role that RLS cannot hide rows from, so a count of 0 means 0', async () => {
    const owner = createDb(urls.owner, { max: 1 });
    try {
      const rows = await owner.db.execute<{ sees_all: boolean }>(sql`
        SELECT (rolsuper OR rolbypassrls) AS sees_all FROM pg_roles WHERE rolname = current_user
      `);
      expect([...rows][0]?.sees_all).toBe(true);
    } finally {
      await owner.close();
    }
  });

  it.each(cases)(
    '%s: only its cost rows and quota counters, never a financial record',
    async (_name, replies) => {
      const businessId = await seedBusiness();
      const before = await tableCounts();

      await new Interpreter(db, config, new StubTransport(replies)).interpret(
        businessId,
        'CUSTOMER_7K2 bought 3 wigs for 150k',
      );

      /* The interpreter proposes; nothing is a draft, a sale, an invoice or a
       * ledger line until the command bus is handed a confirmed command. */
      const changed = changedTables(before, await tableCounts());
      // Named on failure: the table that moved is the finding.
      expect(changed.filter((name) => !AI_ACCOUNTING_TABLES.includes(name))).toEqual([]);
      expect(changed).toContain('usage_events');
    },
  );
});
