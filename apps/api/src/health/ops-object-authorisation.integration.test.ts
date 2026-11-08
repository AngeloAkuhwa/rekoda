/**
 * Object-level authorisation (IDOR) over the PR B surface, through real HTTP and real scoped
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
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { createDb, events, jobsRepo, settleRepo, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, storedEventId, truncateAll, type Urls } from '@rekoda/db/testing';

const ISSUER = 'https://issuer.test/';
const AUDIENCE = 'rekoda-operator-plane';
const TEST_KEY = ['sk', 'test', 'i'.repeat(24)].join('_');
const DAY = 86_400_000;
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

let urls: Urls;
let app: NestFastifyApplication;
let appDb: Db;
let workerDb: Db;
let ownerDb: Db;
let jwks: Server;
let mint: (scope: string) => Promise<string>;
const closers: Array<() => Promise<void>> = [];
const saved: Record<string, string | undefined> = {};

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
  jwks = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
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
    OPERATOR_OIDC_JWKS_URL: `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks.json`,
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
  await new Promise<void>((resolve) => jwks?.close(() => resolve()));
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

beforeEach(async () => {
  await truncateAll(urls);
  await ownerDb.execute(sql`DELETE FROM staging_environment`);
});

/* ── callers ─────────────────────────────────────────────────────────────── */

const call = (
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string> = {},
  payload?: object,
) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

const operator = async (scope: string) => ({ authorization: `Bearer ${await mint(scope)}` });

async function signIn(phone: string): Promise<Record<string, string>> {
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
async function business(): Promise<{ id: string; session: Record<string, string> }> {
  phoneSeq += 1;
  const setup = await signIn(`+2348140${String(phoneSeq).padStart(6, '0')}`);
  const created = (
    await call('POST', '/v1/businesses', setup, { name: `Shop ${phoneSeq}`, businessType: null })
  ).json() as { sessionToken: string; businessId: string };
  return { id: created.businessId, session: { authorization: `Bearer ${created.sessionToken}` } };
}

/* ── seeding ─────────────────────────────────────────────────────────────── */

let eventSeq = 0;
async function attributedEvent(businessId: string): Promise<string> {
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
async function deadJob(businessId: string, eventId: string): Promise<string> {
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

async function blockedRenewal(businessId: string, reference: string, blocked: boolean) {
  await ownerDb.execute(sql`
    INSERT INTO subscription_charges
      (business_id, reference, kind, plan, amount_k, status, blocked_at, blocked_reason)
    VALUES (${businessId}::uuid, ${reference}, 'renewal', 'chat', 500000, 'pending',
            ${blocked ? sql`now()` : sql`NULL`},
            ${blocked ? 'payments_not_configured' : null})`);
}

/** Everything a request in this file could have touched, in one comparable value. */
async function snapshot() {
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

const REASON = 'checking the object boundary';

/* ── vertical: who may call the operator plane at all ───────────────────── */

describe('vertical: the operator plane is closed to everyone without the right scope', () => {
  it('refuses no credential, a business session and a forged token, and changes nothing', async () => {
    const a = await business();
    const job = await deadJob(a.id, await attributedEvent(a.id));
    await blockedRenewal(a.id, 'RKD-SUB-20261108-AAAAAA', true);
    const before = await snapshot();
    const forged = { authorization: 'Bearer not.a.token' };

    const routes: Array<['GET' | 'POST', string, object?]> = [
      ['GET', '/v1/ops/exceptions'],
      ['POST', `/v1/ops/dead-jobs/${job}/recover`, { reason: REASON }],
      ['POST', `/v1/ops/dead-jobs/${job}/resolve`, { resolution: REASON }],
      [
        'POST',
        '/v1/ops/exceptions/renewals/RKD-SUB-20261108-AAAAAA/resolve',
        { resolution: REASON },
      ],
      ['POST', `/v1/ops/staging/businesses/${a.id}/designate`, { reason: REASON }],
      ['GET', `/v1/ops/staging/businesses/${a.id}/actions`],
    ];
    for (const [method, url, body] of routes) {
      for (const headers of [{}, a.session, forged]) {
        const r = await call(method, url, headers, body);
        expect(r.statusCode, `${method} ${url}`).toBe(401);
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it('ops:read lists but cannot recover, resolve or touch staging', async () => {
    const a = await business();
    const job = await deadJob(a.id, await attributedEvent(a.id));
    await blockedRenewal(a.id, 'RKD-SUB-20261108-AAAAAA', true);
    const read = await operator('ops:read');
    const before = await snapshot();

    expect((await call('GET', '/v1/ops/exceptions', read)).statusCode).toBe(200);
    const denied: Array<[string, object]> = [
      [`/v1/ops/dead-jobs/${job}/recover`, { reason: REASON }],
      [`/v1/ops/dead-jobs/${job}/resolve`, { resolution: REASON }],
      ['/v1/ops/exceptions/renewals/RKD-SUB-20261108-AAAAAA/resolve', { resolution: REASON }],
      [`/v1/ops/staging/businesses/${a.id}/designate`, { reason: REASON }],
      [`/v1/ops/staging/businesses/${a.id}/faults`, { kind: 'send_timeout', reason: REASON }],
    ];
    for (const [url, body] of denied) {
      expect((await call('POST', url, read, body)).statusCode, url).toBe(403);
    }
    expect((await call('GET', `/v1/ops/staging/businesses/${a.id}/actions`, read)).statusCode).toBe(
      403,
    );
    expect(await snapshot()).toEqual(before);
  });

  it('ops:payment cannot use staging, and ops:staging cannot recover or resolve', async () => {
    const a = await business();
    const job = await deadJob(a.id, await attributedEvent(a.id));
    const before = await snapshot();
    const payment = await operator('ops:payment');
    const staging = await operator('ops:staging');

    expect(
      (
        await call('POST', `/v1/ops/staging/businesses/${a.id}/designate`, payment, {
          reason: REASON,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call('POST', `/v1/ops/dead-jobs/${job}/recover`, staging, { reason: REASON }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call('POST', `/v1/ops/dead-jobs/${job}/resolve`, staging, { resolution: REASON }))
        .statusCode,
    ).toBe(403);
    expect(await snapshot()).toEqual(before);
  });

  it('a business id, role or scope smuggled into a body grants nothing and is never trusted', async () => {
    const a = await business();
    const b = await business();
    const jobA = await deadJob(a.id, await attributedEvent(a.id));
    const jobB = await deadJob(b.id, await attributedEvent(b.id));
    const payment = await operator('ops:payment');

    // The route names the job; a body naming business B cannot move the action to B.
    const r = await call('POST', `/v1/ops/dead-jobs/${jobA}/resolve`, payment, {
      resolution: REASON,
      businessId: b.id,
      scopes: ['ops:staging'],
    });
    expect(r.statusCode).toBe(200);
    const rows = await ownerDb.execute<{ job_id: string; status: string }>(
      sql`SELECT job_id, status FROM dead_job_exceptions`,
    );
    const byJob = Object.fromEntries([...rows].map((x) => [x.job_id, x.status]));
    expect(byJob[jobA]).toBe('resolved');
    expect(byJob[jobB]).toBe('open');
    const audit = await ownerDb.execute<{ business_id: string }>(
      sql`SELECT business_id FROM audit_events WHERE action = 'dead_job_resolved'`,
    );
    expect([...audit].map((x) => x.business_id)).toEqual([a.id]);
  });
});

/* ── horizontal: a business reaching another business's records ─────────── */

describe('horizontal: business A cannot reach business B through an id or reference', () => {
  it("B's payment record reads as nothing to A, exactly like a reference that never existed", async () => {
    const a = await business();
    const b = await business();
    await blockedRenewal(b.id, 'RKD-SUB-20261108-BBBBBB', false);

    const theirs = await call('GET', '/v1/billing/payments/RKD-SUB-20261108-BBBBBB', a.session);
    const never = await call('GET', '/v1/billing/payments/RKD-SUB-20261108-ZZZZZZ', a.session);
    expect(theirs.statusCode).toBe(404);
    expect(never.statusCode).toBe(404);
    expect(theirs.body).toBe(never.body);
    expect(
      (await call('GET', '/v1/billing/payments/RKD-SUB-20261108-BBBBBB', b.session)).statusCode,
    ).toBe(200);
  });

  it("B's dead job never shows on A's billing page, and A cannot resolve B's payment exception", async () => {
    const a = await business();
    const b = await business();
    await deadJob(b.id, await attributedEvent(b.id));
    const bException = (
      await withBusiness(appDb, b.id, (tx) =>
        settleRepo.reconciliationsFor(tx, { status: 'EXCEPTION', limit: 10 }),
      )
    ).find((r) => r.reason === 'payment_processing_stopped')!;
    const before = await snapshot();

    const overview = (await call('GET', '/v1/billing', a.session)).json() as {
      processingIssue: unknown;
    };
    expect(overview.processingIssue).toBeNull();
    const listed = (await call('GET', '/v1/payments/exceptions', a.session)).json() as {
      exceptions: Array<{ id: string }>;
    };
    expect(listed.exceptions.map((e) => e.id)).not.toContain(bException.id);

    const stolen = await call(
      'POST',
      `/v1/payments/exceptions/${bException.id}/resolve`,
      a.session,
    );
    expect(stolen.statusCode).toBe(404);
    expect(await snapshot()).toEqual(before);
  });

  it('a business session cannot call the operator routes for its own or another business', async () => {
    const a = await business();
    const b = await business();
    const jobB = await deadJob(b.id, await attributedEvent(b.id));
    const before = await snapshot();
    for (const url of [
      `/v1/ops/dead-jobs/${jobB}/resolve`,
      `/v1/ops/dead-jobs/${jobB}/recover`,
      `/v1/ops/staging/businesses/${a.id}/designate`,
    ]) {
      const r = await call('POST', url, a.session, { reason: REASON, resolution: REASON });
      expect(r.statusCode, url).toBe(401);
    }
    expect(await snapshot()).toEqual(before);
  });
});

/* ── operational: an operator pointing at the wrong record ──────────────── */

describe('operational: a recovery or resolution acts only on the record it names', () => {
  const payment = () => operator('ops:payment');

  it('an unknown job id is a 404 and changes nothing', async () => {
    const a = await business();
    await deadJob(a.id, await attributedEvent(a.id));
    const before = await snapshot();
    const unknown = '00000000-0000-4000-8000-00000000dead';
    for (const action of ['recover', 'resolve']) {
      const r = await call('POST', `/v1/ops/dead-jobs/${unknown}/${action}`, await payment(), {
        reason: REASON,
        resolution: REASON,
      });
      expect(r.statusCode, action).toBe(404);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("a job of A that names B's event never binds, recovers, or resolves B's event", async () => {
    const a = await business();
    const b = await business();
    const eventB = await attributedEvent(b.id);
    const jobA = await deadJob(a.id, eventB); // A's payload points at B's event
    const jobB = await deadJob(b.id, eventB);

    const record = (
      await ownerDb.execute<{ event_id: string | null }>(
        sql`SELECT event_id FROM dead_job_exceptions WHERE job_id = ${jobA}::uuid`,
      )
    )[0];
    expect(record?.event_id, "a foreign event is never bound to A's record").toBeNull();

    const before = await snapshot();
    const recover = await call('POST', `/v1/ops/dead-jobs/${jobA}/recover`, await payment(), {
      reason: REASON,
    });
    expect(recover.statusCode).toBe(422); // nothing to verify: no event of A's own
    const afterRecover = await snapshot();
    // The refusal is audited against A's own job; nothing else moved, and nothing was requeued.
    expect(afterRecover.jobs).toEqual(before.jobs);
    expect(afterRecover.events).toEqual(before.events);
    expect(afterRecover.deadJobs).toEqual(before.deadJobs);

    const resolve = await call('POST', `/v1/ops/dead-jobs/${jobA}/resolve`, await payment(), {
      resolution: REASON,
    });
    expect(resolve.statusCode).toBe(200);
    const after = await snapshot();
    expect(after.events, "B's event is untouched by A's resolution").toEqual(before.events);
    const status = Object.fromEntries(
      (after.deadJobs as Array<{ job_id: string; status: string }>).map((r) => [
        r.job_id,
        r.status,
      ]),
    );
    expect(status[jobA]).toBe('resolved');
    expect(status[jobB]).toBe('open');
  });

  it('a job that is already closed cannot be recovered or resolved again', async () => {
    const a = await business();
    const job = await deadJob(a.id, await attributedEvent(a.id));
    expect(
      (
        await call('POST', `/v1/ops/dead-jobs/${job}/resolve`, await payment(), {
          resolution: REASON,
        })
      ).statusCode,
    ).toBe(200);
    const before = await snapshot();
    expect(
      (await call('POST', `/v1/ops/dead-jobs/${job}/recover`, await payment(), { reason: REASON }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await call('POST', `/v1/ops/dead-jobs/${job}/resolve`, await payment(), {
          resolution: REASON,
        })
      ).statusCode,
    ).toBe(409);
    expect(await snapshot()).toEqual(before);
  });

  it('the generic event resolve cannot close an event that belongs to an open dead job', async () => {
    const a = await business();
    const event = await attributedEvent(a.id);
    await deadJob(a.id, event);
    const before = await snapshot();
    const r = await call('POST', `/v1/ops/exceptions/${event}/resolve`, await payment(), {
      resolution: REASON,
    });
    expect(r.statusCode).toBe(409);
    expect(await snapshot()).toEqual(before);
  });

  it('a blocked-renewal reference resolves only that renewal, once, and nothing else', async () => {
    const a = await business();
    const b = await business();
    await blockedRenewal(a.id, 'RKD-SUB-20261108-AAAAAA', true);
    await blockedRenewal(b.id, 'RKD-SUB-20261108-BBBBBB', true); // another open block
    await blockedRenewal(b.id, 'RKD-SUB-20261108-CCCCCC', false); // a plain renewal, never blocked
    const op = await payment();
    const route = (ref: string) => `/v1/ops/exceptions/renewals/${ref}/resolve`;

    const before = await snapshot();
    // A renewal that was never blocked, a reference that does not exist, and a malformed one.
    expect(
      (await call('POST', route('RKD-SUB-20261108-CCCCCC'), op, { resolution: REASON })).statusCode,
    ).toBe(409);
    expect(
      (await call('POST', route('RKD-SUB-20261108-ZZZZZZ'), op, { resolution: REASON })).statusCode,
    ).toBe(404);
    expect(
      (await call('POST', route('not-a-reference'), op, { resolution: REASON })).statusCode,
    ).toBe(404);
    expect(await snapshot()).toEqual(before);

    expect(
      (await call('POST', route('RKD-SUB-20261108-AAAAAA'), op, { resolution: REASON })).statusCode,
    ).toBe(200);
    const after = Object.fromEntries(
      (await snapshot()).charges.map((c) => [
        (c as { reference: string }).reference,
        (c as { blocked_resolved_at: unknown }).blocked_resolved_at !== null,
      ]),
    );
    expect(after).toEqual({
      'RKD-SUB-20261108-AAAAAA': true,
      'RKD-SUB-20261108-BBBBBB': false,
      'RKD-SUB-20261108-CCCCCC': false,
    });
    const audit = await ownerDb.execute<{ business_id: string; entity_id: string }>(
      sql`SELECT business_id, entity_id FROM audit_events WHERE action = 'renewal_block_resolved'`,
    );
    expect([...audit]).toEqual([{ business_id: a.id, entity_id: 'RKD-SUB-20261108-AAAAAA' }]);
    expect(
      (await call('POST', route('RKD-SUB-20261108-AAAAAA'), op, { resolution: REASON })).statusCode,
    ).toBe(409);
  });
});

/* ── staging tools: environment safeguards and per-business scope ───────── */

describe('staging tools act only on the designated business named in the route', () => {
  const mark = () =>
    ownerDb.execute(sql`INSERT INTO staging_environment (marked_by) VALUES ('owner:test')`);
  const trialEnd = async (id: string) =>
    (
      await ownerDb.execute<{ plan_expires_at: Date }>(
        sql`SELECT plan_expires_at FROM businesses WHERE id = ${id}::uuid`,
      )
    )[0]!.plan_expires_at;

  it('without the database marker every staging route refuses and writes nothing', async () => {
    const a = await business();
    const staging = await operator('ops:staging');
    const before = await snapshot();
    const r = await call('POST', `/v1/ops/staging/businesses/${a.id}/designate`, staging, {
      reason: REASON,
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
    expect(await snapshot()).toEqual(before);
  });

  it('designating A gives no power over B: dates, faults and reverts refuse for B', async () => {
    await mark();
    const a = await business();
    const b = await business();
    const staging = await operator('ops:staging');
    const designate = await call('POST', `/v1/ops/staging/businesses/${a.id}/designate`, staging, {
      reason: REASON,
    });
    expect(designate.statusCode).toBe(200);

    const aEnd = await trialEnd(a.id);
    const moved = await call('POST', `/v1/ops/staging/businesses/${a.id}/dates`, staging, {
      field: 'trial_end',
      expected: aEnd.toISOString(),
      to: new Date(Date.now() - DAY).toISOString(),
      reason: REASON,
    });
    expect(moved.statusCode).toBe(200);
    const actionId = (moved.json() as { actionId: string }).actionId;
    const before = await snapshot();
    const bEnd = await trialEnd(b.id);

    // B is not a designated test business.
    const moveB = await call('POST', `/v1/ops/staging/businesses/${b.id}/dates`, staging, {
      field: 'trial_end',
      expected: bEnd.toISOString(),
      to: new Date(Date.now() - DAY).toISOString(),
      reason: REASON,
    });
    expect(moveB.statusCode).toBeGreaterThanOrEqual(400);
    const faultB = await call('POST', `/v1/ops/staging/businesses/${b.id}/faults`, staging, {
      kind: 'send_timeout',
      reason: REASON,
    });
    expect(faultB.statusCode).toBeGreaterThanOrEqual(400);

    // A's action id through B's route reverts nothing and shows nothing.
    const revert = await call(
      'POST',
      `/v1/ops/staging/businesses/${b.id}/actions/${actionId}/revert`,
      staging,
      { reason: REASON },
    );
    expect(revert.statusCode).toBeGreaterThanOrEqual(400);
    const listed = (
      await call('GET', `/v1/ops/staging/businesses/${b.id}/actions`, staging)
    ).json() as {
      actions: unknown[];
    };
    expect(listed.actions).toEqual([]);

    const after = await snapshot();
    expect(after.stagingActions).toEqual(before.stagingActions);
    expect(await trialEnd(b.id)).toEqual(bEnd);
    expect(await trialEnd(a.id), "A's move still stands").not.toEqual(aEnd);
  });
});
