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
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunner, type RunnerDeps } from '../jobs/jobs.module.js';
import { issueRepo } from '@rekoda/db';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { Interpreter } from '../ai/interpreter.service.js';
import { StubTransport } from '../ai/transport.stub.js';
import { StubSender } from '../channels/sender.stub.js';
import { StubPaymentProvider } from '../payments/provider.stub.js';
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

  it('does NOT invent a debtor list it cannot compute', async () => {
    await seedMerchant('+2348031234567', 'Ada Fashion');
    await post(messagePayload('2348031234567', 'wamid.OWES', 'who owes me'));
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);

    // A bookkeeping assistant that makes up a debtor list has destroyed the
    // only thing it sells.
    expect(stubSender.lastText).toMatch(/not ready yet/i);
    expect(stubSender.lastText).not.toMatch(/₦|owes you/i);
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
