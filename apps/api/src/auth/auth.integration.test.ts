/**
 * Identity, end to end: a real Nest application over a real PostgreSQL.
 *
 * Several of these exist for attacks rather than features, and a few of them
 * cannot be written any other way — an attempt limit that holds under
 * concurrency is a claim about row locking, and a mocked database would only
 * confirm that the mock counts.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MAX_FAILURES_PER_WINDOW, AuthService } from './auth.service.js';
import { AuthController, BusinessController } from './auth.controller.js';
import { SessionGuard } from './session.guard.js';
import { RolesGuard } from './roles.guard.js';
import { HealthController } from '../health/health.controller.js';
import { issueSetupToken } from './tokens.js';
import { OTP_MAX_ATTEMPTS } from '@rekoda/core/identity';
import { StubSender } from '../channels/sender.stub.js';

const SECRET = 'test-secret-at-least-32-characters-long';
/* The operator credential is deliberately NOT the session-signing secret:
 * it travels in a plaintext header, and config refuses to boot if they
 * match. See the note on `operatorSecret` in config.ts. */
const OPERATOR_SECRET = `operator-${SECRET}`;

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  // requireUrls throws rather than skips: an integration suite that quietly
  // passes with no database reports the same green tick as one that proved
  // something.
  urls = requireUrls();
  await migrate(urls);

  // The API must run as `rekoda_app` — not the owner, no BYPASSRLS — or every
  // tenancy assertion underneath these tests passes for the wrong reason.
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = 'test-pepper-at-least-32-characters-long';
  // 64 hex characters each — 32 bytes, what AES-256 needs. Derived per run
  // rather than written down, so no scanner has a literal to object to.
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_API_SECRET'] = SECRET;
  process.env['REKODA_OPERATOR_SECRET'] = OPERATOR_SECRET;
  process.env['REKODA_REVEAL_OTP'] = '1';
  // This suite makes a few hundred requests from one address in seconds, which
  // is exactly what the limiter exists to stop. The limiter gets its own test
  // below, on its own app instance, rather than throttling everything else.
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

/* ── helpers ─────────────────────────────────────────────────────── */

function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, payload: payload as object, headers });
}

async function requestCode(phone: string): Promise<string> {
  const res = await post('/v1/auth/otp/request', { phone });
  const body = res.json() as { status: string; devCode?: string };
  expect(body.status).toBe('sent');
  return body.devCode!;
}

/** Phone → verified → business created → session token. */
async function onboard(phone: string, name = 'Ada Fashion') {
  const code = await requestCode(phone);
  const verified = (await post('/v1/auth/otp/verify', { phone, code })).json() as {
    status: string;
    setupToken: string;
  };
  expect(verified.status).toBe('setup_required');

  const created = await post(
    '/v1/businesses',
    { name, businessType: 'Fashion & clothing' },
    { 'x-rekoda-setup-token': verified.setupToken },
  );
  expect(created.statusCode).toBe(201);
  return created.json() as { sessionToken: string; businessId: string; role: string };
}

/* ── tests ───────────────────────────────────────────────────────── */

/**
 * Guards against a failure that is silent in both directions.
 *
 * Nest reads constructor dependencies from `design:paramtypes`, which only a
 * TypeScript build with `emitDecoratorMetadata` produces — esbuild, which the
 * test runner uses, does not. With the metadata absent Nest does not error: it
 * concludes the class has NO dependencies, constructs it with none, and every
 * request becomes a 500 on the first property access.
 *
 * The fix is an explicit `@Inject()` on every constructor parameter, so wiring
 * never depends on which compiler ran. This test is what keeps that true when
 * the next provider is added.
 */
describe('per-IP rate limiting', () => {
  it('returns 429 once an address exceeds its budget', async () => {
    // A second app with a tiny ceiling. The property under test is that the
    // limiter is actually wired to every route — the per-phone limits cannot
    // see a caller walking through thousands of DIFFERENT numbers, and once
    // delivery costs money per message that is a way to bill Rekoda by the
    // request.
    process.env['REKODA_RATE_LIMIT_MAX'] = '3';
    const { createApp } = await import('../main.js');
    const limited = await createApp();
    await limited.init();
    await limited.getHttpAdapter().getInstance().ready();

    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await limited.inject({
          method: 'POST',
          url: '/v1/auth/otp/request',
          payload: { phone: '08031234590' },
        });
        statuses.push(res.statusCode);
      }
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);

      // Health is on the allow list: the platform polls it, and a throttled
      // health check reads as an outage.
      const health = await limited.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
    } finally {
      await limited.close();
      process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
    }
  });
});

describe('dependency wiring', () => {
  it('injects every constructor dependency without relying on decorator metadata', () => {
    const cases: Array<[string, object, string]> = [
      ['AuthController', app.get(AuthController), 'auth'],
      ['BusinessController', app.get(BusinessController), 'auth'],
      ['SessionGuard', app.get(SessionGuard), 'auth'],
      ['RolesGuard', app.get(RolesGuard), 'reflector'],
      ['HealthController', app.get(HealthController), 'db'],
      ['AuthService', app.get(AuthService), 'db'],
    ];
    for (const [name, instance, dependency] of cases) {
      expect(
        (instance as Record<string, unknown>)[dependency],
        `${name}.${dependency}`,
      ).toBeDefined();
    }
  });
});

describe('health', () => {
  it('reports the applied migration count, not just a live socket', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toMatchObject({ status: 'ok', database: 'up' });
    expect((res.json() as { migrations: number }).migrations).toBeGreaterThan(0);
  });
});

describe('the onboarding journey', () => {
  it('takes a merchant from a phone number to an authenticated session', async () => {
    const session = await onboard('08031234567');

    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(me.json()).toMatchObject({
      phone: '+2348031234567',
      businessName: 'Ada Fashion',
      plan: 'trial',
      role: 'owner',
    });
  });

  it('resolves every format of the same number to ONE merchant', async () => {
    await onboard('08031234567');
    // A second sign-in in any other format must find the existing business,
    // not mint a second one with its own ledger.
    const code = await requestCode('+234 803 123 4567');
    const verified = (
      await post('/v1/auth/otp/verify', {
        phone: '(0803) 123.4567',
        code,
      })
    ).json() as { status: string; memberships: unknown[] };

    expect(verified.status).toBe('signed_in');
    expect(verified.memberships).toHaveLength(1);
  });

  it('does not create a second business when the grant is submitted twice', async () => {
    // A double-tap on "Create", or a retry on a flaky network, must not leave
    // the merchant with two businesses and two separate ledgers.
    const phone = '08031234580';
    const code = await requestCode(phone);
    const verified = (await post('/v1/auth/otp/verify', { phone, code })).json() as {
      setupToken: string;
    };

    const first = await post(
      '/v1/businesses',
      { name: 'Ada Fashion', businessType: 'Fashion & clothing' },
      { 'x-rekoda-setup-token': verified.setupToken },
    );
    const second = await post(
      '/v1/businesses',
      { name: 'Ada Fashion', businessType: 'Fashion & clothing' },
      { 'x-rekoda-setup-token': verified.setupToken },
    );

    expect(second.statusCode).toBe(201);
    expect((second.json() as { businessId: string }).businessId).toBe(
      (first.json() as { businessId: string }).businessId,
    );
  });

  it('refuses a business with no valid setup token', async () => {
    const res = await post(
      '/v1/businesses',
      { name: 'Ada Fashion', businessType: 'Fashion & clothing' },
      { 'x-rekoda-setup-token': 'not-a-real-token' },
    );
    expect(res.statusCode).toBe(401);
  });

  it('refuses a setup token signed with the wrong secret', async () => {
    const { token } = issueSetupToken(
      { userId: crypto.randomUUID(), phone: '+2348031234567' },
      new Date(),
      'a-different-secret-at-least-32-characters',
    );
    const res = await post(
      '/v1/businesses',
      { name: 'Forged Ltd', businessType: 'Fashion & clothing' },
      { 'x-rekoda-setup-token': token },
    );
    expect(res.statusCode).toBe(401);
  });

  it('never blocks a merchant who has no CAC or TIN', async () => {
    // ADR 0012: requiring registration would exclude exactly the merchants
    // Rekoda exists for. This asserts the request shape has no room for it.
    const session = await onboard('08031234599', 'Mama Nkechi Provisions');
    expect(session.businessId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe('OTP defences', () => {
  it('counts down wrong attempts and then refuses the CORRECT code', async () => {
    const phone = '08031234568';
    const code = await requestCode(phone);

    for (let i = 1; i <= OTP_MAX_ATTEMPTS; i++) {
      const res = (await post('/v1/auth/otp/verify', { phone, code: '000000' })).json() as {
        status: string;
        attemptsLeft: number;
      };
      expect(res.status).toBe('wrong_code');
      expect(res.attemptsLeft).toBe(OTP_MAX_ATTEMPTS - i);
    }

    // Brute force must not be rescued by finally guessing right.
    const withRightCode = (await post('/v1/auth/otp/verify', { phone, code })).json() as {
      status: string;
    };
    expect(withRightCode.status).toBe('too_many_attempts');
  });

  it('holds the attempt limit under CONCURRENT guesses', async () => {
    // The property under test is the advisory lock in withPhoneLock. Without
    // it, twelve parallel guesses each read attempts = 0, each conclude they
    // are within budget, and each write attempts = 1 — an unlimited-tries bug
    // that no sequential test can see.
    const phone = '08031234569';
    await requestCode(phone);

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        post('/v1/auth/otp/verify', { phone, code: '000000' }).then(
          (r) => (r.json() as { status: string }).status,
        ),
      ),
    );

    const wrong = results.filter((s) => s === 'wrong_code').length;
    expect(wrong).toBeLessThanOrEqual(OTP_MAX_ATTEMPTS);
    expect(results.filter((s) => s === 'too_many_attempts').length).toBeGreaterThan(0);
  });

  it('cannot be reset by requesting a fresh code after burning attempts', async () => {
    // The per-challenge limit alone is a sixty-second inconvenience: burn five,
    // wait out the cooldown, request a new challenge with the counter at zero.
    // The cross-challenge window is what actually bounds guessing.
    const phone = '08031234570';
    const service = app.get(AuthService);

    let guesses = 0;
    for (let round = 0; round < 6; round++) {
      // Each round is a fresh challenge, issued past the resend cooldown.
      const now = new Date(Date.now() + round * 61_000);
      const issued = await service.requestOtp(phone, now);
      if (issued.status === 'locked_out') break;

      for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
        const res = await service.verifyOtp(phone, '000000', now);
        if (res.status === 'locked_out') break;
        if (res.status === 'wrong_code') guesses++;
      }
    }

    expect(guesses).toBeLessThanOrEqual(MAX_FAILURES_PER_WINDOW);
    expect((await service.requestOtp(phone)).status).toBe('locked_out');
  });

  it('refuses a code that has already been spent', async () => {
    const phone = '08031234571';
    const code = await requestCode(phone);
    expect(
      ((await post('/v1/auth/otp/verify', { phone, code })).json() as { status: string }).status,
    ).toBe('setup_required');

    const replay = (await post('/v1/auth/otp/verify', { phone, code })).json() as {
      status: string;
    };
    expect(replay.status).toBe('expired');
  });

  it('reuses the live challenge instead of minting one on a fast resend', async () => {
    const phone = '08031234572';
    await requestCode(phone);
    const second = (await post('/v1/auth/otp/request', { phone })).json() as { status: string };
    expect(second.status).toBe('resend_too_soon');
  });

  it('answers identically whether or not a number has a pending sign-in', async () => {
    // Status codes and distinct messages are a side channel — "unknown number"
    // versus "wrong code" tells a prober which numbers to keep.
    const never = await post('/v1/auth/otp/verify', { phone: '08039999999', code: '123456' });
    expect(never.statusCode).toBe(200);
    expect(never.json()).toEqual({ status: 'expired' });
  });

  it('rejects a number that is not a Nigerian mobile', async () => {
    const res = await post('/v1/auth/otp/request', { phone: '+1 415 555 0100' });
    expect(res.statusCode).toBe(400);
  });
});

describe('sessions', () => {
  it('does not resurrect a revoked session', async () => {
    const session = await onboard('08031234573');
    const auth = { authorization: `Bearer ${session.sessionToken}` };

    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth })).statusCode,
    ).toBe(200);
    await app.inject({ method: 'DELETE', url: '/v1/auth/session', headers: auth });

    // Rolling refresh runs on every valid use; revocation is checked first, so
    // using a dead session must not push its expiry forward and revive it.
    expect(
      (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth })).statusCode,
    ).toBe(401);
  });

  it('rejects a token that was never issued', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: 'Bearer clearly-not-a-real-session-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with no Authorization header at all', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me' })).statusCode).toBe(401);
  });
});

describe('roles', () => {
  it('lets an owner reach settings and keeps an accountant out', async () => {
    const owner = await onboard('08031234574');

    // The accountant is INSIDE the tenant: every row passes the RLS policy for
    // them. Only the guard stands between them and settings, which is exactly
    // why this is an exit criterion rather than an assumption.
    const accountant = await identity.upsertUserByPhone(db, '+2348031234575');
    await identity.addMembership(db, owner.businessId, accountant.id, 'accountant');

    const code = await requestCode('+2348031234575');
    const signedIn = (
      await post('/v1/auth/otp/verify', {
        phone: '+2348031234575',
        code,
      })
    ).json() as { status: string; sessionToken: string };
    expect(signedIn.status).toBe('signed_in');

    expect(
      (await post('/v1/businesses/settings', {}, { authorization: `Bearer ${owner.sessionToken}` }))
        .statusCode,
    ).toBe(200);

    expect(
      (
        await post(
          '/v1/businesses/settings',
          {},
          { authorization: `Bearer ${signedIn.sessionToken}` },
        )
      ).statusCode,
    ).toBe(403);
  });
});

describe('OTP delivery (the gate between the funnel and the product)', () => {
  function serviceWith(sender: StubSender, revealOtp = false) {
    return new AuthService(
      db,
      {
        otpPepper: 'test-pepper-at-least-32-characters-long',
        apiSecret: SECRET,
        revealOtp,
      } as never,
      sender,
    );
  }

  it('sends the code to the requesting phone over the message channel', async () => {
    const sender = new StubSender();
    const response = await serviceWith(sender).requestOtp('+2348031239001');

    expect(response.status).toBe('sent');
    expect(sender.authCodes).toHaveLength(1);
    expect(sender.authCodes[0]?.to).toBe('+2348031239001');
    expect(sender.authCodes[0]?.code).toMatch(/^\d{6}$/);
  });

  /**
   * The distinction that decides whether anybody can sign in at all.
   *
   * A code goes to a phone that has NOT messaged the business number, so
   * there is no 24-hour service window to reply inside and Meta rejects a
   * free-form text to it. Sending one anyway is how sign-in passes every test
   * and reaches nobody.
   */
  it('never sends a sign-in code as an ordinary text message', async () => {
    const sender = new StubSender();
    await serviceWith(sender).requestOtp('+2348031239011');

    expect(sender.sent).toHaveLength(0);
  });

  it('still answers "sent" when delivery fails — resend is the recovery, not an oracle', async () => {
    const sender = new StubSender();
    sender.failWith();
    const response = await serviceWith(sender).requestOtp('+2348031239002');
    expect(response.status).toBe('sent');
  });

  it('does not send twice inside the resend cooldown', async () => {
    const sender = new StubSender();
    const service = serviceWith(sender);
    await service.requestOtp('+2348031239003');
    const second = await service.requestOtp('+2348031239003');
    expect(second.status).toBe('resend_too_soon');
    expect(sender.authCodes).toHaveLength(1);
  });
});

describe('the operator plan endpoint', () => {
  const OPERATOR = { 'x-rekoda-operator-secret': OPERATOR_SECRET };

  async function businessFor(phone: string): Promise<string> {
    const code = await requestCode(phone);
    const verified = (await post('/v1/auth/otp/verify', { phone, code })).json() as {
      setupToken: string;
    };
    const created = await post(
      '/v1/businesses',
      { name: 'Ada Fashion', businessType: 'Fashion & clothing' },
      { 'x-rekoda-setup-token': verified.setupToken },
    );
    return (created.json() as { businessId: string }).businessId;
  }

  const change = (body: unknown, headers: Record<string, string> = OPERATOR) =>
    post('/v1/businesses/plan', body, headers);

  it('moves a business onto a paid plan for the operator who names themselves', async () => {
    const businessId = await businessFor('08031234590');
    const res = await change({
      businessId,
      plan: 'chat',
      expiresAt: new Date(Date.now() + 31 * 86_400_000).toISOString(),
      actor: 'angelo',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plan: 'chat' });
  });

  it('refuses without the operator secret, and with a wrong one', async () => {
    const businessId = await businessFor('08031234591');
    const body = { businessId, plan: 'complete', expiresAt: null, actor: 'angelo' };

    expect((await change(body, {})).statusCode).toBe(403);
    expect(
      (await change(body, { 'x-rekoda-operator-secret': 'not-the-secret-but-long-enough-here' }))
        .statusCode,
    ).toBe(403);
  });

  it('refuses a session token in place of the operator secret', async () => {
    // The whole point of the gate: an owner cannot award themselves a plan.
    const phone = '08031234592';
    const code = await requestCode(phone);
    const verified = (await post('/v1/auth/otp/verify', { phone, code })).json() as {
      setupToken: string;
    };
    const created = await post(
      '/v1/businesses',
      { name: 'Ada Fashion', businessType: 'Fashion & clothing' },
      { 'x-rekoda-setup-token': verified.setupToken },
    );
    const session = created.json() as { sessionToken: string; businessId: string };

    const res = await change(
      { businessId: session.businessId, plan: 'complete', expiresAt: null, actor: 'self' },
      { 'x-rekoda-operator-secret': session.sessionToken },
    );
    expect(res.statusCode).toBe(403);
  });

  it('answers 400 for a malformed body and 404 for an unknown business', async () => {
    expect((await change({ plan: 'chat' })).statusCode).toBe(400);
    expect(
      (await change({ businessId: 'not-a-uuid', plan: 'chat', expiresAt: null, actor: 'a' }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await change({
          businessId: '2b0f9b6a-0000-4000-8000-000000000000',
          plan: 'chat',
          expiresAt: null,
          actor: 'angelo',
        })
      ).statusCode,
    ).toBe(404);
  });
});

/**
 * Who can see the books.
 *
 * The `accountant` role has been enforced since M1 and nobody could ever
 * become one, which made the guard a fence around an empty field. Most of
 * what follows is about the boundary rather than the feature: an accountant
 * is INSIDE the tenant and passes every row-level security policy, so this
 * guard is the only thing standing between them and handing out access.
 */
describe('the team an owner can build', () => {
  async function ownerOf(phone: string) {
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

  const team = (auth: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/v1/businesses/members', headers: auth });

  it('starts with the owner alone', async () => {
    const owner = await ownerOf('+2348140000001');
    const body = team(owner.auth);
    const members = (await body).json() as { members: Array<{ role: string }> };
    expect(members.members).toHaveLength(1);
    expect(members.members[0]?.role).toBe('owner');
  });

  it('invites an accountant by phone, before they have ever signed in', async () => {
    const owner = await ownerOf('+2348140000002');

    const invited = await post(
      '/v1/businesses/members',
      { phone: '+2348149990001', role: 'accountant' },
      owner.auth,
    );
    expect(invited.statusCode).toBe(201);
    expect(invited.json()).toMatchObject({ role: 'accountant', phone: '+2348149990001' });

    const members = (await team(owner.auth)).json() as { members: Array<{ role: string }> };
    expect(members.members.map((m) => m.role).sort()).toEqual(['accountant', 'owner']);
  });

  it('that accountant can then sign in on their own phone and reach the books', async () => {
    const owner = await ownerOf('+2348140000003');
    await post(
      '/v1/businesses/members',
      { phone: '+2348149990002', role: 'accountant' },
      owner.auth,
    );

    const requested = (await post('/v1/auth/otp/request', { phone: '+2348149990002' })).json() as {
      devCode?: string;
    };
    const verified = (
      await post('/v1/auth/otp/verify', {
        phone: '+2348149990002',
        code: requested.devCode,
      })
    ).json() as {
      status: string;
      sessionToken?: string;
      memberships?: Array<{ businessId: string; role: string }>;
    };

    /* No setup grant: they already belong to a business, so verifying hands
     * them a session for it rather than sending them to onboarding. */
    expect(verified.status).toBe('signed_in');
    expect(verified.memberships).toEqual([
      expect.objectContaining({ businessId: owner.businessId, role: 'accountant' }),
    ]);
  });

  /**
   * The boundary, stated. An accountant passes every RLS policy on every row
   * of this business, so nothing below the guard would stop them.
   */
  it('REFUSES an accountant who tries to invite somebody else', async () => {
    const owner = await ownerOf('+2348140000004');
    await post(
      '/v1/businesses/members',
      { phone: '+2348149990003', role: 'accountant' },
      owner.auth,
    );

    const requested = (await post('/v1/auth/otp/request', { phone: '+2348149990003' })).json() as {
      devCode?: string;
    };
    const signedIn = (
      await post('/v1/auth/otp/verify', {
        phone: '+2348149990003',
        code: requested.devCode,
      })
    ).json() as { sessionToken: string };
    const accountant = { authorization: `Bearer ${signedIn.sessionToken}` };

    expect(
      (
        await post(
          '/v1/businesses/members',
          { phone: '+2348149990009', role: 'delegate' },
          accountant,
        )
      ).statusCode,
    ).toBe(403);
    expect((await team(accountant)).statusCode).toBe(403);
  });

  it('refuses a second membership for the same person', async () => {
    const owner = await ownerOf('+2348140000005');
    const body = { phone: '+2348149990004', role: 'accountant' };
    expect((await post('/v1/businesses/members', body, owner.auth)).statusCode).toBe(201);
    /* Two rows for one person is not richer access, it is a role that depends
     * on which row a query reads first. */
    expect((await post('/v1/businesses/members', body, owner.auth)).statusCode).toBe(409);
  });

  it('refuses a role nobody may hand out, and a phone that is not one', async () => {
    const owner = await ownerOf('+2348140000006');
    expect(
      (await post('/v1/businesses/members', { phone: '+2348149990005', role: 'owner' }, owner.auth))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post(
          '/v1/businesses/members',
          { phone: 'not-a-phone', role: 'accountant' },
          owner.auth,
        )
      ).statusCode,
    ).toBe(400);
  });

  it('removes an accountant, and says so honestly when there was nobody to remove', async () => {
    const owner = await ownerOf('+2348140000007');
    const invited = (
      await post(
        '/v1/businesses/members',
        { phone: '+2348149990006', role: 'accountant' },
        owner.auth,
      )
    ).json() as { userId: string };

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/businesses/members/${invited.userId}`,
      headers: owner.auth,
    });
    expect(removed.json()).toEqual({ removed: true });

    const again = await app.inject({
      method: 'DELETE',
      url: `/v1/businesses/members/${invited.userId}`,
      headers: owner.auth,
    });
    expect(again.json()).toEqual({ removed: false });
  });

  /**
   * A business with no owner has nobody who can invite one back, change its
   * plan, or delete its data. It is a tenant nobody can administer, and the
   * repair is a database console.
   */
  it('REFUSES to remove the owner, even at the owner request', async () => {
    const owner = await ownerOf('+2348140000008');
    const members = (await team(owner.auth)).json() as {
      members: Array<{ userId: string; role: string }>;
    };
    const self = members.members.find((m) => m.role === 'owner')!;

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/businesses/members/${self.userId}`,
      headers: owner.auth,
    });
    expect(res.statusCode).toBe(400);
    expect((await team(owner.auth)).json()).toMatchObject({ members: [{ role: 'owner' }] });
  });

  it('never shows one business the people of another', async () => {
    const mine = await ownerOf('+2348140000009');
    const theirs = await ownerOf('+2348140000010');
    await post(
      '/v1/businesses/members',
      { phone: '+2348149990007', role: 'accountant' },
      theirs.auth,
    );

    const members = (await team(mine.auth)).json() as { members: unknown[] };
    expect(members.members).toHaveLength(1);
    expect(JSON.stringify(members)).not.toContain('2348149990007');
  });
});
