/**
 * The Developer API Starter, as a merchant actually experiences it
 * (PR-117, migration 0113).
 *
 * The figures landed as catalogue data; this suite proves the product they
 * describe works end to end, which is a different claim. One purchase has
 * to open the door, permit one application, fund a month of requests, and
 * show up on the page the merchant reads when they wonder what they are
 * paying for. Each of those is a different mechanism (an entitlement, a
 * capacity grant, a monthly grant, a holding), and a figure seeded into a
 * table nobody reads would pass a catalogue test and sell nothing.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { billingOverviewResponse } from '@rekoda/contracts';
import { usagePeriod } from '@rekoda/core';
import { createDb, entitlementsRepo, withBusiness, type Db } from '@rekoda/db';
import {
  holdAddOn,
  migrate,
  requireUrls,
  resetPlanCatalogue,
  truncateAll,
  type Urls,
} from '@rekoda/db/testing';
import { meterAllowance, standingCapacity } from './plan-terms.js';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  /* Truncate BEFORE resetting the catalogue: `resetPlanCatalogue`
   * deletes the `test_%` add-ons a previous suite may have invented,
   * and a business still holding one makes that a foreign-key
   * violation. The suites run serially in one process, so "a previous
   * suite" is an ordinary state here, not a rare one. */
  await truncateAll(urls);
  await resetPlanCatalogue(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = 'api-product-pepper-at-least-32-chars';
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_API_SECRET'] = 'api-product-secret-at-least-32-chars';
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
  await resetPlanCatalogue(urls);
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

/** A signed-in owner of a fresh business. */
async function signUp(
  phone: string,
  name: string,
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
  return {
    businessId: created.businessId,
    auth: { authorization: `Bearer ${created.sessionToken}` },
  };
}

describe('one purchase opens the whole API', () => {
  it('grants the entitlement, one application and a month of each consumable', async () => {
    const shop = await signUp('+2348196000001', 'Starter Co');
    const config = { planCatalogueReads: true };

    /* Before: nothing. §27 puts the API in no plan, so a merchant who has
     * not bought it holds none of the four things it grants. */
    await withBusiness(db, shop.businessId, async (tx) => {
      expect(await entitlementsRepo.resolve(tx, shop.businessId)).not.toContain('REKODA_API');
      expect(await standingCapacity(config, tx, shop.businessId, 'trial', 'API_APPLICATIONS')).toBe(
        0,
      );
      expect(await meterAllowance(config, tx, shop.businessId, 'trial', 'API_REQUEST_UNITS')).toBe(
        0,
      );
    });

    await holdAddOn(urls, shop.businessId, 'developer_api_starter');

    await withBusiness(db, shop.businessId, async (tx) => {
      expect(await entitlementsRepo.resolve(tx, shop.businessId)).toContain('REKODA_API');
      expect(await standingCapacity(config, tx, shop.businessId, 'trial', 'API_APPLICATIONS')).toBe(
        1,
      );
      expect(await meterAllowance(config, tx, shop.businessId, 'trial', 'API_REQUEST_UNITS')).toBe(
        25_000,
      );
      expect(await meterAllowance(config, tx, shop.businessId, 'trial', 'WEBHOOK_DELIVERIES')).toBe(
        25_000,
      );
    });
  });

  it('permits exactly the one application it sells, and a second add-on buys a second', async () => {
    const shop = await signUp('+2348196000002', 'One App Co');
    await holdAddOn(urls, shop.businessId, 'developer_api_starter');

    expect((await post('/v1/api-keys/applications', { name: 'First' }, shop.auth)).statusCode).toBe(
      200,
    );

    const refused = await post('/v1/api-keys/applications', { name: 'Second' }, shop.auth);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ message: expect.stringContaining('may hold 1') });

    /* `api_application_extra` is recurring capacity, so holding it raises
     * the standing ceiling rather than crediting a month. */
    await holdAddOn(urls, shop.businessId, 'api_application_extra');
    expect(
      (await post('/v1/api-keys/applications', { name: 'Second' }, shop.auth)).statusCode,
    ).toBe(200);
  });

  it('serves a real API call against the month the add-on funded', async () => {
    const shop = await signUp('+2348196000003', 'Calling Co');
    await holdAddOn(urls, shop.businessId, 'developer_api_starter');

    const application = (
      await post('/v1/api-keys/applications', { name: 'Live' }, shop.auth)
    ).json() as { id: string };
    const minted = (
      await post(`/v1/api-keys/applications/${application.id}/keys`, {}, shop.auth)
    ).json() as { token: string };

    expect(
      (await get('/api/v1/identity', { authorization: `Bearer ${minted.token}` })).statusCode,
    ).toBe(200);
  });
});

describe('the billing page tells the truth about what was bought', () => {
  it('names the add-on and offers the top-ups only to a holder', async () => {
    const holder = await signUp('+2348196000010', 'Holder Co');
    const other = await signUp('+2348196000011', 'Plain Co');
    await holdAddOn(urls, holder.businessId, 'developer_api_starter');

    const held = billingOverviewResponse.parse((await get('/v1/billing', holder.auth)).json());
    expect(held.addOns).toMatchObject([{ addOnId: 'developer_api_starter', endsAt: null }]);
    expect(held.period).toBe(usagePeriod(new Date()));

    /* A trial sells no plan at all, so no pack is offered to either: a pack
     * is overage on a paid plan by definition. What differs is the API
     * units' ceiling, which the holder has and the other does not. */
    const plain = billingOverviewResponse.parse((await get('/v1/billing', other.auth)).json());
    expect(plain.addOns).toEqual([]);

    const requestsOf = (overview: typeof held) =>
      overview.units.find((unit) => unit.unit === 'API_REQUEST_UNITS')?.allowance;
    expect(requestsOf(held)).toBe(25_000);
    expect(requestsOf(plain)).toBe(0);
  });
});
