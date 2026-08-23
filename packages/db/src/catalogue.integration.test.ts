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
    /* Named so it sorts last, which is where a name-ordered page cuts. */
    await withBusiness(db, businessId, async (tx) => {
      for (let i = 0; i < 6; i += 1) {
        await stockRepo.findOrCreateProduct(tx, businessId, `Aaa filler ${i + 1}`);
      }
    });
    await price(businessId, 'Zobo drink', 50_000);

    /* An explicit small page rather than however many the production cap
     * happens to be. The claim is that a lookup is not bounded by the page,
     * and it is the cap MOVING that used to break this test: it seeded three
     * hundred and twenty products to squeeze past a cap of three hundred, and
     * went green-to-red the moment that number changed for a good reason. */
    const page = await withBusiness(db, businessId, (tx) =>
      catalogueRepo.catalogueFor(tx, businessId, 3),
    );
    expect(page.rows).toHaveLength(3);
    expect(page.rows.some((p) => p.name === 'Zobo drink')).toBe(false);

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

/**
 * The counts under the list, and the ones the page acts on.
 *
 * `catalogueFor` returns a page ordered by name, and everything the
 * catalogue page says about the shop used to be derived from that page:
 * "297 products in the shop" to a merchant with 316, and `unpriced` — which
 * the contract calls the number that stops a shop selling — reported as ZERO
 * to a shop with twelve listed products a customer cannot buy, because all
 * twelve sorted past the cap.
 *
 * Worse than a wrong number: the pickers that set a price are built from the
 * same page, so the twelve products that needed fixing were the twelve the
 * page would not let anyone fix, and it never said they were there.
 */
describe('what the catalogue says about the whole shop', () => {
  async function seedProducts(businessId: string, howMany: number) {
    await withBusiness(db, businessId, async (tx) => {
      for (let i = 0; i < howMany; i += 1) {
        const name = `Product ${String(i + 1).padStart(3, '0')}`;
        const product = await stockRepo.findOrCreateProduct(tx, businessId, name);
        /* The last few sort last by name, which is where the cap bites. They
         * are listed and unpriced: the state that stops a shop selling. */
        if (i < howMany - 4) {
          await catalogueRepo.editProduct(tx, businessId, product.id, { unitPriceK: 50_000 });
        }
        if (i === 0) await catalogueRepo.editProduct(tx, businessId, product.id, { active: false });
      }
    });
  }

  it('counts the shop, not the page it returned', async () => {
    const businessId = await seedBusiness('+2348120000091');
    await seedProducts(businessId, 12);

    const page = await withBusiness(db, businessId, (tx) =>
      catalogueRepo.catalogueFor(tx, businessId, 5),
    );
    expect(page.rows).toHaveLength(5);
    expect(page.count).toBe(12);
    expect(page.listed).toBe(11);
    expect(page.hidden).toBe(1);
  });

  it('counts every listed product with no price, wherever it sorts', async () => {
    const businessId = await seedBusiness('+2348120000092');
    await seedProducts(businessId, 12);

    /* A page of five holds none of the four unpriced ones, which sort last.
     * Counting the page would report zero and the page would show no warning
     * at all, which is how a shop sells nothing and is told nothing. */
    const page = await withBusiness(db, businessId, (tx) =>
      catalogueRepo.catalogueFor(tx, businessId, 5),
    );
    expect(page.rows.filter((r) => r.active && r.unitPriceK === null)).toHaveLength(0);
    expect(page.unpriced).toBe(4);
  });

  it('answers zero for a shop with nothing in it', async () => {
    const businessId = await seedBusiness('+2348120000093');
    expect(
      await withBusiness(db, businessId, (tx) => catalogueRepo.catalogueFor(tx, businessId)),
    ).toEqual({ rows: [], count: 0, listed: 0, hidden: 0, unpriced: 0 });
  });
});
