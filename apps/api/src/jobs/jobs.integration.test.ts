/**
 * The runner, against a real PostgreSQL (MASTER-PLAN 4.4 #3).
 *
 * `packages/db/src/jobs.integration.test.ts` proves the queue's SQL. This file
 * proves the thing built on top of it: that a handler runs pinned to its job's
 * tenant, that its writes and its completion are one transaction, and that a
 * handler which throws leaves nothing behind.
 *
 * The runner is built with `buildRunner` — the same function `main.ts` calls —
 * so a handler that exists in the deploy and not in the test registry is not a
 * thing that can happen.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  billingRepo,
  createDb,
  events as eventsRepo,
  identity,
  issueRepo,
  jobsRepo,
  ordersRepo,
  schema,
  sql,
  usageRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { allowanceFor, replies, usagePeriod } from '@rekoda/core';
import { migrate, requireUrls, storedEventId, truncateAll, type Urls } from '@rekoda/db/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobRunner } from './runner.js';
import { buildRunner, type RunnerDeps } from './jobs.module.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { Interpreter } from '../ai/interpreter.service.js';
import { StubTransport } from '../ai/transport.stub.js';
import { StubSender } from '../channels/sender.stub.js';
import { StubTextExtraction } from '../ai/ocr.stub.js';
import { StubSpeechToText } from '../ai/stt.stub.js';
import { StubPaymentProvider } from '../payments/provider.stub.js';
import { PaymentIntentsService } from '../payments/payment-intents.service.js';
import { LocalStorage } from '../documents/r2.storage.js';
import { ReplySender } from '../replies/reply.service.js';
import { loadConfig, type ApiConfig } from '../config.js';
import { sealPayload } from '../privacy/payload-vault.js';
import { ContainerAudioProbe } from '../ai/audio-duration.js';
import { CommandBus } from '../commands/command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';

const RUN_SALT = randomBytes(16).toString('hex');

/** A fresh directory per run, so one suite cannot read another's documents. */
const storageRoot = mkdtempSync(join(tmpdir(), 'rekoda-docs-'));

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
let config: ApiConfig;
/** The real gateway and the real config — `buildRunner` gets what production gets. */
let deps: RunnerDeps;
let stubTransport: StubTransport;
let stubSender: StubSender;
let stubStt: StubSpeechToText;
let stubOcr: StubTextExtraction;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = testKey('pepper');
  process.env['REKODA_API_SECRET'] = testKey('secret');
  process.env['VAULT_KEY'] = testKey('vault');
  process.env['MATCH_KEY'] = testKey('match');
  config = loadConfig();
  stubTransport = StubTransport.answering({
    intent: 'Unclear',
    clarification: 'How many wigs?',
  });
  stubSender = new StubSender();
  stubStt = new StubSpeechToText();
  stubOcr = new StubTextExtraction();
  deps = {
    gateway: new PrivacyGateway(appDb, config),
    interpreter: new Interpreter(appDb, config, stubTransport),
    replySender: new ReplySender(config, stubSender),
    // A real filesystem storage, not a mock: the render job's assertions are
    // about bytes actually landing somewhere and being readable back.
    storage: new LocalStorage(storageRoot),
    sender: stubSender,
    config,
    paymentProvider: new StubPaymentProvider(),
    paymentIntents: new PaymentIntentsService(config, appDb, new StubPaymentProvider()),
    stt: stubStt,
    ocr: stubOcr,
    audioProbe: new ContainerAudioProbe(),
    commandBus: new CommandBus(new RiskPolicyService()),
  };
});

/**
 * Derived per run, never a literal. A high-entropy constant assigned to
 * something named `*_KEY` is indistinguishable from a leaked credential to
 * every scanner pointed at this repository — and generating it is stronger
 * anyway, since no two runs share one.
 */
function testKey(label: string): string {
  return createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');
}

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(name: string, phone: string): Promise<string> {
  const user = await identity.upsertUserByPhone(appDb, phone);
  const business = await identity.createBusinessWithOwner(appDb, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

function enqueue(businessId: string, kind: string, payload: Record<string, unknown> = {}) {
  return withBusiness(appDb, businessId, (tx) =>
    jobsRepo.enqueue(tx, { businessId, kind, payload }),
  );
}

/**
 * Record an attributed event the way the Meta ingress does: inside
 * `withBusiness`, pinned to the tenant it resolved to.
 *
 * Migration 0130 gave `external_events` a tenant policy, so an unpinned
 * insert carrying a `business_id` is refused — correctly. Production never
 * writes one: `meta.service.ts` opens `withBusiness` the moment it has
 * resolved the sender, and only a genuinely unattributed event (a stranger,
 * a Paystack webhook awaiting the pump) goes in without a pin.
 */
function recordPinned(event: Parameters<typeof eventsRepo.recordEvent>[1]) {
  const { businessId } = event;
  if (!businessId) throw new Error('recordPinned is for attributed events only');
  return withBusiness(appDb, businessId, (tx) => eventsRepo.recordEvent(tx, event));
}

/**
 * Stamp a stored message as reaching Rekoda a minute from now (G-23).
 *
 * A "yes" can confirm only a preview that existed when it arrived: a reply
 * to a preview always reaches Rekoda after the preview was written, because
 * the preview is sent only after its draft is. Tests that enqueue a request
 * and its "yes" together, to prove the lanes keep them in order, model that
 * real arrival here rather than a "yes" sent before anything was shown.
 */
function arrivesAfterPreview(businessId: string, stored: Parameters<typeof storedEventId>[0]) {
  return withBusiness(appDb, businessId, (tx) =>
    tx.execute(sql`
      UPDATE external_events SET created_at = now() + interval '1 minute'
       WHERE id = ${storedEventId(stored)}::uuid`),
  );
}

function jobsOf(businessId: string) {
  return withBusiness(appDb, businessId, (tx) => jobsRepo.jobsForBusiness(tx));
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the runner');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function productsOf(businessId: string) {
  // No WHERE clause, deliberately: row-level security is what scopes this, so
  // the assertion below is about the pin rather than about a predicate the
  // test itself supplied.
  return withBusiness(appDb, businessId, (tx) => tx.select().from(schema.products));
}

describe('a handler runs pinned to its job`s tenant', () => {
  it('writes into the right business without being told which', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    const bola = await seedBusiness('Bola Electronics', '+2348050000002');
    await enqueue(ada, 'test.write');

    const runner = new JobRunner(workerDb, appDb);
    runner.register('test.write', async ({ tx, businessId }) => {
      // The handler receives `tx`, already pinned, and has no other handle.
      await tx.insert(schema.products).values({ businessId, name: 'wig', unitPriceK: 1 });
    });

    expect(await runner.runOnce()).toBe(true);
    expect(await productsOf(ada)).toHaveLength(1);
    expect(await productsOf(bola)).toHaveLength(0);
    expect((await jobsOf(ada))[0]).toMatchObject({ state: 'done' });
  });

  it('is refused by the database when it writes into another tenant', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    const bola = await seedBusiness('Bola Electronics', '+2348050000002');
    await enqueue(ada, 'test.smuggle', { target: bola });

    const runner = new JobRunner(workerDb, appDb);
    runner.register('test.smuggle', async ({ tx, payload }) => {
      // A handler doing exactly what a compromised or careless one would.
      await tx
        .insert(schema.products)
        .values({ businessId: payload['target'] as string, name: 'smuggled', unitPriceK: 1 });
    });

    await runner.runOnce();

    expect(await productsOf(bola)).toHaveLength(0);
    // Not silently swallowed either — it is a failed job with a reason.
    const [job] = await jobsOf(ada);
    expect(job).toMatchObject({ state: 'pending', attempts: 1 });
    expect(job!.lastError).toMatch(/row-level security|permission/i);
  });

  it('records WHY a job failed, never the statement or its parameters', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.constraint');

    const runner = new JobRunner(workerDb, appDb);
    runner.register('test.constraint', async ({ tx, businessId }) => {
      await tx
        .insert(schema.products)
        .values({ businessId, name: 'first', unitPriceK: 1, externalCatalogueId: 'CAT-1' });
      // Same catalogue id, so the unique index rejects it — and the bound
      // parameters of the rejected statement include the name below.
      await tx.insert(schema.products).values({
        businessId,
        name: 'Adaeze Okonkwo — 08031234567',
        unitPriceK: 1,
        externalCatalogueId: 'CAT-1',
      });
    });

    await runner.runOnce();
    const error = (await jobsOf(ada))[0]!.lastError ?? '';

    /**
     * `last_error` is a plaintext column outside the vault, and drizzle's
     * wrapper message is `Failed query: <sql>\nparams: <every bound value>`.
     * Stored verbatim, a handler carrying a merchant's message would write its
     * customer's name and number here — past the privacy gateway, in a column
     * nothing redacts. The reason is kept; the row is not.
     */
    expect(error).toMatch(/duplicate key|unique constraint/i);
    expect(error).not.toMatch(/insert into/i);
    expect(error).not.toContain('Adaeze');
    expect(error).not.toContain('08031234567');
  });
});

describe('a job and its effects are one transaction', () => {
  it('leaves NOTHING behind when the handler throws half way', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.explode');

    const runner = new JobRunner(workerDb, appDb);
    runner.register('test.explode', async ({ tx, businessId }) => {
      await tx.insert(schema.products).values({ businessId, name: 'half-written', unitPriceK: 1 });
      throw new Error('provider refused the message');
    });

    await runner.runOnce();

    // The row the handler wrote before throwing is gone. Without this, a
    // retried job would double every write it managed before failing.
    expect(await productsOf(ada)).toHaveLength(0);
    expect((await jobsOf(ada))[0]).toMatchObject({
      state: 'pending',
      attempts: 1,
      lastError: 'provider refused the message',
    });
  });

  it('does not re-run a job whose handler already succeeded', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.count');

    let runs = 0;
    const runner = new JobRunner(workerDb, appDb);
    runner.register('test.count', async () => {
      runs++;
    });

    expect(await runner.runOnce()).toBe(true);
    expect(await runner.runOnce()).toBe(false);
    expect(runs).toBe(1);
  });
});

describe('a job kind nobody handles', () => {
  it('dies on the first attempt instead of retrying five times', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.removed-in-a-deploy');

    const runner = new JobRunner(workerDb, appDb);
    await runner.runOnce();

    // Backing off five times cannot make a missing handler appear; it only
    // delays the moment someone reads the error.
    const [job] = await jobsOf(ada);
    expect(job).toMatchObject({ state: 'dead', attempts: 1 });
    expect(job!.lastError).toMatch(/no handler registered/);
  });
});

describe('the polling loop', () => {
  it('picks work up on its own and stops when asked', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348050000001');
    await enqueue(ada, 'test.polled');

    const done: string[] = [];
    const runner = new JobRunner(workerDb, appDb, { idleMs: 20 });
    runner.register('test.polled', async ({ businessId }) => {
      done.push(businessId);
    });

    // `start()` is what the deploy calls; `runOnce()` is what every other test
    // here calls. Without this one, the loop that actually runs in production
    // is the only part of the runner nothing exercises.
    runner.start();
    await waitFor(() => done.length === 1);
    await runner.stop();

    expect(done).toEqual([ada]);
    expect((await jobsOf(ada))[0]).toMatchObject({ state: 'done' });

    // Stopped means stopped: work queued afterwards stays queued.
    await enqueue(ada, 'test.polled');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(done).toHaveLength(1);
  });
});

describe('the registry the application actually ships', () => {
  it('handles the inbound-message kind', async () => {
    const runner = buildRunner(workerDb, appDb, deps);
    // Registering it twice throws, which is how we know it is already there —
    // a registry assertion that cannot pass by reading a stale export.
    expect(() => runner.register('inbound.message', async () => {})).toThrow(/already registered/);
  });

  it('returns false rather than spinning when the queue is empty', async () => {
    const runner = buildRunner(workerDb, appDb, deps);
    expect(await runner.runOnce()).toBe(false);
  });
});

describe('the chat surface enforces roles', () => {
  /**
   * The dashboard has RolesGuard; chat has only this handler. An accountant
   * is inside the tenant, so RLS passes every row — the refusal below is the
   * only thing standing between a view-only member and the books.
   */
  async function memberOf(
    businessId: string,
    phone: string,
    role: 'accountant' | 'delegate',
  ): Promise<void> {
    await identity.inviteMember(appDb, businessId, phone, role, 3, 'user:test-owner');
  }

  async function saysOverChat(businessId: string, phone: string, text: string): Promise<string> {
    const externalId = `wamid.${randomBytes(8).toString('hex')}`;
    const waId = phone.replace('+', '');
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550001', phone_number_id: 'PNID' },
                contacts: [{ profile: { name: 'X' }, wa_id: waId }],
                messages: [
                  {
                    id: externalId,
                    from: waId,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const recorded = await recordPinned({
      provider: 'meta',
      eventType: 'message.text',
      externalId,
      payload: sealPayload(body, config.vaultKey, 'meta', externalId),
      businessId,
    });
    await enqueue(businessId, 'inbound.message', { eventId: storedEventId(recorded) });
    const runner = buildRunner(workerDb, appDb, deps);
    await runner.runOnce();
    return stubSender.sent[stubSender.sent.length - 1]?.text ?? '';
  }

  it("processes THIS job's message out of a multi-event body, not the first", async () => {
    // One webhook body, two text messages from two different numbers - the
    // shape a batched Meta delivery has. The stored payload is the whole
    // body, and this job is for the SECOND message. Before the fix the
    // handler read events[0] and answered the FIRST sender; now it selects
    // by wamid and answers the one this job is for.
    const businessId = await seedBusiness('Batch Ltd', '+2348140019001');
    const first = { waId: '2348140019011', wamid: 'wamid.batchA' };
    const second = { waId: '2348140019012', wamid: 'wamid.batchB' };
    const message = (m: { waId: string; wamid: string }) => ({
      id: m.wamid,
      from: m.waId,
      timestamp: '1700000000',
      type: 'text' as const,
      text: { body: 'who owes me' },
    });
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550001', phone_number_id: 'PNID' },
                contacts: [
                  { profile: { name: 'A' }, wa_id: first.waId },
                  { profile: { name: 'B' }, wa_id: second.waId },
                ],
                messages: [message(first), message(second)],
              },
            },
          ],
        },
      ],
    };
    const recorded = await recordPinned({
      provider: 'meta',
      eventType: 'message.text',
      externalId: second.wamid,
      payload: sealPayload(body, config.vaultKey, 'meta', second.wamid),
      businessId,
    });
    await enqueue(businessId, 'inbound.message', { eventId: storedEventId(recorded) });
    await buildRunner(workerDb, appDb, deps).runOnce();

    const last = stubSender.sent[stubSender.sent.length - 1];
    expect(last?.to).toBe(second.waId);
  });

  it('refuses a write command from an accountant, after the model names it one', async () => {
    const businessId = await seedBusiness('Role Gate Ltd', '+2348140010001');
    await memberOf(businessId, '+2348140010002', 'accountant');
    stubTransport.replyWith({
      intent: 'RecordExpense',
      description: 'fuel',
      amount: 5_000,
      category: 'transport',
      paymentMethod: 'cash',
    });

    const answer = await saysOverChat(businessId, '+2348140010002', 'spent 5k on fuel today');
    expect(answer).toContain('view only');
  });

  /** What a refused message must leave untouched (G-57). */
  async function footprint(businessId: string): Promise<Record<string, number>> {
    const [row] = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<Record<string, string>>(sql`
        SELECT
          (SELECT COALESCE(sum(used), 0) FROM usage_counters
            WHERE business_id = ${businessId}::uuid AND unit = 'AI_ACTIONS') AS ai_actions,
          /* Every usage and provider-cost row but the reply's own send. */
          (SELECT count(*) FROM usage_events WHERE business_id = ${businessId}::uuid
            AND usage_type <> 'SERVICE_MESSAGE') AS usage_events,
          (SELECT count(*) FROM command_drafts WHERE business_id = ${businessId}::uuid) AS drafts,
          (SELECT count(*) FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
          (SELECT count(*) FROM payments WHERE business_id = ${businessId}::uuid) AS payments,
          (SELECT count(*) FROM ledger_transactions
            WHERE business_id = ${businessId}::uuid) AS postings,
          (SELECT count(*) FROM inventory_movements
            WHERE business_id = ${businessId}::uuid) AS stock_moves`),
    );
    /* Provider cost is platform data the app role cannot read: as the owner. */
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      const [cost] = await ownerDb.execute<{ n: string }>(sql`
        SELECT count(*) AS n FROM platform_cost_events WHERE business_id = ${businessId}::uuid`);
      return {
        ...Object.fromEntries(Object.entries(row!).map(([k, v]) => [k, Number(v)])),
        cost_events: Number(cost!.n),
      };
    } finally {
      await close();
    }
  }

  /* G-57: a view-only member asking to CHANGE the books is refused before
   * anything is paid for. The canonical rule (spec §4.3, rules 2 to 4): a
   * refused request consumes no allowance and calls no provider. The model
   * fixture would name it a sale; it must never be asked. */
  it('refuses an accountant`s free-form sale before metering or calling the model', async () => {
    const businessId = await seedBusiness('Role Gate Meter Ltd', '+2348140010011');
    await memberOf(businessId, '+2348140010012', 'accountant');
    stubTransport.replyWith({
      intent: 'RecordSale',
      customer: { kind: 'none' },
      items: [{ name: 'rice', quantity: 1, unitPrice: 50_000 }],
      statedTotal: 50_000,
      reportedPayment: 50_000,
      paymentMethod: 'cash',
      discount: null,
      deliveryFee: null,
      dueDescription: null,
    });

    const answer = await saysOverChat(businessId, '+2348140010012', 'record a sale of 50k cash');
    expect(answer).toContain('view only');
    expect({
      modelCalls: stubTransport.requests.length,
      ...(await footprint(businessId)),
    }).toEqual({
      modelCalls: 0,
      ai_actions: 0,
      usage_events: 0,
      cost_events: 0,
      drafts: 0,
      invoices: 0,
      payments: 0,
      postings: 0,
      stock_moves: 0,
    });
  });

  const ZERO = {
    modelCalls: 0,
    ai_actions: 0,
    usage_events: 0,
    cost_events: 0,
    drafts: 0,
    invoices: 0,
    payments: 0,
    postings: 0,
    stock_moves: 0,
  };
  const A_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'none' },
    items: [{ name: 'rice', quantity: 1, unitPrice: 20_000 }],
    statedTotal: 20_000,
    reportedPayment: 20_000,
    paymentMethod: 'cash',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };
  const A_SALES_QUESTION = {
    intent: 'Query',
    topic: 'sales_summary',
    customer: null,
    period: 'month',
    periodText: null,
    format: 'chat',
  };
  const seen = async (businessId: string) => ({
    modelCalls: stubTransport.requests.length,
    ...(await footprint(businessId)),
  });

  /* D, E, F (C is above): each kind of record, plainly asked for. */
  it.each([
    ['a purchase', 'bought 10 cartons for 180k'],
    ['an expense', 'I spent 20k on fuel'],
    ['a payment', 'Ada paid me 20k'],
    ['a sale', 'sold rice 5k'],
  ])('refuses %s from an accountant before the meter or the model (G-57)', async (_, text) => {
    const businessId = await seedBusiness('Role Gate Kinds Ltd', '+2348140010021');
    await memberOf(businessId, '+2348140010022', 'accountant');
    stubTransport.replyWith(A_SALE);

    expect(await saysOverChat(businessId, '+2348140010022', text)).toBe(
      replies.viewOnlyRole().text,
    );
    expect(await seen(businessId)).toEqual(ZERO);
  });

  /* O (OWN-25): could be either, so it is never sent to the model, never
   * metered, and never called a record: the member is asked for a question. */
  it('asks an accountant for a question when the message could be either (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Unknown Ltd', '+2348140010023');
    await memberOf(businessId, '+2348140010024', 'accountant');
    stubTransport.replyWith(A_SALE);

    for (const text of ['Ada 20k', 'rice and beans for Chidi']) {
      expect(await saysOverChat(businessId, '+2348140010024', text)).toBe(
        replies.viewOnlyAskAQuestion().text,
      );
    }
    expect(await seen(businessId)).toEqual(ZERO);
  });

  /* G: a question is still theirs, through the model, metered as any read. */
  it('answers an accountant free-form question through the model, metered once (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Question Ltd', '+2348140010025');
    await memberOf(businessId, '+2348140010026', 'accountant');
    stubTransport.replyWith(A_SALES_QUESTION);

    const answer = await saysOverChat(
      businessId,
      '+2348140010026',
      'how much did we sell this month?',
    );
    expect(answer).not.toBe(replies.viewOnlyRole().text);
    expect(answer).not.toBe(replies.viewOnlyAskAQuestion().text);
    expect(stubTransport.requests).toHaveLength(1);
    expect((await footprint(businessId)).ai_actions).toBe(1);
  });

  /* Defence in depth: the early check is not the boundary. A question the
   * model reads as a sale is still refused after the model, and nothing is
   * drafted or booked; only the unit and the call it cost are spent. */
  it('still refuses after the model when a question turns out to be a record (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Depth Ltd', '+2348140010027');
    await memberOf(businessId, '+2348140010028', 'accountant');
    stubTransport.replyWith(A_SALE);

    expect(
      await saysOverChat(businessId, '+2348140010028', 'how much did we sell this month?'),
    ).toBe(replies.viewOnlyRole().text);
    expect(await seen(businessId)).toMatchObject({
      modelCalls: 1,
      ai_actions: 1,
      drafts: 0,
      invoices: 0,
      payments: 0,
      postings: 0,
      stock_moves: 0,
    });
  });

  /* A, B, and the control OWN-25 insists on: a member who may record is never
   * put through the early check, so "Ada 20k" reaches the model as before. */
  it.each([
    ['the owner', null],
    ['a delegate', 'delegate'],
  ] as const)('sends free-form text from %s to the model as before (G-57)', async (_, role) => {
    const businessId = await seedBusiness('Role Gate Writers Ltd', '+2348140010031');
    const phone = role ? '+2348140010032' : '+2348140010031';
    if (role) await memberOf(businessId, phone, role);
    stubTransport.replyWith(A_SALE);

    const preview = await saysOverChat(businessId, phone, 'sold rice 20k');
    expect(preview).toContain('Reply *yes*');
    expect(stubTransport.requests).toHaveLength(1);
    expect((await footprint(businessId)).ai_actions).toBe(1);

    stubTransport.replyWith(A_SALE);
    await saysOverChat(businessId, phone, 'Ada 20k');
    expect(stubTransport.requests).toHaveLength(1);
    expect((await footprint(businessId)).ai_actions).toBe(2);
  });

  /* I, J: the plan is refused first, exactly as before, and costs nothing. */
  it('refuses an Integrate-only or lapsed accountant on the plan first, costing nothing (G-57)', async () => {
    const integrate = await seedBusiness('Role Gate Integrate Ltd', '+2348140010033');
    await memberOf(integrate, '+2348140010034', 'accountant');
    await billingRepo.setPlan(appDb, {
      businessId: integrate,
      plan: 'integrate',
      expiresAt: null,
      actor: 'operator:test-plan',
    });
    stubTransport.replyWith(A_SALE);
    expect(await saysOverChat(integrate, '+2348140010034', 'sold rice 5k')).toBe(
      replies.chatNotInPlan().text,
    );
    expect(await seen(integrate)).toEqual(ZERO);

    const lapsed = await seedBusiness('Role Gate Lapsed Ltd', '+2348140010035');
    await memberOf(lapsed, '+2348140010036', 'accountant');
    await billingRepo.setPlan(appDb, {
      businessId: lapsed,
      plan: 'trial',
      expiresAt: new Date(Date.now() - 1_000),
      actor: 'operator:test-clock',
    });
    stubTransport.replyWith(A_SALES_QUESTION);
    const answer = await saysOverChat(lapsed, '+2348140010036', 'how much did we sell?');
    expect(answer).not.toBe(replies.viewOnlyRole().text);
    expect(await seen(lapsed)).toEqual(ZERO);
  });

  /* K: an accountant's question with the allowance gone is refused at the
   * meter, before the model, and takes nothing more. */
  it('refuses an accountant question at an exhausted allowance before the model (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Exhausted Ltd', '+2348140010037');
    await memberOf(businessId, '+2348140010038', 'accountant');
    const allowance = allowanceFor('trial', 'AI_ACTIONS');
    await withBusiness(appDb, businessId, (tx) =>
      usageRepo.consumeUnit(
        tx,
        businessId,
        usagePeriod(new Date()),
        'AI_ACTIONS',
        allowance,
        allowance,
      ),
    );
    stubTransport.replyWith(A_SALES_QUESTION);

    expect(
      await saysOverChat(businessId, '+2348140010038', 'how much did we sell this month?'),
    ).toBe(replies.allowanceExhausted(allowance).text);
    expect(stubTransport.requests).toHaveLength(0);
    expect((await footprint(businessId)).ai_actions).toBe(allowance);
  });

  /**
   * L, M: a job that fails after deciding is retried, and the retry must not
   * charge again. The reply's service-message row fails once, so attempt 1
   * rolls back after its decision; the retry runs with `retrying`.
   */
  async function withFirstReplyFailing(businessId: string, run: () => Promise<void>) {
    const { db: ownerDb, close } = createDb(urls.owner, { max: 1 });
    try {
      await ownerDb.execute(sql`CREATE SEQUENCE IF NOT EXISTS g57_once`);
      await ownerDb.execute(sql`
        CREATE OR REPLACE FUNCTION g57_fail_once() RETURNS trigger
          SECURITY DEFINER AS $$
        BEGIN
          IF NEW.usage_type = 'SERVICE_MESSAGE' THEN
            IF nextval('g57_once') = 1 THEN
              RAISE EXCEPTION 'g57: first reply fails';
            END IF;
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await ownerDb.execute(sql`
        CREATE TRIGGER g57_fail_once BEFORE INSERT ON usage_events
          FOR EACH ROW EXECUTE FUNCTION g57_fail_once()`);
      await run();
      /* The failed attempt was rescheduled; make it due and run it. */
      await ownerDb.execute(sql`
        UPDATE jobs SET run_at = now() WHERE business_id = ${businessId}::uuid AND state <> 'done'`);
      await buildRunner(workerDb, appDb, deps).runOnce();
      const [job] = await ownerDb.execute<{ state: string; attempts: number }>(sql`
        SELECT state, attempts FROM jobs
         WHERE business_id = ${businessId}::uuid AND kind = 'inbound.message'
         ORDER BY created_at DESC LIMIT 1`);
      expect(job).toMatchObject({ state: 'done', attempts: 2 });
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g57_fail_once ON usage_events`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g57_fail_once()`);
      await ownerDb.execute(sql`DROP SEQUENCE IF EXISTS g57_once`);
      await close();
    }
  }

  it('charges nothing on the retry of an early refusal (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Retry Ltd', '+2348140010039');
    await memberOf(businessId, '+2348140010040', 'accountant');
    stubTransport.replyWith(A_SALE);

    await withFirstReplyFailing(businessId, async () => {
      await saysOverChat(businessId, '+2348140010040', 'record a sale of 50k cash');
    });
    expect(stubSender.sent[stubSender.sent.length - 1]?.text).toBe(replies.viewOnlyRole().text);
    expect(await seen(businessId)).toEqual(ZERO);
  });

  it('does not charge twice for a question whose reply failed once (G-57)', async () => {
    const businessId = await seedBusiness('Role Gate Retry Read Ltd', '+2348140010041');
    await memberOf(businessId, '+2348140010042', 'accountant');
    stubTransport.replyWith(A_SALES_QUESTION);

    await withFirstReplyFailing(businessId, async () => {
      await saysOverChat(businessId, '+2348140010042', 'how much did we sell this month?');
    });
    expect((await footprint(businessId)).ai_actions).toBe(1);
  });

  it('answers a QUESTION from that same accountant, because reads are theirs', async () => {
    const businessId = await seedBusiness('Role Gate Reads Ltd', '+2348140010003');
    await memberOf(businessId, '+2348140010004', 'accountant');

    // "who owes me" is deterministic: no model, no draft, just rows.
    const answer = await saysOverChat(businessId, '+2348140010004', 'who owes me');
    expect(answer).not.toContain('view only');
    expect(answer.length).toBeGreaterThan(0);
  });

  it('refuses an accountant yes, so they cannot confirm the owner draft either', async () => {
    const businessId = await seedBusiness('Role Gate Yes Ltd', '+2348140010005');
    await memberOf(businessId, '+2348140010006', 'accountant');

    const answer = await saysOverChat(businessId, '+2348140010006', 'yes');
    expect(answer).toContain('view only');
  });

  it('lets a delegate through the same gate', async () => {
    const businessId = await seedBusiness('Role Gate Delegate Ltd', '+2348140010007');
    await memberOf(businessId, '+2348140010008', 'delegate');

    // Nothing is pending, so the reply is about the missing draft, which
    // means the role gate did not fire.
    const answer = await saysOverChat(businessId, '+2348140010008', 'yes');
    expect(answer).not.toContain('view only');
  });
});

describe('a customer name never reaches the model twice', () => {
  /**
   * The two-layer privacy promise, end to end. The FIRST mention of a new
   * name is the one message a model reads to understand it; from then on the
   * name is a vault identity, every stored copy holds the token, and the
   * known-name pass protects every later message.
   */
  const ADA_SALE = {
    intent: 'RecordSale',
    customer: { kind: 'mention', mention: 'Ada Obi' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
    reportedPayment: 150_000,
    paymentMethod: 'cash',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };

  async function saleMention(
    businessId: string,
    ownerPhone: string,
    text: string,
    answer: unknown = ADA_SALE,
  ) {
    stubTransport.replyWith(answer);
    const externalId = `wamid.${randomBytes(8).toString('hex')}`;
    const waId = ownerPhone.replace('+', '');
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550001', phone_number_id: 'PNID' },
                contacts: [{ profile: { name: 'X' }, wa_id: waId }],
                messages: [
                  {
                    id: externalId,
                    from: waId,
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const recorded = await recordPinned({
      provider: 'meta',
      eventType: 'message.text',
      externalId,
      payload: sealPayload(body, config.vaultKey, 'meta', externalId),
      businessId,
    });
    await enqueue(businessId, 'inbound.message', { eventId: storedEventId(recorded) });
    const runner = buildRunner(workerDb, appDb, deps);
    await runner.runOnce();
  }

  it('stores the token everywhere and says the name only over the wire', async () => {
    const businessId = await seedBusiness('Names Once Ltd', '+2348140020001');
    await saleMention(businessId, '+2348140020001', 'sold 3 wigs to Ada Obi for 150k, paid');

    /* The model saw the name this once: nothing knew it yet. */
    const firstRequest = stubTransport.requests[stubTransport.requests.length - 1]!;
    expect(firstRequest.userText).toContain('Ada Obi');

    /* The draft holds a token, not the name. */
    const draft = await withBusiness(appDb, businessId, (tx) =>
      tx.select().from(schema.commandDrafts),
    );
    const command = draft[0]!.command as { customer: { kind: string; token?: string } };
    expect(command.customer.kind).toBe('token');
    expect(command.customer.token).toMatch(/^CUSTOMER_/);
    expect(JSON.stringify(draft[0]!.command)).not.toContain('Ada Obi');

    /* The stored conversation holds the token; the WIRE says the name. */
    const messages = await withBusiness(appDb, businessId, (tx) =>
      tx.select().from(schema.conversationMessages),
    );
    for (const m of messages) {
      expect(m.body ?? '', m.body ?? '').not.toContain('Ada Obi');
    }
    expect(stubSender.sent[stubSender.sent.length - 1]?.text ?? '').toContain('Ada Obi');
  });

  it('tokenises the SECOND message before the model ever sees it', async () => {
    const businessId = await seedBusiness('Names Twice Ltd', '+2348140020002');
    await saleMention(businessId, '+2348140020002', 'sold 3 wigs to Ada Obi for 150k, paid');

    await saleMention(businessId, '+2348140020002', 'Ada Obi wants 2 more wigs', {
      intent: 'Unclear',
      clarification: 'How many wigs this time?',
    });

    const request = stubTransport.requests[stubTransport.requests.length - 1]!;
    expect(request.userText).not.toContain('Ada Obi');
    expect(request.userText).toContain('CUSTOMER_');
  });
});

describe('the polling loop with lanes', () => {
  /**
   * SKIP LOCKED makes N lanes take N different jobs by construction; this
   * proves the lanes actually run side by side, because one twenty-second
   * model call stalling every delivery behind it was the whole finding.
   */
  it('runs two jobs at the same time when built with two lanes', async () => {
    const businessId = await seedBusiness('Lanes Ltd', '+2348140030001');
    let inFlight = 0;
    let peak = 0;
    const runner = new JobRunner(workerDb, appDb, { idleMs: 20, concurrency: 2 });
    runner.register('lane.test', async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 200));
      inFlight -= 1;
    });
    await enqueue(businessId, 'lane.test', { n: 1 });
    await enqueue(businessId, 'lane.test', { n: 2 });

    runner.start();
    await waitFor(() => peak >= 2);
    await runner.stop();
    expect(peak).toBe(2);
  });
});

describe('inbound messages for one business never overlap across lanes', () => {
  /**
   * The per-business advisory lock is what keeps the pending-draft
   * read-then-write single-runner. Two messages enqueued together — a sale
   * mention that creates a draft, then "yes" — must serialize so the second
   * sees the first's committed draft and confirms it, even with two lanes.
   * Without the lock the "yes" can run first and find nothing to confirm.
   */
  it('processes a draft then its confirmation in order under two lanes', async () => {
    const businessId = await seedBusiness('Lane Order Ltd', '+2348140040001');
    const waId = '2348140040001';

    function bodyFor(externalId: string, text: string) {
      return {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '15550001', phone_number_id: 'PNID' },
                  contacts: [{ profile: { name: 'X' }, wa_id: waId }],
                  messages: [
                    {
                      id: externalId,
                      from: waId,
                      timestamp: '1700000000',
                      type: 'text',
                      text: { body: text },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
    }

    stubTransport.replyWith({
      intent: 'RecordExpense',
      description: 'fuel',
      amount: 5_000,
      category: 'transport',
      paymentMethod: 'cash',
    });

    const first = await recordPinned({
      provider: 'meta',
      eventType: 'message.text',
      externalId: 'wamid.order1',
      payload: sealPayload(
        bodyFor('wamid.order1', 'spent 5k on fuel'),
        config.vaultKey,
        'meta',
        'wamid.order1',
      ),
      businessId,
    });
    const second = await recordPinned({
      provider: 'meta',
      eventType: 'message.text',
      externalId: 'wamid.order2',
      payload: sealPayload(bodyFor('wamid.order2', 'yes'), config.vaultKey, 'meta', 'wamid.order2'),
      businessId,
    });
    await arrivesAfterPreview(businessId, second);
    await enqueue(businessId, 'inbound.message', { eventId: storedEventId(first) });
    await enqueue(businessId, 'inbound.message', { eventId: storedEventId(second) });

    // Two lanes, both draining; the lock is what keeps them in order.
    const runner = buildRunner(workerDb, appDb, deps, { idleMs: 20, concurrency: 2 });
    runner.start();
    const deadline = Date.now() + 8_000;
    for (;;) {
      const jobs = await jobsOf(businessId);
      if (jobs.length >= 2 && jobs.every((j) => j.state === 'done' || j.state === 'dead')) break;
      if (Date.now() > deadline) throw new Error('timed out waiting for both inbound jobs');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await runner.stop();

    // The "yes" confirmed the expense the first message drafted: exactly one
    // expense recorded, and no draft left pending.
    const expenses = await withBusiness(appDb, businessId, (tx) =>
      tx.select().from(schema.expenses),
    );
    expect(expenses).toHaveLength(1);
    const drafts = await withBusiness(appDb, businessId, (tx) =>
      tx.select().from(schema.commandDrafts),
    );
    expect(drafts.every((d) => d.state !== 'pending')).toBe(true);
  });

  /**
   * The lock alone guarantees exclusion, not order. Between claiming a job and
   * taking the business lock there is a window, and a lane holding the LATER
   * message can win the lock while the earlier message's lane is still on its
   * way — "yes" then finds no draft and the conversation silently loses a
   * record. This pins the window open: the draft's job is claimed by a lane
   * that never reaches the lock, so the confirm's lane must notice it is
   * jumping the queue and step back rather than run.
   */
  it('defers the confirm while the draft message is still claimed elsewhere', async () => {
    const businessId = await seedBusiness('Stalled Lane Ltd', '+2348140040002');
    const waId = '2348140040002';

    function bodyFor(externalId: string, text: string) {
      return {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WABA',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '15550002', phone_number_id: 'PNID' },
                  contacts: [{ profile: { name: 'X' }, wa_id: waId }],
                  messages: [
                    {
                      id: externalId,
                      from: waId,
                      timestamp: '1700000000',
                      type: 'text',
                      text: { body: text },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
    }

    stubTransport.replyWith({
      intent: 'RecordExpense',
      description: 'fuel',
      amount: 5_000,
      category: 'transport',
      paymentMethod: 'cash',
    });

    const first = await recordPinned({
      provider: 'meta',
      eventType: 'message.text',
      externalId: 'wamid.stall1',
      payload: sealPayload(
        bodyFor('wamid.stall1', 'spent 5k on fuel'),
        config.vaultKey,
        'meta',
        'wamid.stall1',
      ),
      businessId,
    });
    const second = await recordPinned({
      provider: 'meta',
      eventType: 'message.text',
      externalId: 'wamid.stall2',
      payload: sealPayload(bodyFor('wamid.stall2', 'yes'), config.vaultKey, 'meta', 'wamid.stall2'),
      businessId,
    });
    await arrivesAfterPreview(businessId, second);
    const draftJob = await enqueue(businessId, 'inbound.message', {
      eventId: storedEventId(first),
    });
    const confirmJob = await enqueue(businessId, 'inbound.message', {
      eventId: storedEventId(second),
    });
    if (!draftJob || !confirmJob) throw new Error('both jobs should have enqueued');

    // A lane claims the draft's job — the oldest — and stalls before the lock.
    const stalled = await jobsRepo.claimNext(workerDb, 'stalled-lane');
    expect(stalled?.id).toBe(draftJob.id);

    const runner = buildRunner(workerDb, appDb, deps, { idleMs: 20 });
    runner.start();
    try {
      // The confirm's lane runs, but must NOT process "yes" ahead of the
      // draft: give it long enough to have claimed, then look.
      await new Promise((resolve) => setTimeout(resolve, 700));
      /* The lane claims the confirm, steps back, and claims it again every
       * idle tick: a single sample can land mid-claim (`running`) on a slow
       * machine. Watch for a while: it must be seen stepped back to
       * `pending`, it must never finish, and the wait costs no attempt. */
      let seenPending = false;
      const watchUntil = Date.now() + 3_000;
      while (Date.now() < watchUntil) {
        const now = await jobsOf(businessId);
        const confirm = now.find((j) => j.id === confirmJob.id);
        expect(['pending', 'running']).toContain(confirm?.state);
        // Stepping back is not failing: the wait costs no attempt.
        expect(confirm?.attempts).toBe(0);
        if (confirm?.state === 'pending') {
          seenPending = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(seenPending).toBe(true);
      const expensesBefore = await withBusiness(appDb, businessId, (tx) =>
        tx.select().from(schema.expenses),
      );
      expect(expensesBefore).toHaveLength(0);

      // The stalled lane's claim is returned to the queue — the actual
      // crashed-worker recovery, with no grace period — and NOW the pair
      // drains in order.
      await jobsRepo.reclaimStalled(workerDb, 0);
      const deadline = Date.now() + 8_000;
      for (;;) {
        const jobs = await jobsOf(businessId);
        if (jobs.length >= 2 && jobs.every((j) => j.state === 'done' || j.state === 'dead')) break;
        if (Date.now() > deadline) throw new Error('timed out waiting for both inbound jobs');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await runner.stop();
    }

    const expenses = await withBusiness(appDb, businessId, (tx) =>
      tx.select().from(schema.expenses),
    );
    expect(expenses).toHaveLength(1);
  });
});

describe('a quote becomes paper', () => {
  beforeEach(() => stubSender.reset());

  /**
   * The gap this closes: invoices and receipts rendered from the day they
   * shipped, quotes never did — the one document whose whole job is being
   * forwarded to somebody deciding whether to buy.
   */
  it('renders the quote PDF, records the document, and delivers it', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348177000501');
    const quote = await withBusiness(appDb, businessId, (tx) =>
      ordersRepo.createQuote(tx, {
        businessId,
        customerId: null,
        lines: [
          {
            productId: null,
            name: 'Ankara bale',
            quantity: 2,
            unitPriceK: 850_000,
            lineTotalK: 1_700_000,
          },
        ],
        totalK: 1_700_000,
        validUntil: '2026-09-30',
        clientRef: null,
        sourceId: 'test',
      }),
    );
    /* The payload the controller enqueues: the id, and the label the PDF
     * prints — a token, never a name, exactly like the invoice's snapshot. */
    await enqueue(businessId, 'document.render', {
      quoteId: quote.id,
      customerToken: 'CUSTOMER_7K2',
    });

    const runner = buildRunner(workerDb, appDb, deps);
    expect(await runner.runOnce()).toBe(true); // render

    const docs = await withBusiness(appDb, businessId, (tx) =>
      issueRepo.documentsFor(tx, businessId),
    );
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ kind: 'quote_pdf', refNumber: quote.orderNumber });

    expect(await runner.runOnce()).toBe(true); // deliver
    const delivered = stubSender.documents[stubSender.documents.length - 1];
    expect(delivered?.filename).toBe(`${quote.orderNumber}.pdf`);
    /* Real bytes, really a PDF — not a row pointing at nothing. */
    expect(delivered?.bytes.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('an unknown quote id retires quietly instead of poisoning the queue', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348177000502');
    await enqueue(businessId, 'document.render', {
      quoteId: '00000000-0000-4000-8000-000000000000',
    });
    const runner = buildRunner(workerDb, appDb, deps);
    expect(await runner.runOnce()).toBe(true);
    expect(stubSender.documents).toHaveLength(0);
  });
});
