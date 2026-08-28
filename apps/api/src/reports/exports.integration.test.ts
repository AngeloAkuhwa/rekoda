/**
 * What an export costs, and what it must never cost (PR-118).
 *
 * Two rules the 28 August owner ruling put next to each other, and the
 * whole point of this suite is that they stay next to each other:
 *
 *   A GENERATED FILE is a produced artefact with a real cost, so it spends
 *   a `REPORT_EXPORTS` unit. Reading the same figures on a page does not.
 *
 *   TAKING YOUR OWN DATA OUT is a right, so it spends nothing, on any plan,
 *   including the lapsed one where `REPORT_EXPORTS` sells zero. That is
 *   exactly when it matters: a merchant who cannot leave with their records
 *   is held hostage by a billing state.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { usagePeriod } from '@rekoda/core';
import { billingRepo, createDb, usageRepo, withBusiness, type Db } from '@rekoda/db';
import {
  migrate,
  requireUrls,
  resetPlanCatalogue,
  truncateAll,
  type Urls,
} from '@rekoda/db/testing';
import { meterAllowance } from '../billing/plan-terms.js';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  await resetPlanCatalogue(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = 'exports-pepper-at-least-32-characters';
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_API_SECRET'] = 'exports-secret-at-least-32-characters';
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

async function onPlan(businessId: string, plan: string): Promise<void> {
  await billingRepo.setPlan(db, { businessId, plan, expiresAt: null, actor: 'operator:test' });
}

async function used(businessId: string): Promise<number> {
  const rows = await withBusiness(db, businessId, (tx) =>
    usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
  );
  return rows.find((row) => row.unit === 'REPORT_EXPORTS')?.used ?? 0;
}

/** Leave exactly `remaining` of the month's exports unspent. */
async function spendDownTo(businessId: string, plan: string, remaining: number): Promise<number> {
  const allowance = await withBusiness(db, businessId, (tx) =>
    meterAllowance({ planCatalogueReads: true }, tx, businessId, plan, 'REPORT_EXPORTS'),
  );
  const toSpend = allowance - remaining;
  if (toSpend > 0) {
    await withBusiness(db, businessId, (tx) =>
      usageRepo.consumeUnit(
        tx,
        businessId,
        usagePeriod(new Date()),
        'REPORT_EXPORTS',
        allowance,
        toSpend,
      ),
    );
  }
  return allowance;
}

describe('a generated file costs a unit', () => {
  it('charges one per file and nothing for reading the same figures', async () => {
    const shop = await signUp('+2348194000001', 'Exporting Co');
    await onPlan(shop.businessId, 'chat');

    /* The page is free. This is the half of the ruling that is easy to lose
     * in a refactor: metering a READ would be charging a merchant to look
     * at their own accounts. */
    expect((await get('/v1/reports/overview', shop.auth)).statusCode).toBe(200);
    expect((await get('/v1/reports/stock', shop.auth)).statusCode).toBe(200);
    expect(await used(shop.businessId)).toBe(0);

    expect((await get('/v1/reports/invoices.csv', shop.auth)).statusCode).toBe(200);
    expect(await used(shop.businessId)).toBe(1);
    expect((await get('/v1/reports/stock.csv', shop.auth)).statusCode).toBe(200);
    expect((await get('/v1/reports/expenses.csv', shop.auth)).statusCode).toBe(200);
    expect(await used(shop.businessId)).toBe(3);
  });

  it('refuses past the month and says what to do instead', async () => {
    const shop = await signUp('+2348194000002', 'Spent Co');
    await onPlan(shop.businessId, 'chat');
    const allowance = await spendDownTo(shop.businessId, 'chat', 1);
    expect(allowance).toBe(50);

    expect((await get('/v1/reports/invoices.csv', shop.auth)).statusCode).toBe(200);

    const refused = await get('/v1/reports/invoices.csv', shop.auth);
    expect(refused.statusCode).toBe(429);
    /* The refusal names the way out. A merchant told only "no" opens a
     * support ticket; one told where the free export lives does not. */
    expect(refused.json()).toMatchObject({
      message: expect.stringContaining('never counts against this'),
    });

    /* And the refusal consumed nothing: the counter sits exactly at the
     * allowance, not one past it. */
    expect(await used(shop.businessId)).toBe(allowance);
  });

  it('refuses an expired business every generated file, because expired sells zero', async () => {
    const shop = await signUp('+2348194000003', 'Lapsed Co');
    await onPlan(shop.businessId, 'expired');

    expect((await get('/v1/reports/invoices.csv', shop.auth)).statusCode).toBe(429);
    expect((await get('/v1/reports/statements.xlsx?period=2026-08', shop.auth)).statusCode).toBe(
      429,
    );
    /* Reading is still free, which is ADR 0024's read-only promise. */
    expect((await get('/v1/reports/overview', shop.auth)).statusCode).toBe(200);
  });
});

describe('taking your own data out is never metered', () => {
  it('works for the expired business that every other export refuses', async () => {
    const shop = await signUp('+2348194000010', 'Leaving Co');
    await onPlan(shop.businessId, 'expired');

    expect((await get('/v1/reports/invoices.csv', shop.auth)).statusCode).toBe(429);

    const taken = await get('/v1/reports/portability.json', shop.auth);
    expect(taken.statusCode).toBe(200);
    expect(taken.headers['content-disposition']).toContain('attachment');
    expect(await used(shop.businessId)).toBe(0);

    const body = JSON.parse(taken.body) as {
      format: string;
      business: { id: string };
      invoices: unknown[];
      notes: string[];
    };
    expect(body.format).toBe('rekoda.portability.v1');
    expect(body.business.id).toBe(shop.businessId);
    expect(Array.isArray(body.invoices)).toBe(true);
    expect(body.notes.join(' ')).toContain('integer kobo');
  });

  it('does not spend a unit even when the month is untouched', async () => {
    const shop = await signUp('+2348194000011', 'Careful Co');
    await onPlan(shop.businessId, 'complete');

    expect((await get('/v1/reports/portability.json', shop.auth)).statusCode).toBe(200);
    expect(await used(shop.businessId)).toBe(0);
  });

  it('throttles the second request rather than refusing it, and says when', async () => {
    const shop = await signUp('+2348194000012', 'Looping Co');
    await onPlan(shop.businessId, 'complete');

    expect((await get('/v1/reports/portability.json', shop.auth)).statusCode).toBe(200);

    const again = await get('/v1/reports/portability.json', shop.auth);
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ message: expect.stringContaining('Try again after') });
  });
});
