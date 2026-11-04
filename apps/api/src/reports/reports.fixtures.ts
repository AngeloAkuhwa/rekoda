/**
 * Shared setup for the reports suites, split from reports.integration.test.ts: one running app
 * over a real PostgreSQL, a session from onboarding, and the request helpers. Each suite calls
 * useReportsHarness() once at its top level; Vitest gives every test file its own copy of this
 * module.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { recordAssetResponse } from '@rekoda/contracts';
import { createDb, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** These call sites always expect a successful record; narrow the union once. */
export function recordedAsset(res: { json(): unknown }): { assetId: string; owedK: number } {
  const parsed = recordAssetResponse.parse(res.json());
  if (parsed.outcome !== 'recorded') throw new Error(`expected recorded, got ${parsed.outcome}`);
  return parsed;
}

/** What `app.inject` resolves to, named so the helpers can be exported. */
export interface InjectedResponse {
  statusCode: number;
  body: string;
  payload: string;
  headers: Record<string, string | string[] | number | undefined>;
  json<T = any>(): T;
}

export let urls: Urls;
export let app: NestFastifyApplication;
export let db: Db;
let closeDb: () => Promise<void>;

export function post(
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
): Promise<InjectedResponse> {
  return app.inject({
    method: 'POST',
    url: path,
    payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Void an invoice the way a merchant actually can: ask, then claim.
 *
 * `VoidReceipt` is HIGH_RISK, so the endpoint answers the first call with a
 * confirmation naming the consequence and does nothing else. There is no
 * configuration that skips this, which is the point of the tier, so every
 * suite that voids an invoice as SETUP goes through the ceremony rather than
 * through a shortcut that no deployment offers.
 *
 * Returns the second call's body: the outcome the caller is asserting on.
 */
export async function voidInvoice(
  invoiceNumber: string,
  reason: string,
  auth: Record<string, string>,
): Promise<unknown> {
  const asked = (
    await post('/v1/reports/invoices/void', { invoiceNumber, reason }, auth)
  ).json() as {
    outcome: string;
    confirmationId?: string;
  };
  if (asked.outcome !== 'confirm') return asked;
  return (
    await post(
      '/v1/reports/invoices/void',
      { invoiceNumber, reason, confirmationId: asked.confirmationId },
      auth,
    )
  ).json();
}

export async function onboard(phone: string) {
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as {
    devCode?: string;
  };
  const verified = (
    await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
  ).json() as { setupToken: string };
  const created = await post(
    '/v1/businesses',
    { name: 'Ada Fashion', businessType: 'Fashion & clothing' },
    { 'x-rekoda-setup-token': verified.setupToken },
  );
  const session = created.json() as { sessionToken: string; businessId: string };
  return {
    businessId: session.businessId,
    auth: { authorization: `Bearer ${session.sessionToken}` },
  };
}

export const ENDPOINTS = [
  '/v1/reports/overview',
  '/v1/reports/cashflow',
  '/v1/reports/debtors',
  '/v1/reports/activity',
  '/v1/reports/compare',
  '/v1/reports/statements',
  '/v1/reports/invoices',
  '/v1/reports/receipts',
  '/v1/reports/expenses',
  '/v1/reports/audit',
] as const;

export function hash(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

/** Registers the suite hooks; call once at the top level of each suite. */
export function useReportsHarness(): void {
  beforeAll(async () => {
    urls = requireUrls();
    await migrate(urls);

    process.env['DATABASE_URL'] = urls.app;
    process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
    process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
    process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
    process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
    process.env['REKODA_REVEAL_OTP'] = '1';
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
}
