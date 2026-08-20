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
import { createDb, events, identity, jobsRepo, withBusiness, type Db } from '@rekoda/db';
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
