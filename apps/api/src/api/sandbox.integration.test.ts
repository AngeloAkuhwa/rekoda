/**
 * The sandbox (PR-114, API-D closes).
 *
 * A test key is not a second environment with a second database — it is the
 * SAME business, the SAME books and one refusal. That choice is the whole
 * value: an integrator proves their authentication, their paging, their
 * error handling and their webhook verification against real shapes, and
 * cannot post a sale into a real merchant's ledger while doing it. A
 * separate sandbox estate would prove none of that, because the data in it
 * would be nothing like the data they eventually meet.
 *
 * So what this suite pins is the pair: reads work exactly as live, writes do
 * not work at all, and the difference is legible before either happens.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { publicApi } from '@rekoda/contracts';
import { usagePeriod } from '@rekoda/core';
import { createDb, entitlementsRepo, usageRepo, withBusiness, type Db } from '@rekoda/db';
import {
  grantCapacityAddOn,
  migrate,
  requireUrls,
  truncateAll,
  type Urls,
} from '@rekoda/db/testing';

const SECRET = 'sandbox-secret-at-least-32-characters';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = 'sandbox-pepper-at-least-32-characters';
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
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

interface Developer {
  businessId: string;
  auth: Record<string, string>;
  applicationId: string;
  live: Record<string, string>;
  test: Record<string, string>;
}

/** One business, one application, one key of each world. */
async function developer(phone: string, name: string): Promise<Developer> {
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
  const auth = { authorization: `Bearer ${created.sessionToken}` };

  const period = usagePeriod(new Date());
  await withBusiness(db, created.businessId, async (tx) => {
    await entitlementsRepo.grant(tx, {
      businessId: created.businessId,
      entitlementKey: 'REKODA_API',
      source: 'MANUAL_GRANT',
      grantedBy: 'operator:sandbox-suite',
    });
    await usageRepo.creditBonus(tx, created.businessId, period, 'API_REQUEST_UNITS', 20);
  });
  /* Applications are held, not spent (PR-116): capacity comes from an
   * add-on holding rather than a credit against the month. */
  await grantCapacityAddOn(urls, created.businessId, 'API_APPLICATIONS', 5);

  const application = (
    await post('/v1/api-keys/applications', { name: `${name} app` }, auth)
  ).json() as { id: string };
  const live = (
    await post(`/v1/api-keys/applications/${application.id}/keys`, { mode: 'live' }, auth)
  ).json() as { token: string };
  const test = (
    await post(`/v1/api-keys/applications/${application.id}/keys`, { mode: 'test' }, auth)
  ).json() as { token: string };

  return {
    businessId: created.businessId,
    auth,
    applicationId: application.id,
    live: { authorization: `Bearer ${live.token}` },
    test: { authorization: `Bearer ${test.token}` },
  };
}

const SALE = { items: [{ name: 'Rice', quantity: 1, unitPriceK: 100_000 }] };

describe('minting', () => {
  it('says which world a key belongs to, in its prefix and in the listing', async () => {
    const dev = await developer('+2348196000001', 'Sandbox Co');

    const listed = (await get('/v1/api-keys', dev.auth)).json() as {
      keys: { prefix: string; mode: string }[];
    };
    const modes = listed.keys.map((key) => key.mode).sort();
    expect(modes).toEqual(['live', 'test']);
    for (const key of listed.keys) {
      expect(key.prefix.startsWith(`rk_${key.mode}_`)).toBe(true);
    }
  });

  it('counts the cap per world, so test keys cannot block a rotation', async () => {
    const dev = await developer('+2348196000002', 'Rotating Co');

    /* Four more test keys, taking that world to its cap of five. */
    for (let i = 0; i < 4; i += 1) {
      expect(
        (
          await post(
            `/v1/api-keys/applications/${dev.applicationId}/keys`,
            { mode: 'test' },
            dev.auth,
          )
        ).statusCode,
      ).toBe(200);
    }
    expect(
      (
        await post(
          `/v1/api-keys/applications/${dev.applicationId}/keys`,
          { mode: 'test' },
          dev.auth,
        )
      ).statusCode,
    ).toBe(400);

    /* And the live world still has room, which is the point. */
    expect(
      (
        await post(
          `/v1/api-keys/applications/${dev.applicationId}/keys`,
          { mode: 'live' },
          dev.auth,
        )
      ).statusCode,
    ).toBe(200);
  });
});

describe('what a test key may do', () => {
  it('reads the same books the live key reads', async () => {
    const dev = await developer('+2348196000010', 'Reading Co');
    await post('/api/v1/sales', SALE, dev.live);

    const live = (await get('/api/v1/invoices', dev.live)).json() as {
      items: { invoiceNumber: string }[];
    };
    const sandbox = (await get('/api/v1/invoices', dev.test)).json() as {
      items: { invoiceNumber: string }[];
    };
    expect(sandbox.items).toEqual(live.items);
    expect(sandbox.items).toHaveLength(1);
  });

  it('says which world it is in, before anything is written', async () => {
    const dev = await developer('+2348196000011', 'Told Co');

    const live = publicApi.v1.publicIdentityResponse.parse(
      (await get('/api/v1/identity', dev.live)).json(),
    );
    const sandbox = publicApi.v1.publicIdentityResponse.parse(
      (await get('/api/v1/identity', dev.test)).json(),
    );
    expect(live.mode).toBe('live');
    expect(sandbox.mode).toBe('test');
    /* The same business either way: one estate, one set of books. */
    expect(sandbox.businessId).toBe(live.businessId);
  });

  it('writes nothing, and says so in the envelope', async () => {
    const dev = await developer('+2348196000012', 'Refused Co');

    const refused = await post('/api/v1/sales', SALE, dev.test);
    expect(refused.statusCode).toBe(403);
    const body = publicApi.v1.publicErrorResponse.parse(refused.json());
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).toContain('test key');

    const payment = await post(
      '/api/v1/payments',
      { invoiceNumber: 'INV-2026-000001', amountK: 1_000 },
      dev.test,
    );
    expect(payment.statusCode).toBe(403);

    /* Nothing reached the books. */
    const listed = (await get('/api/v1/invoices', dev.live)).json() as { items: unknown[] };
    expect(listed.items).toHaveLength(0);
  });

  it('refuses a bad body before it refuses the key, because that is fixable first', async () => {
    const dev = await developer('+2348196000013', 'Ordered Co');
    const response = await post('/api/v1/sales', { items: [] }, dev.test);
    expect(response.statusCode).toBe(400);
    expect(publicApi.v1.publicErrorResponse.parse(response.json()).error.code).toBe(
      'invalid_request',
    );
  });

  it('costs no capacity, so proving a wiring is free', async () => {
    const dev = await developer('+2348196000014', 'Free Co');

    for (let i = 0; i < 5; i += 1) {
      expect((await get('/api/v1/identity', dev.test)).statusCode).toBe(200);
    }
    const rows = await withBusiness(db, dev.businessId, (tx) =>
      usageRepo.usageFor(tx, dev.businessId, usagePeriod(new Date())),
    );
    expect(rows.find((row) => row.unit === 'API_REQUEST_UNITS')?.used ?? 0).toBe(0);

    /* A live call on the same key pair still costs one, so "free" is the
     * sandbox and not a hole in the meter. */
    await get('/api/v1/identity', dev.live);
    const after = await withBusiness(db, dev.businessId, (tx) =>
      usageRepo.usageFor(tx, dev.businessId, usagePeriod(new Date())),
    );
    expect(after.find((row) => row.unit === 'API_REQUEST_UNITS')?.used).toBe(1);
  });

  it('is still bound by the tenant its key resolved to', async () => {
    const mine = await developer('+2348196000015', 'Mine Co');
    const theirs = await developer('+2348196000016', 'Theirs Co');
    await post('/api/v1/sales', SALE, mine.live);

    const seen = (await get('/api/v1/invoices', theirs.test)).json() as { items: unknown[] };
    expect(seen.items).toHaveLength(0);
  });
});
