/**
 * The idempotency record against real PostgreSQL (spec §26).
 *
 * The claim is what matters. A retrying client sends the same request twice
 * in the same second as a matter of course, so "two at once" is the ordinary
 * case rather than the edge one, and the three states a key can be in are the
 * three answers a caller must be able to tell apart.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, idempotencyRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481800${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const claim = (businessId: string, over: Record<string, string> = {}) =>
  withBusiness(db, businessId, (tx) =>
    idempotencyRepo.claim(tx, {
      businessId,
      key: 'idem-1',
      commandName: 'RecordSale',
      requestHash: 'hash-a',
      ...over,
    }),
  );

const complete = (businessId: string, id: string, response: unknown) =>
  withBusiness(db, businessId, (tx) => idempotencyRepo.complete(tx, { businessId, id, response }));

describe('taking a key', () => {
  it('is fresh the first time', async () => {
    const businessId = await seedBusiness();
    expect((await claim(businessId)).outcome).toBe('fresh');
  });

  /**
   * The state an ad-hoc key check always misses. A second request arriving
   * while the first is still running must be told to wait, not told "done"
   * with an empty hand and not allowed to run the command again.
   */
  it('reports the second caller as running while the first is unfinished', async () => {
    const businessId = await seedBusiness();
    const first = await claim(businessId);
    expect(first.outcome).toBe('fresh');

    const second = await claim(businessId);
    expect(second.outcome).toBe('running');
  });

  it('replays the first response once it has one', async () => {
    const businessId = await seedBusiness();
    const first = await claim(businessId);
    if (first.outcome !== 'fresh') throw new Error('expected a fresh claim');
    await complete(businessId, first.id, { invoice: 'INV-2026-000041', total: 45_000 });

    const again = await claim(businessId);
    expect(again).toMatchObject({
      outcome: 'replay',
      response: { invoice: 'INV-2026-000041', total: 45_000 },
    });
  });

  /**
   * Two identical requests in the same instant. Exactly one may hold the key;
   * the unique index decides, not the order the application happened to read
   * in.
   */
  it('hands the key to exactly one of two simultaneous callers', async () => {
    const businessId = await seedBusiness();
    const results = await Promise.all([claim(businessId), claim(businessId)]);
    expect(results.filter((r) => r.outcome === 'fresh')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'running')).toHaveLength(1);
  });

  it('hands it to exactly one of ten', async () => {
    const businessId = await seedBusiness();
    const results = await Promise.all(Array.from({ length: 10 }, () => claim(businessId)));
    expect(results.filter((r) => r.outcome === 'fresh')).toHaveLength(1);
  });
});

/**
 * A key reused for a different request is a client bug, and replaying the
 * first answer would hide it behind something plausible: the caller believes
 * their second command ran when it never did.
 */
describe('a key used for something else', () => {
  it('refuses a different payload under the same key', async () => {
    const businessId = await seedBusiness();
    await claim(businessId);
    const different = await claim(businessId, { requestHash: 'hash-b' });
    expect(different).toEqual({ outcome: 'key_reused', commandName: 'RecordSale' });
  });

  it('refuses a different command under the same key', async () => {
    const businessId = await seedBusiness();
    await claim(businessId);
    const different = await claim(businessId, { commandName: 'RefundPayment' });
    expect(different).toEqual({ outcome: 'key_reused', commandName: 'RecordSale' });
  });

  /* And it refuses even after the first one finished, because the mistake is
   * the same mistake whether or not the original has completed. */
  it('refuses after the original completed', async () => {
    const businessId = await seedBusiness();
    const first = await claim(businessId);
    if (first.outcome !== 'fresh') throw new Error('expected a fresh claim');
    await complete(businessId, first.id, { ok: true });
    expect((await claim(businessId, { requestHash: 'hash-b' })).outcome).toBe('key_reused');
  });
});

describe('writing down the answer', () => {
  it('cannot be overwritten by a second completion', async () => {
    const businessId = await seedBusiness();
    const first = await claim(businessId);
    if (first.outcome !== 'fresh') throw new Error('expected a fresh claim');

    expect(await complete(businessId, first.id, { total: 1 })).toBe(true);
    expect(await complete(businessId, first.id, { total: 2 })).toBe(false);

    const replay = await claim(businessId);
    expect(replay).toMatchObject({ outcome: 'replay', response: { total: 1 } });
  });

  /* A command that answers nothing still answered. Null is a response, and a
   * record holding it must read as `replay` rather than as still running. */
  it('treats a null answer as an answer', async () => {
    const businessId = await seedBusiness();
    const first = await claim(businessId);
    if (first.outcome !== 'fresh') throw new Error('expected a fresh claim');
    await complete(businessId, first.id, null);
    const replay = await claim(businessId);
    expect(replay.outcome).toBe('replay');
    expect((replay as { response: unknown }).response).toBeNull();
  });

  /**
   * The snapshot and the state change share a transaction. A record
   * committed beside a rolled back sale would be handed to the next retry as
   * though the sale had happened.
   */
  it('rolls back with the work it describes', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, async (tx) => {
        const taken = await idempotencyRepo.claim(tx, {
          businessId,
          key: 'idem-rollback',
          commandName: 'RecordSale',
          requestHash: 'hash-a',
        });
        if (taken.outcome !== 'fresh') throw new Error('expected a fresh claim');
        await idempotencyRepo.complete(tx, { businessId, id: taken.id, response: { ok: true } });
        throw new Error('the command failed after answering');
      }),
    ).rejects.toThrow('the command failed after answering');

    /* Nothing survives, so the retry is a first attempt rather than a replay
     * of something that never happened. */
    const after = await withBusiness(db, businessId, (tx) =>
      idempotencyRepo.find(tx, businessId, 'idem-rollback'),
    );
    expect(after).toBeNull();
  });
});

describe('keys belong to one business', () => {
  it('lets two businesses use the same key for different work', async () => {
    const mine = await seedBusiness();
    const theirs = await seedBusiness();

    const first = await claim(mine);
    if (first.outcome !== 'fresh') throw new Error('expected a fresh claim');
    await complete(mine, first.id, { whose: 'mine' });

    /* The same key, a different tenant: a fresh claim, not somebody else's
     * answer. */
    const other = await withBusiness(db, theirs, (tx) =>
      idempotencyRepo.claim(tx, {
        businessId: theirs,
        key: 'idem-1',
        commandName: 'RecordSale',
        requestHash: 'hash-a',
      }),
    );
    expect(other.outcome).toBe('fresh');
  });
});

/**
 * A record of what a command already answered is not the application's to
 * remove. Deleting one turns a replay back into a second execution, which is
 * the entire thing this table exists to prevent.
 */
describe('the record it leaves', () => {
  it('cannot be deleted by the application', async () => {
    const businessId = await seedBusiness();
    await claim(businessId);
    await expect(
      withBusiness(db, businessId, (tx) => tx.execute(sql`DELETE FROM idempotency_records`)),
    ).rejects.toThrow();
  });
});
