/**
 * OD-50 (migration 0213), over real HTTP: `POST /v1/businesses/plan/support-review` moves a
 * merchant whose own upgrade went to support review onto the reviewed plan and keeps the
 * paid-through date exactly as it is.
 *
 * The journey is the real one: an operator-assigned cycle, the owner asking to upgrade on the
 * billing route (answered `support_review`, which records the request), then the operator's
 * resolution. A date in the body is refused; so is a business with no review, a trial, an expired
 * plan, and a caller with no operator identity. The normal assignment route still runs standard
 * periods. The database rules themselves are pinned in
 * `packages/db/src/billing/support-review-plan-change.integration.test.ts`.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const OPERATOR_SECRET = `operator-${randomBytes(24).toString('hex')}`;
const OPERATOR = { 'x-rekoda-operator-secret': OPERATOR_SECRET };

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['REKODA_OPERATOR_SECRET'] = OPERATOR_SECRET;
  process.env['REKODA_REVEAL_OTP'] = '1';
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  process.env['REKODA_WEB_URL'] = 'https://books.example.test';
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
});

beforeEach(async () => {
  await truncateAll(urls);
});

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers });

async function ownerOf(
  phone: string,
): Promise<{ businessId: string; auth: { authorization: string } }> {
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as { devCode: string };
  const verified = (
    await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
  ).json() as { setupToken: string };
  const created = (
    await post(
      '/v1/businesses',
      { name: 'Ada Fashion', businessType: 'Fashion & clothing' },
      { 'x-rekoda-setup-token': verified.setupToken },
    )
  ).json() as { businessId: string; sessionToken: string };
  return {
    businessId: created.businessId,
    auth: { authorization: `Bearer ${created.sessionToken}` },
  };
}

const subscription = (businessId: string) =>
  withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{
      plan: string;
      plan_expires_at: string;
      cycle_started_at: string | null;
      trial_started_at: string;
    }>(
      sql`SELECT plan, plan_expires_at::text, cycle_started_at::text, trial_started_at::text FROM businesses WHERE id = ${businessId}::uuid`,
    );
    return [...rows][0]!;
  });

const audits = (businessId: string) =>
  withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{
      actor: string;
      new_value: Record<string, unknown>;
      reason: string | null;
    }>(
      sql`SELECT actor, new_value, reason FROM audit_events WHERE business_id = ${businessId}::uuid AND action = 'plan_changed' ORDER BY created_at`,
    );
    return [...rows];
  });

const assign = (body: unknown) => post('/v1/businesses/plan', body, OPERATOR);
const resolve = (body: unknown, headers: Record<string, string> = OPERATOR) =>
  post('/v1/businesses/plan/support-review', body, headers);

/** An operator-assigned Chat month, then the owner's own upgrade request, answered support_review. */
async function reviewedUpgrade(phone: string) {
  const owner = await ownerOf(phone);
  expect(
    (await assign({ businessId: owner.businessId, plan: 'chat', expiresAt: null })).statusCode,
  ).toBe(200);
  const asked = await post('/v1/billing/plan', { plan: 'complete' }, owner.auth);
  expect(asked.json()).toEqual({ state: 'unavailable', reason: 'support_review' });
  return owner;
}

describe('the support-review resolution keeps the paid-through date (OD-50)', () => {
  it('moves the reviewed upgrade and returns the paid-through date it kept, unchanged', async () => {
    const { businessId } = await reviewedUpgrade('08031234601');
    const before = await subscription(businessId);

    const res = await resolve({
      businessId,
      plan: 'complete',
      reason: 'difference paid by transfer',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      plan: 'complete',
      previousPlan: 'chat',
      paidThrough: new Date(before.plan_expires_at).toISOString(),
      changed: true,
    });
    const after = await subscription(businessId);
    expect(after.plan).toBe('complete');
    expect(after.plan_expires_at).toBe(before.plan_expires_at);
    expect(after.cycle_started_at).toBe(before.cycle_started_at);
    expect(after.trial_started_at).toBe(before.trial_started_at);
    const trail = await audits(businessId);
    expect(trail).toHaveLength(2);
    expect(trail[1]).toMatchObject({
      actor: 'operator:local:operator-secret',
      reason: 'difference paid by transfer',
      new_value: { plan: 'complete', paidThroughKept: true },
    });
  });

  it('refuses a body that carries a date or any other extra field, writing nothing', async () => {
    const { businessId } = await reviewedUpgrade('08031234602');
    const before = await subscription(businessId);
    for (const extra of [
      { expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() },
      { expiresAt: null },
      { paidThrough: '2099-01-01T00:00:00.000Z' },
      { billingInterval: 'annual' },
      { supportReview: true },
    ]) {
      const res = await resolve({ businessId, plan: 'complete', reason: 'r', ...extra });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      expect((res.json() as { message: string }).message).toMatch(/no date is accepted/);
    }
    for (const body of [
      { businessId, plan: 'complete' }, // no reason
      { businessId, plan: 'complete', reason: '   ' },
      { businessId, plan: 'trial', reason: 'r' },
      { businessId, plan: 'expired', reason: 'r' },
    ]) {
      expect((await resolve(body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await subscription(businessId)).toEqual(before);
    expect(await audits(businessId)).toHaveLength(1);
  });

  it('a client flag does not make an assignment a support review: without the merchant request it is refused', async () => {
    const owner = await ownerOf('08031234603');
    await assign({ businessId: owner.businessId, plan: 'chat', expiresAt: null });
    const res = await resolve({ businessId: owner.businessId, plan: 'complete', reason: 'r' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toMatch(
      /no open support review asks for this plan/,
    );
    expect((await subscription(owner.businessId)).plan).toBe('chat');
  });

  it('refuses a trial and an expired plan', async () => {
    const trial = await ownerOf('08031234604');
    expect(
      (await resolve({ businessId: trial.businessId, plan: 'complete', reason: 'r' })).statusCode,
    ).toBe(400);
    expect((await subscription(trial.businessId)).plan).toBe('trial');

    const { businessId } = await reviewedUpgrade('08031234605');
    await assign({ businessId, plan: 'expired', expiresAt: null });
    const res = await resolve({ businessId, plan: 'complete', reason: 'r' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toMatch(/no paid-through date to keep/);
    expect((await subscription(businessId)).plan).toBe('expired');
  });

  it('refuses a caller with no operator identity, a wrong secret and a merchant session', async () => {
    const owner = await reviewedUpgrade('08031234606');
    const body = { businessId: owner.businessId, plan: 'complete', reason: 'r' };
    expect((await resolve(body, {})).statusCode).toBe(401);
    expect((await resolve(body, { 'x-rekoda-operator-secret': 'not-the-secret' })).statusCode).toBe(
      401,
    );
    expect((await resolve(body, owner.auth)).statusCode).toBe(401);
    expect((await subscription(owner.businessId)).plan).toBe('chat');
  });

  it('is idempotent: a repeat answers changed false and writes nothing more', async () => {
    const { businessId } = await reviewedUpgrade('08031234607');
    const body = { businessId, plan: 'complete', reason: 'difference paid by transfer' };
    const first = (await resolve(body)).json() as { paidThrough: string };
    const again = await resolve(body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({
      plan: 'complete',
      previousPlan: 'chat',
      paidThrough: first.paidThrough,
      changed: false,
    });
    expect(await audits(businessId)).toHaveLength(2);
  });

  it('answers 404 for a business that does not exist', async () => {
    const res = await resolve({
      businessId: '00000000-0000-4000-8000-000000000000',
      plan: 'complete',
      reason: 'r',
    });
    expect(res.statusCode).toBe(404);
  });

  it('the ordinary assignment still runs a standard period and still refuses a date', async () => {
    const owner = await ownerOf('08031234608');
    const dated = await assign({
      businessId: owner.businessId,
      plan: 'chat',
      expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
    });
    expect(dated.statusCode).toBe(400);
    for (const [interval, days] of [
      ['monthly', [28, 31]],
      ['annual', [365, 366]],
    ] as const) {
      const res = await assign({
        businessId: owner.businessId,
        plan: 'complete',
        billingInterval: interval,
        expiresAt: null,
      });
      expect(res.statusCode).toBe(200);
      const span =
        (new Date((await subscription(owner.businessId)).plan_expires_at).getTime() - Date.now()) /
        86_400_000;
      expect(span).toBeGreaterThan(days[0] - 0.01);
      expect(span).toBeLessThan(days[1] + 0.01);
    }
  });
});
