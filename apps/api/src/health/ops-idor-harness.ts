/**
 * Shared harness for the object-level authorisation (IDOR) suites over the PR B surface, through real HTTP and real scoped
 * operator tokens (OIDC, a local JWKS) and real business sessions.
 *
 * A rejected request must change nothing: every refusal below is checked by comparing a snapshot
 * of the records the request could have touched (jobs, dead-job records and their audit trail,
 * events, charges, staging actions, plan dates) before and after.
 *
 * Horizontal: business A reaching business B's records through an id or reference.
 * Vertical: a caller without the scope or the environment safeguards for the action.
 * Operational: an operator pointing a recovery or resolution at a record it does not match.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { createDb, events, jobsRepo, settleRepo, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, storedEventId, truncateAll, type Urls } from '@rekoda/db/testing';

const ISSUER = 'https://issuer.test/';
const JWKS_URL = 'https://issuer.test/jwks.json';
const AUDIENCE = 'rekoda-operator-plane';
const TEST_KEY = ['sk', 'test', 'i'.repeat(24)].join('_');
export const DAY = 86_400_000;
const MANAGED = [
  'DATABASE_URL',
  'WORKER_DATABASE_URL',
  'REKODA_WORKER',
  'OTP_PEPPER',
  'VAULT_KEY',
  'MATCH_KEY',
  'REKODA_API_SECRET',
  'REKODA_OPERATOR_SECRET',
  'REKODA_REVEAL_OTP',
  'REKODA_RATE_LIMIT_MAX',
  'NODE_ENV',
  'PAYSTACK_SECRET_KEY',
  'REKODA_STAGING_TOOLS',
  'REKODA_PAYSTACK_PLATFORM_CONFIRMED',
  'OPERATOR_OIDC_ISSUER',
  'OPERATOR_OIDC_AUDIENCE',
  'OPERATOR_OIDC_JWKS_URL',
] as const;

export let urls: Urls;
export let app: NestFastifyApplication;
export let appDb: Db;
export let workerDb: Db;
export let ownerDb: Db;
export let realFetch: typeof fetch;
export let mint: (scope: string) => Promise<string>;
const closers: Array<() => Promise<void>> = [];
const saved: Record<string, string | undefined> = {};

export function useHarness(): void {
  beforeAll(async () => {
    urls = requireUrls();
    await migrate(urls);
    for (const [url, set] of [
      [urls.app, (d: Db) => (appDb = d)],
      [urls.worker, (d: Db) => (workerDb = d)],
      [urls.owner, (d: Db) => (ownerDb = d)],
    ] as const) {
      const { db, close } = createDb(url, { max: 4 });
      set(db);
      closers.push(close);
    }

    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'idor-test', alg: 'RS256' };
    // jose fetches the key set with the global fetch; serve it from memory for this one https URL.
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(input instanceof Request ? input.url : input) === JWKS_URL
        ? new Response(JSON.stringify({ keys: [jwk] }), {
            headers: { 'content-type': 'application/json' },
          })
        : realFetch(input, init)) as typeof fetch;
    mint = (scope) =>
      new SignJWT({ sub: 'ada@rekoda.app', scope })
        .setProtectedHeader({ alg: 'RS256', kid: 'idor-test' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey);

    for (const key of MANAGED) saved[key] = process.env[key];
    Object.assign(process.env, {
      DATABASE_URL: urls.app,
      WORKER_DATABASE_URL: urls.worker,
      OTP_PEPPER: randomBytes(24).toString('hex'),
      VAULT_KEY: randomBytes(32).toString('hex'),
      MATCH_KEY: randomBytes(32).toString('hex'),
      REKODA_API_SECRET: randomBytes(24).toString('hex'),
      REKODA_REVEAL_OTP: '1',
      REKODA_RATE_LIMIT_MAX: '100000',
      PAYSTACK_SECRET_KEY: TEST_KEY,
      REKODA_STAGING_TOOLS: '1',
      OPERATOR_OIDC_ISSUER: ISSUER,
      OPERATOR_OIDC_AUDIENCE: AUDIENCE,
      OPERATOR_OIDC_JWKS_URL: JWKS_URL,
    });
    delete process.env['REKODA_WORKER'];
    delete process.env['REKODA_OPERATOR_SECRET'];
    delete process.env['REKODA_PAYSTACK_PLATFORM_CONFIRMED'];
    delete process.env['NODE_ENV'];
    const { createApp } = await import('../main.js');
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
    for (const close of closers) await close();
    globalThis.fetch = realFetch;
    for (const key of MANAGED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  beforeEach(async () => {
    await truncateAll(urls);
    await ownerDb.execute(sql`DELETE FROM staging_environment`);
  });
}

/* ── callers ─────────────────────────────────────────────────────────────── */

export const call = (
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string> = {},
  payload?: object,
): ReturnType<NestFastifyApplication['inject']> =>
  app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

export const operator = async (scope: string) => ({ authorization: `Bearer ${await mint(scope)}` });

export async function signIn(phone: string): Promise<Record<string, string>> {
  const requested = (await call('POST', '/v1/auth/otp/request', {}, { phone })).json() as {
    devCode?: string;
  };
  const verified = (
    await call('POST', '/v1/auth/otp/verify', {}, { phone, code: requested.devCode })
  ).json() as { sessionToken?: string; setupToken?: string };
  return verified.sessionToken
    ? { authorization: `Bearer ${verified.sessionToken}` }
    : { 'x-rekoda-setup-token': verified.setupToken! };
}

let phoneSeq = 0;
export async function business(): Promise<{ id: string; session: Record<string, string> }> {
  phoneSeq += 1;
  const setup = await signIn(`+2348140${String(phoneSeq).padStart(6, '0')}`);
  const created = (
    await call('POST', '/v1/businesses', setup, { name: `Shop ${phoneSeq}`, businessType: null })
  ).json() as { sessionToken: string; businessId: string };
  return { id: created.businessId, session: { authorization: `Bearer ${created.sessionToken}` } };
}

/* ── seeding ─────────────────────────────────────────────────────────────── */

let eventSeq = 0;
export async function attributedEvent(businessId: string): Promise<string> {
  eventSeq += 1;
  const recorded = await events.recordEvent(appDb, {
    provider: 'paystack',
    eventType: 'charge.success',
    externalId: `idor-${eventSeq}:charge.success`,
    payload: { sealed: 'opaque' },
    businessId: null,
  });
  const id = storedEventId(recorded);
  expect(await events.attributeEvent(workerDb, id, businessId)).toBe(true);
  return id;
}

/** A dead payment job in `businessId` whose payload names `eventId` (any business's). */
export async function deadJob(businessId: string, eventId: string): Promise<string> {
  await withBusiness(appDb, businessId, (tx) =>
    jobsRepo.enqueue(tx, {
      businessId,
      kind: 'payment.process',
      payload: { eventId },
      maxAttempts: 1,
    }),
  );
  const job = await jobsRepo.claimNext(workerDb, 'idor');
  expect((await jobsRepo.markFailed(workerDb, job!, 'boom', 0)).state).toBe('dead');
  return job!.id;
}

export async function blockedRenewal(businessId: string, reference: string, blocked: boolean) {
  await ownerDb.execute(sql`
    INSERT INTO subscription_charges
      (business_id, reference, kind, plan, amount_k, status, blocked_at, blocked_reason)
    VALUES (${businessId}::uuid, ${reference}, 'renewal', 'chat', 500000, 'pending',
            ${blocked ? sql`now()` : sql`NULL`},
            ${blocked ? 'payments_not_configured' : null})`);
}

/** Everything a request in this file could have touched, in one comparable value. */
export async function snapshot() {
  const q = async (text: ReturnType<typeof sql>) => [...(await ownerDb.execute(text))];
  return {
    jobs: await q(sql`SELECT id, state, attempts, max_attempts FROM jobs ORDER BY id`),
    deadJobs: await q(
      sql`SELECT job_id, business_id, status, death_count, event_id, closed_at, recovery_requested_at
          FROM dead_job_exceptions ORDER BY job_id`,
    ),
    audit: await q(
      sql`SELECT business_id, entity, entity_id, action FROM audit_events
          WHERE entity IN ('job', 'subscription_charge') ORDER BY created_at, id`,
    ),
    events: await q(sql`SELECT id, processed_at, resolved_at FROM external_events ORDER BY id`),
    charges: await q(
      sql`SELECT reference, status, blocked_resolved_at FROM subscription_charges ORDER BY reference`,
    ),
    exceptions: await q(
      sql`SELECT id, resolved_at FROM reconciliations WHERE status = 'EXCEPTION' ORDER BY id`,
    ),
    stagingActions: await q(sql`SELECT id, business_id FROM staging_tool_actions ORDER BY id`),
    plans: await q(sql`SELECT id, plan, plan_expires_at FROM businesses ORDER BY id`),
  };
}

export const REASON = 'checking the object boundary';
