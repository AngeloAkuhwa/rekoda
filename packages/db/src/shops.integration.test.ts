/**
 * The public face of a business (shops.ts), against real PostgreSQL.
 *
 * This is the one table anybody can read, so the claims that matter are about
 * what that read can and cannot reach: a published shop answers by slug with
 * no tenant pinned, an unpublished one does not, and no session can publish,
 * rename or take down a shop belonging to somebody else.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, shopsRepo } from './index.js';
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

async function seedBusiness(phone = '+2348120000081'): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

function save(businessId: string, slug: string, published = true) {
  return withBusiness(db, businessId, (tx) =>
    shopsRepo.saveShop(tx, {
      businessId,
      slug,
      displayName: 'Ada Fashion',
      whatsappE164: '+2348031234567',
      tagline: 'Wax print by the bale',
      published,
    }),
  );
}

describe('slugify', () => {
  it('makes a handle a customer could read off a shop sign', () => {
    expect(shopsRepo.slugify('Ada Fashion')).toBe('ada-fashion');
    expect(shopsRepo.slugify("Chidi's Store & Co.")).toBe('chidi-s-store-co');
    expect(shopsRepo.slugify('  Spaced   Out  ')).toBe('spaced-out');
  });

  it('gives nothing back rather than a handle too short to be one', () => {
    expect(shopsRepo.slugify('A')).toBe('');
    expect(shopsRepo.slugify('!!!')).toBe('');
  });
});

describe('isShopSlug', () => {
  it('accepts what the database accepts and refuses what it refuses', () => {
    expect(shopsRepo.isShopSlug('ada-fashion')).toBe(true);
    expect(shopsRepo.isShopSlug('ada')).toBe(true);
    expect(shopsRepo.isShopSlug('Ada')).toBe(false);
    expect(shopsRepo.isShopSlug('ada--fashion')).toBe(false);
    expect(shopsRepo.isShopSlug('-ada')).toBe(false);
    expect(shopsRepo.isShopSlug('ad')).toBe(false);
    expect(shopsRepo.isShopSlug('a'.repeat(41))).toBe(false);
  });
});

describe('a published shop', () => {
  it('answers by slug with no tenant pinned at all', async () => {
    const businessId = await seedBusiness();
    expect(await save(businessId, 'ada-fashion')).toBe('saved');

    /* The plain `Db`, no `withBusiness`. This is the whole point: a customer
     * has no session and the slug is the only thing they bring. */
    const shop = await shopsRepo.shopBySlug(db, 'ada-fashion');
    expect(shop).toMatchObject({
      businessId,
      slug: 'ada-fashion',
      displayName: 'Ada Fashion',
      whatsappE164: '+2348031234567',
      tagline: 'Wax print by the bale',
    });
  });

  /* Reserved is not live. A slug somebody is still setting up must not be a
   * way to discover that their business exists. */
  it('stays invisible until it is published', async () => {
    const businessId = await seedBusiness();
    await save(businessId, 'ada-fashion', false);
    expect(await shopsRepo.shopBySlug(db, 'ada-fashion')).toBeNull();

    await save(businessId, 'ada-fashion', true);
    expect(await shopsRepo.shopBySlug(db, 'ada-fashion')).not.toBeNull();
  });

  it('goes back to invisible when it is taken down', async () => {
    const businessId = await seedBusiness();
    await save(businessId, 'ada-fashion', true);
    await save(businessId, 'ada-fashion', false);
    expect(await shopsRepo.shopBySlug(db, 'ada-fashion')).toBeNull();
  });

  it('keeps the day it first went public across later edits', async () => {
    const businessId = await seedBusiness();
    await save(businessId, 'ada-fashion', true);
    const first = (await withBusiness(db, businessId, (tx) => shopsRepo.shopFor(tx, businessId)))!
      .publishedAt;

    await save(businessId, 'ada-fashion', true);
    const after = (await withBusiness(db, businessId, (tx) => shopsRepo.shopFor(tx, businessId)))!
      .publishedAt;
    expect(after?.getTime()).toBe(first?.getTime());
  });

  it('answers nothing for a slug nobody has, and for one that is not a slug', async () => {
    expect(await shopsRepo.shopBySlug(db, 'nobody-here')).toBeNull();
    expect(await shopsRepo.shopBySlug(db, 'NOT A SLUG')).toBeNull();
    expect(await shopsRepo.shopBySlug(db, "'; DROP TABLE shops; --")).toBeNull();
  });
});

/**
 * The list the sitemap is built from.
 *
 * Same invisibility rule as `shopBySlug`, checked separately because it is a
 * separate query: a shop that is unreachable by its own URL but present in
 * the file that advertises URLs is worse than either failure alone.
 */
describe('listing the open shops', () => {
  it('carries only the ones that are open, in a stable order', async () => {
    const open = await seedBusiness('+2348120000091');
    const closed = await seedBusiness('+2348120000092');
    const alsoOpen = await seedBusiness('+2348120000093');
    await save(open, 'bola-foods', true);
    await save(closed, 'quiet-shop', false);
    await save(alsoOpen, 'ada-fashion', true);

    const listed = await shopsRepo.publishedShops(db, 50);
    /* By slug, not by date. A file that reshuffles between fetches tells a
     * crawler the whole site changed when nothing did. */
    expect(listed.map((s) => s.slug)).toEqual(['ada-fashion', 'bola-foods']);
    for (const entry of listed) expect(entry.updatedAt).toBeInstanceOf(Date);
  });

  it('drops a shop the day it is taken down', async () => {
    const businessId = await seedBusiness('+2348120000094');
    await save(businessId, 'ada-fashion', true);
    expect((await shopsRepo.publishedShops(db, 50)).map((s) => s.slug)).toEqual(['ada-fashion']);

    await save(businessId, 'ada-fashion', false);
    expect(await shopsRepo.publishedShops(db, 50)).toEqual([]);
  });

  /* The cap is the caller's, and the caller asks for one more than it wants
   * so that "the list ran out" and "the list was cut off" are different
   * answers rather than the same one. */
  it('stops at the limit it is given', async () => {
    for (const [n, phone] of [
      ['aaa-shop', '+2348120000095'],
      ['bbb-shop', '+2348120000096'],
      ['ccc-shop', '+2348120000097'],
    ] as const) {
      await save(await seedBusiness(phone), n, true);
    }
    expect((await shopsRepo.publishedShops(db, 2)).map((s) => s.slug)).toEqual([
      'aaa-shop',
      'bbb-shop',
    ]);
  });
});

describe('choosing a handle', () => {
  it('refuses one the database would refuse, before asking it', async () => {
    const businessId = await seedBusiness();
    expect(await save(businessId, 'Ada Fashion')).toBe('bad_slug');
    expect(await save(businessId, 'ad')).toBe('bad_slug');
  });

  /**
   * Two merchants can both find a name free and only one can have it. The
   * unique index decides, not a read before the write.
   *
   * It THROWS rather than returning an outcome because a unique violation
   * aborts the transaction it happened in: swallowing it and returning would
   * leave the caller inside a transaction that can no longer commit.
   */
  it('tells the second merchant the name is taken', async () => {
    const mine = await seedBusiness('+2348120000081');
    const theirs = await seedBusiness('+2348120000082');

    expect(await save(mine, 'ada-fashion')).toBe('saved');
    await expect(save(theirs, 'ada-fashion')).rejects.toBeInstanceOf(shopsRepo.SlugTaken);

    /* And the first merchant still has it. */
    expect(await shopsRepo.shopBySlug(db, 'ada-fashion')).toMatchObject({ businessId: mine });
  });

  it('lets one business change its own handle', async () => {
    const businessId = await seedBusiness();
    await save(businessId, 'ada-fashion');
    expect(await save(businessId, 'ada-wax')).toBe('saved');

    expect(await shopsRepo.shopBySlug(db, 'ada-fashion')).toBeNull();
    expect(await shopsRepo.shopBySlug(db, 'ada-wax')).not.toBeNull();
  });
});

describe('tenant isolation', () => {
  it('shows a merchant their own shop and never another’s', async () => {
    const mine = await seedBusiness('+2348120000081');
    const theirs = await seedBusiness('+2348120000082');
    await save(theirs, 'their-shop');

    expect(await withBusiness(db, mine, (tx) => shopsRepo.shopFor(tx, mine))).toBeNull();
  });

  /**
   * The claim the whole write policy exists for. A public read is fine
   * because everything in this table was published; a public WRITE would let
   * anybody take down somebody else's shop.
   */
  it('cannot take down or rename a shop belonging to somebody else', async () => {
    const mine = await seedBusiness('+2348120000081');
    const theirs = await seedBusiness('+2348120000082');
    await save(theirs, 'their-shop');

    /* Pinned to MY business, writing THEIR business id: the WITH CHECK
     * refuses the row outright. */
    await expect(
      withBusiness(db, mine, (tx) =>
        shopsRepo.saveShop(tx, {
          businessId: theirs,
          slug: 'stolen',
          displayName: 'Not theirs',
          whatsappE164: '+2340000000000',
          tagline: null,
          published: false,
        }),
      ),
    ).rejects.toThrow();

    /* And their shop is exactly as they left it. */
    expect(await shopsRepo.shopBySlug(db, 'their-shop')).not.toBeNull();
  });
});
