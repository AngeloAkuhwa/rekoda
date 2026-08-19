/**
 * Webhook ingress, end to end (MASTER-PLAN §5.3.1).
 *
 * The fixed order — signature → parse → idempotency → tenant → persist → 200 —
 * is only real if each step is proven against a running app and a real
 * database. Idempotency in particular cannot be tested any other way: it is a
 * claim about a unique constraint under concurrency.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, events, identity, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const APP_SECRET = 'meta-app-secret-for-tests';
const VERIFY_TOKEN = 'meta-verify-token-for-tests';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = 'test-pepper-at-least-32-characters-long';
  process.env['REKODA_API_SECRET'] = 'test-secret-at-least-32-characters-long';
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  process.env['META_APP_SECRET'] = APP_SECRET;
  process.env['META_VERIFY_TOKEN'] = VERIFY_TOKEN;
  delete process.env['NODE_ENV'];

  const { createApp } = await import('../main.js');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
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
