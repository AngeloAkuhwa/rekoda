/**
 * The API's three meters (PR-113, canonical spec §27, §4.2).
 *
 * §27 requires API usage to be "metered … and gated by entitlement like
 * everything else". The entitlement gate landed with the keys; this suite is
 * about the meters, and the property that matters most is the one that makes
 * them real: every plan sells ZERO of these units, so a business is bounded
 * by what the API product credited and by nothing else.
 *
 *   API_REQUEST_UNITS    consumable: one per authenticated request, taken
 *                        behind the per-minute ceiling so a flood cannot
 *                        burn a month.
 *   API_APPLICATIONS     capacity: held rather than spent, so the ceiling
 *                        comes from an add-on holding and the answer comes
 *                        from counting what exists (PR-116).
 *   WEBHOOK_DELIVERIES   consumable: one per delivery, refunded on every
 *                        attempt that delivered nothing.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { publicApi } from '@rekoda/contracts';
import { usagePeriod } from '@rekoda/core';
import { createDb, entitlementsRepo, usageRepo, withBusiness, type Db } from '@rekoda/db';
import { meterAllowance, standingCapacity } from '../billing/plan-terms.js';
import {
  grantCapacityAddOn,
  migrate,
  requireUrls,
  truncateAll,
  type Urls,
} from '@rekoda/db/testing';

const SECRET = 'api-metering-secret-at-least-32-chars';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = 'api-metering-pepper-at-least-32-chars';
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

/** An entitled business, with exactly the capacity the caller names. */
async function entitled(
  phone: string,
  name: string,
  capacity: { requests?: number; applications?: number },
): Promise<{ businessId: string; auth: Record<string, string> }> {
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

  const period = usagePeriod(new Date());
  await withBusiness(db, created.businessId, async (tx) => {
    await entitlementsRepo.grant(tx, {
      businessId: created.businessId,
      entitlementKey: 'REKODA_API',
      source: 'MANUAL_GRANT',
      grantedBy: 'operator:metering-suite',
    });
    if (capacity.requests !== undefined) {
      await usageRepo.creditBonus(
        tx,
        created.businessId,
        period,
        'API_REQUEST_UNITS',
        capacity.requests,
      );
    }
  });

  /* Capacity is HELD, not credited: API_APPLICATIONS never touches the
   * monthly meter, so the ceiling arrives as an add-on the business holds
   * (PR-116). Crediting a bonus here is exactly the mistake this suite
   * exists to prevent, and `check-boundaries` refuses it in source. */
  if (capacity.applications !== undefined) {
    await grantCapacityAddOn(urls, created.businessId, 'API_APPLICATIONS', capacity.applications);
  }

  return {
    businessId: created.businessId,
    auth: { authorization: `Bearer ${created.sessionToken}` },
  };
}

async function mintKey(auth: Record<string, string>, name: string): Promise<string> {
  const application = (await post('/v1/api-keys/applications', { name }, auth)).json() as {
    id: string;
  };
  const minted = (
    await post(`/v1/api-keys/applications/${application.id}/keys`, {}, auth)
  ).json() as { token: string };
  return minted.token;
}

async function used(businessId: string, unit: string): Promise<number> {
  const rows = await withBusiness(db, businessId, (tx) =>
    usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
  );
  return rows.find((row) => row.unit === unit)?.used ?? 0;
}

describe('API_REQUEST_UNITS', () => {
  it('moves once per authenticated request, and not at all for a refused one', async () => {
    const shop = await entitled('+2348195000001', 'Metered Co', {
      requests: 10,
      applications: 5,
    });
    const token = await mintKey(shop.auth, 'Metered app');
    const key = { authorization: `Bearer ${token}` };

    expect((await get('/api/v1/identity', key)).statusCode).toBe(200);
    expect((await get('/api/v1/identity', key)).statusCode).toBe(200);
    expect(await used(shop.businessId, 'API_REQUEST_UNITS')).toBe(2);

    /* A refused credential never reaches the meter: the chain is shape →
     * resolve → validity → entitlement → rate limit → meter. */
    expect(
      (await get('/api/v1/identity', { authorization: 'Bearer rk_live_dead_beef' })).statusCode,
    ).toBe(401);
    expect(await used(shop.businessId, 'API_REQUEST_UNITS')).toBe(2);
  });

  it('refuses with quota_exhausted once the month is spent, and says so distinctly', async () => {
    const shop = await entitled('+2348195000002', 'Spent Co', { requests: 1, applications: 5 });
    const key = { authorization: `Bearer ${await mintKey(shop.auth, 'Spent app')}` };

    expect((await get('/api/v1/identity', key)).statusCode).toBe(200);

    const refused = await get('/api/v1/identity', key);
    expect(refused.statusCode).toBe(429);
    const body = publicApi.v1.publicErrorResponse.parse(refused.json());
    expect(body.error.code).toBe('quota_exhausted');
    /* No Retry-After: waiting will not help, and telling a caller to come
     * back in a minute when the month is spent teaches them to keep
     * failing. That is the whole reason this is not `rate_limited`. */
    expect(body.error.retryAfterSeconds).toBeUndefined();
    expect(refused.headers['retry-after']).toBeUndefined();
  });

  it('refuses a business that bought the API and no capacity', async () => {
    const shop = await entitled('+2348195000003', 'Capacityless Co', { applications: 5 });
    const key = { authorization: `Bearer ${await mintKey(shop.auth, 'Nothing app')}` };

    const refused = await get('/api/v1/identity', key);
    expect(refused.statusCode).toBe(429);
    expect(publicApi.v1.publicErrorResponse.parse(refused.json()).error.code).toBe(
      'quota_exhausted',
    );
  });

  it("meters the Merchant API's reads and writes on the same counter", async () => {
    const shop = await entitled('+2348195000004', 'Both Co', { requests: 10, applications: 5 });
    const key = { authorization: `Bearer ${await mintKey(shop.auth, 'Both app')}` };

    await get('/api/v1/invoices', key);
    await post(
      '/api/v1/sales',
      { items: [{ name: 'Rice', quantity: 1, unitPriceK: 100_000 }] },
      key,
    );
    expect(await used(shop.businessId, 'API_REQUEST_UNITS')).toBe(2);
  });
});

describe('API_APPLICATIONS is capacity, not a monthly tally', () => {
  it('refuses the one past the standing ceiling', async () => {
    const shop = await entitled('+2348195000010', 'Apps Co', { requests: 10, applications: 2 });

    expect((await post('/v1/api-keys/applications', { name: 'One' }, shop.auth)).statusCode).toBe(
      200,
    );
    expect((await post('/v1/api-keys/applications', { name: 'Two' }, shop.auth)).statusCode).toBe(
      200,
    );

    const refused = await post('/v1/api-keys/applications', { name: 'Three' }, shop.auth);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ message: expect.stringContaining('may hold 2') });

    /* The refusal wrote nothing: a merchant refused has the applications
     * they had before they asked. */
    const listed = (await get('/v1/api-keys', shop.auth)).json() as { applications: unknown[] };
    expect(listed.applications).toHaveLength(2);
  });

  it('frees the slot when an application is disabled', async () => {
    const shop = await entitled('+2348195000011', 'Freed Co', { requests: 10, applications: 1 });
    const created = (
      await post('/v1/api-keys/applications', { name: 'First' }, shop.auth)
    ).json() as { id: string };

    /* At the ceiling, so the second is refused. */
    expect(
      (await post('/v1/api-keys/applications', { name: 'Second' }, shop.auth)).statusCode,
    ).toBe(403);

    await post(`/v1/api-keys/applications/${created.id}/disable`, {}, shop.auth);

    /* This is the behaviour PR-113 got wrong. A monthly tally counts
     * EVENTS, so the merchant had spent their registration and would have
     * waited for the month to turn over even though they now hold nothing.
     * Capacity counts what is THERE. */
    expect(
      (await post('/v1/api-keys/applications', { name: 'Second' }, shop.auth)).statusCode,
    ).toBe(200);
  });

  it('never writes a usage counter for a held thing', async () => {
    const shop = await entitled('+2348195000012', 'Uncounted Co', {
      requests: 10,
      applications: 3,
    });
    await post('/v1/api-keys/applications', { name: 'One' }, shop.auth);

    /* `usage_counters.used` means "spent this period", and a held thing is
     * not spent. A row here would be a lie about what happened. */
    expect(await used(shop.businessId, 'API_APPLICATIONS')).toBe(0);
  });
});

describe("the two seams refuse each other's units", () => {
  it('will not answer a capacity question as an allowance, or the reverse', async () => {
    const shop = await entitled('+2348195000030', 'Confused Co', { requests: 10 });
    const config = { planCatalogueReads: true };

    await withBusiness(db, shop.businessId, async (tx) => {
      /* A silent answer is how the confusion returns: a number from
       * `meterAllowance` is a number the meter will decrement, and
       * decrementing a held thing is the PR-113 bug. */
      await expect(
        meterAllowance(config, tx, shop.businessId, 'chat', 'API_APPLICATIONS'),
      ).rejects.toThrow(/standingCapacity/);

      await expect(
        standingCapacity(config, tx, shop.businessId, 'chat', 'API_REQUEST_UNITS'),
      ).rejects.toThrow(/meterAllowance/);
    });
  });
});
