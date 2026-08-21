/**
 * Stock, against a real PostgreSQL.
 *
 * On-hand is `SUM(delta)` over an append-only ledger and never a stored
 * count, so the claims worth testing are about aggregation and about tenant
 * isolation, and neither has a meaningful in-memory imitation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, stockRepo } from './index.js';
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

async function seedBusiness(phone: string): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Mama Chidi Stores',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

function adjust(businessId: string, productId: string, delta: number): Promise<void> {
  return withBusiness(db, businessId, (tx) =>
    stockRepo.recordMovement(tx, {
      businessId,
      productId,
      delta,
      reason: 'adjustment',
      sourceType: 'chat',
      sourceId: 'test',
    }),
  );
}

describe('finding a product', () => {
  it('creates one the first time the merchant mentions it', async () => {
    const businessId = await seedBusiness('+2348050000001');
    const product = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Bags of rice'),
    );
    expect(product.name).toBe('Bags of rice');
    expect(product.onHand).toBe(0);
  });

  it('finds the same one again rather than making a second', async () => {
    const businessId = await seedBusiness('+2348050000002');
    const first = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Bags of rice'),
    );
    const second = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, '  bags of RICE '),
    );
    expect(second.id).toBe(first.id);
    expect(
      await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId)),
    ).toHaveLength(1);
  });

  it('keeps the name the merchant typed, not a normalised one', async () => {
    const businessId = await seedBusiness('+2348050000003');
    await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Bags of Rice'),
    );
    const found = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'bags of rice'),
    );
    expect(found?.name).toBe('Bags of Rice');
  });

  it('does not match a different product on a partial name', async () => {
    const businessId = await seedBusiness('+2348050000004');
    await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Bags of rice'),
    );
    /* "rice" and "bags of rice" are one product in some shops and two in
     * others. A matcher that guessed would move stock nobody meant to move. */
    const found = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'rice'),
    );
    expect(found).toBeNull();
  });

  it('says nothing rather than inventing a product that was never mentioned', async () => {
    const businessId = await seedBusiness('+2348050000005');
    const found = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'generators'),
    );
    expect(found).toBeNull();
  });
});

describe('on hand', () => {
  it('is the sum of the movements, not a stored count', async () => {
    const businessId = await seedBusiness('+2348050000006');
    const product = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Bags of rice'),
    );
    await adjust(businessId, product.id, 20);
    await adjust(businessId, product.id, 5);
    await adjust(businessId, product.id, -8);

    const found = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'Bags of rice'),
    );
    expect(found?.onHand).toBe(17);
  });

  it('is zero for something counted and never moved', async () => {
    const businessId = await seedBusiness('+2348050000007');
    await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Wigs'),
    );
    const found = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'Wigs'),
    );
    expect(found?.onHand).toBe(0);
  });

  it('keeps the history when the count comes back to where it started', async () => {
    const businessId = await seedBusiness('+2348050000008');
    const product = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Crates'),
    );
    await adjust(businessId, product.id, 12);
    await adjust(businessId, product.id, -12);

    const found = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'Crates'),
    );
    expect(found?.onHand).toBe(0);
    /* The ledger is append-only, so a net zero is two rows and not none. The
     * money ledger works the same way and for the same reason. */
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM inventory_movements WHERE product_id = ${product.id}::uuid`,
      ),
    );
    expect([...rows][0]?.n).toBe(2);
  });
});

describe('a sale taking stock off the shelf', () => {
  it('moves the lines that name something the shop tracks', async () => {
    const businessId = await seedBusiness('+2348050000009');
    const rice = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Bags of rice'),
    );
    await adjust(businessId, rice.id, 20);

    const moved = await withBusiness(db, businessId, (tx) =>
      stockRepo.recordSaleMovements(
        tx,
        businessId,
        [
          { name: 'Bags of rice', quantity: 3 },
          { name: 'A thing nobody counts', quantity: 9 },
        ],
        'INV-2026-000001',
      ),
    );

    expect(moved).toBe(1);
    const found = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'Bags of rice'),
    );
    expect(found?.onHand).toBe(17);
  });

  it('does not invent a product for a line the shop never counted', async () => {
    const businessId = await seedBusiness('+2348050000010');
    await withBusiness(db, businessId, (tx) =>
      stockRepo.recordSaleMovements(tx, businessId, [{ name: 'Generator', quantity: 1 }], 'INV-1'),
    );
    /* Otherwise a shop that sold one of something it never stocked would be
     * told it holds minus one of them, forever. */
    expect(await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId))).toEqual(
      [],
    );
  });

  it('matches a sale line however the merchant capitalised it', async () => {
    const businessId = await seedBusiness('+2348050000011');
    const wigs = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Wigs'),
    );
    await adjust(businessId, wigs.id, 10);
    await withBusiness(db, businessId, (tx) =>
      stockRepo.recordSaleMovements(tx, businessId, [{ name: 'wigs', quantity: 2 }], 'INV-2'),
    );
    const found = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'Wigs'),
    );
    expect(found?.onHand).toBe(8);
  });

  it('rounds a fractional sale UP, so a shop never believes it holds more', async () => {
    const businessId = await seedBusiness('+2348050000016');
    const rice = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Bags of rice'),
    );
    await adjust(businessId, rice.id, 20);

    /* The contract allows 2.5 and a merchant selling by weight will send it.
     * Truncating to 2 would leave them believing they hold 18 when 17 is the
     * truth, and a merchant who thinks they have stock promises a customer
     * something that is not on the shelf. */
    await withBusiness(db, businessId, (tx) =>
      stockRepo.recordSaleMovements(
        tx,
        businessId,
        [{ name: 'Bags of rice', quantity: 2.5 }],
        'INV-F',
      ),
    );

    const found = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'Bags of rice'),
    );
    expect(found?.onHand).toBe(17);
  });

  it('does not let a sub-unit sale vanish', async () => {
    const businessId = await seedBusiness('+2348050000017');
    const rice = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Bags of rice'),
    );
    await adjust(businessId, rice.id, 5);

    const moved = await withBusiness(db, businessId, (tx) =>
      stockRepo.recordSaleMovements(
        tx,
        businessId,
        [{ name: 'Bags of rice', quantity: 0.5 }],
        'INV-G',
      ),
    );
    expect(moved).toBe(1);
    const found = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'Bags of rice'),
    );
    expect(found?.onHand).toBe(4);
  });

  it('ignores a line with no quantity rather than writing a zero movement', async () => {
    const businessId = await seedBusiness('+2348050000012');
    const wigs = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Wigs'),
    );
    await adjust(businessId, wigs.id, 10);
    const moved = await withBusiness(db, businessId, (tx) =>
      stockRepo.recordSaleMovements(tx, businessId, [{ name: 'Wigs', quantity: 0 }], 'INV-3'),
    );
    expect(moved).toBe(0);
  });
});

describe('the stock list', () => {
  it('puts what is about to run out first', async () => {
    const businessId = await seedBusiness('+2348050000013');
    const rice = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Bags of rice'),
    );
    const wigs = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Wigs'),
    );
    await adjust(businessId, rice.id, 40);
    await adjust(businessId, wigs.id, 2);

    const list = await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId));
    expect(list.map((p) => p.name)).toEqual(['Wigs', 'Bags of rice']);
  });

  it('shows one tenant nothing of another', async () => {
    const mine = await seedBusiness('+2348050000014');
    const theirs = await seedBusiness('+2348050000015');
    const product = await withBusiness(db, theirs, (tx) =>
      stockRepo.findOrCreateProduct(tx, theirs, 'Their secret product'),
    );
    await adjust(theirs, product.id, 99);

    expect(await withBusiness(db, mine, (tx) => stockRepo.stockList(tx, mine))).toEqual([]);
    expect(
      await withBusiness(db, mine, (tx) =>
        stockRepo.productByName(tx, mine, 'Their secret product'),
      ),
    ).toBeNull();
  });
});
