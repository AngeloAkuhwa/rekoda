/**
 * The public reminder opt-out has its own, tighter per-IP limit (REM-02).
 *
 * It is the one reminder route a stranger can reach without a session, so it is throttled harder
 * than the global ceiling: a real API app, a global limit set far above it, and visitors arriving
 * through the web tier the way production sends them. The signed token stays the only credential;
 * this only bounds how fast anyone can guess at one.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { migrate, requireUrls, truncateAll } from '@rekoda/db/testing';
import { CLIENT_ADDRESS_HEADER } from '../http/client-address.js';
import { REMINDER_OPT_OUT_RATE_LIMIT } from './reminders.controller.js';

const WEB = '10.20.0.21';

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
  await truncateAll(urls);
  for (const name of CHANGED) saved.set(name, process.env[name]);
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = 'optout-throttle-pepper-at-least-32-chars';
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_API_SECRET'] = 'optout-throttle-secret-at-least-32-chars';
  /* Far above the route's own limit, so a 429 here can only be the route's. */
  process.env['REKODA_RATE_LIMIT_MAX'] = '1000';
  process.env['REKODA_TRUSTED_PROXIES'] = '10.20.0.20';
  process.env['REKODA_TRUSTED_WEB'] = WEB;
  const { createApp } = await import('../main.js');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await truncateAll(urls);
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** A forged token: the route answers 404 for it, after counting it. */
const optOut = (visitor: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/public/reminders/opt-out',
    remoteAddress: WEB,
    headers: { [CLIENT_ADDRESS_HEADER]: visitor },
    payload: { token: 'x'.repeat(60) },
  });

describe('the public opt-out route', () => {
  it('is tighter than the global ceiling: ten a minute per visitor, then 429', async () => {
    expect(REMINDER_OPT_OUT_RATE_LIMIT).toEqual({ max: 10, timeWindow: '1 minute' });
    const visitor = '203.0.113.71';
    const codes: number[] = [];
    for (let i = 0; i < 10; i += 1) codes.push((await optOut(visitor)).statusCode);
    expect(codes).toEqual(Array(10).fill(404));
    const refused = await optOut(visitor);
    expect(refused.statusCode).toBe(429);
    // The refusal names no token and no address.
    expect(refused.body).not.toContain('x'.repeat(20));
  });

  it("keeps one visitor's exhaustion off another's, and off the rest of the API", async () => {
    const noisy = '203.0.113.72';
    for (let i = 0; i < 11; i += 1) await optOut(noisy);
    expect((await optOut(noisy)).statusCode).toBe(429);
    expect((await optOut('203.0.113.73')).statusCode).toBe(404);
    const elsewhere = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      remoteAddress: WEB,
      headers: { [CLIENT_ADDRESS_HEADER]: noisy },
    });
    expect(elsewhere.statusCode).not.toBe(429);
  });
});
