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
  schema,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { buildRunner } from '../jobs/jobs.module.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { loadConfig, type ApiConfig } from '../config.js';
import type { InboundMessageDeps } from '../jobs/inbound-message.handler.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const APP_SECRET = 'meta-app-secret-for-tests';
const VERIFY_TOKEN = 'meta-verify-token-for-tests';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let workerDb: Db;
let closeDb: () => Promise<void>;
let closeWorkerDb: () => Promise<void>;
let deps: InboundMessageDeps;

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
  deps = { gateway: new PrivacyGateway(db, config), config };
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
    expect(messages).toHaveLength(1);
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

    const messages = await withBusiness(db, business.id, (tx) =>
      conversationsRepo.messagesFor(tx, business.id),
    );
    expect(messages).toHaveLength(1);
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
