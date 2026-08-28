/**
 * The versioned public surface, over a real application (PR-110, spec §27).
 *
 * The contract shapes are frozen in `packages/contracts`; what is proven
 * here is that the SERVER keeps the same promises the contract makes:
 *
 *   1. Every public response says which version answered it, on success and
 *      on every failure, because an integrator debugging a 401 is exactly
 *      who needs to know which version they reached.
 *   2. Every public failure is the envelope, with a code from the closed
 *      set, whichever layer refused: the guard, the router or the limiter.
 *   3. A version this API does not serve says so by name, and a bad route
 *      inside a version it does serve does not.
 *   4. The dashboard's own routes are untouched by any of it.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { publicApi } from '@rekoda/contracts';
import { createDb, entitlementsRepo, usageRepo, withBusiness, type Db } from '@rekoda/db';
import { usagePeriod } from '@rekoda/core';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';

const SECRET = 'public-api-secret-at-least-32-characters';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = 'public-api-pepper-at-least-32-characters';
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_API_SECRET'] = SECRET;
  process.env['REKODA_OPERATOR_SECRET'] = `operator-${SECRET}`;
  process.env['REKODA_REVEAL_OTP'] = '1';
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  delete process.env['NODE_ENV'];

  const { createApp } = await import('../../main.js');
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

/** An entitled business holding one live API key. */
async function entitledKey(
  phone: string,
  name: string,
): Promise<{ token: string; businessId: string }> {
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

  await withBusiness(db, created.businessId, (tx) =>
    entitlementsRepo.grant(tx, {
      businessId: created.businessId,
      entitlementKey: 'REKODA_API',
      source: 'MANUAL_GRANT',
      grantedBy: 'operator:public-api-suite',
    }),
  );

  await creditApiCapacity(created.businessId);

  const application = (
    await post('/v1/api-keys/applications', { name: `${name} app` }, auth)
  ).json() as { id: string };
  const minted = (
    await post(`/v1/api-keys/applications/${application.id}/keys`, {}, auth)
  ).json() as { token: string };
  return { token: minted.token, businessId: created.businessId };
}

describe('the version header', () => {
  it('is on a success', async () => {
    const { token } = await entitledKey('+2348191000001', 'Versioned Co');
    const response = await get('/api/v1/identity', { authorization: `Bearer ${token}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers[publicApi.v1.PUBLIC_VERSION_HEADER]).toBe('v1');
  });

  it('is on a failure, which is when it matters most', async () => {
    const response = await get('/api/v1/identity');
    expect(response.statusCode).toBe(401);
    expect(response.headers[publicApi.v1.PUBLIC_VERSION_HEADER]).toBe('v1');
  });

  it('is absent from the dashboard, which has no public version', async () => {
    const response = await get('/v1/api-keys');
    expect(response.headers[publicApi.v1.PUBLIC_VERSION_HEADER]).toBeUndefined();
  });

  it('carries no retirement notice while nothing is retired', async () => {
    const response = await get('/api/v1/identity');
    expect(response.headers['deprecation']).toBeUndefined();
    expect(response.headers['sunset']).toBeUndefined();
    expect(publicApi.PUBLIC_API_RETIREMENTS).toEqual({});
  });
});

describe('the error envelope', () => {
  it('answers a missing credential in the envelope, saying nothing else', async () => {
    const response = await get('/api/v1/identity');
    const body = publicApi.v1.publicErrorResponse.parse(response.json());
    expect(body.error.code).toBe('unauthenticated');
    /* Nest's own body would carry `statusCode` and `error`. A client that
     * branched on those would be branching on an implementation detail. */
    expect(response.json()).not.toHaveProperty('statusCode');
  });

  it('names the entitlement refusal, and only that one', async () => {
    const phone = '+2348191000010';
    const requested = (await post('/v1/auth/otp/request', { phone })).json() as {
      devCode: string;
    };
    const verified = (
      await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
    ).json() as { setupToken: string };
    const created = (
      await post(
        '/v1/businesses',
        { name: 'Unpaid Co', businessType: null },
        { 'x-rekoda-setup-token': verified.setupToken },
      )
    ).json() as { sessionToken: string; businessId: string };
    const auth = { authorization: `Bearer ${created.sessionToken}` };
    await creditApiCapacity(created.businessId);
    const application = (
      await post('/v1/api-keys/applications', { name: 'Unpaid app' }, auth)
    ).json() as { id: string };
    const minted = (
      await post(`/v1/api-keys/applications/${application.id}/keys`, {}, auth)
    ).json() as { token: string };

    const response = await get('/api/v1/identity', {
      authorization: `Bearer ${minted.token}`,
    });
    expect(response.statusCode).toBe(403);
    expect(publicApi.v1.publicErrorResponse.parse(response.json()).error.code).toBe('not_entitled');
  });

  it('puts the wait in the body and the header when a key hits its ceiling', async () => {
    const { token, businessId } = await entitledKey('+2348191000011', 'Ceiling Co');
    const auth = { authorization: `Bearer ${token}` };

    /* The key's own ceiling is 120 a minute, which is a lot of injections.
     * The limit lives on the key's row, so it is lowered under the tenant
     * pin exactly as an operator would have to. */
    const { sql } = await import('@rekoda/db');
    await withBusiness(db, businessId, (tx) =>
      tx.execute(
        sql`UPDATE api_keys SET rate_limit_per_minute = 1 WHERE business_id = ${businessId}`,
      ),
    );

    expect((await get('/api/v1/identity', auth)).statusCode).toBe(200);
    const refused = await get('/api/v1/identity', auth);
    expect(refused.statusCode).toBe(429);

    const body = publicApi.v1.publicErrorResponse.parse(refused.json());
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(refused.headers['retry-after'])).toBe(body.error.retryAfterSeconds);
  });
});

describe('the version edge', () => {
  it('names the versions it serves when asked for one it does not', async () => {
    const response = await get('/api/v2/identity');
    expect(response.statusCode).toBe(404);
    const body = publicApi.v1.publicErrorResponse.parse(response.json());
    expect(body.error.code).toBe('unsupported_version');
    expect(body.error.message).toContain('v1');
  });

  it('calls a bad route inside a served version what it is', async () => {
    const response = await get('/api/v1/nothing-here');
    expect(response.statusCode).toBe(404);
    expect(publicApi.v1.publicErrorResponse.parse(response.json()).error.code).toBe('not_found');
  });

  it('does not let the wildcard shadow a real route', async () => {
    const { token } = await entitledKey('+2348191000020', 'Routed Co');
    const response = await get('/api/v1/identity', { authorization: `Bearer ${token}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('businessId');
  });

  it('answers the same to every method, since a version is not a verb', async () => {
    const response = await post('/api/v9/anything', {});
    expect(response.statusCode).toBe(404);
    expect(publicApi.v1.publicErrorResponse.parse(response.json()).error.code).toBe(
      'unsupported_version',
    );
  });
});

/**
 * The capacity the API product sells, credited as bonus.
 *
 * Every plan sells ZERO of the API units (spec §27 puts the API in no
 * plan), so an entitled business with no bonus is refused at the meter.
 * That is the product, not a test detail: what a merchant buys with the
 * API is capacity, and these lines are where this suite buys it.
 */
async function creditApiCapacity(businessId: string): Promise<void> {
  const period = usagePeriod(new Date());
  await withBusiness(db, businessId, async (tx) => {
    await usageRepo.creditBonus(tx, businessId, period, 'API_REQUEST_UNITS', 1_000);
    await usageRepo.creditBonus(tx, businessId, period, 'API_APPLICATIONS', 20);
  });
}
