/**
 * Webhooks end to end (PR-112), over a real application and database.
 *
 * The chain under test is the whole point of the PR: a command commits a
 * fact, the outbox dispatcher fans it out to whatever the merchant
 * subscribed, and the sender delivers it signed. Every piece here is the one
 * production runs — `buildOutboxDispatcher` with the real `webhookFanOut`,
 * and `deliverWebhooks` — with a recording sender in place of the network,
 * because what is worth proving is the state machine and the signature, not
 * that `fetch` works.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { publicApi, type WebhookSecretResponse } from '@rekoda/contracts';
import { verifyRekodaSignature, WEBHOOK_SIGNATURE_HEADER } from '@rekoda/core/webhooks';
import { createDb, sql, usageRepo, webhooksRepo, withBusiness, type Db } from '@rekoda/db';
import { usagePeriod } from '@rekoda/core';
import { MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS } from '@rekoda/core/webhooks';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { buildOutboxDispatcher } from '../jobs/jobs.module.js';
import { webhookFanOut } from './fan-out.js';
import { deliverWebhooks } from './delivery.sweep.js';
import { WebhookSendFailed, type WebhookSender } from './sender.js';

const SECRET = 'webhooks-secret-at-least-32-characters';
const VAULT_KEY = randomBytes(32).toString('hex');

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let workerDb: Db;
let closeDb: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 2 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = 'webhooks-pepper-at-least-32-characters';
  process.env['VAULT_KEY'] = VAULT_KEY;
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_API_SECRET'] = SECRET;
  process.env['REKODA_OPERATOR_SECRET'] = `operator-${SECRET}`;
  process.env['REKODA_REVEAL_OTP'] = '1';
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  delete process.env['NODE_ENV'];

  const { createApp } = await import('../main.js');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, payload: payload as object, headers });
}

function get(url: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url, headers });
}

/** A business with an owner session. */
async function onboard(phone: string, name: string) {
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as { devCode: string };
  const verified = (
    await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
  ).json() as { setupToken: string };
  const created = (
    await post(
      '/v1/businesses',
      { name, businessType: null },
      { 'x-rekoda-setup-token': verified.setupToken },
    )
  ).json() as { sessionToken: string; businessId: string };
  /* Deliveries are metered (spec §27's WEBHOOK_DELIVERIES) and no plan
   * sells them, so the capacity a merchant buys with the API product is
   * credited here as bonus. A business without it is refused at the meter,
   * which is its own test below. */
  await withBusiness(db, created.businessId, (tx) =>
    usageRepo.creditBonus(
      tx,
      created.businessId,
      usagePeriod(new Date()),
      'WEBHOOK_DELIVERIES',
      100,
    ),
  );

  return {
    businessId: created.businessId,
    auth: { authorization: `Bearer ${created.sessionToken}` },
  };
}

/** A sender that records what it was handed, and answers however it is told. */
class RecordingSender implements WebhookSender {
  readonly sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  constructor(private readonly answer: () => number | Error = () => 200) {}

  async send(input: { url: string; body: string; headers: Record<string, string> }) {
    this.sent.push(input);
    const answer = this.answer();
    if (answer instanceof Error) throw answer;
    return { status: answer };
  }
}

/** Commit a fact the way a command does: an outbox event inside a transaction. */
async function emit(businessId: string, type: string, payload: Record<string, unknown>) {
  const { outboxRepo } = await import('@rekoda/db');
  return withBusiness(db, businessId, (tx) => outboxRepo.append(tx, { businessId, type, payload }));
}

async function fanOutOnce(): Promise<void> {
  await buildOutboxDispatcher(webhookFanOut(workerDb)).runOnce(workerDb);
}

describe('registering an endpoint', () => {
  it('mints a signing secret, shows it once, and never lists it again', async () => {
    const shop = await onboard('+2348193000001', 'Hooked Co');

    const created = (
      await post('/v1/webhooks', { url: 'https://example.test/hook' }, shop.auth)
    ).json() as WebhookSecretResponse;
    expect(created.signingSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(created.endpoint.status).toBe('active');

    const listed = (await get('/v1/webhooks', shop.auth)).json() as { endpoints: unknown[] };
    expect(listed.endpoints).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.signingSecret);
  });

  it('refuses a plaintext callback', async () => {
    const shop = await onboard('+2348193000002', 'Plaintext Co');
    expect(
      (await post('/v1/webhooks', { url: 'http://example.test/hook' }, shop.auth)).statusCode,
    ).toBe(400);
  });

  /**
   * Server-side request forgery, refused at the door (PR-134).
   *
   * Registration is where a merchant can still fix it. The address is
   * checked again inside the connection (destination.ts), which is what
   * holds against a name that turns inward later.
   */
  it('refuses an endpoint pointed at the estate itself', async () => {
    const shop = await onboard('+2348193000010', 'Forgery Co');
    const inside = [
      'https://169.254.169.254/latest/meta-data/', // cloud metadata
      'https://127.0.0.1/hook', // loopback
      'https://[::1]/hook', // loopback, v6
      'https://[fd00:ec2::254]/hook', // AWS metadata, v6
      'https://10.0.0.5/hook', // RFC1918
      'https://192.168.1.1/hook', // RFC1918
      'https://localhost/hook', // the name for loopback
      'https://db.internal/hook', // an internal suffix
      'https://user:pass@example.test/hook', // credentials smuggled in the URL
    ];
    for (const url of inside) {
      const answer = await post('/v1/webhooks', { url }, shop.auth);
      expect(answer.statusCode, url).toBe(400);
      /* The refusal must not report what is or is not there: that would be
       * the network-mapping oracle this guard exists to close. */
      expect(answer.body, url).not.toContain('169.254');
      expect(answer.body, url).not.toContain('127.0.0.1');
    }

    /* And nothing was created by any of it. */
    const listed = (await get('/v1/webhooks', shop.auth)).json() as { endpoints: unknown[] };
    expect(listed.endpoints).toHaveLength(0);
  });

  it('keeps a business to a countable number of endpoints', async () => {
    const shop = await onboard('+2348193000011', 'Fan Out Co');
    for (let n = 0; n < MAX_WEBHOOK_ENDPOINTS_PER_BUSINESS; n++) {
      expect(
        (await post('/v1/webhooks', { url: `https://example.test/hook-${n}` }, shop.auth))
          .statusCode,
        `endpoint ${n}`,
      ).toBe(200);
    }
    /* One past the cap is refused, and says what to do about it. */
    const refused = await post(
      '/v1/webhooks',
      { url: 'https://example.test/one-too-many' },
      shop.auth,
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('remove one');
  });

  it('stores the secret encrypted, bound to its own endpoint', async () => {
    const shop = await onboard('+2348193000003', 'Sealed Co');
    const created = (
      await post('/v1/webhooks', { url: 'https://example.test/sealed' }, shop.auth)
    ).json() as WebhookSecretResponse;

    const rows = await withBusiness(db, shop.businessId, (tx) =>
      tx.execute<{ encrypted_secret: string }>(
        sql`SELECT encrypted_secret FROM webhook_endpoints WHERE id = ${created.endpoint.id}`,
      ),
    );
    const blob = [...rows][0]!.encrypted_secret;
    expect(blob).not.toContain(created.signingSecret);

    const { decryptFacet } = await import('@rekoda/core/vault');
    expect(decryptFacet(blob, VAULT_KEY, created.endpoint.id)).toBe(created.signingSecret);
    /* Bound: the same blob read as another endpoint's fails authentication
     * rather than handing back a working signing key. */
    expect(() => decryptFacet(blob, VAULT_KEY, shop.businessId)).toThrow();
  });
});

describe('fan-out', () => {
  it('queues one delivery per subscribed endpoint, and none for the unsubscribed', async () => {
    const shop = await onboard('+2348193000010', 'Fanned Co');
    await post('/v1/webhooks', { url: 'https://a.test/hook' }, shop.auth);
    await post(
      '/v1/webhooks',
      { url: 'https://b.test/hook', eventTypes: ['payment.recorded'] },
      shop.auth,
    );

    await emit(shop.businessId, 'sale.recorded', { invoiceNumber: 'INV-1' });
    await fanOutOnce();

    const queued = await withBusiness(db, shop.businessId, (tx) =>
      webhooksRepo.deliveriesFor(tx, shop.businessId),
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]!.eventType).toBe('sale.recorded');
  });

  it('queues nothing for a business with no endpoints, and nothing twice', async () => {
    const shop = await onboard('+2348193000011', 'Quiet Co');
    await emit(shop.businessId, 'sale.recorded', {});
    await fanOutOnce();

    let queued = await withBusiness(db, shop.businessId, (tx) =>
      webhooksRepo.deliveriesFor(tx, shop.businessId),
    );
    expect(queued).toHaveLength(0);

    await post('/v1/webhooks', { url: 'https://c.test/hook' }, shop.auth);
    const event = await emit(shop.businessId, 'invoice.issued', {});
    await fanOutOnce();

    /* A second fan-out of the same event: at-least-once delivery means this
     * pass HAPPENS, and the unique index is what makes it harmless. */
    const endpoints = await withBusiness(db, shop.businessId, (tx) =>
      webhooksRepo.endpointsFor(tx, shop.businessId),
    );
    const queuedAgain = await withBusiness(workerDb, shop.businessId, (tx) =>
      webhooksRepo.queueDelivery(tx, {
        businessId: shop.businessId,
        endpointId: endpoints[0]!.id,
        outboxEventId: event.id,
        eventType: 'invoice.issued',
        payload: {},
      }),
    );
    expect(queuedAgain).toBe(false);

    queued = await withBusiness(db, shop.businessId, (tx) =>
      webhooksRepo.deliveriesFor(tx, shop.businessId),
    );
    expect(queued).toHaveLength(1);
  });

  it("sends one business's facts to that business's endpoints only", async () => {
    const mine = await onboard('+2348193000012', 'Mine Co');
    const theirs = await onboard('+2348193000013', 'Theirs Co');
    await post('/v1/webhooks', { url: 'https://mine.test/hook' }, mine.auth);
    await post('/v1/webhooks', { url: 'https://theirs.test/hook' }, theirs.auth);

    await emit(mine.businessId, 'sale.recorded', {});
    await fanOutOnce();

    const ours = await withBusiness(db, mine.businessId, (tx) =>
      webhooksRepo.deliveriesFor(tx, mine.businessId),
    );
    const others = await withBusiness(db, theirs.businessId, (tx) =>
      webhooksRepo.deliveriesFor(tx, theirs.businessId),
    );
    expect(ours).toHaveLength(1);
    expect(others).toHaveLength(0);
  });
});

describe('delivery', () => {
  it('sends a signed body the merchant can verify, and marks it delivered', async () => {
    const shop = await onboard('+2348193000020', 'Signed Co');
    const created = (
      await post('/v1/webhooks', { url: 'https://signed.test/hook' }, shop.auth)
    ).json() as WebhookSecretResponse;

    await emit(shop.businessId, 'sale.recorded', { invoiceNumber: 'INV-7' });
    await fanOutOnce();

    const sender = new RecordingSender();
    const now = new Date();
    const result = await deliverWebhooks({
      worker: workerDb,
      vaultKey: VAULT_KEY,
      sender,
      now,
      planCatalogueReads: true,
    });
    expect(result).toEqual({ sent: 1, failed: 0, dead: 0 });

    const attempt = sender.sent[0]!;
    expect(attempt.url).toBe('https://signed.test/hook');
    /* The merchant's own verifier, run against what was actually sent. */
    expect(
      verifyRekodaSignature(
        attempt.body,
        attempt.headers[WEBHOOK_SIGNATURE_HEADER],
        created.signingSecret,
        now,
      ),
    ).toBe(true);

    const event = publicApi.v1.webhookEvent.parse(JSON.parse(attempt.body));
    expect(event).toMatchObject({
      type: 'sale.recorded',
      businessId: shop.businessId,
      attempt: 1,
      data: { invoiceNumber: 'INV-7' },
    });

    const log = await withBusiness(db, shop.businessId, (tx) =>
      webhooksRepo.deliveriesFor(tx, shop.businessId),
    );
    expect(log[0]).toMatchObject({ status: 'delivered', attempts: 1, lastStatus: 200 });
  });

  it('retries a refused delivery on a backoff, and gives up visibly', async () => {
    const shop = await onboard('+2348193000021', 'Failing Co');
    await post('/v1/webhooks', { url: 'https://down.test/hook' }, shop.auth);
    await emit(shop.businessId, 'sale.recorded', {});
    await fanOutOnce();

    const sender = new RecordingSender(() => new WebhookSendFailed('endpoint answered 500', 500));

    /* Six attempts, each at the moment the last one made due. The row's own
     * max_attempts decides when to stop, in the UPDATE, so this loop cannot
     * talk it past the ceiling. */
    let last = { sent: 0, failed: 0, dead: 0 };
    let at = new Date();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      last = await deliverWebhooks({
        worker: workerDb,
        vaultKey: VAULT_KEY,
        sender,
        now: at,
        planCatalogueReads: true,
      });
      const rows = await withBusiness(db, shop.businessId, (tx) =>
        webhooksRepo.deliveriesFor(tx, shop.businessId),
      );
      at = new Date(rows[0]!.nextAttemptAt.getTime() + 1_000);
    }

    expect(sender.sent).toHaveLength(6);
    expect(last.dead).toBe(1);

    const log = await withBusiness(db, shop.businessId, (tx) =>
      webhooksRepo.deliveriesFor(tx, shop.businessId),
    );
    expect(log[0]).toMatchObject({ status: 'dead', attempts: 6, lastStatus: 500 });
    expect(log[0]!.lastError).toContain('500');

    /* A dead delivery stays dead: nothing is due any more. */
    const after = await deliverWebhooks({
      worker: workerDb,
      vaultKey: VAULT_KEY,
      planCatalogueReads: true,
      sender,
      now: new Date(at.getTime() + 86_400_000),
    });
    expect(after).toEqual({ sent: 0, failed: 0, dead: 0 });
  });

  it('does not deliver to a disabled endpoint, and resumes when it is enabled', async () => {
    const shop = await onboard('+2348193000022', 'Paused Co');
    const created = (
      await post('/v1/webhooks', { url: 'https://paused.test/hook' }, shop.auth)
    ).json() as WebhookSecretResponse;

    await emit(shop.businessId, 'sale.recorded', {});
    await fanOutOnce();
    await post(`/v1/webhooks/${created.endpoint.id}/disable`, {}, shop.auth);

    const sender = new RecordingSender();
    expect(
      await deliverWebhooks({
        worker: workerDb,
        vaultKey: VAULT_KEY,
        sender,
        planCatalogueReads: true,
      }),
    ).toEqual({
      sent: 0,
      failed: 0,
      dead: 0,
    });

    await post(`/v1/webhooks/${created.endpoint.id}/enable`, {}, shop.auth);
    expect(
      (
        await deliverWebhooks({
          worker: workerDb,
          vaultKey: VAULT_KEY,
          sender,
          planCatalogueReads: true,
        })
      ).sent,
    ).toBe(1);
  });

  it("counts an endpoint's failures and clears the count on a success", async () => {
    const shop = await onboard('+2348193000023', 'Counted Co');
    await post('/v1/webhooks', { url: 'https://counted.test/hook' }, shop.auth);
    await emit(shop.businessId, 'sale.recorded', {});
    await fanOutOnce();

    await deliverWebhooks({
      worker: workerDb,
      vaultKey: VAULT_KEY,
      planCatalogueReads: true,
      sender: new RecordingSender(() => new WebhookSendFailed('nope', 502)),
    });
    let listed = (await get('/v1/webhooks', shop.auth)).json() as {
      endpoints: { consecutiveFailures: number; lastSuccessAt: string | null }[];
    };
    expect(listed.endpoints[0]!.consecutiveFailures).toBe(1);
    expect(listed.endpoints[0]!.lastSuccessAt).toBeNull();

    const rows = await withBusiness(db, shop.businessId, (tx) =>
      webhooksRepo.deliveriesFor(tx, shop.businessId),
    );
    await deliverWebhooks({
      worker: workerDb,
      vaultKey: VAULT_KEY,
      planCatalogueReads: true,
      sender: new RecordingSender(),
      now: new Date(rows[0]!.nextAttemptAt.getTime() + 1_000),
    });

    listed = (await get('/v1/webhooks', shop.auth)).json() as {
      endpoints: { consecutiveFailures: number; lastSuccessAt: string | null }[];
    };
    expect(listed.endpoints[0]!.consecutiveFailures).toBe(0);
    expect(listed.endpoints[0]!.lastSuccessAt).not.toBeNull();
  });

  it('signs with the new secret after a rotation, and the old one stops verifying', async () => {
    const shop = await onboard('+2348193000024', 'Rotated Co');
    const created = (
      await post('/v1/webhooks', { url: 'https://rotated.test/hook' }, shop.auth)
    ).json() as WebhookSecretResponse;
    const rotated = (
      await post(`/v1/webhooks/${created.endpoint.id}/rotate`, {}, shop.auth)
    ).json() as WebhookSecretResponse;
    expect(rotated.signingSecret).not.toBe(created.signingSecret);

    await emit(shop.businessId, 'sale.recorded', {});
    await fanOutOnce();

    const sender = new RecordingSender();
    const now = new Date();
    await deliverWebhooks({
      worker: workerDb,
      vaultKey: VAULT_KEY,
      sender,
      now,
      planCatalogueReads: true,
    });
    const attempt = sender.sent[0]!;
    const header = attempt.headers[WEBHOOK_SIGNATURE_HEADER];

    expect(verifyRekodaSignature(attempt.body, header, rotated.signingSecret, now)).toBe(true);
    expect(verifyRekodaSignature(attempt.body, header, created.signingSecret, now)).toBe(false);
  });
});

describe('the delivery meter', () => {
  /** Spend the endpoint's whole month, leaving nothing for the next fact. */
  async function drain(businessId: string): Promise<void> {
    await withBusiness(db, businessId, (tx) =>
      usageRepo.consumeUnit(
        tx,
        businessId,
        usagePeriod(new Date()),
        'WEBHOOK_DELIVERIES',
        100,
        100,
      ),
    );
  }

  it('counts a delivery that arrived (spec §27)', async () => {
    const shop = await onboard('+2348193000030', 'Counted Co');
    await post('/v1/webhooks', { url: 'https://metered.test/hook' }, shop.auth);
    await emit(shop.businessId, 'sale.recorded', {});
    await fanOutOnce();

    await deliverWebhooks({
      worker: workerDb,
      vaultKey: VAULT_KEY,
      sender: new RecordingSender(),
      planCatalogueReads: true,
    });

    const rows = await withBusiness(db, shop.businessId, (tx) =>
      usageRepo.usageFor(tx, shop.businessId, usagePeriod(new Date())),
    );
    expect(rows.find((row) => row.unit === 'WEBHOOK_DELIVERIES')?.used).toBe(1);
  });

  it('gives the unit back when the endpoint refused, so an outage is not billed', async () => {
    const shop = await onboard('+2348193000031', 'Refunded Co');
    await post('/v1/webhooks', { url: 'https://refunded.test/hook' }, shop.auth);
    await emit(shop.businessId, 'sale.recorded', {});
    await fanOutOnce();

    await deliverWebhooks({
      worker: workerDb,
      vaultKey: VAULT_KEY,
      planCatalogueReads: true,
      sender: new RecordingSender(() => new WebhookSendFailed('endpoint answered 500', 500)),
    });

    const rows = await withBusiness(db, shop.businessId, (tx) =>
      usageRepo.usageFor(tx, shop.businessId, usagePeriod(new Date())),
    );
    expect(rows.find((row) => row.unit === 'WEBHOOK_DELIVERIES')?.used).toBe(0);
  });

  it('holds the fact rather than dropping it when the month is spent', async () => {
    const shop = await onboard('+2348193000032', 'Spent Co');
    await post('/v1/webhooks', { url: 'https://spent.test/hook' }, shop.auth);
    await emit(shop.businessId, 'sale.recorded', {});
    await fanOutOnce();
    await drain(shop.businessId);

    const sender = new RecordingSender();
    const refused = await deliverWebhooks({
      worker: workerDb,
      vaultKey: VAULT_KEY,
      sender,
      planCatalogueReads: true,
    });
    expect(refused).toEqual({ sent: 0, failed: 1, dead: 0 });
    expect(sender.sent).toHaveLength(0);

    const log = await withBusiness(db, shop.businessId, (tx) =>
      webhooksRepo.deliveriesFor(tx, shop.businessId),
    );
    /* Still pending, with the reason readable: the merchant who buys
     * capacity inside the backoff still receives the fact. */
    expect(log[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(log[0]!.lastError).toContain('capacity');

    await withBusiness(db, shop.businessId, (tx) =>
      usageRepo.creditBonus(tx, shop.businessId, usagePeriod(new Date()), 'WEBHOOK_DELIVERIES', 10),
    );
    const after = await deliverWebhooks({
      worker: workerDb,
      vaultKey: VAULT_KEY,
      sender,
      planCatalogueReads: true,
      now: new Date(log[0]!.nextAttemptAt.getTime() + 1_000),
    });
    expect(after.sent).toBe(1);
  });
});
