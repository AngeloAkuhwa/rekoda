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
  createDb,
  events as eventsRepo,
  identity,
  issueRepo,
  jobsRepo,
  ordersRepo,
  schema,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
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
    await identity.inviteMember(appDb, businessId, phone, role, 3);
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
    const recorded = await eventsRepo.recordEvent(appDb, {
      provider: 'meta',
      eventType: 'message.text',
      externalId,
      payload: sealPayload(body, config.vaultKey, 'meta', externalId),
      businessId,
    });
    await enqueue(businessId, 'inbound.message', { eventId: recorded.id });
    const runner = buildRunner(workerDb, appDb, deps);
    await runner.runOnce();
    return stubSender.sent[stubSender.sent.length - 1]?.text ?? '';
  }

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
    const recorded = await eventsRepo.recordEvent(appDb, {
      provider: 'meta',
      eventType: 'message.text',
      externalId,
      payload: sealPayload(body, config.vaultKey, 'meta', externalId),
      businessId,
    });
    await enqueue(businessId, 'inbound.message', { eventId: recorded.id });
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

    const first = await eventsRepo.recordEvent(appDb, {
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
    const second = await eventsRepo.recordEvent(appDb, {
      provider: 'meta',
      eventType: 'message.text',
      externalId: 'wamid.order2',
      payload: sealPayload(bodyFor('wamid.order2', 'yes'), config.vaultKey, 'meta', 'wamid.order2'),
      businessId,
    });
    await enqueue(businessId, 'inbound.message', { eventId: first.id });
    await enqueue(businessId, 'inbound.message', { eventId: second.id });

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
