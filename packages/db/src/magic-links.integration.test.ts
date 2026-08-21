/**
 * Sign-in links, against real PostgreSQL.
 *
 * Two claims, and neither survives an in-memory imitation. The row stores a
 * HASH and never the token that was sent, so a leaked database cannot be
 * replayed as a set of working URLs. And `consumeMagicLink` is a conditional
 * UPDATE whose entire value is what happens when two taps of the same link
 * arrive together, which a read-then-write would get wrong.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { hashSecret, issueMagicLink } from '@rekoda/core/identity';
import { randomBytes } from 'node:crypto';
import { createDb, type Db } from './client.js';
import { identity } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seed() {
  const user = await identity.upsertUserByPhone(db, '+2348133000001');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const { token, link } = issueMagicLink((bytes) => randomBytes(bytes), new Date());
  const row = await identity.insertMagicLink(db, {
    userId: user.id,
    businessId: business.id,
    tokenHash: link.tokenHash,
    expiresAt: link.expiresAt,
    usedAt: null,
  });
  return { token, row };
}

describe('what a sign-in link leaves behind', () => {
  it('stores the hash and never the token that was sent', async () => {
    const { token } = await seed();

    const rows = await db.execute<{ token_hash: string }>(sql`SELECT token_hash FROM magic_links`);
    const stored = [...rows];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.token_hash).not.toBe(token);
    /* And it is the hash the lookup uses, so a stolen row cannot be turned
     * back into a URL by anyone who reads the table. */
    expect(stored[0]?.token_hash).toBe(hashSecret(token));
  });

  it('finds the row by hash and by nothing else', async () => {
    const { token, row } = await seed();
    expect((await identity.findMagicLinkByHash(db, hashSecret(token)))?.id).toBe(row.id);
    expect(await identity.findMagicLinkByHash(db, hashSecret('not-the-token'))).toBeNull();
  });
});

/**
 * The property "single use" actually means.
 *
 * Two taps arrive together often enough in practice: a merchant double-taps,
 * or a link preview fetches the URL before they do. A read-then-write would
 * let both observe `used_at IS NULL` and both mint a session.
 */
describe('burning a link', () => {
  it('lets exactly ONE of two simultaneous claims through', async () => {
    const { row } = await seed();
    const now = new Date();

    const outcomes = await Promise.all([
      identity.consumeMagicLink(db, row.id, now),
      identity.consumeMagicLink(db, row.id, now),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it('stays burned', async () => {
    const { row } = await seed();
    expect(await identity.consumeMagicLink(db, row.id, new Date())).toBe(true);
    expect(await identity.consumeMagicLink(db, row.id, new Date())).toBe(false);
  });

  it('reports false for a link that was never there', async () => {
    await seed();
    expect(
      await identity.consumeMagicLink(db, '00000000-0000-0000-0000-000000000000', new Date()),
    ).toBe(false);
  });
});
