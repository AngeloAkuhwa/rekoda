/**
 * Shared setup for the bank suites, split from bank.integration.test.ts: one running app over
 * a real PostgreSQL, onboarding, the sample statements and the position, classification and
 * release helpers. Each suite calls useBankHarness() once at its top level; Vitest gives every
 * test file its own copy of this module.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { bankPositionResponse, classifyLineResponse, unmatchLineResponse } from '@rekoda/contracts';
import { KEY_BY_CODE, type AccountKey } from '@rekoda/core';
import { createDb, sql, withBusiness, type Db, type TenantDb } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { type Classification } from '../commands/bank-commands.js';

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

export const post = (
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<InjectedResponse> =>
  app.inject({
    method: 'POST',
    url,
    payload,
    headers: { 'content-type': 'application/json', ...headers },
  });

export async function onboard(phone: string) {
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as { devCode?: string };
  const verified = (
    await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
  ).json() as {
    setupToken: string;
  };
  const created = await post(
    '/v1/businesses',
    { name: 'Mama Chidi Stores', businessType: 'Provisions & groceries' },
    { 'x-rekoda-setup-token': verified.setupToken },
  );
  const session = created.json() as { sessionToken: string; businessId: string };
  return {
    businessId: session.businessId,
    auth: { authorization: `Bearer ${session.sessionToken}` },
  };
}

export const AUGUST = `Date,Description,Amount
03/08/2026,TRF FROM ADEBAYO O,150000.00
05/08/2026,POS PURCHASE SHOPRITE,-20000.00
31/08/2026,CLOSING BALANCE,
`;

/* Shared by the classification suites below (G-95 release, G-97 forget):
 * they assert the money, not the number of journals. */
export const ONE_CREDIT = `Date,Description,Amount
03/08/2026,TRF FROM ADEBAYO O,150000.00
`;
export const CREDIT_AND_DEBIT = `Date,Description,Amount
03/08/2026,TRF FROM ADEBAYO O,150000.00
05/08/2026,POS PURCHASE SHOPRITE,-20000.00
`;

/** Each account's net (debit minus credit) in kobo, keyed by chart key. */
export async function nets(businessId: string): Promise<Partial<Record<AccountKey, number>>> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ code: string; net: string }>(sql`
        SELECT a.code, SUM(e.debit_k - e.credit_k)::bigint AS net
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid
        GROUP BY a.code
      `),
  );
  return Object.fromEntries(
    [...rows]
      .filter((r) => Number(r.net) !== 0)
      .map((r) => [KEY_BY_CODE[r.code] ?? r.code, Number(r.net)]),
  );
}

/** Every posting's provenance, oldest first. */
export async function postings(businessId: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{
      id: string;
      source_type: string;
      source_id: string | null;
      reverses_id: string | null;
      month: string;
    }>(sql`
        SELECT id, source_type, source_id, reverses_id,
               to_char(created_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM') AS month
        FROM ledger_transactions WHERE business_id = ${businessId}::uuid
        ORDER BY created_at, id
      `),
  );
  return [...rows];
}

/** What the audit trail says happened to the pairing. */
export async function releaseAudits(businessId: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ action: string; old_value: unknown; new_value: unknown }>(sql`
        SELECT action, old_value, new_value FROM audit_events
        WHERE business_id = ${businessId}::uuid AND entity = 'bank_line_match'
          AND action IN ('released', 'classification_released')
        ORDER BY created_at, id
      `),
  );
  return [...rows];
}

export async function position(auth: Record<string, string>) {
  return bankPositionResponse.parse(
    (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
  );
}

export const matchedTo = async (auth: Record<string, string>, lineId: string) =>
  (await position(auth)).lines.find((l) => l.id === lineId)!.matchedTo;

export const classify = async (
  auth: Record<string, string>,
  lineId: string,
  classification: Classification = 'OWNER_CAPITAL',
) =>
  classifyLineResponse.parse(
    (await post('/v1/bank/classify', { lineId, classification }, auth)).json(),
  );

export const release = async (auth: Record<string, string>, lineId: string) =>
  unmatchLineResponse.parse((await post('/v1/bank/unmatch', { lineId }, auth)).json());

/** One statement, one business, the line of the amount asked for. */
export async function setUp(phone: string, csv = ONE_CREDIT, amountK = 15_000_000) {
  const { businessId, auth } = await onboard(phone);
  await post('/v1/bank/statement', { csv }, auth);
  const line = (await position(auth)).lines.find((l) => l.amountK === amountK)!;
  return { businessId, auth, line };
}

/**
 * A transaction held open after its work, so a second one can be started
 * against it for real rather than run one after the other.
 */
export const held: (() => void)[] = [];

export function holdOpen<T>(businessId: string, work: (tx: TenantDb) => Promise<T>) {
  let letGo!: () => void;
  const gate = new Promise<void>((resolve) => (letGo = resolve));
  held.push(letGo);
  let reached!: (value: T) => void;
  const workDone = new Promise<T>((resolve) => (reached = resolve));
  const committed = withBusiness(db, businessId, async (tx) => {
    const value = await work(tx);
    reached(value);
    await gate;
    return value;
  });
  return {
    ready: Promise.race([workDone, committed]),
    commit: () => {
      letGo();
      return committed;
    },
  };
}

/* Long enough for the second transaction to reach the lock it waits on. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** Whether `pending` is still waiting after a settle: proof of overlap. */
export const stillWaiting = (pending: Promise<unknown>) =>
  Promise.race([pending.then(() => false), settle().then(() => true)]);

/** Registers the suite hooks; call once at the top level of each suite. */
export function useBankHarness(): void {
  beforeAll(async () => {
    urls = requireUrls();
    await migrate(urls);
    ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));

    process.env['DATABASE_URL'] = urls.app;
    process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
    process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
    process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
    process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
    process.env['REKODA_REVEAL_OTP'] = '1';
    process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
    /* This harness pins the UNCONFIGURED feed posture; the configured one boots
     * its own app in feed.integration.test.ts. */
    delete process.env['MONO_SECRET_KEY'];
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

  /* A test that fails while holding a transaction must not hold it into the
   * next test: every gate opens when the test ends, pass or fail. */
  afterEach(() => {
    for (const letGo of held.splice(0)) letGo();
  });
}
