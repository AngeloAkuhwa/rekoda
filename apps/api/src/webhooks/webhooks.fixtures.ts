/**
 * Shared setup for the outbound-webhook suites (PR-112): the real application and database, a
 * business with delivery capacity, a recording sender, and the outbox fan-out. Split from
 * webhooks.integration.test.ts so the delivery-meter suite can use it too.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createDb, withBusiness, type Db } from '@rekoda/db';
import { usagePeriod } from '@rekoda/core';
import {
  migrate,
  requireUrls,
  truncateAll,
  type Urls,
  settlementDb,
  creditBonusForTest,
} from '@rekoda/db/testing';
import { buildOutboxDispatcher } from '../jobs/jobs.module.js';
import type { InjectedResponse } from '../channels/meta-webhook.fixtures.js';
import { webhookFanOut } from './fan-out.js';
import type { WebhookSender } from './sender.js';

export const SECRET = 'webhooks-secret-at-least-32-characters';
export const VAULT_KEY = randomBytes(32).toString('hex');

let urls: Urls;
export let app: NestFastifyApplication;
export let db: Db;
export let workerDb: Db;
let closeDb: () => Promise<void>;
let closeWorker: () => Promise<void>;

/**
 * Registers the suite's hooks: one application and two database handles for the file, and an
 * empty database before every test. Call it once at the top of each test file.
 */
export function useWebhooksHarness(): void {
  beforeAll(async () => {
    urls = requireUrls();
    await migrate(urls);
    ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
    ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 2 }));

    process.env['DATABASE_URL'] = urls.app;
    process.env['OTP_PEPPER'] = 'webhooks-pepper-at-least-32-characters';
    process.env['VAULT_KEY'] = VAULT_KEY;
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
    await closeWorker?.();
  });

  beforeEach(async () => {
    await truncateAll(urls);
  });
}

export function post(
  url: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<InjectedResponse> {
  return app.inject({ method: 'POST', url, payload: payload as object, headers });
}

export function get(url: string, headers: Record<string, string> = {}): Promise<InjectedResponse> {
  return app.inject({ method: 'GET', url, headers });
}

/** The same instant one month on, for the periods a backoff can reach. */
function nextMonth(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1, 12));
}

/** A business with an owner session. */
export async function onboard(phone: string, name: string) {
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
  const now = new Date();
  /* Deliveries are metered (spec §27's WEBHOOK_DELIVERIES) and no plan
   * sells them, so the capacity a merchant buys with the API product is
   * credited here as bonus. A business without it is refused at the meter,
   * which is its own test below.
   *
   * Credited for THIS month and the next, because the retry backoff spans
   * more than half a day: a delivery that first fails late on the last day
   * of a month makes its last attempts in the following billing period, and
   * a merchant whose subscription renews has capacity there too. Crediting
   * only the current period made the retry test pass on the 1st and fail on
   * the 31st, which is a property of the calendar rather than of the code
   * under test. */
  for (const period of [usagePeriod(now), usagePeriod(nextMonth(now))]) {
    await withBusiness(settlementDb(), created.businessId, (tx) =>
      creditBonusForTest(tx, created.businessId, period, 'WEBHOOK_DELIVERIES', 100),
    );
  }

  return {
    businessId: created.businessId,
    auth: { authorization: `Bearer ${created.sessionToken}` },
  };
}

/** A sender that records what it was handed, and answers however it is told. */
export class RecordingSender implements WebhookSender {
  readonly sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  constructor(private readonly answer: () => number | Error = () => 200) {}

  async send(input: { url: string; body: string; headers: Record<string, string> }) {
    this.sent.push(input);
    const answer = this.answer();
    if (answer instanceof Error) throw answer;
    return { status: answer };
  }
}

/** Commit a fact the way a command does: an outbox event inside a transaction. */
export async function emit(businessId: string, type: string, payload: Record<string, unknown>) {
  const { outboxRepo } = await import('@rekoda/db');
  return withBusiness(db, businessId, (tx) => outboxRepo.append(tx, { businessId, type, payload }));
}

export async function fanOutOnce(): Promise<void> {
  await buildOutboxDispatcher(webhookFanOut(workerDb)).runOnce(workerDb);
}
