/**
 * Connection onboarding, end to end (docs/payments-v1.md §3–5, §47).
 *
 * A real Nest app over a real database, with the REAL Paystack adapter
 * pointed at a local fake — so what is proven is the whole path an owner's
 * form takes: session guard → zod contract → vaulted storage → provider
 * call → §5 state machine → masked response. The claims that matter most
 * are negative: the account number never appears in any response, never
 * lands in a row in plaintext, and a live key without the §47 flag creates
 * NOTHING provider-side.
 */
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, paymentsHub, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PaymentConnectionsService } from './connections.service.js';
import { StubPaymentProvider } from './provider.stub.js';
import type { ApiConfig } from '../config.js';

const ACCOUNT_NUMBER = '0123456789';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;
let fake: Server;
let fakeCalls: Array<{ path: string; body: Record<string, unknown> }>;
let rejectNext: string | null;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);

  /* A fake Paystack that records what it is asked and answers like the real
   * one: 200 + subaccount_code, or 400 with a message when scripted to. */
  fakeCalls = [];
  rejectNext = null;
  fake = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      fakeCalls.push({ path: req.url ?? '', body });
      if (rejectNext) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: false, message: rejectNext }));
        rejectNext = null;
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ status: true, data: { subaccount_code: `ACCT_${fakeCalls.length}` } }),
      );
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const address = fake.address();
  if (!address || typeof address === 'string') throw new Error('no fake address');

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['CONNECTION_KEY'] = randomBytes(32).toString('hex');
  process.env['PAYSTACK_SECRET_KEY'] = 'sk_test_for_connections';
  process.env['PAYSTACK_BASE_URL'] = `http://127.0.0.1:${address.port}`;
  process.env['REKODA_REVEAL_OTP'] = '1';
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
  if (fake) await new Promise((resolve) => fake.close(resolve));
});

beforeEach(async () => {
  await truncateAll(urls);
  fakeCalls.length = 0;
  rejectNext = null;
});

function post(path: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: path,
    payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Phone → verified → business created → bearer session. */
async function onboard(phone: string) {
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as {
    devCode?: string;
  };
  const verified = (
    await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
  ).json() as { setupToken: string };
  const created = await post(
    '/v1/businesses',
    { name: 'Ada Fashion', businessType: 'Fashion & clothing' },
    { 'x-rekoda-setup-token': verified.setupToken },
  );
  expect(created.statusCode).toBe(201);
  const session = created.json() as { sessionToken: string; businessId: string };
  return {
    businessId: session.businessId,
    auth: { authorization: `Bearer ${session.sessionToken}` },
  };
}

const DETAILS = { bankCode: '058', accountNumber: ACCOUNT_NUMBER, accountName: 'Ada Fashion' };

describe('submitting settlement details', () => {
  it('vaults the account, creates the subaccount, activates, and masks everything', async () => {
    const { businessId, auth } = await onboard('+2348150000001');

    const res = await post('/v1/payments/connection', DETAILS, auth);
    expect(res.statusCode).toBe(200);
    const view = res.json() as Record<string, unknown>;
    expect(view['status']).toBe('active');
    expect(view['accountLast4']).toBe('6789');
    // The full number appears in NO response, masked or otherwise.
    expect(res.body).not.toContain(ACCOUNT_NUMBER);

    // The provider was asked with V1's zero platform cut.
    expect(fakeCalls).toHaveLength(1);
    expect(fakeCalls[0]?.path).toBe('/subaccount');
    expect(fakeCalls[0]?.body['percentage_charge']).toBe(0);

    // At rest: a cipher, never the number.
    const row = await withBusiness(db, businessId, (tx) =>
      paymentsHub.connectionFor(tx, businessId, 'paystack'),
    );
    expect(row?.status).toBe('active');
    expect(row?.externalSubaccountId).toBe('ACCT_1');
    const cipher = await withBusiness(db, businessId, (tx) =>
      paymentsHub.settlementCipherFor(tx, businessId, 'paystack'),
    );
    expect(cipher ?? '').not.toContain(ACCOUNT_NUMBER);
    expect((cipher ?? '').length).toBeGreaterThan(20);
  });

  it('surfaces a provider rejection as FAILED, and a corrected resubmit recovers', async () => {
    const { auth } = await onboard('+2348150000002');

    rejectNext = 'Account number is invalid';
    const rejected = await post('/v1/payments/connection', DETAILS, auth);
    expect(rejected.statusCode).toBe(200);
    expect((rejected.json() as Record<string, unknown>)['status']).toBe('failed');

    // Same row, new state — reconnecting is a transition, never a second row.
    const fixed = await post('/v1/payments/connection', DETAILS, auth);
    expect((fixed.json() as Record<string, unknown>)['status']).toBe('active');
  });

  it('refuses an unauthenticated caller and an unreadable body', async () => {
    const { auth } = await onboard('+2348150000003');
    expect((await post('/v1/payments/connection', DETAILS)).statusCode).toBe(401);
    expect((await post('/v1/payments/connection', { accountNumber: '12' }, auth)).statusCode).toBe(
      400,
    );
  });

  it('answers not_configured before anything is submitted, then the masked view', async () => {
    const { auth } = await onboard('+2348150000004');

    const before = await app.inject({
      method: 'GET',
      url: '/v1/payments/connection',
      headers: auth,
    });
    expect((before.json() as Record<string, unknown>)['status']).toBe('not_configured');

    await post('/v1/payments/connection', DETAILS, auth);
    const after = await app.inject({
      method: 'GET',
      url: '/v1/payments/connection',
      headers: auth,
    });
    const view = after.json() as Record<string, unknown>;
    expect(view['status']).toBe('active');
    expect(view['accountLast4']).toBe('6789');
    expect(after.body).not.toContain(ACCOUNT_NUMBER);
  });

  it('serves the meter and the empty exception queue to a fresh business', async () => {
    const { auth } = await onboard('+2348150000005');
    const usage = await app.inject({ method: 'GET', url: '/v1/payments/usage', headers: auth });
    const usageBody = usage.json() as { plan: string; period: string };
    expect(usageBody.plan).toBe('trial');
    expect(usageBody.period).toMatch(/^\d{4}-\d{2}$/);

    const exceptions = await app.inject({
      method: 'GET',
      url: '/v1/payments/exceptions',
      headers: auth,
    });
    expect((exceptions.json() as { exceptions: unknown[] }).exceptions).toEqual([]);
  });
});

describe('§47 is code, not a runbook', () => {
  function configLike(overrides: Partial<ApiConfig>): ApiConfig {
    return {
      connectionKey: randomBytes(32).toString('hex'),
      paystackSecretKey: 'sk_live_pretend',
      paystackPlatformConfirmed: false,
      ...overrides,
    } as ApiConfig;
  }

  async function seeded() {
    const { businessId } = await onboard('+2348150000006');
    return businessId;
  }

  it('holds a LIVE key with no written confirmation: details stored, NOTHING created provider-side', async () => {
    const businessId = await seeded();
    const stub = new StubPaymentProvider();
    const service = new PaymentConnectionsService(configLike({}), db, stub);

    const outcome = await service.submit(businessId, DETAILS);

    expect(outcome.state).toBe('submitted');
    if (outcome.state === 'submitted') {
      expect(outcome.held).toBe('awaiting_platform_confirmation');
      expect(outcome.connection.status).toBe('pending_provider_creation');
    }
    expect(stub.subaccountsCreated).toHaveLength(0); // the whole point of §47
  });

  it('proceeds on a live key once the confirmation flag records the paperwork', async () => {
    const businessId = await seeded();
    const stub = new StubPaymentProvider();
    const service = new PaymentConnectionsService(
      configLike({ paystackPlatformConfirmed: true }),
      db,
      stub,
    );

    const outcome = await service.submit(businessId, DETAILS);
    expect(outcome.state).toBe('submitted');
    if (outcome.state === 'submitted') expect(outcome.connection.status).toBe('active');
    expect(stub.subaccountsCreated).toHaveLength(1);
  });

  it('refuses to store anything at all without a CONNECTION_KEY', async () => {
    const businessId = await seeded();
    const stub = new StubPaymentProvider();
    const service = new PaymentConnectionsService(configLike({ connectionKey: '' }), db, stub);

    const outcome = await service.submit(businessId, DETAILS);
    expect(outcome).toEqual({ state: 'unavailable', reason: 'connection_key_missing' });
    const row = await withBusiness(db, businessId, (tx) =>
      paymentsHub.connectionFor(tx, businessId, 'paystack'),
    );
    expect(row).toBeNull(); // refused plainly, stored nothing
  });
});
