/**
 * The catalogue read paths, against real PostgreSQL.
 *
 * `catalogueFor` is a page a merchant EDITS. `catalogueByNames` is a lookup
 * order pricing runs, and the difference is the point: pricing an order
 * against a page meant everything past the cap was priced as something the
 * shop does not stock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, withBusiness, type Db } from './client.js';
import { catalogueRepo, identity, stockRepo } from './index.js';
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
    name: 'Ngozi Provisions',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function price(businessId: string, name: string, unitPriceK: number): Promise<void> {
  await withBusiness(db, businessId, async (tx) => {
    const product = await stockRepo.findOrCreateProduct(tx, businessId, name);
    await catalogueRepo.editProduct(tx, businessId, product.id, { unitPriceK });
  });
}

describe('looking a product up by the name an order used', () => {
  it('finds one the catalogue page would have cut off', async () => {
    const businessId = await seedBusiness();
    /* Past the three hundred `catalogueFor` returns, and named so it sorts
     * last: exactly the product a four hundred SKU shop could not sell. */
    await withBusiness(db, businessId, async (tx) => {
      for (let i = 0; i < 320; i += 1) {
        await stockRepo.findOrCreateProduct(tx, businessId, `Aaa filler ${i + 1}`);
      }
    });
    await price(businessId, 'Zobo drink', 50_000);

    const page = await withBusiness(db, businessId, (tx) =>
      catalogueRepo.catalogueFor(tx, businessId),
    );
    expect(page.some((p) => p.name === 'Zobo drink')).toBe(false);

    const found = await withBusiness(db, businessId, (tx) =>
      catalogueRepo.catalogueByNames(tx, businessId, ['zobo drink']),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: 'Zobo drink', unitPriceK: 50_000 });
  });

  it('folds spacing and case the same way the pricing does', async () => {
    const businessId = await seedBusiness('+2348120000082');
    await price(businessId, 'Ankara bale', 850_000);

    const found = await withBusiness(db, businessId, (tx) =>
      catalogueRepo.catalogueByNames(tx, businessId, ['  ANKARA   bale ']),
    );
    expect(found.map((p) => p.name)).toEqual(['Ankara bale']);
  });

  it('returns nothing rather than everything for an order that names nothing', async () => {
    const businessId = await seedBusiness('+2348120000083');
    await price(businessId, 'Ankara bale', 850_000);
    /* An empty IN list is a syntax error in Postgres, and returning the whole
     * catalogue would be worse than the error. */
    expect(
      await withBusiness(db, businessId, (tx) =>
        catalogueRepo.catalogueByNames(tx, businessId, []),
      ),
    ).toEqual([]);
    expect(
      await withBusiness(db, businessId, (tx) =>
        catalogueRepo.catalogueByNames(tx, businessId, ['   ']),
      ),
    ).toEqual([]);
  });

  it('shows one business nothing of another', async () => {
    const mine = await seedBusiness('+2348120000084');
    const theirs = await seedBusiness('+2348120000085');
    await price(theirs, 'Their secret product', 12_000);

    expect(
      await withBusiness(db, mine, (tx) =>
        catalogueRepo.catalogueByNames(tx, mine, ['their secret product']),
      ),
    ).toEqual([]);
  });
});
