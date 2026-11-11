/**
 * OWN-70 (PR B item 4) on the operator plane: a blocked renewal is listed on
 * GET /v1/ops/exceptions with what an operator needs, and closed once by
 * POST /v1/ops/exceptions/renewals/:reference/resolve (`ops:payment`).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { opsExceptionsResponse } from '@rekoda/contracts';
import { createDb, identity, subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import {
  applyFixtureCycle,
  migrate,
  requireUrls,
  truncateAll,
  type Urls,
} from '@rekoda/db/testing';
import { settlementDb } from '@rekoda/db/testing';
import { sweepRenewals } from '../billing/renewal-sweep.js';

const OPERATOR_SECRET = `operator-${randomBytes(24).toString('hex')}`;
const operator = { 'x-rekoda-operator-secret': OPERATOR_SECRET };
const DAY = 86_400_000;

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let workerDb: Db;
let closeDb: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  process.env['DATABASE_URL'] = urls.app;
  process.env['WORKER_DATABASE_URL'] = urls.worker;
  delete process.env['REKODA_WORKER'];
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['REKODA_OPERATOR_SECRET'] = OPERATOR_SECRET;
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  delete process.env['NODE_ENV'];
  const { createApp } = await import('../main.js');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function blockedRenewal(): Promise<{ businessId: string; reference: string }> {
  const user = await identity.upsertUserByPhone(db, '+2348194000001');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const renewsAt = new Date(Date.now() - DAY);
  await withBusiness(db, business.id, (tx) =>
    applyFixtureCycle(tx, business.id, {
      plan: 'chat',
      cycleStartedAt: new Date(renewsAt.getTime() - 30 * DAY),
      renewsAt,
      anchorDay: renewsAt.getUTCDate(),
    }),
  );
  await sweepRenewals({
    settlementDb: settlementDb(),
    workerDb,
    appDb: db,
    config: {
      planCatalogueReads: false,
      paystackSecretKey: ['sk', 'live', 'b'.repeat(24)].join('_'),
      paystackPlatformConfirmed: false,
    },
  });
  const [charge] = (
    await withBusiness(db, business.id, (tx) => subscriptionsRepo.chargesFor(tx, business.id))
  ).rows;
  return { businessId: business.id, reference: charge!.reference };
}

const list = async () =>
  opsExceptionsResponse.parse(
    (await app.inject({ method: 'GET', url: '/v1/ops/exceptions', headers: operator })).json(),
  );

const resolve = (reference: string, headers: Record<string, string> = operator) =>
  app.inject({
    method: 'POST',
    url: `/v1/ops/exceptions/renewals/${reference}/resolve`,
    payload: { resolution: 'merchant asked to pay from billing once confirmed' },
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('a blocked renewal on the operator plane (OWN-70)', () => {
  it('is listed with the reason and the business state, then closed once', async () => {
    const { businessId, reference } = await blockedRenewal();

    expect((await list()).blockedRenewals).toMatchObject([
      {
        reference,
        businessId,
        plan: 'chat',
        reason: 'awaiting_platform_confirmation',
        currentPlan: 'chat',
      },
    ]);

    expect((await resolve(reference, {})).statusCode).toBe(401);
    expect((await resolve(reference)).statusCode).toBe(200);
    expect((await resolve(reference)).statusCode).toBe(409);
    expect((await list()).blockedRenewals).toEqual([]);
  });

  it('answers 404 for a reference that is no charge', async () => {
    expect((await resolve('RKD-SUB-20261108-ZZZZZZ')).statusCode).toBe(404);
  });
});
