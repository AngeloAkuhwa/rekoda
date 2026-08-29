/**
 * The public API's front door, over a real application and a real database
 * (PR-109, canonical spec §27).
 *
 * Four properties are worth this suite's existence, and every one of them is
 * a way the API could quietly become the widest hole in the product:
 *
 *   1. The key names the tenant. Nothing a caller sends can change which
 *      business their key speaks for.
 *   2. §27's entitlement is real. A key held by a business that never bought
 *      REKODA_API opens nothing, whatever plan they are on.
 *   3. The ceiling is a ceiling. It refuses at the limit, not near it.
 *   4. The token is unrecoverable. It exists in one response and as a hash.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { entitlementsRepo, sql, usageRepo, withBusiness, createDb, type Db } from '@rekoda/db';
import { usagePeriod } from '@rekoda/core';
import {
  grantCapacityAddOn,
  migrate,
  requireUrls,
  truncateAll,
  type Urls,
} from '@rekoda/db/testing';

const SECRET = 'api-keys-secret-at-least-32-characters'; // gitleaks:allow - test fixture, not a credential

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = 'api-keys-pepper-at-least-32-characters';
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

/** A business with an owner session. The API entitlement is granted separately. */
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

  await creditApiCapacity(created.businessId);
  return {
    businessId: created.businessId,
    auth: { authorization: `Bearer ${created.sessionToken}` },
  };
}

/**
 * Buy the API capacity this suite spends.
 *
 * §27 sells API units with the API product and no plan grants them (every
 * plan sells zero of all three, which is why the allowance comes from the
 * plan), so an entitled business with nothing bought is refused. That is
 * the product, not a test detail, and the two units are bought differently
 * because they are different kinds (PR-116): requests are CONSUMED, so they
 * are credited to the month; applications are HELD, so they arrive as an
 * add-on holding and are answered by counting what exists.
 */
async function creditApiCapacity(businessId: string): Promise<void> {
  const period = usagePeriod(new Date());
  await withBusiness(db, businessId, async (tx) => {
    await usageRepo.creditBonus(tx, businessId, period, 'API_REQUEST_UNITS', 1_000);
  });
  await grantCapacityAddOn(urls, businessId, 'API_APPLICATIONS', 20);
}

async function grantApi(businessId: string): Promise<void> {
  await withBusiness(db, businessId, (tx) =>
    entitlementsRepo.grant(tx, {
      businessId,
      entitlementKey: 'REKODA_API',
      source: 'MANUAL_GRANT',
      grantedBy: 'operator:api-keys-suite',
    }),
  );
}

/** Register an application and mint one key, returning the plaintext token. */
async function mint(
  auth: Record<string, string>,
  applicationName: string,
): Promise<{ applicationId: string; keyId: string; token: string }> {
  const application = (
    await post('/v1/api-keys/applications', { name: applicationName }, auth)
  ).json() as { id: string };
  const minted = (
    await post(`/v1/api-keys/applications/${application.id}/keys`, { label: 'server' }, auth)
  ).json() as { key: { id: string }; token: string };
  return { applicationId: application.id, keyId: minted.key.id, token: minted.token };
}

function asKey(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('minting keys', () => {
  it('hands the token back once and stores only its hash', async () => {
    const { businessId, auth } = await onboard('+2348190000001', 'Key Co');
    const { token, keyId } = await mint(auth, 'Storefront sync');

    const stored = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ token_hash: string; prefix: string }>(
        sql`SELECT token_hash, prefix FROM api_keys WHERE id = ${keyId}`,
      ),
    );
    const row = [...stored][0]!;
    expect(row.token_hash).not.toBe(token);
    expect(token.startsWith(row.prefix)).toBe(true);

    // And the whole row, every column, holds no substring of the secret.
    const columns = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ dump: string }>(
        sql`SELECT api_keys::text AS dump FROM api_keys WHERE id = ${keyId}`,
      ),
    );
    const secret = token.slice(row.prefix.length + 1);
    expect([...columns][0]!.dump).not.toContain(secret);
  });

  it('lists a key by its public half and never by its token', async () => {
    const { auth } = await onboard('+2348190000002', 'List Co');
    const { token } = await mint(auth, 'Reporting');

    const listed = (await get('/v1/api-keys', auth)).json() as {
      applications: { name: string }[];
      keys: { prefix: string }[];
    };
    expect(listed.applications.map((a) => a.name)).toEqual(['Reporting']);
    expect(listed.keys).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(token);
  });

  it('caps live keys per application, and a revoke makes room again', async () => {
    const { auth } = await onboard('+2348190000003', 'Rotate Co');
    const application = (
      await post('/v1/api-keys/applications', { name: 'Rotator' }, auth)
    ).json() as { id: string };

    const minted: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await post(`/v1/api-keys/applications/${application.id}/keys`, {}, auth);
      expect(response.statusCode).toBe(200);
      minted.push((response.json() as { key: { id: string } }).key.id);
    }

    expect(
      (await post(`/v1/api-keys/applications/${application.id}/keys`, {}, auth)).statusCode,
    ).toBe(400);

    expect((await post(`/v1/api-keys/keys/${minted[0]}/revoke`, {}, auth)).statusCode).toBe(200);
    expect(
      (await post(`/v1/api-keys/applications/${application.id}/keys`, {}, auth)).statusCode,
    ).toBe(200);
  });
});

describe('authenticating', () => {
  it('opens the API for an entitled business and names the business it opened', async () => {
    const { businessId, auth } = await onboard('+2348190000010', 'Entitled Co');
    await grantApi(businessId);
    const { token, applicationId } = await mint(auth, 'Integration');

    const response = await get('/api/v1/identity', asKey(token));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      businessId,
      businessName: 'Entitled Co',
      applicationId,
      rateLimitPerMinute: 120,
    });
  });

  it('refuses a business that never bought the API, whatever its plan', async () => {
    const { auth } = await onboard('+2348190000011', 'Unentitled Co');
    const { token } = await mint(auth, 'Integration');

    const response = await get('/api/v1/identity', asKey(token));
    expect(response.statusCode).toBe(403);
  });

  it('refuses a revoked key, a garbled key and a session token alike', async () => {
    const { businessId, auth } = await onboard('+2348190000012', 'Refusals Co');
    await grantApi(businessId);
    const { token, keyId } = await mint(auth, 'Integration');
    expect((await get('/api/v1/identity', asKey(token))).statusCode).toBe(200);

    await post(`/v1/api-keys/keys/${keyId}/revoke`, {}, auth);
    expect((await get('/api/v1/identity', asKey(token))).statusCode).toBe(401);

    expect((await get('/api/v1/identity', asKey('rk_live_deadbeef_nope'))).statusCode).toBe(401);
    expect((await get('/api/v1/identity', {})).statusCode).toBe(401);
    /* The merchant's own session is not an API credential, and the API key
     * is not a session. Neither door opens with the other's key. */
    expect((await get('/api/v1/identity', auth)).statusCode).toBe(401);
    expect((await get('/v1/api-keys', asKey(token))).statusCode).toBe(401);
  });

  it('refuses every key of a disabled application, without revoking any of them', async () => {
    const { businessId, auth } = await onboard('+2348190000013', 'Disabled Co');
    await grantApi(businessId);
    const { token, applicationId } = await mint(auth, 'Integration');

    await post(`/v1/api-keys/applications/${applicationId}/disable`, {}, auth);
    expect((await get('/api/v1/identity', asKey(token))).statusCode).toBe(401);

    await post(`/v1/api-keys/applications/${applicationId}/enable`, {}, auth);
    expect((await get('/api/v1/identity', asKey(token))).statusCode).toBe(200);
  });

  it('gives each business its own tenant, and no way to ask for another', async () => {
    const first = await onboard('+2348190000014', 'First Co');
    const second = await onboard('+2348190000015', 'Second Co');
    await grantApi(first.businessId);
    await grantApi(second.businessId);
    const firstKey = await mint(first.auth, 'Integration');

    const seen = (await get('/api/v1/identity', asKey(firstKey.token))).json() as {
      businessId: string;
    };
    expect(seen.businessId).toBe(first.businessId);
    expect(seen.businessId).not.toBe(second.businessId);

    /* Neither business can see the other's applications through the managed
     * surface either: RLS, not a WHERE clause somebody remembered. */
    const listed = (await get('/v1/api-keys', second.auth)).json() as { keys: unknown[] };
    expect(listed.keys).toEqual([]);
  });

  it('records last use, so a forgotten integration is visible', async () => {
    const { businessId, auth } = await onboard('+2348190000016', 'Used Co');
    await grantApi(businessId);
    const { token } = await mint(auth, 'Integration');

    const before = (await get('/v1/api-keys', auth)).json() as { keys: { lastUsedAt: null }[] };
    expect(before.keys[0]!.lastUsedAt).toBeNull();

    await get('/api/v1/identity', asKey(token));

    const after = (await get('/v1/api-keys', auth)).json() as {
      keys: { lastUsedAt: string | null }[];
    };
    expect(after.keys[0]!.lastUsedAt).not.toBeNull();
  });
});

describe('the rate limit', () => {
  it('refuses at the ceiling, counts per key, and says when to come back', async () => {
    const { businessId, auth } = await onboard('+2348190000020', 'Busy Co');
    await grantApi(businessId);
    const busy = await mint(auth, 'Chatty');
    const quiet = await mint(auth, 'Polite');

    /* Three a minute, so the ceiling is reachable without three hundred
     * requests. The limit is a column precisely so it can differ per key. */
    await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`UPDATE api_keys SET rate_limit_per_minute = 3 WHERE id = ${busy.keyId}`),
    );

    for (let i = 0; i < 3; i += 1) {
      expect((await get('/api/v1/identity', asKey(busy.token))).statusCode).toBe(200);
    }

    const refused = await get('/api/v1/identity', asKey(busy.token));
    expect(refused.statusCode).toBe(429);
    /* The public envelope, not Nest's body: the shape is PR-110's, and the
     * ceiling this suite is about is what fills it in. */
    const body = refused.json() as { error: { code: string; retryAfterSeconds: number } };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.error.retryAfterSeconds).toBeLessThanOrEqual(60);

    /* The other key of the same business is untouched. One noisy
     * integration must not spend another's headroom. */
    expect((await get('/api/v1/identity', asKey(quiet.token))).statusCode).toBe(200);
  });

  it('spends no room on a key that is refused before the ceiling is reached', async () => {
    const { businessId, auth } = await onboard('+2348190000021', 'Unpaid Co');
    const { token, keyId } = await mint(auth, 'Integration');

    // No entitlement: three attempts, all 403.
    for (let i = 0; i < 3; i += 1) {
      expect((await get('/api/v1/identity', asKey(token))).statusCode).toBe(403);
    }

    const windows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM api_key_rate_windows WHERE api_key_id = ${keyId}`,
      ),
    );
    expect([...windows][0]!.n).toBe(0);
  });
});
