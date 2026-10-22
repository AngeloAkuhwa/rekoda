/**
 * A lapsed plan keeps the books readable and records nothing new (G-44).
 *
 * `MANUAL_BOOKKEEPING` is a shared capability that a plan of `expired` loses
 * (`hasCapability`), spec §4.5 keeps existing books readable and existing
 * invoices collectible, and a lapsed trial "is a plan whose every allowance is
 * zero". The dashboard's bookkeeping doors carried no plan check at all, so a
 * business whose trial ended could still post journals, assets and stock
 * counts. Same assertion style as the write matrix: 403 proves the plan guard
 * fired, 400 proves the request got past it and died on its empty body.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { billingRepo, createDb, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';

const SECRET = randomBytes(24).toString('hex');

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
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

/** Past the plan guard: the route exists and answered, and it was not the plan that refused. */
function expectPastPlanGuard(res: { statusCode: number }, url: string): void {
  expect(res.statusCode, url).not.toBe(403);
  expect(res.statusCode, url).not.toBe(404);
  expect(res.statusCode, url).toBeLessThan(500);
}

function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, payload: payload as object, headers });
}

async function ownerOf(
  seed: string,
): Promise<{ owner: Record<string, string>; businessId: string }> {
  const phone = `+23481403${seed}0`;
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as { devCode?: string };
  const verified = (
    await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
  ).json() as {
    setupToken: string;
  };
  const created = (
    await post(
      '/v1/businesses',
      { name: 'Lapse Ltd', businessType: null },
      { 'x-rekoda-setup-token': verified.setupToken },
    )
  ).json() as { sessionToken: string; businessId: string };
  return {
    owner: { authorization: `Bearer ${created.sessionToken}` },
    businessId: created.businessId,
  };
}

async function lapse(businessId: string): Promise<void> {
  await billingRepo.setPlan(db, {
    businessId,
    plan: 'expired',
    expiresAt: null,
    actor: 'operator:g44',
  });
}

/** New bookkeeping: each one adds a record or starts new work. */
const REFUSED_WHEN_LAPSED = [
  '/v1/reports/quotes',
  '/v1/reports/quotes/convert',
  '/v1/reports/purchase-orders',
  '/v1/reports/purchase-orders/receive',
  '/v1/reports/assets',
  '/v1/reports/opening-balances',
  '/v1/reports/stock-count',
  '/v1/reports/journal',
  '/v1/reports/expenses/recurring',
  '/v1/bank/statement',
  '/v1/bank/feed/connect',
  '/v1/bank/feed/sync',
  '/v1/bank/match',
  '/v1/bank/classify',
  '/v1/bank/reconcile',
] as const;

/** Collecting, correcting, stopping and deleting what already exists. */
const KEPT_WHEN_LAPSED = [
  '/v1/reports/payments/record',
  '/v1/reports/suppliers/pay',
  '/v1/reports/invoices/void',
  '/v1/reports/invoices/credit',
  '/v1/reports/expenses/void',
  '/v1/reports/expenses/recurring/stop',
  '/v1/reports/quotes/cancel',
  '/v1/reports/purchase-orders/cancel',
  '/v1/reports/assets/dispose',
  '/v1/reports/assets/withdraw',
  '/v1/reports/close',
  '/v1/reports/reopen',
  '/v1/bank/unmatch',
  '/v1/bank/statement/forget',
  '/v1/billing/plan',
  '/v1/billing/cancel',
] as const;

describe('a lapsed plan (G-44)', () => {
  it('refuses new bookkeeping, and says the records are safe', async () => {
    const { owner, businessId } = await ownerOf('0001');
    await lapse(businessId);
    for (const url of REFUSED_WHEN_LAPSED) {
      const res = await post(url, {}, owner);
      expect(res.statusCode, url).toBe(403);
      expect((res.json() as { message: string }).message, url).toMatch(/records are safe/i);
    }
  });

  it('still lets the merchant collect, correct, stop, delete and pay', async () => {
    const { owner, businessId } = await ownerOf('0002');
    await lapse(businessId);
    for (const url of KEPT_WHEN_LAPSED) {
      // Past the plan guard: not 403 for the plan (a body error is the proof).
      expectPastPlanGuard(await post(url, {}, owner), url);
    }
  });

  it('refuses nothing on a live plan', async () => {
    const { owner, businessId } = await ownerOf('0003');
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'complete',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      actor: 'operator:g44',
    });
    for (const url of REFUSED_WHEN_LAPSED) {
      expectPastPlanGuard(await post(url, {}, owner), url);
    }
  });

  it('refuses a trial whose date has passed, though the plan is still stored as trial', async () => {
    const { owner, businessId } = await ownerOf('0005');
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'trial',
      expiresAt: new Date(Date.now() - 86_400_000),
      actor: 'operator:g44',
    });
    for (const url of REFUSED_WHEN_LAPSED) {
      const res = await post(url, {}, owner);
      expect(res.statusCode, url).toBe(403);
    }
    // A trial still inside its 14 days is not lapsed.
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'trial',
      expiresAt: new Date(Date.now() + 86_400_000),
      actor: 'operator:g44',
    });
    for (const url of REFUSED_WHEN_LAPSED) {
      expectPastPlanGuard(await post(url, {}, owner), url);
    }
  });

  it('opens again the moment a plan is bought', async () => {
    const { owner, businessId } = await ownerOf('0004');
    await lapse(businessId);
    expect((await post('/v1/reports/journal', {}, owner)).statusCode).toBe(403);
    await billingRepo.setPlan(db, {
      businessId,
      plan: 'chat',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      actor: 'operator:g44',
    });
    expect((await post('/v1/reports/journal', {}, owner)).statusCode).toBe(400);
  });
});
