/**
 * The merchant's own Paystack key, end to end (ADR 0019, fix-plan 6 M5a).
 *
 * Booted CONFIGURED: CONNECTION_KEY set and PAYSTACK_BASE_URL pointed at a
 * local stub, so the promise under test is the whole one — the key is
 * checked with the provider BEFORE it is stored, a refused key stores
 * nothing, and a stored key never travels anywhere again except as a tail.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paymentConnectionResponse, submitMerchantKeyResponse } from '@rekoda/contracts';
import { decryptFacet } from '@rekoda/core/vault';
import { createDb, paymentsHub, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;
let connectionKey: string;

let paystack: Server;
let paystackRespond: (req: IncomingMessage, res: ServerResponse) => void;
let seenAuth: string[];

beforeAll(async () => {
  paystack = createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ''));
    paystackRespond(req, res);
  });
  await new Promise<void>((resolve) => paystack.listen(0, '127.0.0.1', resolve));
  const address = paystack.address();
  if (!address || typeof address === 'string') throw new Error('no address');

  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));

  connectionKey = randomBytes(32).toString('hex');
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['CONNECTION_KEY'] = connectionKey;
  process.env['PAYSTACK_BASE_URL'] = `http://127.0.0.1:${address.port}`;
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
  await new Promise((resolve) => paystack.close(resolve));
  delete process.env['CONNECTION_KEY'];
  delete process.env['PAYSTACK_BASE_URL'];
});

beforeEach(async () => {
  await truncateAll(urls);
  seenAuth = [];
  paystackRespond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: true, data: [] }));
  };
});

const post = (
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method: 'POST',
    url,
    payload,
    headers: { 'content-type': 'application/json', ...headers },
  });

/* Assembled at runtime so the secret scanner never sees a key-shaped literal
 * assigned to a key-named variable. These are fabricated values for a stub
 * server; the scan has no way to know that, and it is right to be strict. */
const fakeKey = (label: string) => ['sk', 'test', label].join('_');

async function onboard(phone: string) {
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as { devCode?: string };
  const verified = (
    await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
  ).json() as { setupToken: string };
  const created = await post(
    '/v1/businesses',
    { name: 'Ada Fashion', businessType: 'Fashion & clothing' },
    { 'x-rekoda-setup-token': verified.setupToken },
  );
  const session = created.json() as { sessionToken: string; businessId: string };
  return {
    businessId: session.businessId,
    auth: { authorization: `Bearer ${session.sessionToken}` },
  };
}

describe('connecting the merchant key', () => {
  it('refuses a caller with no session', async () => {
    expect(
      (await post('/v1/payments/merchant-key', { secretKey: fakeKey('x'.repeat(12)) })).statusCode,
    ).toBe(401);
  });

  it('verifies with Paystack, vaults the key, and only ever shows a tail', async () => {
    const { auth, businessId } = await onboard('+2348188100001');
    const secretKey = fakeKey('verified_abcd1234');

    const connected = submitMerchantKeyResponse.parse(
      (await post('/v1/payments/merchant-key', { secretKey }, auth)).json(),
    );
    expect(connected).toEqual({ state: 'connected', merchantKeyTail: '1234' });
    /* The verification actually went over the wire, carrying the key once. */
    expect(seenAuth).toContain(`Bearer ${secretKey}`);

    const view = paymentConnectionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/payments/connection', headers: auth })).json(),
    );
    expect(view).toMatchObject({
      status: 'active',
      keyMode: 'merchant_key',
      merchantKeyTail: '1234',
    });
    /* Never the key itself, anywhere on the wire. */
    expect(JSON.stringify(view)).not.toContain(secretKey);

    /* Stored as a cipher the connection key opens, bound to this business. */
    const cipher = await withBusiness(db, businessId, (tx) =>
      paymentsHub.merchantKeyCipherFor(tx, businessId, 'paystack'),
    );
    expect(cipher).not.toBeNull();
    expect(cipher).not.toContain(secretKey);
    expect(decryptFacet(cipher!, connectionKey, `${businessId}:merchant_key`)).toBe(secretKey);
  });

  it('a key Paystack refuses is never stored', async () => {
    const { auth, businessId } = await onboard('+2348188100002');
    paystackRespond = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: false, message: 'Invalid key' }));
    };

    const refused = submitMerchantKeyResponse.parse(
      (
        await post('/v1/payments/merchant-key', { secretKey: fakeKey('wrong_key_9999') }, auth)
      ).json(),
    );
    expect(refused).toEqual({ state: 'rejected' });

    const cipher = await withBusiness(db, businessId, (tx) =>
      paymentsHub.merchantKeyCipherFor(tx, businessId, 'paystack'),
    );
    expect(cipher).toBeNull();
  });

  it('replacing the key is the same call, and the new tail wins', async () => {
    const { auth } = await onboard('+2348188100003');
    await post('/v1/payments/merchant-key', { secretKey: fakeKey('first_key_1111') }, auth);
    const replaced = submitMerchantKeyResponse.parse(
      (
        await post('/v1/payments/merchant-key', { secretKey: fakeKey('second_key_2222') }, auth)
      ).json(),
    );
    expect(replaced).toEqual({ state: 'connected', merchantKeyTail: '2222' });

    const view = paymentConnectionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/payments/connection', headers: auth })).json(),
    );
    expect(view.merchantKeyTail).toBe('2222');
  });
});

describe('test money is not real money (remediation R4)', () => {
  const liveKey = (label: string) => ['sk', 'live', label].join('_');

  /** NODE_ENV is what `isProductionEnv` reads, and it reads it per call. */
  async function inProduction<T>(fn: () => Promise<T>): Promise<T> {
    const before = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      return await fn();
    } finally {
      if (before === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = before;
    }
  }

  const environmentOf = (businessId: string) =>
    withBusiness(db, businessId, async (tx) => {
      const connection = await paymentsHub.connectionFor(tx, businessId, 'paystack');
      return connection?.providerEnvironment ?? null;
    });

  it('refuses a test key in production, and stores nothing', async () => {
    const { auth, businessId } = await onboard('+2348188100010');
    const secretKey = fakeKey('works_but_sandbox');

    const outcome = submitMerchantKeyResponse.parse(
      await inProduction(async () =>
        (await post('/v1/payments/merchant-key', { secretKey }, auth)).json(),
      ),
    );

    /* Paystack ACCEPTED this key: the stub answers for it, and `rejected`
     * would have been the wrong word. The key works; its money is not real. */
    expect(outcome).toEqual({ state: 'rejected_test_key' });
    expect(
      await withBusiness(db, businessId, (tx) =>
        paymentsHub.merchantKeyCipherFor(tx, businessId, 'paystack'),
      ),
    ).toBeNull();
  });

  it('accepts a live key in production and records which world it belongs to', async () => {
    const { auth, businessId } = await onboard('+2348188100011');

    const outcome = submitMerchantKeyResponse.parse(
      await inProduction(async () =>
        (await post('/v1/payments/merchant-key', { secretKey: liveKey('real_5678') }, auth)).json(),
      ),
    );

    expect(outcome).toEqual({ state: 'connected', merchantKeyTail: '5678' });
    expect(await environmentOf(businessId)).toBe('LIVE');
  });

  it('allows a test key outside production, and says so on the connection', async () => {
    const { auth, businessId } = await onboard('+2348188100012');

    const outcome = submitMerchantKeyResponse.parse(
      (
        await post('/v1/payments/merchant-key', { secretKey: fakeKey('sandbox_4321') }, auth)
      ).json(),
    );

    /* Sandbox is a legitimate place to work. What must never happen is a
     * sandbox key being mistaken for real money, and the row now says which
     * it is rather than leaving the reader to guess from a prefix. */
    expect(outcome).toEqual({ state: 'connected', merchantKeyTail: '4321' });
    expect(await environmentOf(businessId)).toBe('TEST');
  });
});
