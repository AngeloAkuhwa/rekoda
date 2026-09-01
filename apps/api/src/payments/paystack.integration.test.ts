/**
 * Paystack ingress (docs/payments-v1.md §18–20), end to end over a real app
 * and a real database — the same properties the Meta endpoint proves, because
 * they are the same claims: the signature is the admission check, retries are
 * no-ops by construction, and nothing sensitive lands in plaintext.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, events, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const PAYSTACK_SECRET = 'sk_test_paystack_secret_for_tests';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['PAYSTACK_SECRET_KEY'] = PAYSTACK_SECRET;
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
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
  await truncateAll(urls);
});

function chargeSuccess(transactionId: number, reference: string) {
  return {
    event: 'charge.success',
    data: {
      id: transactionId,
      reference,
      // Paystack reports kobo already: this is ₦150,000, not ₦15,000,000.
      amount: 15_000_000,
      currency: 'NGN',
      status: 'success',
      customer: { email: 'adaeze.okonkwo@example.com', phone: '+2348039998888' },
    },
  };
}

function post(payload: unknown, opts: { secret?: string; raw?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(payload);
  const signature = createHmac('sha512', opts.secret ?? PAYSTACK_SECRET)
    .update(raw, 'utf8')
    .digest('hex');
  return app.inject({
    method: 'POST',
    url: '/webhooks/paystack',
    payload: raw,
    headers: { 'content-type': 'application/json', 'x-paystack-signature': signature },
  });
}

describe('the signature is the admission check', () => {
  it('accepts a genuine event and stores it once', async () => {
    const response = await post(chargeSuccess(881, 'RKD-PAY-20260819-A83F92'));
    expect(response.statusCode).toBe(200);
    expect(await events.eventCount(db)).toBe(1);
  });

  it('rejects a forged signature BEFORE anything is stored', async () => {
    const response = await post(chargeSuccess(882, 'RKD-PAY-20260819-B00001'), {
      secret: 'sk_test_wrong_secret',
    });
    expect(response.statusCode).toBe(401);
    // The endpoint is world-reachable; storing unsigned payloads would be an
    // unbounded write anyone on the internet can perform.
    expect(await events.eventCount(db)).toBe(0);
  });

  it('rejects everything when no missing header is supplied', async () => {
    const raw = JSON.stringify(chargeSuccess(883, 'RKD-PAY-20260819-B00002'));
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/paystack',
      payload: raw,
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('signs the RAW bytes — a re-serialisation must fail', async () => {
    const body = chargeSuccess(884, 'RKD-PAY-20260819-B00003');
    const spaced = JSON.stringify(body, null, 2);
    const compact = JSON.stringify(body);
    // Signature over the spaced form, body delivering the compact form.
    const signature = createHmac('sha512', PAYSTACK_SECRET).update(spaced, 'utf8').digest('hex');
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/paystack',
      payload: compact,
      headers: { 'content-type': 'application/json', 'x-paystack-signature': signature },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('idempotency', () => {
  it('stores one event however many times Paystack retries it', async () => {
    const body = chargeSuccess(885, 'RKD-PAY-20260819-B00004');
    await Promise.all(Array.from({ length: 6 }, () => post(body)));
    expect(await events.eventCount(db)).toBe(1);
  });

  it('keeps DIFFERENT event types for one transaction separate', async () => {
    // charge.success now, refund.processed next month — a fingerprint on the
    // transaction id alone would discard the refund as a duplicate.
    const reference = 'RKD-PAY-20260819-B00005';
    await post(chargeSuccess(886, reference));
    await post({ event: 'refund.processed', data: { id: 886, reference, amount: 15_000_000 } });
    expect(await events.eventCount(db)).toBe(2);
  });

  it('still dedupes byte-identical retries when Paystack sends no id', async () => {
    const body = { event: 'transfer.success', data: { reference: 'RKD-PAY-20260819-B00006' } };
    await post(body);
    await post(body);
    expect(await events.eventCount(db)).toBe(1);
  });
});

describe('what lands in the table', () => {
  it('seals the payload — the payer`s identity never sits in plaintext', async () => {
    await post(chargeSuccess(887, 'RKD-PAY-20260819-B00007'));

    const [row] = await events.unprocessedEvents(db, 'paystack');
    const stored = JSON.stringify(row?.payload);
    /**
     * Paystack bodies carry the payer's email and phone, and the worker
     * reads external_events across every tenant. Same rule as Meta: sealed at
     * write, opened by the worker that processes it.
     */
    expect(stored).not.toContain('adaeze.okonkwo');
    expect(stored).not.toContain('2348039998888');
    expect(stored).toContain('sealed');
  });

  it('lands unattributed — attribution is the worker`s job, by policy', async () => {
    await post(chargeSuccess(888, 'RKD-PAY-20260819-B00008'));
    const [row] = await events.unprocessedEvents(db, 'paystack');
    // Resolving the reference to a business is a cross-tenant read the API
    // role deliberately cannot perform (worker_resolve, migration 0010).
    expect(row?.businessId).toBeNull();
  });

  it('answers 200 to a signed shape it cannot read, and stores nothing', async () => {
    const response = await post({ unexpected: 'shape' });
    expect(response.statusCode).toBe(200);
    expect(await events.eventCount(db)).toBe(0);
  });
});
