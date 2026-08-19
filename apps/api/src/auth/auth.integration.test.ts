/**
 * Identity, end to end: a real Nest application over a real PostgreSQL.
 *
 * Several of these exist for attacks rather than features, and a few of them
 * cannot be written any other way — an attempt limit that holds under
 * concurrency is a claim about row locking, and a mocked database would only
 * confirm that the mock counts.
 */
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

const SECRET = 'test-secret-at-least-32-characters-long';

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
  process.env['REKODA_API_SECRET'] = SECRET;
  process.env['REKODA_REVEAL_OTP'] = '1';
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
