/**
 * Owner review of PR #432, item 3 (migration 0203), over real HTTP: `POST /v1/businesses/plan` holds
 * an operator to Rekoda's plan durations. A monthly plan ends within one calendar month, an annual
 * plan within twelve, a trial within 14 days of the business's own trial start, `expired` at or
 * before now, and no paid plan is open-ended. A date outside the rule is a 400 that writes nothing;
 * no date means the rule's own (one period). The write runs on the billing-operator principal
 * (OD-37, 0202): the application credential cannot run the operator writer at all.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addInterval } from '@rekoda/core';
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

async function businessFor(phone: string): Promise<string> {
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as { devCode: string };
  const verified = (
    await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
  ).json() as {
    setupToken: string;
  };
  const created = await post(
    '/v1/businesses',
    { name: 'Ada Fashion', businessType: 'Fashion & clothing' },
    { 'x-rekoda-setup-token': verified.setupToken },
  );
  return (created.json() as { businessId: string }).businessId;
}

const change = (body: unknown) => post('/v1/businesses/plan', body, OPERATOR);

describe('the operator plan endpoint keeps to Rekoda plan durations', () => {
  it('refuses dates outside Rekoda plan durations with 400, and writes nothing', async () => {
    const businessId = await businessFor('08031234597');
    const day = 86_400_000;
    for (const [body, message] of [
      [
        { plan: 'chat', expiresAt: new Date(Date.now() + 45 * day).toISOString() },
        /monthly plan ends within one month/,
      ],
      [
        {
          plan: 'complete',
          billingInterval: 'annual',
          expiresAt: new Date(Date.now() + 400 * day).toISOString(),
        },
        /annual plan ends within twelve months/,
      ],
      [
        { plan: 'trial', expiresAt: new Date(Date.now() + 30 * day).toISOString() },
        /trial ends within 14 days/,
      ],
      [{ plan: 'trial', billingInterval: 'monthly', expiresAt: null }, /has no billing interval/],
      [
        { plan: 'expired', expiresAt: new Date(Date.now() + day).toISOString() },
        /cannot end in the future/,
      ],
      [
        { plan: 'chat', billingInterval: 'weekly', expiresAt: null },
        /billingInterval is monthly or annual/,
      ],
    ] as const) {
      const res = await change({ businessId, ...body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect((res.json() as { message: string }).message).toMatch(message);
    }
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ plan: string; n: number }>(sql`
        SELECT plan, (SELECT count(*)::int FROM audit_events WHERE action = 'plan_changed') AS n
        FROM businesses WHERE id = ${businessId}::uuid`),
    );
    expect([...rows][0]).toEqual({ plan: 'trial', n: 0 });
  });

  it('with no date, a paid plan gets exactly one period: a month by default, a year when annual', async () => {
    const businessId = await businessFor('08031234598');
    const expiryOf = async () =>
      new Date(
        [
          ...(await withBusiness(db, businessId, (tx) =>
            tx.execute<{ at: string }>(
              sql`SELECT plan_expires_at::text AS at FROM businesses WHERE id = ${businessId}::uuid`,
            ),
          )),
        ][0]!.at,
      ).getTime();
    const before = new Date();
    expect((await change({ businessId, plan: 'integrate', expiresAt: null })).statusCode).toBe(200);
    expect(Math.abs((await expiryOf()) - addInterval(before, 'monthly').getTime())).toBeLessThan(
      120_000,
    );
    expect(
      (await change({ businessId, plan: 'complete', billingInterval: 'annual', expiresAt: null }))
        .statusCode,
    ).toBe(200);
    expect(Math.abs((await expiryOf()) - addInterval(before, 'annual').getTime())).toBeLessThan(
      120_000,
    );
  });
});
