/**
 * The API-key tables' database properties (PR-109, migration 0110).
 *
 * The HTTP behaviour is proven in `apps/api`; what is proven here is what the
 * DATABASE guarantees no matter which code path reaches it:
 *
 *   - the tables are under RLS, so an unpinned or wrongly pinned reader sees
 *     nothing, and `api_key_resolve` is the one bounded exception;
 *   - the rate counter is a real ceiling under concurrency, not a
 *     read-then-decide;
 *   - the app role may kill a key and may never erase one;
 *   - the worker has no reach into API credentials at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { issueApiKey } from '@rekoda/core/api-keys';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { apiKeysRepo, identity } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 4 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(phone: string, name: string): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** A business with one application and one live key. */
async function seedKey(
  phone: string,
  name: string,
): Promise<{ businessId: string; applicationId: string; keyId: string; tokenHash: string }> {
  const businessId = await seedBusiness(phone, name);
  const application = await withBusiness(db, businessId, (tx) =>
    apiKeysRepo.createApplication(tx, { businessId, name: `${name} app` }),
  );
  const issued = issueApiKey((n) => randomBytes(n));
  const key = await withBusiness(db, businessId, (tx) =>
    apiKeysRepo.insertKey(tx, {
      businessId,
      applicationId: application.id,
      prefix: issued.prefix,
      tokenHash: issued.tokenHash,
      label: null,
      rateLimitPerMinute: 3,
      expiresAt: null,
    }),
  );
  return {
    businessId,
    applicationId: application.id,
    keyId: key.id,
    tokenHash: issued.tokenHash,
  };
}

describe('tenancy', () => {
  it('hides every key from an unpinned reader and from the wrong tenant', async () => {
    const mine = await seedKey('+2348188000001', 'Mine');
    const theirs = await seedBusiness('+2348188000002', 'Theirs');

    const unpinned = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM api_keys`);
    expect([...unpinned][0]!.n).toBe(0);

    const wrongTenant = await withBusiness(db, theirs, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM api_keys`),
    );
    expect([...wrongTenant][0]!.n).toBe(0);

    const own = await withBusiness(db, mine.businessId, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM api_keys`),
    );
    expect([...own][0]!.n).toBe(1);
  });

  it('resolves a token to its tenant through the one function that may', async () => {
    const mine = await seedKey('+2348188000003', 'Resolvable');

    /* Unpinned deliberately: this IS the read that happens before a tenant
     * is known, and the whole point of migration 0110's function. */
    const resolved = await apiKeysRepo.resolve(db, mine.tokenHash);
    expect(resolved?.businessId).toBe(mine.businessId);
    expect(resolved?.id).toBe(mine.keyId);

    // A hash nobody minted resolves to nothing, not to somebody.
    expect(await apiKeysRepo.resolve(db, 'f'.repeat(64))).toBeNull();
  });

  it('returns no secret from the resolve function', async () => {
    const mine = await seedKey('+2348188000004', 'No Secrets');
    const rows = await db.execute<Record<string, unknown>>(
      sql`SELECT * FROM api_key_resolve(${mine.tokenHash})`,
    );
    /* The hash the caller already supplied is the only secret this row
     * could leak, and the function does not hand it back. */
    expect(Object.keys([...rows][0]!)).not.toContain('token_hash');
  });
});

describe('the rate ceiling', () => {
  it('refuses the request past the limit and nothing before it', async () => {
    const mine = await seedKey('+2348188000010', 'Ceiling');
    const windowStart = new Date('2026-08-28T09:00:00Z');

    for (let i = 1; i <= 3; i += 1) {
      const taken = await withBusiness(db, mine.businessId, (tx) =>
        apiKeysRepo.reserveRequest(tx, {
          businessId: mine.businessId,
          apiKeyId: mine.keyId,
          windowStart,
          limit: 3,
        }),
      );
      expect(taken).toEqual({ ok: true, calls: i });
    }

    const refused = await withBusiness(db, mine.businessId, (tx) =>
      apiKeysRepo.reserveRequest(tx, {
        businessId: mine.businessId,
        apiKeyId: mine.keyId,
        windowStart,
        limit: 3,
      }),
    );
    expect(refused).toEqual({ ok: false });
  });

  it('holds under a burst that arrives together', async () => {
    const mine = await seedKey('+2348188000011', 'Burst');
    const windowStart = new Date('2026-08-28T09:01:00Z');

    /* Ten at once against a ceiling of three. A read-then-decide limiter
     * lets several through here; the WHERE in the UPDATE does not. */
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () =>
        withBusiness(db, mine.businessId, (tx) =>
          apiKeysRepo.reserveRequest(tx, {
            businessId: mine.businessId,
            apiKeyId: mine.keyId,
            windowStart,
            limit: 3,
          }),
        ),
      ),
    );
    expect(outcomes.filter((o) => o.ok)).toHaveLength(3);
  });

  it('starts fresh in the next minute and drops the closed one', async () => {
    const mine = await seedKey('+2348188000012', 'Rollover');
    const first = new Date('2026-08-28T09:02:00Z');
    const second = new Date('2026-08-28T09:03:00Z');

    await withBusiness(db, mine.businessId, (tx) =>
      apiKeysRepo.reserveRequest(tx, {
        businessId: mine.businessId,
        apiKeyId: mine.keyId,
        windowStart: first,
        limit: 3,
      }),
    );
    const rolled = await withBusiness(db, mine.businessId, async (tx) => {
      const taken = await apiKeysRepo.reserveRequest(tx, {
        businessId: mine.businessId,
        apiKeyId: mine.keyId,
        windowStart: second,
        limit: 3,
      });
      await apiKeysRepo.pruneWindows(tx, mine.businessId, mine.keyId, second);
      return taken;
    });
    expect(rolled).toEqual({ ok: true, calls: 1 });

    const left = await withBusiness(db, mine.businessId, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM api_key_rate_windows`),
    );
    expect([...left][0]!.n).toBe(1);
  });
});

describe('privilege', () => {
  it('lets the application revoke a key and never delete one', async () => {
    const mine = await seedKey('+2348188000020', 'Revocable');

    const revoked = await withBusiness(db, mine.businessId, (tx) =>
      apiKeysRepo.revokeKey(tx, mine.businessId, mine.keyId, new Date()),
    );
    expect(revoked).toBe(true);

    /* Drizzle wraps the driver's error, so the refusal is read from the
     * cause rather than the wrapper's "Failed query" text. */
    const refused = await withBusiness(db, mine.businessId, (tx) =>
      tx.execute(sql`DELETE FROM api_keys WHERE id = ${mine.keyId}`),
    ).then(
      () => null,
      (error: Error & { cause?: Error }) => error.cause?.message ?? error.message,
    );
    expect(refused).toMatch(/permission denied/i);
  });

  it('keeps the first revocation time when a merchant clicks twice', async () => {
    const mine = await seedKey('+2348188000021', 'Twice');
    const first = new Date('2026-08-28T09:10:00Z');
    const second = new Date('2026-08-28T10:10:00Z');

    await withBusiness(db, mine.businessId, (tx) =>
      apiKeysRepo.revokeKey(tx, mine.businessId, mine.keyId, first),
    );
    await withBusiness(db, mine.businessId, (tx) =>
      apiKeysRepo.revokeKey(tx, mine.businessId, mine.keyId, second),
    );

    const rows = await withBusiness(db, mine.businessId, (tx) =>
      tx.execute<{ revoked_at: string }>(
        sql`SELECT revoked_at FROM api_keys WHERE id = ${mine.keyId}`,
      ),
    );
    expect(new Date([...rows][0]!.revoked_at).toISOString()).toBe(first.toISOString());
  });

  it('gives the worker no reach into API credentials at all', async () => {
    await seedKey('+2348188000022', 'Off Limits');
    const worker = postgres(urls.worker, { max: 1, onnotice: () => {} });
    try {
      for (const table of ['api_keys', 'api_applications', 'api_key_rate_windows']) {
        await expect(worker.unsafe(`SELECT count(*) FROM ${table}`)).rejects.toThrow(
          /permission denied/i,
        );
      }
    } finally {
      await worker.end();
    }
  });
});
