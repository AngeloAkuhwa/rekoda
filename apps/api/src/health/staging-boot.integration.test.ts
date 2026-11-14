/**
 * OWN-77: the boot guards are exercised through `createApp`, the real startup path. A test that
 * calls only the helper would stay green if `main.ts` stopped calling it.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createDb, sql, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';

const LIVE_KEY = ['sk', 'live', 'b'.repeat(24)].join('_');
const TEST_KEY = ['sk', 'test', 'b'.repeat(24)].join('_');
const MANAGED = [
  'DATABASE_URL',
  'WORKER_DATABASE_URL',
  'REKODA_WORKER',
  'OTP_PEPPER',
  'VAULT_KEY',
  'MATCH_KEY',
  'REKODA_API_SECRET',
  'REKODA_RATE_LIMIT_MAX',
  'NODE_ENV',
  'PAYSTACK_SECRET_KEY',
  'REKODA_STAGING_TOOLS',
  'REKODA_PAYSTACK_PLATFORM_CONFIRMED',
] as const;

let urls: Urls;
let ownerDb: Db;
let closeOwner: () => Promise<void>;
const saved: Record<string, string | undefined> = {};
const opened: NestFastifyApplication[] = [];

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 2 }));
  for (const key of MANAGED) saved[key] = process.env[key];
});

afterAll(async () => {
  await closeOwner?.();
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

beforeEach(async () => {
  await truncateAll(urls);
  process.env['DATABASE_URL'] = urls.app;
  process.env['WORKER_DATABASE_URL'] = urls.worker;
  delete process.env['REKODA_WORKER'];
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  delete process.env['NODE_ENV'];
  delete process.env['REKODA_STAGING_TOOLS'];
  delete process.env['REKODA_PAYSTACK_PLATFORM_CONFIRMED'];
});

afterEach(async () => {
  while (opened.length) await opened.pop()?.close();
  await ownerDb.execute(sql`DELETE FROM staging_environment`);
  // Each createApp enrolled this test's random VAULT_KEY / MATCH_KEY fingerprints; a later file
  // that boots with different keys would refuse them, so clear them with everything else.
  await truncateAll(urls);
});

const mark = () =>
  ownerDb.execute(sql`INSERT INTO staging_environment (marked_by) VALUES ('owner:test')`);

async function boot(): Promise<NestFastifyApplication> {
  const { createApp } = await import('../main.js');
  const app = await createApp();
  opened.push(app);
  return app;
}

describe('createApp refuses an unsafe staging configuration', () => {
  it('a staging-marked database with a live key and the tools off', async () => {
    await mark();
    process.env['PAYSTACK_SECRET_KEY'] = LIVE_KEY;
    await expect(boot()).rejects.toThrow(/marked as staging/);
  });

  it('boots with a live key on an unmarked database, and with a test key on a marked one', async () => {
    process.env['PAYSTACK_SECRET_KEY'] = LIVE_KEY;
    expect(await boot()).toBeDefined();
    await mark();
    process.env['PAYSTACK_SECRET_KEY'] = TEST_KEY;
    expect(await boot()).toBeDefined();
  });
});
