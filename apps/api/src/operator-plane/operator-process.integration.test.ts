/**
 * OD-51.1: the operator plan routes are served by a dedicated process that holds only the
 * billing-operator credential and verifies the operator's identity ITSELF.
 *
 * Real cryptography and real roles: a local key pair, a JWKS served over HTTP, tokens minted for
 * each caller the boundary must tell apart, and the `rekoda_billing_operator` database role. The
 * point of the separate audience is that a token the API accepts (it sees operator tokens on every
 * other operator route) is not a token that changes a plan, so nothing the API holds or can replay
 * is an authority here.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { createDb, identity, sql, subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import { applicationDb, migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { startOperatorProcess } from '../operator-main.js';
import { buildOperatorServer } from './server.js';

const ISSUER = 'https://issuer.test/';
/** This process's own audience, and the API's: same issuer, same keys, different purpose. */
const BILLING_AUDIENCE = 'rekoda-operator-billing';
const API_AUDIENCE = 'rekoda-operator-plane';

let urls: Urls;
let appDb: Db;
let operatorDb: Db;
let closeApp: () => Promise<void>;
let closeOperator: () => Promise<void>;
let jwks: Server;
let server: Server;
let base: string;
interface Minting {
  audience?: string;
  issuer?: string;
  expiresIn?: string;
}
let sign: (claims: Record<string, unknown>, over?: Minting) => Promise<string>;
let strangerSign: (claims: Record<string, unknown>) => Promise<string>;
let trustedKey: CryptoKey;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 2 }));
  ({ db: operatorDb, close: closeOperator } = createDb(urls.operator, { max: 2 }));

  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const stranger = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'operator-test', alg: 'RS256' };
  jwks = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
  const jwksUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/jwks.json`;
  const mint =
    (key: CryptoKey) =>
    (claims: Record<string, unknown>, over: Minting = {}): Promise<string> =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'operator-test' })
        .setIssuer(over.issuer ?? ISSUER)
        .setAudience(over.audience ?? BILLING_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(over.expiresIn ?? '5m')
        .sign(key);
  sign = mint(privateKey);
  trustedKey = privateKey;
  strangerSign = mint(stranger.privateKey);

  /* The server exactly as `operator-main.ts` builds it, on the operator credential alone. */
  server = buildOperatorServer({
    operatorDb,
    auth: {
      operatorAuth: {
        issuer: ISSUER,
        audience: BILLING_AUDIENCE,
        jwksUrl,
        scopeClaim: 'scope',
        /* As `loadOperatorConfig` sets it (pinned in config.test.ts). */
        exclusiveAudience: true,
      },
      operatorSecret: null,
    },
    release: 'test',
    commit: 'test',
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => jwks.close(() => resolve()));
  await closeApp?.();
  await closeOperator?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let phoneSeq = 0;
async function seedBusiness(): Promise<string> {
  phoneSeq += 1;
  const user = await identity.upsertUserByPhone(
    appDb,
    `+23481930000${String(phoneSeq).padStart(2, '0')}`,
  );
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const billingToken = (sub = 'ada@rekoda.app') => sign({ sub, scope: 'ops:billing' });

const subscription = (businessId: string) =>
  withBusiness(appDb, businessId, async (tx) => {
    const rows = await tx.execute<{ plan: string; plan_expires_at: string | null }>(
      sql`SELECT plan, plan_expires_at::text FROM businesses WHERE id = ${businessId}::uuid`,
    );
    return [...rows][0]!;
  });
const planAudits = (businessId: string) =>
  withBusiness(appDb, businessId, async (tx) => {
    const rows = await tx.execute<{ actor: string }>(
      sql`SELECT actor FROM audit_events WHERE business_id = ${businessId}::uuid
          AND action = 'plan_changed' ORDER BY created_at`,
    );
    return [...rows].map((row) => row.actor);
  });

describe('the operator process verifies the operator itself (OD-51.1)', () => {
  it('changes a plan for a verified operator with ops:billing, and audits the token subject', async () => {
    const businessId = await seedBusiness();

    const res = await post(
      '/v1/businesses/plan',
      { businessId, plan: 'chat', expiresAt: null },
      bearer(await billingToken('ada@rekoda.app')),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: 'chat', changed: true });
    expect((await subscription(businessId)).plan).toBe('chat');
    expect(await planAudits(businessId)).toEqual(['operator:ada@rekoda.app']);
  });

  it('refuses a token minted for the API: a valid operator there is not one here', async () => {
    const businessId = await seedBusiness();
    const apiToken = await sign(
      { sub: 'ada@rekoda.app', scope: 'ops:billing' },
      { audience: API_AUDIENCE },
    );

    const res = await post(
      '/v1/businesses/plan',
      { businessId, plan: 'complete', expiresAt: null },
      bearer(apiToken),
    );

    expect(res.status).toBe(401);
    expect((await subscription(businessId)).plan).toBe('trial');
    expect(await planAudits(businessId)).toEqual([]);
  });

  it('refuses a token that names the API audience as well as its own (review of 208c919)', async () => {
    /* An identity provider that issues ONE token for both audiences would let whoever holds an
     * API-audience token, the API process included, replay it as a plan change. */
    const businessId = await seedBusiness();
    for (const audience of [
      [API_AUDIENCE, BILLING_AUDIENCE],
      [BILLING_AUDIENCE, API_AUDIENCE],
      [BILLING_AUDIENCE, 'some-other-app'],
    ]) {
      const token = await new SignJWT({ sub: 'ada@rekoda.app', scope: 'ops:billing' })
        .setProtectedHeader({ alg: 'RS256', kid: 'operator-test' })
        .setIssuer(ISSUER)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(trustedKey);
      const res = await post(
        '/v1/businesses/plan',
        { businessId, plan: 'complete', expiresAt: null },
        bearer(token),
      );
      expect(res.status, audience.join(',')).toBe(401);
    }
    /* Its own audience alone, as a one-element array, is still its own audience. */
    const single = await new SignJWT({ sub: 'ada@rekoda.app', scope: 'ops:billing' })
      .setProtectedHeader({ alg: 'RS256', kid: 'operator-test' })
      .setIssuer(ISSUER)
      .setAudience([BILLING_AUDIENCE])
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(trustedKey);
    expect(
      (
        await post(
          '/v1/businesses/plan',
          { businessId, plan: 'chat', expiresAt: null },
          bearer(single),
        )
      ).status,
    ).toBe(200);
    expect((await subscription(businessId)).plan).toBe('chat');
  });

  it('refuses no token, a shared secret, a forged signature, another issuer and an expired token', async () => {
    const businessId = await seedBusiness();
    const body = { businessId, plan: 'complete', expiresAt: null };
    const attempts: Record<string, string>[] = [
      {},
      { 'x-rekoda-operator-secret': 'x'.repeat(40) },
      { 'x-rekoda-api-secret': 'x'.repeat(40) },
      bearer('not-a-token'),
      bearer(await strangerSign({ sub: 'mallory', scope: 'ops:billing' })),
      bearer(await sign({ sub: 'ada', scope: 'ops:billing' }, { issuer: 'https://evil.test/' })),
      bearer(await sign({ sub: 'ada', scope: 'ops:billing' }, { expiresIn: '-1m' })),
    ];
    for (const headers of attempts) {
      const res = await post('/v1/businesses/plan', body, headers);
      expect(res.status, JSON.stringify(Object.keys(headers))).toBe(401);
    }
    expect((await subscription(businessId)).plan).toBe('trial');
    expect(await planAudits(businessId)).toEqual([]);
  });

  it('refuses a verified operator without ops:billing, naming the scope, and changes nothing', async () => {
    const businessId = await seedBusiness();
    const token = await sign({ sub: 'ada@rekoda.app', scope: 'ops:read ops:payment' });

    for (const path of ['/v1/businesses/plan', '/v1/businesses/plan/support-review']) {
      const res = await post(
        path,
        { businessId, plan: 'complete', expiresAt: null },
        bearer(token),
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { message: string }).message).toMatch(/ops:billing/);
    }
    expect((await subscription(businessId)).plan).toBe('trial');
  });

  it('refuses a subject it could not record as an audit actor, before anything is written', async () => {
    const businessId = await seedBusiness();
    const token = await sign({ sub: 'ada lovelace', scope: 'ops:billing' });

    const res = await post(
      '/v1/businesses/plan',
      { businessId, plan: 'chat', expiresAt: null },
      bearer(token),
    );

    expect(res.status).toBe(400);
    expect((await subscription(businessId)).plan).toBe('trial');
  });

  it('keeps the plan rules of the operations it runs: a caller date is refused (OD-50, 0207)', async () => {
    const businessId = await seedBusiness();
    const token = await billingToken();

    const dated = await post(
      '/v1/businesses/plan',
      { businessId, plan: 'chat', expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() },
      bearer(token),
    );
    expect(dated.status).toBe(400);
    expect((await subscription(businessId)).plan).toBe('trial');
  });

  it('resolves a support-reviewed upgrade and keeps the paid-through date (OD-50, 0213)', async () => {
    const businessId = await seedBusiness();
    const token = await billingToken('ada@rekoda.app');
    expect(
      (
        await post(
          '/v1/businesses/plan',
          { businessId, plan: 'chat', expiresAt: null },
          bearer(token),
        )
      ).status,
    ).toBe(200);
    const before = await subscription(businessId);
    expect(
      await withBusiness(applicationDb(), businessId, (tx) =>
        subscriptionsRepo.requestPlanReview(tx, businessId, 'complete'),
      ),
    ).not.toBeNull();

    const withDate = await post(
      '/v1/businesses/plan/support-review',
      { businessId, plan: 'complete', reason: 'paid by transfer', expiresAt: null },
      bearer(token),
    );
    expect(withDate.status).toBe(400);

    const res = await post(
      '/v1/businesses/plan/support-review',
      { businessId, plan: 'complete', reason: 'paid by transfer' },
      bearer(token),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      plan: 'complete',
      previousPlan: 'chat',
      changed: true,
    });
    const after = await subscription(businessId);
    expect(after.plan).toBe('complete');
    expect(after.plan_expires_at).toBe(before.plan_expires_at);
  });
});

describe('the operator process serves the plan routes and nothing else', () => {
  it('answers health, and 404 for every other path, without reading an identity', async () => {
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', process: 'operator' });
    for (const path of ['/', '/v1/ops/exceptions', '/v1/businesses', '/v1/businesses/plan/x']) {
      expect((await post(path, {}, bearer(await billingToken()))).status, path).toBe(404);
    }
    expect(
      (await post('/v1/businesses/plan', undefined, bearer(await billingToken()), 'GET')).status,
    ).toBe(405);
  });

  it('refuses a body that is not JSON, is not valid JSON, or is too large', async () => {
    const headers = bearer(await billingToken());
    const text = await post('/v1/businesses/plan', 'plan=complete', {
      ...headers,
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(text.status).toBe(415);
    expect((await post('/v1/businesses/plan', '{"plan":', headers)).status).toBe(400);
    const large = await post(
      '/v1/businesses/plan',
      JSON.stringify({ pad: 'x'.repeat(20 * 1024) }),
      headers,
    );
    expect(large.status).toBe(413);
  });
});

describe('the operator process holds one credential, and it must be the operator role', () => {
  const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    NODE_ENV: 'test',
    PORT: '0',
    OPERATOR_DATABASE_URL: urls.operator,
    REKODA_OPERATOR_SECRET: `operator-${randomBytes(24).toString('hex')}`,
    ...over,
  });

  it('starts on rekoda_billing_operator alone and answers health', async () => {
    const running = await startOperatorProcess(env());
    try {
      const health = await fetch(`http://127.0.0.1:${running.port}/health`);
      expect(await health.json()).toMatchObject({ status: 'ok', process: 'operator' });
    } finally {
      await running.close();
    }
  });

  it('refuses to start on the application, worker, settlement or owner credential', async () => {
    for (const url of [urls.app, urls.worker, urls.settlement, urls.owner]) {
      await expect(startOperatorProcess(env({ OPERATOR_DATABASE_URL: url }))).rejects.toThrow(
        /rekoda_billing_operator|SUPERUSER|BYPASSRLS/,
      );
    }
  });

  it('the credential it holds cannot read a tenant record, settle a charge or run a job', async () => {
    const businessId = await seedBusiness();
    const refusal = (statement: ReturnType<typeof sql>) =>
      withBusiness(operatorDb, businessId, (tx) => tx.execute(statement)).then(
        () => 'allowed',
        (error: { cause?: { message?: string } }) => String(error.cause?.message),
      );
    for (const statement of [
      sql`SELECT 1 FROM customers LIMIT 1`,
      sql`SELECT 1 FROM subscription_charges LIMIT 1`,
      sql`SELECT 1 FROM jobs LIMIT 1`,
      sql`SELECT 1 FROM sessions LIMIT 1`,
      sql`UPDATE usage_counters SET bonus = 1000`,
      sql`SELECT public.usage_credit_pack(${businessId}::uuid, 'RKD-ADD-X', '2026-11', 'AI_ACTIONS', 100)`,
    ]) {
      expect(await refusal(statement)).toMatch(/permission denied/);
    }
  });
});
