/**
 * The write matrix, enforced at the edge (spec §35).
 *
 * RLS answers "which tenant" and nothing else: an invited accountant passes
 * every row policy in the business, so the ONLY thing between a view-only
 * member and a journal entry is the RolesGuard on the route. These tests are
 * the list of doors and who each one opens for, checked over a real Nest
 * application so a forgotten decorator fails here rather than in production.
 *
 * The assertion style is deliberate: 403 proves the guard fired; any OTHER
 * status (200, 400, 404) proves it did not, without needing a fixture that
 * makes the whole write succeed. A 400 from zod means the request got past
 * the guard and died on its body, which is exactly what "allowed" means at
 * this layer.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { billingRepo, createDb, usageRepo, withBusiness, type Db } from '@rekoda/db';
import { usagePeriod } from '@rekoda/core';
import {
  grantCapacityAddOn,
  migrate,
  requireUrls,
  truncateAll,
  type Urls,
} from '@rekoda/db/testing';

const SECRET = 'roles-secret-at-least-32-characters-long';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = 'roles-pepper-at-least-32-characters-long';
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

async function signIn(phone: string): Promise<Record<string, string>> {
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as {
    devCode?: string;
  };
  const verified = (
    await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
  ).json() as { sessionToken?: string; setupToken?: string };
  return verified.sessionToken
    ? { authorization: `Bearer ${verified.sessionToken}` }
    : { 'x-rekoda-setup-token': verified.setupToken! };
}

/** Owner, accountant and delegate of one business, each holding a session. */
async function team(seed: string): Promise<{
  owner: Record<string, string>;
  accountant: Record<string, string>;
  delegate: Record<string, string>;
}> {
  const ownerPhone = `+23481402${seed}1`;
  const accountantPhone = `+23481402${seed}2`;
  const delegatePhone = `+23481402${seed}3`;

  const setup = await signIn(ownerPhone);
  const created = (
    await post('/v1/businesses', { name: 'Matrix Ltd', businessType: null }, setup)
  ).json() as { sessionToken: string; businessId: string };
  const owner = { authorization: `Bearer ${created.sessionToken}` };

  /* A business running all three roles is a Complete-shaped business: the
   * seat table (SEATS_PER_PLAN) now refuses a trial's second invite, which
   * is the product working, not this suite's subject. */
  await billingRepo.setPlan(db, {
    businessId: created.businessId,
    plan: 'complete',
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    actor: 'operator:roles-suite',
  });

  /* The API units are sold with the API product, never with a plan (spec
   * §27), so the owner's application door below opens only once capacity
   * exists. Applications are HELD rather than spent (PR-116), so the
   * capacity arrives as an add-on holding, not a monthly credit. */
  await grantCapacityAddOn(urls, created.businessId, 'API_APPLICATIONS', 5);

  await post('/v1/businesses/members', { phone: accountantPhone, role: 'accountant' }, owner);
  await post('/v1/businesses/members', { phone: delegatePhone, role: 'delegate' }, owner);

  return {
    owner,
    accountant: await signIn(accountantPhone),
    delegate: await signIn(delegatePhone),
  };
}

describe('what an accountant may do', () => {
  it('reads every page and every export', async () => {
    const { accountant } = await team('0100');
    expect((await get('/v1/reports/overview', accountant)).statusCode).toBe(200);
    expect((await get('/v1/reports/statements?period=2026-08', accountant)).statusCode).toBe(200);
    expect((await get('/v1/reports/invoices.csv', accountant)).statusCode).toBe(200);
    expect((await get('/v1/bank/position', accountant)).statusCode).toBe(200);
    expect((await get('/v1/billing', accountant)).statusCode).toBe(200);
    expect((await get('/v1/catalogue', accountant)).statusCode).toBe(200);
    expect((await get('/v1/shop-settings', accountant)).statusCode).toBe(200);
  });

  it('reconciles the bank, which is accountant work', async () => {
    const { accountant } = await team('0101');
    // 400, not 403: past the guard, refused by the body schema.
    expect((await post('/v1/bank/match', {}, accountant)).statusCode).toBe(400);
    expect((await post('/v1/bank/statement', {}, accountant)).statusCode).toBe(400);
  });

  it('cannot change the books, spend money, or delete anything', async () => {
    const { accountant } = await team('0102');
    const doors = [
      ['/v1/reports/invoices/void', {}],
      ['/v1/reports/invoices/credit', {}],
      ['/v1/reports/payments/record', {}],
      ['/v1/reports/expenses/void', {}],
      ['/v1/reports/assets', {}],
      ['/v1/reports/suppliers/pay', {}],
      ['/v1/reports/opening-balances', {}],
      ['/v1/reports/stock-count', {}],
      ['/v1/reports/journal', {}],
      ['/v1/reports/close', {}],
      ['/v1/reports/reopen', {}],
      ['/v1/reports/expenses/recurring', {}],
      ['/v1/bank/statement/forget', {}],
      ['/v1/billing/plan', { plan: 'complete' }],
      ['/v1/billing/packs', { packId: 'docs-100' }],
      ['/v1/catalogue/product', {}],
      ['/v1/shop-settings', {}],
      /* Minting an API key is standing access to the whole business that
       * outlives every sign-out. Owner only (spec §27). */
      ['/v1/api-keys/applications', { name: 'Accountant app' }],
      /* A webhook endpoint is a standing copy of the books going somewhere
       * the owner chose, and it outlives every sign-out (spec §26). */
      ['/v1/webhooks', { url: 'https://accountant.test/hook' }],
    ] as const;
    for (const [url, payload] of doors) {
      expect((await post(url, payload, accountant)).statusCode, url).toBe(403);
    }
  });
});

describe('what a delegate may do', () => {
  it('records day-to-day trade', async () => {
    const { delegate } = await team('0103');
    // Past the guard on each: refused by the body, not the role.
    expect((await post('/v1/reports/payments/record', {}, delegate)).statusCode).toBe(400);
    expect((await post('/v1/reports/suppliers/pay', {}, delegate)).statusCode).toBe(400);
    expect((await post('/v1/reports/stock-count', {}, delegate)).statusCode).toBe(400);
    expect((await post('/v1/catalogue/product', {}, delegate)).statusCode).toBe(400);
  });

  it('cannot rewrite history, reconcile, or spend the owner money', async () => {
    const { delegate } = await team('0104');
    const doors = [
      ['/v1/reports/journal', {}],
      ['/v1/reports/invoices/void', {}],
      ['/v1/reports/close', {}],
      ['/v1/bank/match', {}],
      ['/v1/bank/statement/forget', {}],
      ['/v1/billing/plan', { plan: 'complete' }],
      ['/v1/shop-settings', {}],
      ['/v1/api-keys/applications', { name: 'Delegate app' }],
      ['/v1/webhooks', { url: 'https://delegate.test/hook' }],
    ] as const;
    for (const [url, payload] of doors) {
      expect((await post(url, payload, delegate)).statusCode, url).toBe(403);
    }
  });
});

describe('what the owner may do', () => {
  it('opens every door the others found locked', async () => {
    const { owner } = await team('0105');
    // 400s: past every guard, refused only by empty bodies.
    expect((await post('/v1/reports/journal', {}, owner)).statusCode).toBe(400);
    expect((await post('/v1/bank/statement/forget', {}, owner)).statusCode).toBe(400);
    expect((await post('/v1/billing/packs', {}, owner)).statusCode).toBe(400);
    // The shop route answers a bad body with {outcome: 'bad_slug'} and 200,
    // so "past the guard" here is simply "anything but 403".
    expect((await post('/v1/shop-settings', {}, owner)).statusCode).not.toBe(403);
    expect((await post('/v1/api-keys/applications', { name: 'Owner app' }, owner)).statusCode).toBe(
      200,
    );
    expect((await post('/v1/webhooks', { url: 'https://owner.test/hook' }, owner)).statusCode).toBe(
      200,
    );
  });
});
