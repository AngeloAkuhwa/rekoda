/**
 * G-13: `CONNECTION_KEY` is held to the key the database enrolled, like `VAULT_KEY` and
 * `MATCH_KEY`.
 *
 * `CONNECTION_KEY` seals merchants' Paystack secret keys, WABA access tokens and settlement account
 * numbers. A process started with a different key does not error: it cannot open a single existing
 * connection and seals every new one under a key the old rows do not share, splitting the estate.
 * The boot must refuse instead, naming the variable and never the key.
 *
 * The key stays optional (empty turns merchant connections off and seals nothing, invariant 8), so
 * a process without it boots and enrols nothing. Exercised through `createApp`, the real startup
 * path: a test of the helper alone would stay green if `main.ts` stopped calling it.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { bootChecks, createDb, sql, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';

const MANAGED = [
  'DATABASE_URL',
  'WORKER_DATABASE_URL',
  'REKODA_WORKER',
  'OTP_PEPPER',
  'VAULT_KEY',
  'MATCH_KEY',
  'CONNECTION_KEY',
  'REKODA_API_SECRET',
  'REKODA_RATE_LIMIT_MAX',
  'NODE_ENV',
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
  delete process.env['CONNECTION_KEY'];
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  delete process.env['NODE_ENV'];
});

afterEach(async () => {
  while (opened.length) await opened.pop()?.close();
  // Each boot enrolled this test's random keys; clear them so a later file boots with its own.
  await truncateAll(urls);
});

async function boot(): Promise<NestFastifyApplication> {
  const { createApp } = await import('../main.js');
  const app = await createApp();
  opened.push(app);
  return app;
}

async function enrolled(): Promise<string | undefined> {
  const rows = await ownerDb.execute<{ fingerprint: string }>(sql`
    SELECT fingerprint FROM key_fingerprints WHERE key_name = 'CONNECTION_KEY'
  `);
  return [...rows][0]?.fingerprint;
}

describe('CONNECTION_KEY at boot (G-13)', () => {
  it('enrols the key on first boot and boots again with the same key', async () => {
    const key = randomBytes(32).toString('hex');
    process.env['CONNECTION_KEY'] = key;

    await boot();
    expect(await enrolled()).toBe(bootChecks.fingerprintKey(key));

    await expect(boot()).resolves.toBeDefined();
  });

  it('refuses a boot with a different key, naming the variable and neither key', async () => {
    const first = randomBytes(32).toString('hex');
    const second = randomBytes(32).toString('hex');
    process.env['CONNECTION_KEY'] = first;
    await boot();

    process.env['CONNECTION_KEY'] = second;
    const refusal = await boot().then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(bootChecks.KeyFingerprintMismatch);
    const message = (refusal as Error).message;
    expect(message).toContain('CONNECTION_KEY');
    expect(message).not.toContain(first);
    expect(message).not.toContain(second);
    // The enrolled key is untouched: the refused process changed nothing.
    expect(await enrolled()).toBe(bootChecks.fingerprintKey(first));
  });

  it('boots without the key and enrols nothing, so the first real key is the one enrolled', async () => {
    await boot();
    expect(await enrolled()).toBeUndefined();

    const key = randomBytes(32).toString('hex');
    process.env['CONNECTION_KEY'] = key;
    await boot();
    expect(await enrolled()).toBe(bootChecks.fingerprintKey(key));
  });

  it('a process started without the key after enrolment still boots, and the enrolment holds', async () => {
    const key = randomBytes(32).toString('hex');
    process.env['CONNECTION_KEY'] = key;
    await boot();

    delete process.env['CONNECTION_KEY'];
    await expect(boot()).resolves.toBeDefined();

    process.env['CONNECTION_KEY'] = randomBytes(32).toString('hex');
    await expect(boot()).rejects.toBeInstanceOf(bootChecks.KeyFingerprintMismatch);
  });
});
