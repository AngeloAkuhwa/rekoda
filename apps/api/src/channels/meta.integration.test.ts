/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * The fixed order — signature → parse → idempotency → tenant → persist → 200 —
 * is only real if each step is proven against a running app and a real
 * database. Idempotency in particular cannot be tested any other way: it is a
 * claim about a unique constraint under concurrency.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  conversationsRepo,
  createDb,
  events,
  identity,
  jobsRepo,
  quotaRepo,
  schema,
  usageRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { PLAN_ALLOWANCES, usagePeriod } from '@rekoda/core';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunner, type RunnerDeps } from '../jobs/jobs.module.js';
import {
  billingRepo,
  customersRepo,
  issueRepo,
  paymentsHub,
  reportsRepo,
  settleRepo,
  spendRepo,
} from '@rekoda/db';
import { encryptFacet, matchKeyFor } from '@rekoda/core/vault';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { Interpreter } from '../ai/interpreter.service.js';
import { StubTransport } from '../ai/transport.stub.js';
import { StubSender } from '../channels/sender.stub.js';
import { StubPaymentProvider } from '../payments/provider.stub.js';
import { PaymentIntentsService } from '../payments/payment-intents.service.js';
import { LocalStorage } from '../documents/r2.storage.js';
import { ReplySender } from '../replies/reply.service.js';
import { loadConfig, type ApiConfig } from '../config.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const APP_SECRET = 'meta-app-secret-for-tests';
const VERIFY_TOKEN = 'meta-verify-token-for-tests';

/** A fresh directory per run, so one suite cannot read another's documents. */
const storageRoot = mkdtempSync(join(tmpdir(), 'rekoda-docs-'));

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let workerDb: Db;
let closeDb: () => Promise<void>;
let closeWorkerDb: () => Promise<void>;
let deps: RunnerDeps;
let stubTransport: StubTransport;
let stubSender: StubSender;
const intentsProvider = new StubPaymentProvider();

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = 'test-pepper-at-least-32-characters-long';
  process.env['REKODA_API_SECRET'] = 'test-secret-at-least-32-characters-long';
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  process.env['META_APP_SECRET'] = APP_SECRET;
  process.env['META_VERIFY_TOKEN'] = VERIFY_TOKEN;
  // 64 hex characters each, derived per run rather than written down.
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  delete process.env['NODE_ENV'];

  const { createApp } = await import('../main.js');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorkerDb } = createDb(urls.worker, { max: 2 }));
  const config: ApiConfig = loadConfig();
  stubTransport = StubTransport.answering({
    intent: 'Unclear',
    clarification: 'How many wigs?',
  });
  stubSender = new StubSender();
  deps = {
    gateway: new PrivacyGateway(db, config),
    interpreter: new Interpreter(db, config, stubTransport),
    replySender: new ReplySender(config, stubSender),
    // A real filesystem storage, not a mock: the render job's assertions are
    // about bytes actually landing somewhere and being readable back.
    storage: new LocalStorage(storageRoot),
    sender: stubSender,
    config,
    paymentProvider: new StubPaymentProvider(),
    paymentIntents: new PaymentIntentsService(config, db, intentsProvider),
  };
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await closeWorkerDb?.();
});

beforeEach(async () => {
  // `truncateAll` covers external_events — apps/api deliberately has no
  // `postgres` dependency, so the fixture reset is offered by @rekoda/db.
  await truncateAll(urls);
  // One stub is shared across this file, so its record of what was asked has
  // to be cleared too — otherwise "the model was never called" quietly means
  // "not called since the file started".
  stubTransport.reset();
  stubSender.reset();
  intentsProvider.reset();
});

function messagePayload(waId: string, wamid: string, text = 'Ada bought 3 wigs for 150k') {
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
              metadata: { phone_number_id: 'PNID' },
              messages: [
                {
                  id: wamid,
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

/** A delivery receipt: same envelope, `statuses` instead of `messages`. */
function invoiceCount(businessId: string): Promise<number> {
  return withBusiness(db, businessId, (tx) => issueRepo.invoiceCount(tx));
}

function statusPayload(recipientId: string, wamid: string, status: string) {
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
              metadata: { phone_number_id: 'PNID' },
              statuses: [{ id: wamid, status, recipient_id: recipientId }],
            },
          },
        ],
      },
    ],
  };
}

/** Sends exactly the bytes it signs — as Meta does. */
function post(payload: unknown, opts: { secret?: string; corrupt?: boolean } = {}) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', opts.secret ?? APP_SECRET)
    .update(raw, 'utf8')
    .digest('hex')}`;
  return app.inject({
    method: 'POST',
    url: '/webhooks/meta',
    payload: opts.corrupt ? `${raw} ` : raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
  });
}

describe('the subscription handshake', () => {
  it('echoes the challenge for the right token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('1158201444');
  });

  it('refuses the wrong token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('signature verification', () => {
  it('accepts a correctly signed payload', async () => {
    const res = await post(messagePayload('2348031234567', 'wamid.A1'));
    expect(res.statusCode).toBe(200);
    expect(await events.eventCount(db)).toBe(1);
  });

  it('rejects an unsigned payload and stores nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/meta',
      payload: JSON.stringify(messagePayload('2348031234567', 'wamid.A2')),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
    // The endpoint is unauthenticated and world-reachable. Persisting
    // unsigned payloads "for forensics" would be an unbounded write for
    // anyone who finds the URL.
    expect(await events.eventCount(db)).toBe(0);
  });

  it('rejects a payload signed with someone else key', async () => {
    const res = await post(messagePayload('2348031234567', 'wamid.A3'), { secret: 'not-ours' });
    expect(res.statusCode).toBe(401);
    expect(await events.eventCount(db)).toBe(0);
  });

  it('rejects a body altered in flight, even by one byte', async () => {
    const res = await post(messagePayload('2348031234567', 'wamid.A4'), { corrupt: true });
    expect(res.statusCode).toBe(401);
    expect(await events.eventCount(db)).toBe(0);
  });
});

describe('idempotency', () => {
  it('stores one row however many times Meta retries', async () => {
    const payload = messagePayload('2348031234567', 'wamid.RETRY');
    for (let i = 0; i < 4; i++) expect((await post(payload)).statusCode).toBe(200);
    expect(await events.eventCount(db)).toBe(1);
  });

  it('holds under CONCURRENT delivery of the same message', async () => {
    // Meta retries in parallel. A select-then-insert loses this race and
    // records the same sale twice — the failure the unique constraint exists
    // to make impossible.
    const payload = messagePayload('2348031234567', 'wamid.PARALLEL');
    const results = await Promise.all(Array.from({ length: 8 }, () => post(payload)));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(await events.eventCount(db)).toBe(1);
  });

  it('keeps sent, delivered and read apart', async () => {
    await post({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: 'wamid.S', status: 'sent' },
                  { id: 'wamid.S', status: 'delivered' },
                  { id: 'wamid.S', status: 'read' },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(await events.eventCount(db)).toBe(3);
  });
});

describe('tenant resolution', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('attributes a message to the sender business', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.OWNED'));

    const [row] = await events.unprocessedEvents(db, 'meta');
    expect(row?.businessId).toBe(business.id);
  });

  it('stores a stranger message unattributed rather than dropping it', async () => {
    // Someone messaging Rekoda who has no account is an ordinary event, and
    // the reply layer should be able to offer them a signup.
    await post(messagePayload('2349099999999', 'wamid.STRANGER'));
    const [row] = await events.unprocessedEvents(db, 'meta');
    expect(row).toBeDefined();
    expect(row?.businessId).toBeNull();
  });

  it('refuses to guess when a user has more than one business', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348031234567');
    await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    await identity.createBusinessWithOwner(db, {
      name: 'Ada Logistics',
      businessType: null,
      ownerUserId: user.id,
    });

    await post(messagePayload('2348031234567', 'wamid.AMBIGUOUS'));

    // Picking the first membership is a coin toss that could file a sale into
    // the wrong set of books. Unattributed, for a human to resolve.
    const [row] = await events.unprocessedEvents(db, 'meta');
    expect(row?.businessId).toBeNull();
  });
});

describe('what happens after the 200', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('queues the message for a worker rather than processing it inline', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.QUEUED'));

    const queued = await withBusiness(db, business.id, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: 'inbound.message', state: 'pending' });
  });

  it('runs that job and closes the event out', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.QUEUED'));

    // The registry the deploy uses, not a test-local one.
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    // `unprocessedEvents` is the backlog. Empty means the loop closed.
    expect(await events.unprocessedEvents(db, 'meta')).toHaveLength(0);
    const [job] = await withBusiness(db, business.id, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(job).toMatchObject({ state: 'done' });
  });

  it('queues nothing for a stranger — there is no tenant to run as', async () => {
    await post(messagePayload('2349099999999', 'wamid.STRANGER'));
    // `jobs.business_id` is NOT NULL, so "run this for nobody" is not
    // expressible. The event is still stored for the reply layer.
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(false);
  });

  it('queues nothing for a delivery receipt — there is nothing to understand', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(statusPayload('2348031234567', 'wamid.SENT', 'delivered'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(false);
  });

  it('queues ONE job when Meta delivers the same message eight times', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await Promise.all(
      Array.from({ length: 8 }, () => post(messagePayload('2348031234567', 'wamid.RETRIED'))),
    );

    // Two independent guards have to hold at once here: the unique index on
    // (provider, external_id), and the singleton key on the job. Recording a
    // sale twice is the failure this whole path exists to prevent.
    const queued = await withBusiness(db, business.id, (tx) => jobsRepo.jobsForBusiness(tx));
    expect(queued).toHaveLength(1);
  });
});

describe('nothing raw is stored', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('seals the webhook payload — the message text never lands in plaintext', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(
      messagePayload('2348031234567', 'wamid.SEALED', 'Ada 08039998888 bought 3 wigs for 150k'),
    );

    const [row] = await events.unprocessedEvents(db, 'meta');
    const stored = JSON.stringify(row?.payload);

    /**
     * `external_events` is the one table with row-level security deliberately
     * off, because an event arrives before its tenant is known. Storing a Meta
     * body verbatim therefore put the merchant's message AND the sender's
     * number in plaintext in the least protected table in the schema — while
     * the table's own comment claimed PII was redacted at write time.
     */
    expect(stored).not.toContain('bought 3 wigs');
    expect(stored).not.toContain('08039998888');
    expect(stored).not.toContain('2348031234567');
    expect(stored).toContain('sealed');
  });

  it('records a DETERMINISTIC message as its classification, not its words', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.YES', 'yes please'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    const messages = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    // Inbound plus the reply it earned. The inbound one is what this asserts.
    expect(messages[0]).toMatchObject({ direction: 'inbound', body: '[affirm]' });

    // And the gateway never ran: no customer, no vault write, nothing left.
    const customers = await withBusiness(db, business.id, (tx) =>
      tx.select().from(schema.customers),
    );
    expect(customers).toHaveLength(0);
  });

  it('records everything else TOKENISED', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.SALE', 'Ada 08039998888 bought 3 wigs'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    const [message] = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    expect(message!.body).not.toContain('08039998888');
    expect(message!.body).toMatch(/CUSTOMER_[0-9A-Z]{3}/);
    // The goods and the count survive — they are the whole point of the message.
    expect(message!.body).toContain('3 wigs');
  });

  it('writes one conversation row when the same message is delivered twice', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.ONCE', 'yes'));

    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true);
    // A reclaimed lock or a re-enqueued job must not double the history.
    await withBusiness(db, business.id, (tx) =>
      conversationsRepo.recordInbound(tx, {
        businessId: business.id,
        channel: 'meta',
        kind: 'text',
        body: '[affirm]',
        providerMessageId: 'wamid.ONCE',
      }),
    );

    const inbound = (
      await withBusiness(db, business.id, (tx) => conversationsRepo.messagesFor(tx, business.id))
    ).filter((m) => m.direction === 'inbound');
    expect(inbound).toHaveLength(1);
  });
});

describe('what the model understood', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('stores a draft for a message only the model could read', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.DRAFT', 'Ada 08039998888 bought 3 wigs'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    const drafts = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.draftsFor(tx, business.id),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ intent: 'Unclear', state: 'pending' });
    // The command holds tokens, because tokens are all the model ever saw.
    expect(JSON.stringify(drafts[0]!.command)).not.toContain('08039998888');
  });

  it('does NOT call a model for a message the router already answered', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.CHEAP', 'good morning'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    // No request, no draft, no usage row, no naira spent.
    expect(stubTransport.requests).toHaveLength(0);
    const drafts = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.draftsFor(tx, business.id),
    );
    expect(drafts).toHaveLength(0);
    // Scoped to anthropic: the outbound reply writes its own usage row, and
    // "no AI spend" is a different claim from "no cost at all".
    const spend = await withBusiness(db, business.id, (tx) =>
      quotaRepo.usageTotals(tx, 'anthropic'),
    );
    expect(spend.calls).toBe(0);
  });

  it('does not pay twice for one sentence when the job runs again', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.ONCE', 'Ada bought 3 wigs'));

    // Captured before the run, because running it marks the event handled.
    const [event] = await events.unprocessedEvents(db, 'meta');
    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true);
    expect(stubTransport.requests).toHaveLength(1);

    /**
     * Exactly what a reclaimed lock produces: the same event, queued again.
     * `recordInbound` reports `isNew: false` the second time, which is what
     * stops the model being paid for a sentence it has already read.
     */
    await withBusiness(db, business.id, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId: business.id,
        kind: 'inbound.message',
        payload: { eventId: event!.id },
      }),
    );
    expect(await runner.runOnce()).toBe(true);

    expect(stubTransport.requests).toHaveLength(1);
    const drafts = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.draftsFor(tx, business.id),
    );
    expect(drafts).toHaveLength(1);
  });
});

describe('answering the merchant', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('answers a greeting without a model, a vault write, or a naira', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.HI', 'good morning'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.sent).toHaveLength(1);
    expect(stubSender.lastText).toMatch(/I keep your books/i);
    expect(stubTransport.requests).toHaveLength(0);

    // The reply is on record too, so an undelivered one is findable.
    const messages = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    expect(messages.map((m) => m.direction)).toEqual(['inbound', 'outbound']);
  });

  it('tells a merchant plainly when there is nothing to say yes to', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.YES', 'yes'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /**
     * Before the gates landed this was silence, because "yes" answers a
     * question and there was none to answer. Now that a draft can exist, a
     * "yes" with none pending is a real state worth naming — and the reply
     * says what WOULD produce something to confirm.
     */
    expect(stubSender.lastText).toMatch(/nothing waiting for a yes/i);
    expect(stubSender.lastText).toMatch(/tell me a sale/i);
  });

  it('answers the debtor question from rows, never an invented figure', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.OWES', 'who owes me'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    // A book with no invoices has exactly one honest answer, and it carries
    // no figure at all. A bookkeeping assistant that makes up a debtor list
    // has destroyed the only thing it sells.
    expect(stubSender.lastText).toContain('Nobody owes you right now');
    expect(stubSender.lastText).not.toMatch(/₦/);
  });

  it('passes the model`s clarifying question through as written', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.ASK', 'Ada bought wigs'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toBe('How many wigs?');
  });

  it('answers once when the same message is delivered twice', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.TWICE', 'good morning'));

    const [event] = await events.unprocessedEvents(db, 'meta');
    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true);

    await withBusiness(db, business.id, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId: business.id,
        kind: 'inbound.message',
        payload: { eventId: event!.id },
      }),
    );
    expect(await runner.runOnce()).toBe(true);

    // One reply per retry is how a bug becomes a nuisance the merchant feels.
    expect(stubSender.sent).toHaveLength(1);
  });

  it('keeps the record when the reply cannot be delivered', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.DOWN', 'good morning'));
    stubSender.failWith();

    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    /**
     * Failing the job over an undelivered reply would roll the merchant's
     * message back and re-read it from scratch on the retry — paying for the
     * model twice to fix a delivery problem.
     */
    const messages = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    expect(messages).toHaveLength(2);
    // No provider id: a reply we owed and did not deliver, and findable as one.
    expect(messages[1]).toMatchObject({ direction: 'outbound', providerMessageId: null });
  });
});

describe("the plan's own example, end to end", () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  const THE_SALE = {
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

  /**
   * Post a message and DRAIN the queue, which is what a real worker does.
   *
   * A single `runOnce()` was enough until issuing began enqueuing a render
   * job: the runner takes the oldest due job, so the render would be claimed
   * ahead of the next inbound message and the conversation would silently stop
   * advancing. The test failed in exactly that way, which is the right way for
   * it to fail.
   */
  async function send(text: string, wamid: string) {
    await post(messagePayload('2348031234567', wamid, text));
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    expect(worked).toBe(true);
    while (worked) worked = await runner.runOnce();
  }

  it('turns a WhatsApp message into a confirmed, balanced, numbered record', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);

    // 1. The sale. CG2: previewed, not saved.
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');
    expect(stubSender.lastText).toContain('Please check this before I save it');
    expect(stubSender.lastText).toContain('Total: ₦150,000');
    expect(stubSender.lastText).toContain('Balance: ₦50,000');

    // Nothing issued yet — that is the entire point of the gate.
    expect(await invoiceCount(business.id)).toBe(0);

    // 2. The yes. CG3 claims the draft and the engine issues.
    await send('yes', 'wamid.YES');
    expect(stubSender.lastText).toMatch(/Saved ✅ INV-\d{4}-000001 for ₦150,000/);
    expect(stubSender.lastText).toContain('₦50,000 still owed');

    expect(await invoiceCount(business.id)).toBe(1);

    // 3. The books balance, read back out of the database.
    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    const debits = entries.reduce((n, e) => n + e.debitK, 0);
    const credits = entries.reduce((n, e) => n + e.creditK, 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(15_000_000);
  });

  it('renders and stores the PDF, and it opens', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');
    await send('yes', 'wamid.YES');

    // Issuing enqueues the render inside the same transaction, so draining the
    // queue after the confirmation is all it takes.
    const stored = await withBusiness(db, business.id, (tx) =>
      issueRepo.documentsFor(tx, business.id),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: 'invoice_pdf', refNumber: 'INV-2026-000001' });

    // The key is unguessable — a sequential one would let anyone holding one
    // document's URL walk the merchant's whole sales history by counting.
    expect(stored[0]!.storageKey).toMatch(
      new RegExp(`^documents/${business.id}/invoice_pdf/[0-9a-f]{32}\\.pdf$`),
    );

    // And the bytes are really there, and really a PDF.
    const bytes = await deps.storage.get(stored[0]!.storageKey);
    expect(bytes).not.toBeNull();
    expect(bytes!.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes!.length).toBe(stored[0]!.bytes);
  });

  it('DELIVERS the document to the merchant', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');
    await send('yes', 'wamid.YES');

    /**
     * The M2 exit criterion, end to end: a message became a confirmed record
     * and the merchant received the paper for it.
     */
    expect(stubSender.documents).toHaveLength(1);
    const sent = stubSender.lastDocument!;

    // Named so a merchant can find it again in three weeks, not by a uuid.
    expect(sent.filename).toBe('INV-2026-000001.pdf');
    expect(sent.contentType).toBe('application/pdf');
    expect(sent.to).toBe('+2348031234567');
    expect(sent.caption).toContain('INV-2026-000001');

    // The real bytes, not a link — a link would need the PDF to be publicly
    // reachable, which is what the unguessable key exists to avoid.
    expect(sent.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // And the merchant's history shows what they actually received.
    const messages = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    expect(messages.some((m) => m.kind === 'media' && m.direction === 'outbound')).toBe(true);
  });

  it('retries delivery rather than losing the document', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');

    // Meta is down at the moment the document is ready. Targeted at documents
    // specifically: a one-shot failure would be consumed by the text reply
    // that precedes it, and the delivery would then succeed.
    stubSender.failDocumentsWith();
    await post(messagePayload('2348031234567', 'wamid.YES', 'yes'));
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();

    expect(stubSender.documents).toHaveLength(0);

    /**
     * A failed reply is swallowed; a failed DELIVERY is not. The reply is a
     * sentence the merchant misses — the document is the thing they asked for,
     * and the PDF already exists in storage, so a retry is cheap and is the
     * only way they ever get it.
     */
    const queued = await withBusiness(db, business.id, (tx) =>
      jobsRepo.jobsForBusiness(tx, 'document.deliver'),
    );
    expect(queued[0]).toMatchObject({ state: 'pending', attempts: 1 });

    // The invoice and its PDF survived the delivery failure untouched.
    expect(await invoiceCount(business.id)).toBe(1);
    const stored = await withBusiness(db, business.id, (tx) =>
      issueRepo.documentsFor(tx, business.id),
    );
    expect(stored).toHaveLength(1);
  });

  it('does not render two PDFs for one sale', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');
    await send('yes', 'wamid.YES');

    // A second yes finds nothing pending (CG3), so nothing is issued and no
    // second render is enqueued. Two PDFs with two storage keys for one sale
    // is a document a customer could be shown twice at different URLs.
    await send('yes', 'wamid.YES2');

    const stored = await withBusiness(db, business.id, (tx) =>
      issueRepo.documentsFor(tx, business.id),
    );
    expect(stored).toHaveLength(1);
  });

  it('does not issue TWICE when the merchant taps yes twice', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');

    await send('yes', 'wamid.YES1');
    await send('yes', 'wamid.YES2');

    // CG3. On WhatsApp a double-tap is not an edge case, it is Tuesday.
    expect(await invoiceCount(business.id)).toBe(1);
    // And the second yes is told the truth rather than apologised to.
    expect(stubSender.lastText).toMatch(/nothing waiting for a yes|already saving/i);
  });

  it('questions an arithmetic mismatch instead of previewing it', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith({ ...THE_SALE, statedTotal: 120_000, reportedPayment: null });

    await send('Ada bought 3 wigs, total 120k', 'wamid.ODD');

    // CG1 before CG2: a preview of numbers we know are wrong is a request to
    // approve a mistake.
    expect(stubSender.lastText).toContain('do not add up');
    expect(stubSender.lastText).toContain('₦30,000');
    expect(stubSender.lastText).not.toContain('Please check this before I save it');
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('lets a correction replace the draft before anything is issued', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');

    // CG5 — "no, 4 not 3" re-runs the draft rather than mutating anything.
    stubTransport.replyWith({
      ...THE_SALE,
      items: [{ name: 'wig', quantity: 4, unitPrice: 50_000 }],
      statedTotal: 200_000,
    });
    await send('no, 4 not 3', 'wamid.FIX');
    expect(stubSender.lastText).toContain('replaced the earlier version');
    expect(stubSender.lastText).toContain('Total: ₦200,000');

    await send('yes', 'wamid.YES');

    // One invoice, for the CORRECTED figure. Confirming the superseded draft
    // would be the failure CG5 exists to prevent.
    expect(await invoiceCount(business.id)).toBe(1);
    const rows = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.draftsFor(tx, business.id),
    );
    expect(rows.map((r) => r.state).sort()).toEqual(['confirmed', 'superseded']);
  });

  it('discards the draft when the merchant says no', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.SALE');

    await send('no', 'wamid.NO');
    expect(stubSender.lastText).toMatch(/cancelled/i);

    // A discarded draft must not be confirmable by an accidental yes later.
    await send('yes', 'wamid.LATE');
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('closes an exhausted month with a doorway, not a wall (metering-v1 §3)', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const allowance = PLAN_ALLOWANCES.trial.messages;
    // The whole trial allowance, spent the atomic way fifty messages would.
    await withBusiness(db, business.id, (tx) =>
      usageRepo.consumeUnit(
        tx,
        business.id,
        usagePeriod(new Date()),
        'messages',
        allowance,
        allowance,
      ),
    );

    stubTransport.replyWith(THE_SALE);
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.EXHAUSTED');

    // Three things, exactly: what ran out, nothing lost, two doors forward.
    expect(stubSender.lastText).toContain(`used all ${allowance} messages`);
    expect(stubSender.lastText).toContain('who owes me');
    expect(stubSender.lastText).toContain('upgrade');
    // And the model was never paid for a refused message.
    expect(stubTransport.requests).toHaveLength(0);

    // Reading stays free FOREVER at zero units — the router tier is not metered.
    await send('help', 'wamid.STILLFREE');
    expect(stubSender.lastText).toContain('Record a sale');
  });

  it('refunds the unit when Rekoda failed, not the merchant (metering-v1)', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    // A reply the border checkpoint rejects: the model ran, Rekoda paid,
    // the merchant got nothing. Their meter must not move.
    stubTransport.replyWith({ intent: 'SomethingUnparseable' });
    await send('Ada bought 3 wigs for 150k, paid 100k', 'wamid.UNUSABLE');
    expect(stubSender.lastText).toContain('could not turn that into a record');

    const rows = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, usagePeriod(new Date())),
    );
    expect(rows[0]?.used ?? 0).toBe(0);
  });

  it('records an EXPENSE the same way: previewed, confirmed, balanced', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith({
      intent: 'RecordExpense',
      description: 'fuel for generator',
      amount: 12_000,
      category: 'utilities',
      paymentMethod: 'cash',
    });

    // CG2: previewed, nothing in the books yet.
    await send('bought fuel for the gen, 12k', 'wamid.EXP');
    expect(stubSender.lastText).toContain('Expense: fuel for generator');
    expect(stubSender.lastText).toContain('*Amount: ₦12,000*');
    expect(
      await withBusiness(db, business.id, (tx) => spendRepo.expensesFor(tx, business.id)),
    ).toHaveLength(0);

    // The yes. Row + posting land together; the reply claims books, not paper.
    await send('yes', 'wamid.EXPYES');
    expect(stubSender.lastText).toContain('Saved ✅ ₦12,000 expense: fuel for generator');

    const rows = await withBusiness(db, business.id, (tx) =>
      spendRepo.expensesFor(tx, business.id),
    );
    expect(rows).toHaveLength(1);
    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'EXPENSES', debitK: 1_200_000 }),
    );
    const debits = entries.reduce((n, e) => n + e.debitK, 0);
    expect(debits).toBe(entries.reduce((n, e) => n + e.creditK, 0));
  });

  it('records a stock purchase on credit and says what is still owed', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    stubTransport.replyWith({
      intent: 'RecordPurchase',
      supplierMention: 'Mama Nkechi',
      description: 'ankara fabric',
      amount: 50_000,
      reportedPayment: 20_000,
    });

    await send('bought ankara from Mama Nkechi 50k, paid 20k', 'wamid.PUR');
    expect(stubSender.lastText).toContain('Owing to supplier: ₦30,000');

    await send('yes', 'wamid.PURYES');
    expect(stubSender.lastText).toContain('Saved ✅ ₦50,000 stock purchase');
    expect(stubSender.lastText).toContain('₦30,000 still owed to your supplier');

    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'INVENTORY', debitK: 5_000_000 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'ACCOUNTS_PAYABLE', creditK: 3_000_000 }),
    );

    /* The supplier's NAME stops at the preview: the merchant confirmed it on
     * WhatsApp, and the books keep the stock, not the person (spend.ts). */
    const rows = await withBusiness(db, business.id, (tx) =>
      spendRepo.expensesFor(tx, business.id),
    );
    expect(rows[0]?.description).toBe('ankara fabric');
    expect(JSON.stringify(rows)).not.toContain('Nkechi');
  });
});

describe('collecting money from chat (payments-v1 §160)', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  async function send(text: string, wamid: string) {
    await post(messagePayload('2348031234567', wamid, text));
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    expect(worked).toBe(true);
    while (worked) worked = await runner.runOnce();
  }

  async function activeConnection(businessId: string) {
    await withBusiness(db, businessId, async (tx) => {
      const connection = await paymentsHub.upsertConnection(tx, {
        businessId,
        providerType: 'paystack',
        settlementAccountLast4: '4821',
      });
      await paymentsHub.setConnectionState(tx, connection.id, {
        status: 'active',
        externalSubaccountId: 'ACCT_live1',
      });
    });
  }

  /** An open ₦80,000 invoice for a customer whose email is on file. */
  async function openInvoiceWithEmail(businessId: string, config: ApiConfig) {
    const customer = await customersRepo.createCustomerWithIdentities(db, businessId, 'X81', [
      {
        facet: 'phone',
        ciphertext: encryptFacet('+2348039998888', config.vaultKey),
        matchKey: matchKeyFor(businessId, 'phone', '+2348039998888', config.matchKey),
      },
      {
        facet: 'email',
        ciphertext: encryptFacet('adaeze@example.com', config.vaultKey),
        matchKey: null,
      },
    ]);
    return withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: customer.id,
        customerToken: 'CUSTOMER_X81',
        items: [{ name: 'gown', quantity: 1, unitPriceK: 8_000_000 }],
        subtotalK: 8_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 8_000_000,
        paidK: 0,
        balanceDueK: 8_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-pay',
        actor: 'system',
      }),
    );
  }

  it('who owes me answers from the ledger: numbers, totals, no names', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await openInvoiceWithEmail(business.id, deps.config);

    await send('who owes me', 'wamid.OWES');
    expect(stubSender.lastText).toContain('One invoice is unpaid: ₦80,000 owed to you');
    expect(stubSender.lastText).toMatch(/INV-\d{4}-000001: ₦80,000/);
    expect(stubSender.lastText).not.toContain('CUSTOMER_X81');
  });

  it('payment details with an active connection returns a forwardable link', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await activeConnection(business.id);
    await openInvoiceWithEmail(business.id, deps.config);

    await send('send payment link', 'wamid.PAY1');
    expect(stubSender.lastText).toMatch(/Payment link for INV-\d{4}-000001: ₦80,000 outstanding/);
    expect(stubSender.lastText).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);
  });

  it('payment details without a connection points at onboarding, never a dead link', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await openInvoiceWithEmail(business.id, deps.config);

    await send('payment details', 'wamid.PAY2');
    expect(stubSender.lastText).toContain('add your settlement account');
    expect(stubSender.lastText).not.toContain('http');
  });

  it('a provider outage degrades to an honest sentence, and the next try works', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await activeConnection(business.id);
    await openInvoiceWithEmail(business.id, deps.config);

    intentsProvider.failNextInitializeWith(new Error('Paystack is down'));
    await send('payment details', 'wamid.PAYDOWN');
    expect(stubSender.lastText).toContain('could not reach your payment provider');
    expect(stubSender.lastText).not.toContain('http');

    // The job completed rather than dying in retries, so the next ask succeeds.
    await send('payment details', 'wamid.PAYUP');
    expect(stubSender.lastText).toMatch(/https:\/\/checkout\.stub\/RKD-PAY-/);
  });

  it('payment details with nothing owed says so', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await send('payment details', 'wamid.PAY3');
    expect(stubSender.lastText).toContain('nothing to collect');
  });
});

describe('acknowledging things we cannot use', () => {
  it('answers 200 to a payload whose shape we do not recognise', async () => {
    // Meta retries anything else, escalating until it disables the webhook.
    const res = await post({ object: 'whatsapp_business_account', entry: 'not-an-array' });
    expect(res.statusCode).toBe(200);
    expect(await events.eventCount(db)).toBe(0);
  });

  it('answers 200 to an empty envelope', async () => {
    expect((await post({ entry: [] })).statusCode).toBe(200);
  });
});

describe('records, resend and messages Rekoda cannot read', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  function audioPayload(waId: string, wamid: string) {
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
                metadata: { phone_number_id: 'PNID' },
                messages: [{ id: wamid, from: waId, timestamp: '1700000000', type: 'audio' }],
              },
            },
          ],
        },
      ],
    };
  }

  it('answers "records" with real month figures and no model call', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await withBusiness(db, business.id, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId: business.id,
        description: 'fuel',
        category: null,
        amountK: 1_200_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'd-rec',
      }),
    );
    await post(messagePayload('2348031234567', 'wamid.REC', 'records'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('Your books this month');
    expect(stubSender.lastText).toContain('Money out ₦12,000');
    expect(stubTransport.requests).toHaveLength(0);
  });

  it('says the books are empty rather than reciting four zeros', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.REC0', 'records'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('Nothing in your books yet this month');
    expect(stubSender.lastText).not.toMatch(/₦/);
  });

  it('"resend" queues the newest document back through delivery, exactly once', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const doc = await withBusiness(db, business.id, (tx) =>
      issueRepo.recordDocument(tx, {
        businessId: business.id,
        kind: 'invoice_pdf',
        storageKey: 'test/unguessable-1',
        refNumber: 'INV-2026-000007',
        bytes: 1234,
      }),
    );

    await post(messagePayload('2348031234567', 'wamid.RESEND', 'resend'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('Sending INV-2026-000007 again');

    const queued = await withBusiness(db, business.id, (tx) =>
      jobsRepo.jobsForBusiness(tx, 'document.deliver'),
    );
    expect(queued).toHaveLength(1);
    expect(doc.id).toBeTruthy();
  });

  it('"resend" with nothing ever issued is an honest miss', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.RESEND0', 'resend'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('no document to resend yet');
  });

  it('a voice note gets an honest sentence, never a model call on silence', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(audioPayload('2348031234567', 'wamid.VOICE'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('only read typed messages');
    // The whole point: silence never becomes a paid interpretation call.
    expect(stubTransport.requests).toHaveLength(0);

    const messages = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    // Recorded as what it was, not as empty text.
    expect(messages[0]?.body).toBe('[audio message]');
  });
});

describe('consent (STOP/START) and erasure, as facts not sentences', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  it('STOP persists, suppresses proactive deliveries, and START undoes it', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');

    await post(messagePayload('2348031234567', 'wamid.STOP1', 'stop'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('I will not message you again');
    expect(await identity.optedOutAt(db, '+2348031234567')).not.toBeNull();

    // A receipt delivery — the proactive send class — goes nowhere now.
    await deps.storage.put('test/suppressed-1', Buffer.from('%PDF-fake'), 'application/pdf');
    const doc = await withBusiness(db, business.id, (tx) =>
      issueRepo.recordDocument(tx, {
        businessId: business.id,
        kind: 'receipt_pdf',
        storageKey: 'test/suppressed-1',
        refNumber: 'RCT-2026-000009',
        bytes: 9,
      }),
    );
    await withBusiness(db, business.id, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId: business.id,
        kind: 'document.deliver',
        payload: { documentId: doc.id },
        singletonKey: `deliver:${doc.id}`,
      }),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.documents).toHaveLength(0);

    // START clears the flag; the same delivery class flows again.
    await post(messagePayload('2348031234567', 'wamid.START1', 'start'));
    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true);
    expect(await identity.optedOutAt(db, '+2348031234567')).toBeNull();
  });

  it('an explicit resend still delivers to an opted-out merchant — they asked', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await identity.setOptOut(db, '+2348031234567', new Date());

    await deps.storage.put('test/resend-1', Buffer.from('%PDF-fake'), 'application/pdf');
    await withBusiness(db, business.id, (tx) =>
      issueRepo.recordDocument(tx, {
        businessId: business.id,
        kind: 'invoice_pdf',
        storageKey: 'test/resend-1',
        refNumber: 'INV-2026-000011',
        bytes: 9,
      }),
    );

    await post(messagePayload('2348031234567', 'wamid.RESENDOPT', 'resend'));
    const runner = buildRunner(workerDb, db, deps);
    expect(await runner.runOnce()).toBe(true); // the inbound command
    expect(await runner.runOnce()).toBe(true); // the delivery it queued
    expect(stubSender.documents).toHaveLength(1);
    expect(stubSender.lastDocument?.filename).toBe('INV-2026-000011.pdf');
  });

  it('erasure takes two exact asks, deletes every identity facet, and says how many', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T1',
      [
        { facet: 'name', ciphertext: 'sealed-name', matchKey: 'mk-name' },
        { facet: 'phone', ciphertext: 'sealed-phone', matchKey: 'mk-phone' },
      ],
    );

    await post(messagePayload('2348031234567', 'wamid.DEL1', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');

    await post(messagePayload('2348031234567', 'wamid.DEL2', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('deleted (2 records)');

    const left = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(left).toEqual([]);
  });

  /**
   * Owner only. This deletes every customer's contact details for the whole
   * business in one irreversible statement, which is not a thing an
   * accountant or a delegate should be able to do from a phone.
   */
  it('refuses erasure from a member who is not the owner', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const accountant = await identity.upsertUserByPhone(db, '+2348039990001');
    await identity.addMembership(db, business.id, accountant.id, 'accountant');
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T9',
      [{ facet: 'name', ciphertext: 'sealed-name', matchKey: 'mk-name-9' }],
    );

    await post(messagePayload('2348039990001', 'wamid.DELX', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('Only the business owner can delete');
    const left = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(left).toHaveLength(1);
  });

  /**
   * Asking to erase clears whatever was waiting for a yes, and the merchant
   * has to be told: a sale they previewed a minute ago silently vanishing is
   * how a shop ends up with a day's takings unrecorded.
   */
  it('says so when the erasure ask discards an entry waiting for a yes', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');

    stubTransport.replyWith({
      intent: 'RecordSale',
      customer: { kind: 'token', token: 'CUSTOMER_7K2' },
      items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
      statedTotal: 150_000,
      reportedPayment: 0,
      paymentMethod: 'transfer',
      discount: null,
      deliveryFee: null,
      dueDescription: null,
    });
    await post(messagePayload('2348031234567', 'wamid.DELD1', 'Ada bought 3 wigs for 150k'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('Reply *yes*');

    await post(messagePayload('2348031234567', 'wamid.DELD2', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('waiting for your yes has been dropped');
  });

  it('a "yes" after the erasure prompt keeps everything — only the phrase confirms', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      business.id,
      'CUSTOMER_T2',
      [{ facet: 'name', ciphertext: 'sealed', matchKey: 'mk' }],
    );

    await post(messagePayload('2348031234567', 'wamid.DEL3', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    await post(messagePayload('2348031234567', 'wamid.DELYES', 'yes'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('Kept');
    const left = await withBusiness(db, business.id, (tx) =>
      customersRepo.identityFacetsFor(tx, business.id, customer.id),
    );
    expect(left).toHaveLength(1);

    // And the claimed draft cannot be resurrected: a fresh ask starts over.
    await post(messagePayload('2348031234567', 'wamid.DEL4', 'delete my data'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('Reply *DELETE MY DATA* again');
  });
});

describe('the trial clock and the upgrade door', () => {
  async function seedMerchant(phone: string, name: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, { name, businessType: null, ownerUserId: user.id });
  }

  /** Age the trial past its date, as thirty days would. */
  async function expireTrial(businessId: string) {
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'trial',
      expiresAt: new Date(Date.now() - 1_000),
      actor: 'operator:test-clock',
    });
  }

  it('tells an expired trial the truth, and spends no model call doing it', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await expireTrial(business.id);

    await post(messagePayload('2348031234567', 'wamid.EXP1', 'Ada bought 3 wigs for 150k'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('30-day free trial has ended');
    expect(stubSender.lastText).toContain('Reply *upgrade*');
    // The gate runs before the model: an expired trial costs nothing.
    expect(stubTransport.requests).toHaveLength(0);
  });

  it('still answers the free read commands after the trial ends', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await expireTrial(business.id);

    await post(messagePayload('2348031234567', 'wamid.EXP2', 'who owes me'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    // Reading is never gated — the books stay theirs.
    expect(stubSender.lastText).toContain('Nobody owes you right now');
  });

  it('records an upgrade request from chat and answers a human, not a dead link', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await expireTrial(business.id);

    await post(messagePayload('2348031234567', 'wamid.UPG1', 'upgrade'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('upgrade request');
    expect(stubSender.lastText).not.toContain('rekoda.app/pricing');

    const requests = await withBusiness(db, business.id, (tx) =>
      billingRepo.upgradeRequestsFor(tx, business.id),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.fromPlan).toBe('expired');
  });

  it('recording works again the moment an operator moves them onto a plan', async () => {
    const business = await seedMerchant('+2348031234567', 'Ada Fashion');
    await expireTrial(business.id);

    await billingRepo.setPlan(db, {
      businessId: business.id,
      plan: 'chat',
      expiresAt: new Date(Date.now() + 31 * 86_400_000),
      actor: 'operator:test',
    });

    await post(messagePayload('2348031234567', 'wamid.AFTER', 'Ada bought 3 wigs for 150k'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    // Back to the ordinary path: the model ran and a preview came back.
    expect(stubTransport.requests).toHaveLength(1);
    expect(stubSender.lastText).not.toContain('trial has ended');
  });
});

describe('metering the things that cost money', () => {
  /** A sale the stub will hand back, so the confirm path is reached. */
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

  it('spends a documents unit per invoice, and refuses between transactions when they run out', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348031234567');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });

    // Burn the trial's 25 documents, leaving the allowance exactly spent.
    const period = usagePeriod(new Date());
    await withBusiness(db, business.id, (tx) =>
      usageRepo.consumeUnit(tx, business.id, period, 'documents', 25, 25),
    );

    stubTransport.replyWith(A_SALE);
    await post(messagePayload('2348031234567', 'wamid.DOC1', 'Ada bought 3 wigs for 150k'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    // The preview still happens: the message unit paid for reading it.
    expect(stubSender.lastText).toContain('Reply *yes*');

    await post(messagePayload('2348031234567', 'wamid.DOC2', 'yes'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    expect(stubSender.lastText).toContain('invoices and receipts');
    expect(stubSender.lastText).toContain('Reply *upgrade*');
    // Nothing was booked: the refusal happened BEFORE the sale, so the
    // merchant lost neither the sale nor the draft.
    expect(await invoiceCount(business.id)).toBe(0);
  });

  it('records the Meta media cost when a document is delivered', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348031234567');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });

    await deps.storage.put('test/cost-1', Buffer.from('%PDF-fake'), 'application/pdf');
    const doc = await withBusiness(db, business.id, (tx) =>
      issueRepo.recordDocument(tx, {
        businessId: business.id,
        kind: 'invoice_pdf',
        storageKey: 'test/cost-1',
        refNumber: 'INV-2026-000021',
        bytes: 9,
      }),
    );
    await withBusiness(db, business.id, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId: business.id,
        kind: 'document.deliver',
        payload: { documentId: doc.id },
        singletonKey: `deliver:${doc.id}`,
      }),
    );
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.documents).toHaveLength(1);

    /* Media is chargeable from 1 October 2026. The row has to exist NOW or
     * the repricing arrives with no baseline for the expensive class. */
    const totals = await withBusiness(db, business.id, (tx) => quotaRepo.usageTotals(tx, 'meta'));
    expect(totals.calls).toBeGreaterThanOrEqual(1);
  });
});

describe('a payment the merchant reports (RecordPayment)', () => {
  const A_SALE_FOR_PAYMENT = {
    intent: 'RecordSale',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    items: [{ name: 'wig', quantity: 3, unitPrice: 50_000 }],
    statedTotal: 150_000,
    reportedPayment: 0,
    paymentMethod: 'transfer',
    discount: null,
    deliveryFee: null,
    dueDescription: null,
  };

  const paymentOf = (over: Record<string, unknown>) => ({
    intent: 'RecordPayment',
    customer: { kind: 'token', token: 'CUSTOMER_7K2' },
    amount: null,
    relativeAmount: null,
    documentRef: null,
    paymentMethod: 'cash',
    ...over,
  });

  async function seedMerchant(phone: string) {
    const user = await identity.upsertUserByPhone(db, phone);
    return identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
  }

  /** Work the queue to empty, as a real worker does: issuing enqueues renders. */
  async function drain() {
    const runner = buildRunner(workerDb, db, deps);
    let worked = await runner.runOnce();
    while (worked) worked = await runner.runOnce();
  }

  /** Issue a ₦150,000 invoice with nothing paid, through the chat path. */
  async function issueUnpaidInvoice(wamid: string) {
    stubTransport.replyWith(A_SALE_FOR_PAYMENT);
    await post(messagePayload('2348031234567', `${wamid}-sale`, 'Ada bought 3 wigs for 150k'));
    await drain();
    await post(messagePayload('2348031234567', `${wamid}-yes`, 'yes'));
    await drain();
  }

  it('records a part payment, moves the ledger, and issues a receipt', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P1');

    stubTransport.replyWith(paymentOf({ amount: 60_000 }));
    await post(messagePayload('2348031234567', 'wamid.P1-pay', 'Ada paid 60k'));
    await drain();
    // CG2 first: money never moves on a preview.
    expect(stubSender.lastText).toContain('Payment on INV-');
    expect(stubSender.lastText).toContain('Still owing after this: ₦90,000');

    await post(messagePayload('2348031234567', 'wamid.P1-confirm', 'yes'));
    await drain();

    expect(stubSender.lastText).toContain('₦60,000 recorded against INV-');
    expect(stubSender.lastText).toContain('₦90,000 still owed');
    expect(stubSender.lastText).toContain('Receipt RCT-');

    const payments = await withBusiness(db, business.id, (tx) => settleRepo.paymentsFor(tx));
    expect(payments).toHaveLength(1);
    // RECORDED, never verified: no provider confirmed this (ADR 0014).
    expect(payments[0]?.verified).toBe(0);
    expect(payments[0]?.amountK).toBe(6_000_000);

    // The books balance, and the receivable came down by exactly the payment.
    const entries = await withBusiness(db, business.id, (tx) =>
      issueRepo.ledgerEntriesFor(tx, business.id),
    );
    const debits = entries.reduce((n, e) => n + e.debitK, 0);
    const credits = entries.reduce((n, e) => n + e.creditK, 0);
    expect(debits).toBe(credits);
    const arCredit = entries
      .filter((e) => e.account === 'ACCOUNTS_RECEIVABLE')
      .reduce((n, e) => n + e.creditK, 0);
    expect(arCredit).toBe(6_000_000);
  });

  it('resolves "the rest" against the real balance and settles the invoice', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P2');

    stubTransport.replyWith(paymentOf({ relativeAmount: 'remainder' }));
    await post(messagePayload('2348031234567', 'wamid.P2-pay', 'Ada paid the rest'));
    await drain();
    expect(stubSender.lastText).toContain('settles the invoice');

    await post(messagePayload('2348031234567', 'wamid.P2-confirm', 'yes'));
    await drain();
    expect(stubSender.lastText).toContain('That settles it');

    const invoices = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    expect(invoices.rows[0]?.status).toBe('paid');
    expect(invoices.outstandingK).toBe(0);
  });

  it('refuses to absorb more than the invoice owes, and asks instead', async () => {
    await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P3');

    stubTransport.replyWith(paymentOf({ amount: 400_000 }));
    await post(messagePayload('2348031234567', 'wamid.P3-pay', 'Ada paid 400k'));
    await drain();

    // A question, not a preview: an overpayment is a real event a merchant
    // decides, never something the books quietly round away.
    expect(stubSender.lastText).toContain('only has ₦150,000 owing');
    expect(stubSender.lastText).not.toContain('Reply *yes*');
  });

  it('never invents an allocation when nothing is open', async () => {
    await seedMerchant('+2348031234567');

    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await post(messagePayload('2348031234567', 'wamid.P4-pay', 'Ada paid 20k'));
    await drain();

    expect(stubSender.lastText).toContain('could not find an unpaid invoice');
  });

  /**
   * The one that matters most on this whole path.
   *
   * A chat-issued invoice carries `customer_id = NULL` and keeps the customer
   * token in its snapshot, so resolving by a customer JOIN alone matched
   * nothing and fell through to "the newest open invoice at all" — which for
   * a shop that issues more than one invoice a day is somebody else's.
   */
  it('puts a named customer payment on THEIR invoice, not the newest one', async () => {
    const business = await seedMerchant('+2348031234567');
    // Ada first, then Bola. Bola's is newest, so a fallback would take it.
    await issueUnpaidInvoice('wamid.P5');
    stubTransport.replyWith({
      ...A_SALE_FOR_PAYMENT,
      customer: { kind: 'token', token: 'CUSTOMER_B9L' },
      items: [{ name: 'bag', quantity: 1, unitPrice: 80_000 }],
      statedTotal: 80_000,
    });
    await post(messagePayload('2348031234567', 'wamid.P5-sale2', 'Bola bought a bag for 80k'));
    await drain();
    await post(messagePayload('2348031234567', 'wamid.P5-yes2', 'yes'));
    await drain();

    const before = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    const adaInvoice = before.rows.find((r) => r.totalK === 15_000_000)!;
    const bolaInvoice = before.rows.find((r) => r.totalK === 8_000_000)!;

    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await post(messagePayload('2348031234567', 'wamid.P5-pay', 'Ada paid 20k'));
    await drain();
    expect(stubSender.lastText).toContain(`Payment on ${adaInvoice.invoiceNumber}`);

    await post(messagePayload('2348031234567', 'wamid.P5-confirm', 'yes'));
    await drain();

    const after = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    const ada = after.rows.find((r) => r.invoiceNumber === adaInvoice.invoiceNumber)!;
    const bola = after.rows.find((r) => r.invoiceNumber === bolaInvoice.invoiceNumber)!;
    expect(ada.paidK).toBe(2_000_000);
    // Bola never paid anything, and nothing may say otherwise.
    expect(bola.paidK).toBe(0);
    expect(bola.balanceDueK).toBe(8_000_000);
  });

  it('asks which invoice when nobody is named and several are open', async () => {
    await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P6');
    stubTransport.replyWith({
      ...A_SALE_FOR_PAYMENT,
      customer: { kind: 'token', token: 'CUSTOMER_B9L' },
      items: [{ name: 'bag', quantity: 1, unitPrice: 80_000 }],
      statedTotal: 80_000,
    });
    await post(messagePayload('2348031234567', 'wamid.P6-sale2', 'Bola bought a bag for 80k'));
    await drain();
    await post(messagePayload('2348031234567', 'wamid.P6-yes2', 'yes'));
    await drain();

    stubTransport.replyWith(paymentOf({ amount: 20_000, customer: { kind: 'none' } }));
    await post(messagePayload('2348031234567', 'wamid.P6-pay', 'received 20k'));
    await drain();

    expect(stubSender.lastText).toContain('2 unpaid invoices open');
    expect(stubSender.lastText).not.toContain('Reply *yes*');
  });

  it('says so rather than guessing when the named customer owes nothing', async () => {
    await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P7');

    stubTransport.replyWith(
      paymentOf({ amount: 20_000, customer: { kind: 'token', token: 'CUSTOMER_ZZZ' } }),
    );
    await post(messagePayload('2348031234567', 'wamid.P7-pay', 'Ngozi paid 20k'));
    await drain();

    expect(stubSender.lastText).toContain('could not find an unpaid invoice');
  });

  it('takes the invoice number the merchant typed over the customer they named', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P8');
    const open = await withBusiness(db, business.id, (tx) =>
      reportsRepo.invoicesFor(tx, business.id, 10),
    );
    const number = open.rows[0]!.invoiceNumber;

    stubTransport.replyWith(
      paymentOf({
        amount: 20_000,
        documentRef: number,
        customer: { kind: 'token', token: 'CUSTOMER_ZZZ' },
      }),
    );
    await post(messagePayload('2348031234567', 'wamid.P8-pay', `${number} paid 20k`));
    await drain();

    expect(stubSender.lastText).toContain(`Payment on ${number}`);
  });

  it('refuses an invoice number that names nothing open, rather than falling back', async () => {
    await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.P9');

    stubTransport.replyWith(paymentOf({ amount: 20_000, documentRef: 'INV-2026-999999' }));
    await post(messagePayload('2348031234567', 'wamid.P9-pay', 'INV-2026-999999 paid 20k'));
    await drain();

    expect(stubSender.lastText).toContain('could not find an unpaid invoice');
  });

  /** Units used of one kind, or zero before the counter row exists. */
  const usedOf = (rows: Array<{ unit: string; used: number }>, unit: string) =>
    rows.find((r) => r.unit === unit)?.used ?? 0;

  /**
   * A receipt is a metered document, and the copy has always said so
   * ("invoices and receipts"). Recording a payment issues one, so it costs a
   * unit exactly like a sale does: leaving it free let a merchant on an
   * exhausted plan take receipts without limit.
   */
  it('spends a documents unit on the receipt a reported payment issues', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.PB');
    const period = usagePeriod(new Date());
    const before = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );

    stubTransport.replyWith(paymentOf({ amount: 60_000 }));
    await post(messagePayload('2348031234567', 'wamid.PB-pay', 'Ada paid 60k'));
    await drain();
    await post(messagePayload('2348031234567', 'wamid.PB-confirm', 'yes'));
    await drain();

    const after = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(usedOf(after, 'documents') - usedOf(before, 'documents')).toBe(1);
  });

  it('gives the unit back when the payment could not be placed', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.PC');
    const period = usagePeriod(new Date());

    // Preview against the real invoice, then let the invoice settle before
    // the yes lands: the message unit is spent, the receipt never issues.
    stubTransport.replyWith(paymentOf({ amount: 20_000 }));
    await post(messagePayload('2348031234567', 'wamid.PC-pay', 'Ada paid 20k'));
    await drain();

    const before = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    const open = await withBusiness(db, business.id, (tx) =>
      issueRepo.latestOpenInvoice(tx, business.id),
    );
    await withBusiness(db, business.id, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId: business.id,
        invoiceId: open!.id,
        amountK: 15_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'settled-elsewhere',
        actor: 'test',
      }),
    );

    await post(messagePayload('2348031234567', 'wamid.PC-confirm', 'yes'));
    await drain();

    expect(stubSender.lastText).toContain('could not find an unpaid invoice');
    const after = await withBusiness(db, business.id, (tx) =>
      usageRepo.usageFor(tx, business.id, period),
    );
    expect(usedOf(after, 'documents')).toBe(usedOf(before, 'documents'));
  });

  /**
   * The balance fell between the preview and the yes.
   *
   * The confirmation re-resolves the invoice and re-gates on the FRESH
   * balance, which is the whole reason it does not carry the preview's
   * figure forward: the merchant is asked before anything is attempted.
   * `BalanceMoved` in settle.ts guards the narrower race that remains,
   * between that read and the row lock, and refuses there too. Neither path
   * posts what fits and drops the rest, which would leave real money with no
   * story and only the merchant knows where it belongs.
   */
  it('asks rather than posting less when the invoice owes less than reported', async () => {
    const business = await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.PD');

    stubTransport.replyWith(paymentOf({ amount: 150_000 }));
    await post(messagePayload('2348031234567', 'wamid.PD-pay', 'Ada paid 150k'));
    await drain();
    expect(stubSender.lastText).toContain('Reply *yes*');

    // A transfer lands while the merchant is typing their confirmation.
    const open = await withBusiness(db, business.id, (tx) =>
      issueRepo.latestOpenInvoice(tx, business.id),
    );
    await withBusiness(db, business.id, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId: business.id,
        invoiceId: open!.id,
        amountK: 10_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'landed-meanwhile',
        actor: 'test',
      }),
    );

    await post(messagePayload('2348031234567', 'wamid.PD-confirm', 'yes'));
    await drain();

    expect(stubSender.lastText).toContain('only has ₦50,000 owing');
    expect(stubSender.lastText).toContain('you said ₦150,000');
    // A question, never a preview: nothing here invites another yes.
    expect(stubSender.lastText).not.toContain('Reply *yes*');

    // Exactly the one payment that really landed, and no second receipt.
    const payments = await withBusiness(db, business.id, (tx) => settleRepo.paymentsFor(tx));
    expect(payments).toHaveLength(1);
  });

  it('tells the customer on the receipt that the seller recorded it, not a provider', async () => {
    await seedMerchant('+2348031234567');
    await issueUnpaidInvoice('wamid.PA');

    stubTransport.replyWith(paymentOf({ amount: 60_000 }));
    await post(messagePayload('2348031234567', 'wamid.PA-pay', 'Ada paid 60k'));
    await drain();
    await post(messagePayload('2348031234567', 'wamid.PA-confirm', 'yes'));
    await drain();

    const receipt = stubSender.documents.at(-1);
    expect(receipt).toBeDefined();
    // The caption the merchant forwards must never borrow "confirmed".
    expect(receipt?.caption ?? '').not.toContain('confirmed');
    expect(receipt?.caption ?? '').toContain('Forward it to your customer');
  });
});
