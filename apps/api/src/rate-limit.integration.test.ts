/**
 * The per-IP limit counts visitors, not hops (G-71).
 *
 * A real API app with a tiny ceiling, driven the way production drives it:
 * requests arriving from Caddy's address carry Caddy's X-Forwarded-For entry,
 * requests arriving from the web tier's address carry X-Rekoda-Client-IP, and
 * requests from anywhere else carry whatever a stranger chooses to send.
 * Fastify's inject sets the TCP peer, which is the fact the API trusts.
 *
 * The end-to-end half, through a real Caddy and a real Next.js, is the
 * deployment smoke test (scripts/deploy-smoke.sh).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { migrate, requireUrls, truncateAll } from '@rekoda/db/testing';
import { CLIENT_ADDRESS_HEADER } from './client-address.js';

const CADDY = '10.20.0.10';
const WEB = '10.20.0.11';
const LIMIT = 4;

const CHANGED = [
  'DATABASE_URL',
  'OTP_PEPPER',
  'VAULT_KEY',
  'MATCH_KEY',
  'REKODA_API_SECRET',
  'REKODA_RATE_LIMIT_MAX',
  'REKODA_TRUSTED_PROXIES',
  'REKODA_TRUSTED_WEB',
] as const;
const saved = new Map<string, string | undefined>();
let app: NestFastifyApplication;
let urls: ReturnType<typeof requireUrls>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  /* A clean estate, as every suite starts: the key fingerprints another run
   * enrolled would refuse this run's fresh keys. */
  await truncateAll(urls);
  for (const name of CHANGED) saved.set(name, process.env[name]);
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = 'rate-limit-pepper-at-least-32-characters';
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_API_SECRET'] = 'rate-limit-secret-at-least-32-characters';
  process.env['REKODA_RATE_LIMIT_MAX'] = String(LIMIT);
  process.env['REKODA_TRUSTED_PROXIES'] = CADDY;
  process.env['REKODA_TRUSTED_WEB'] = WEB;
  const { createApp } = await import('./main.js');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  /* And leave it clean: the next suite enrols its own keys. */
  await truncateAll(urls);
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** A dashboard-shaped request (401 without a session, but counted first). */
const me = (remoteAddress: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: '/v1/auth/me', remoteAddress, headers });
const viaWeb = (visitor?: string) =>
  me(WEB, visitor === undefined ? {} : { [CLIENT_ADDRESS_HEADER]: visitor });
const viaCaddy = (forwarded: string, headers: Record<string, string> = {}) =>
  me(CADDY, { 'x-forwarded-for': forwarded, ...headers });
const otpViaWeb = (visitor: string, phone: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/auth/otp/request',
    remoteAddress: WEB,
    headers: { [CLIENT_ADDRESS_HEADER]: visitor },
    payload: { phone },
  });

async function statuses(send: () => Promise<{ statusCode: number }>, times: number) {
  const out: number[] = [];
  for (let i = 0; i < times; i++) out.push((await send()).statusCode);
  return out;
}
const limited = (codes: number[]) => codes.filter((c) => c === 429).length;

describe('the web tier calls for distinct visitors', () => {
  it('lets visitor A exhaust A’s own bucket and leaves visitor B’s fresh', async () => {
    const a = await statuses(() => viaWeb('203.0.113.1'), LIMIT + 1);
    expect(limited(a.slice(0, LIMIT))).toBe(0);
    expect(a[LIMIT]).toBe(429);
    expect((await viaWeb('203.0.113.2')).statusCode).not.toBe(429);
  });

  it('keys sign-in codes and dashboard requests per visitor, not on one web bucket', async () => {
    const c = '203.0.113.3';
    expect(limited(await statuses(() => viaWeb(c), LIMIT + 1))).toBe(1);
    /* The same visitor's sign-in request is over the same budget ... */
    expect((await otpViaWeb(c, '08031234581')).statusCode).toBe(429);
    /* ... and another visitor's sign-in, through the same web tier, is not. */
    expect((await otpViaWeb('203.0.113.4', '08031234582')).statusCode).not.toBe(429);
  });

  it('counts a call made for no visitor against the web tier itself, apart from every visitor', async () => {
    expect(limited(await statuses(() => viaWeb(), LIMIT + 1))).toBe(1);
    expect((await viaWeb('203.0.113.5')).statusCode).not.toBe(429);
  });

  it('keys an IPv6 visitor by /64, so rotating within one allocation resets nothing', async () => {
    const first = await statuses(() => viaWeb('2001:db8:5:5::1'), LIMIT);
    expect(limited(first)).toBe(0);
    expect((await viaWeb('2001:db8:5:5:ffff::2')).statusCode).toBe(429);
    expect((await viaWeb('2001:db8:5:6::1')).statusCode).not.toBe(429);
  });
});

describe('nobody else can name the visitor', () => {
  it('ignores the header on a request from Caddy, which is keyed by its X-Forwarded-For entry', async () => {
    /* A browser that got the header past Caddy (it cannot: Caddy removes it)
     * still could not choose its bucket, because only the web tier is
     * believed. Here visitor E sends F's address every time. */
    const e = await statuses(
      () => viaCaddy('198.51.100.1', { [CLIENT_ADDRESS_HEADER]: '198.51.100.2' }),
      LIMIT + 1,
    );
    expect(e[LIMIT]).toBe(429);
    /* F's bucket was never touched ... */
    expect((await viaWeb('198.51.100.2')).statusCode).not.toBe(429);
    /* ... and E cannot escape its own by naming a fresh address. */
    expect(
      (await viaCaddy('198.51.100.1', { [CLIENT_ADDRESS_HEADER]: '198.51.100.99' })).statusCode,
    ).toBe(429);
  });

  it('ignores the header from a direct caller, who is keyed by the socket', async () => {
    const stranger = '192.0.2.50';
    const codes = await statuses(
      () =>
        me(stranger, { [CLIENT_ADDRESS_HEADER]: '192.0.2.51', 'x-forwarded-for': '192.0.2.52' }),
      LIMIT + 1,
    );
    expect(codes[LIMIT]).toBe(429);
    expect((await viaWeb('192.0.2.51')).statusCode).not.toBe(429);
    expect((await viaCaddy('192.0.2.52')).statusCode).not.toBe(429);
  });

  it('keeps direct API traffic on the address Caddy decided', async () => {
    expect(limited(await statuses(() => viaCaddy('198.51.100.10'), LIMIT + 1))).toBe(1);
    expect((await viaCaddy('198.51.100.11')).statusCode).not.toBe(429);
    /* One visitor is one bucket whichever road they take. */
    expect((await viaWeb('198.51.100.10')).statusCode).toBe(429);
  });
});
