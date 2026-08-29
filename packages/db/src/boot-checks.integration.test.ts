/**
 * The production boot invariants (remediation A5, A6), proven against real
 * Postgres and the real roles.
 *
 * Both checks guard failures that no request-time test can see: a
 * BYPASSRLS credential returns the right rows for every tenant-scoped
 * query and the wrong rows for every missed one, and a wrong vault key
 * decrypts nothing while erroring nowhere. The dev cluster is a gift here:
 * its owner role IS a superuser, so the negative case for the role check
 * runs against the genuine article rather than a mock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';
import { bootChecks } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let app: Db;
let worker: Db;
let owner: Db;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  for (const [key, assign] of [
    [urls.app, (db: Db) => (app = db)],
    [urls.worker, (db: Db) => (worker = db)],
    [urls.owner, (db: Db) => (owner = db)],
  ] as const) {
    const created = createDb(key, { max: 2 });
    assign(created.db);
    closers.push(created.close);
  }
});

afterAll(async () => {
  for (const close of closers) await close();
});

beforeEach(async () => {
  await truncateAll(urls);
});

describe('assertRoleCannotBypassRls (A5)', () => {
  it('passes for the application role', async () => {
    await expect(bootChecks.assertRoleCannotBypassRls(app, 'application')).resolves.toBeUndefined();
  });

  it('passes for the worker role', async () => {
    await expect(bootChecks.assertRoleCannotBypassRls(worker, 'worker')).resolves.toBeUndefined();
  });

  it('refuses a credential that can walk through row-level security', async () => {
    await expect(bootChecks.assertRoleCannotBypassRls(owner, 'application')).rejects.toThrow(
      /row-level security/,
    );
  });
});

describe('fingerprintKey (A6)', () => {
  const KEY = 'a'.repeat(64);

  it('is deterministic, short and hex — safe to store and to log', () => {
    const fp = bootChecks.fingerprintKey(KEY);
    expect(fp).toBe(bootChecks.fingerprintKey(KEY));
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('never contains the key it fingerprints', () => {
    expect(bootChecks.fingerprintKey(KEY)).not.toContain(KEY);
  });

  it('tells two keys apart', () => {
    expect(bootChecks.fingerprintKey(KEY)).not.toBe(bootChecks.fingerprintKey('b'.repeat(64)));
  });
});

describe('assertKeyUnchanged (A6)', () => {
  const KEY = 'f'.repeat(64);
  const OTHER = '0'.repeat(64);

  it('enrolls the fingerprint on first boot and accepts the same key after', async () => {
    await bootChecks.assertKeyUnchanged(app, 'VAULT_KEY', KEY);

    const rows = await app.execute<{ fingerprint: string }>(sql`
      SELECT fingerprint FROM key_fingerprints WHERE key_name = 'VAULT_KEY'
    `);
    expect([...rows][0]?.fingerprint).toBe(bootChecks.fingerprintKey(KEY));

    await expect(bootChecks.assertKeyUnchanged(app, 'VAULT_KEY', KEY)).resolves.toBeUndefined();
  });

  it('refuses a different key, naming both fingerprints and neither key', async () => {
    await bootChecks.assertKeyUnchanged(app, 'VAULT_KEY', KEY);

    const refusal = bootChecks.assertKeyUnchanged(app, 'VAULT_KEY', OTHER);
    await expect(refusal).rejects.toThrow(bootChecks.KeyFingerprintMismatch);
    await expect(refusal).rejects.toThrow(bootChecks.fingerprintKey(KEY));
    await expect(refusal).rejects.toThrow(bootChecks.fingerprintKey(OTHER));

    const message = await refusal.catch((error: Error) => error.message);
    expect(message).not.toContain(KEY);
    expect(message).not.toContain(OTHER);
  });

  it('keys are independent: MATCH_KEY enrolment does not constrain VAULT_KEY', async () => {
    await bootChecks.assertKeyUnchanged(app, 'MATCH_KEY', KEY);
    await expect(bootChecks.assertKeyUnchanged(app, 'VAULT_KEY', OTHER)).resolves.toBeUndefined();
  });

  it('two processes racing first boot with the same key both come up', async () => {
    await expect(
      Promise.all([
        bootChecks.assertKeyUnchanged(app, 'VAULT_KEY', KEY),
        bootChecks.assertKeyUnchanged(worker, 'VAULT_KEY', KEY),
      ]),
    ).resolves.toBeDefined();
  });

  it('the application role cannot rewrite an enrolled fingerprint', async () => {
    /* Rotation is an owner ceremony (docs/runbooks/key-rotation.md), never
     * something a compromised or confused app process can do to itself:
     * the migration grants SELECT and INSERT only. */
    await bootChecks.assertKeyUnchanged(app, 'VAULT_KEY', KEY);
    /* Drizzle wraps the Postgres "permission denied" in its own error, so
     * assert the two things that matter: the statement is refused, and the
     * enrolled row is exactly as it was. */
    await expect(
      app.execute(
        sql`UPDATE key_fingerprints SET fingerprint = 'forged' WHERE key_name = 'VAULT_KEY'`,
      ),
    ).rejects.toThrow();
    await expect(
      app.execute(sql`DELETE FROM key_fingerprints WHERE key_name = 'VAULT_KEY'`),
    ).rejects.toThrow();
    const rows = await owner.execute<{ fingerprint: string }>(sql`
      SELECT fingerprint FROM key_fingerprints WHERE key_name = 'VAULT_KEY'
    `);
    expect([...rows][0]?.fingerprint).toBe(bootChecks.fingerprintKey(KEY));
  });
});
