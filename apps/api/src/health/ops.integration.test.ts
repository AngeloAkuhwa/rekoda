/**
 * The operator health surface, over a real application and a real database.
 *
 * Two things are being asserted and only one of them is the numbers. The
 * other is that this endpoint is shut: it answers a question that spans every
 * tenant, so a merchant session reaching it would be a cross-tenant read with
 * a friendly name.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  billingRepo,
  createDb,
  events,
  identity,
  jobsRepo,
  quotaRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';

const SECRET = 'test-secret-at-least-32-characters-long';
/* Deliberately different from REKODA_API_SECRET, which is the point of it
 * existing: this one travels in a plaintext header and must not be the key
 * that signs setup grants. Config refuses to boot if they match. */
const OPERATOR_SECRET = `operator-${SECRET}`;

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);

  process.env['DATABASE_URL'] = urls.app;
  // The queue spans tenants, so the endpoint needs the worker credential to
  // count it. Given here WITHOUT REKODA_WORKER, which is the arrangement
  // worth testing: a web process that runs no jobs still reports the queue.
  process.env['WORKER_DATABASE_URL'] = urls.worker;
  delete process.env['REKODA_WORKER'];
  process.env['OTP_PEPPER'] = 'test-pepper-at-least-32-characters-long';
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_API_SECRET'] = SECRET;
  process.env['REKODA_OPERATOR_SECRET'] = OPERATOR_SECRET;
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
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

function health(headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url: '/v1/ops/health', headers });
}

function margin(query = '', headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url: `/v1/ops/margin${query}`, headers });
}

describe('who can read the operator health surface', () => {
  it('refuses a request with no secret', async () => {
    expect((await health()).statusCode).toBe(403);
  });

  it('refuses a wrong secret of the same length', async () => {
    const wrong = 'x'.repeat(OPERATOR_SECRET.length);
    expect((await health({ 'x-rekoda-operator-secret': wrong })).statusCode).toBe(403);
  });

  it('refuses a secret that is merely a prefix', async () => {
    const short = OPERATOR_SECRET.slice(0, 8);
    expect((await health({ 'x-rekoda-operator-secret': short })).statusCode).toBe(403);
  });

  it('answers the right secret', async () => {
    expect((await health({ 'x-rekoda-operator-secret': OPERATOR_SECRET })).statusCode).toBe(200);
  });
});

describe('what the operator health surface says', () => {
  it('is all zeros on a quiet platform', async () => {
    const res = await health({ 'x-rekoda-operator-secret': OPERATOR_SECRET });

    expect(res.json()).toEqual({
      queue: { dead: 0, pending: 0, running: 0, oldestPendingSeconds: 0 },
      meta: { unprocessed: 0, flagged: 0, badSignatures: 0 },
      paystack: { unprocessed: 0, flagged: 0, badSignatures: 0 },
    });
  });

  it('counts a queued job even though this process claims none', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348030000001');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Stores',
      businessType: null,
      ownerUserId: user.id,
    });
    await withBusiness(db, business.id, (tx) =>
      jobsRepo.enqueue(tx, { businessId: business.id, kind: 'inbound.message' }),
    );

    const body = await health({ 'x-rekoda-operator-secret': OPERATOR_SECRET }).then((r) =>
      r.json(),
    );

    expect(body.queue.pending).toBe(1);
  });

  it('counts webhook intake per provider', async () => {
    await events.recordEvent(db, {
      provider: 'paystack',
      eventType: 'charge.success',
      externalId: 'evt.waiting',
      payload: { sealed: true },
      businessId: null,
    });

    const body = await health({ 'x-rekoda-operator-secret': OPERATOR_SECRET }).then((r) =>
      r.json(),
    );

    expect(body.paystack.unprocessed).toBe(1);
    expect(body.meta.unprocessed).toBe(0);
  });

  it('names no business and no person', async () => {
    const user = await identity.upsertUserByPhone(db, '+2348030000002');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Chidi Electronics',
      businessType: null,
      ownerUserId: user.id,
    });
    await withBusiness(db, business.id, (tx) =>
      jobsRepo.enqueue(tx, { businessId: business.id, kind: 'inbound.message' }),
    );

    const raw = await health({ 'x-rekoda-operator-secret': OPERATOR_SECRET }).then((r) => r.body);

    expect(raw).not.toContain('Chidi');
    expect(raw).not.toContain(business.id);
    expect(raw).not.toContain('2348030000002');
  });
});

/**
 * The margin report over the same real application.
 *
 * `usage_events` had been collecting since metering shipped with nothing
 * reading it. These assert both halves of "reading it": the arithmetic, and
 * the fact that the gate in front of it is the same shut one.
 */
describe('the margin report', () => {
  const PERIOD = '2026-08';

  async function merchant(name: string, phone: string, plan: string): Promise<string> {
    const user = await identity.upsertUserByPhone(db, phone);
    const business = await identity.createBusinessWithOwner(db, {
      name,
      businessType: null,
      ownerUserId: user.id,
    });
    await billingRepo.setPlan(db, {
      businessId: business.id,
      plan,
      expiresAt: null,
      actor: 'operator:test',
    });
    return business.id;
  }

  function spend(
    businessId: string,
    provider: quotaRepo.UsageRecord['provider'],
    nairaEquivalentK: number,
  ): Promise<void> {
    return withBusiness(db, businessId, (tx) =>
      quotaRepo.recordUsage(tx, {
        businessId,
        provider,
        usageType: 'test',
        quantity: 1,
        providerCostMicros: 0,
        nairaEquivalentK,
        billingPeriod: PERIOD,
      }),
    );
  }

  it('is shut to a request with no secret', async () => {
    expect((await margin()).statusCode).toBe(403);
  });

  it('is shut to a wrong secret of the same length', async () => {
    const wrong = 'x'.repeat(OPERATOR_SECRET.length);
    expect((await margin('', { 'x-rekoda-operator-secret': wrong })).statusCode).toBe(403);
  });

  it('refuses a period that is not a month', async () => {
    const response = await margin('?period=august', {
      'x-rekoda-operator-secret': OPERATOR_SECRET,
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a thirteenth month', async () => {
    const response = await margin('?period=2026-13', {
      'x-rekoda-operator-secret': OPERATOR_SECRET,
    });
    expect(response.statusCode).toBe(400);
  });

  it('prices each merchant against their plan', async () => {
    const chat = await merchant('Chat Shop', '+2348030000201', 'chat');
    const complete = await merchant('Complete Shop', '+2348030000202', 'complete');
    await spend(chat, 'meta', 120_000);
    await spend(chat, 'anthropic', 9_000);
    await spend(complete, 'meta', 300_000);

    const body = await margin(`?period=${PERIOD}`, {
      'x-rekoda-operator-secret': OPERATOR_SECRET,
    }).then((r) => r.json());

    const rows = new Map(body.businesses.map((b: { businessId: string }) => [b.businessId, b]));
    expect(rows.get(chat)).toMatchObject({
      plan: 'chat',
      revenueK: 990_000,
      costK: 129_000,
      marginK: 861_000,
      costRatioBp: 1_303,
    });
    expect(rows.get(complete)).toMatchObject({ revenueK: 2_990_000, costK: 300_000 });
  });

  it('counts a trial as cost with no revenue rather than hiding it', async () => {
    const trial = await merchant('Trying It', '+2348030000203', 'trial');
    await spend(trial, 'meta', 45_000);

    const body = await margin(`?period=${PERIOD}`, {
      'x-rekoda-operator-secret': OPERATOR_SECRET,
    }).then((r) => r.json());

    const row = body.businesses.find((b: { businessId: string }) => b.businessId === trial);
    expect(row).toMatchObject({ revenueK: 0, costK: 45_000, marginK: -45_000, costRatioBp: null });
    expect(body.total.businesses).toBe(1);
    expect(body.total.paying).toBe(0);
    expect(body.total.costK).toBe(45_000);
    expect(body.total.marginK).toBe(-45_000);
    expect(body.total.costRatioBp).toBeNull();
  });

  it('totals the estate rather than the rows it printed', async () => {
    const one = await merchant('One', '+2348030000204', 'chat');
    const two = await merchant('Two', '+2348030000205', 'integrate');
    await merchant('Three', '+2348030000209', 'trial');
    await spend(one, 'meta', 60_000);
    await spend(two, 'meta', 240_000);

    const body = await margin(`?period=${PERIOD}`, {
      'x-rekoda-operator-secret': OPERATOR_SECRET,
    }).then((r) => r.json());

    expect(body.total.revenueK).toBe(990_000 + 1_990_000);
    expect(body.total.costK).toBe(300_000);
    expect(body.total.marginK).toBe(990_000 + 1_990_000 - 300_000);
    expect(body.total.businesses).toBe(3);
    expect(body.total.paying).toBe(2);
    expect(body.total.spending).toBe(2);
    expect(body.total.events).toBe(2);
  });

  it('splits the spend by who Rekoda is paying', async () => {
    const shop = await merchant('Split', '+2348030000206', 'chat');
    await spend(shop, 'meta', 80_000);
    await spend(shop, 'anthropic', 12_000);

    const body = await margin(`?period=${PERIOD}`, {
      'x-rekoda-operator-secret': OPERATOR_SECRET,
    }).then((r) => r.json());

    expect(body.byProvider).toEqual([
      { provider: 'meta', costK: 80_000, quantity: 1, events: 1 },
      { provider: 'anthropic', costK: 12_000, quantity: 1, events: 1 },
    ]);
  });

  it('lists the months that have usage, so nobody guesses at an empty one', async () => {
    const shop = await merchant('Historic', '+2348030000207', 'chat');
    await spend(shop, 'meta', 1_000);

    const body = await margin(`?period=${PERIOD}`, {
      'x-rekoda-operator-secret': OPERATOR_SECRET,
    }).then((r) => r.json());

    expect(body.availablePeriods).toEqual([PERIOD]);
  });

  it('defaults to the current billing month', async () => {
    const body = await margin('', { 'x-rekoda-operator-secret': OPERATOR_SECRET }).then((r) =>
      r.json(),
    );
    expect(body.period).toBe(new Date(Date.now() + 3_600_000).toISOString().slice(0, 7));
  });

  it('carries ids and no names, no phone numbers and no customers', async () => {
    const shop = await merchant('Chidi Electronics', '+2348030000208', 'chat');
    await spend(shop, 'meta', 5_000);

    const raw = await margin(`?period=${PERIOD}`, {
      'x-rekoda-operator-secret': OPERATOR_SECRET,
    }).then((r) => r.body);

    expect(raw).toContain(shop);
    expect(raw).not.toContain('Chidi');
    expect(raw).not.toContain('2348030000208');
  });
});
