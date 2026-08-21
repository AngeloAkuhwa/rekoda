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

    expect(moved.moved).toBe(1);
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
    expect(moved.moved).toBe(1);
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
    expect(moved.moved).toBe(0);
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

/**
 * What the goods cost, against real PostgreSQL.
 *
 * The claims that matter: a delivery moves the weighted average and the count
 * together; a sale reports the cost of exactly what came off the shelf; and a
 * product nobody has priced reports nothing rather than nothing-per-unit.
 */
describe('what the stock cost', () => {
  it('sets the average from the first delivery, and moves it on the second', async () => {
    const businessId = await seedBusiness('+2348120000201');
    const first = await withBusiness(db, businessId, async (tx) => {
      const product = await stockRepo.findOrCreateProduct(tx, businessId, 'Ankara bale');
      return stockRepo.recordDelivery(tx, {
        businessId,
        product,
        quantity: 10,
        costK: 50_000_00,
        sourceType: 'chat',
        sourceId: 'd1',
      });
    });
    expect(first).toBe(5_000_00);

    const second = await withBusiness(db, businessId, async (tx) => {
      const product = (await stockRepo.productByName(tx, businessId, 'Ankara bale'))!;
      expect(product.onHand).toBe(10);
      expect(product.unitCostK).toBe(5_000_00);
      return stockRepo.recordDelivery(tx, {
        businessId,
        product,
        quantity: 10,
        costK: 70_000_00,
        sourceType: 'chat',
        sourceId: 'd2',
      });
    });
    /* 10 at ₦5,000 plus 10 at ₦7,000 is ₦120,000 over 20. */
    expect(second).toBe(6_000_00);

    const after = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'Ankara bale'),
    );
    expect(after).toMatchObject({ onHand: 20, unitCostK: 6_000_00 });
  });

  it('reports what a sale took off the shelf, at that average', async () => {
    const businessId = await seedBusiness('+2348120000202');
    await withBusiness(db, businessId, async (tx) => {
      const product = await stockRepo.findOrCreateProduct(tx, businessId, 'Ankara bale');
      await stockRepo.recordDelivery(tx, {
        businessId,
        product,
        quantity: 10,
        costK: 50_000_00,
        sourceType: 'chat',
        sourceId: 'd1',
      });
    });

    const moved = await withBusiness(db, businessId, (tx) =>
      stockRepo.recordSaleMovements(
        tx,
        businessId,
        [{ name: 'ankara bale', quantity: 3 }],
        'INV-1',
      ),
    );
    expect(moved).toEqual({ moved: 1, costK: 15_000_00, uncosted: 0 });
  });

  /**
   * The state every product starts in, and a great many stay in. Nothing is
   * reported rather than nothing-per-unit, so the statements can say how much
   * revenue had no cost against it instead of implying the goods were free.
   */
  it('reports no cost for a product nobody has priced, and counts the line', async () => {
    const businessId = await seedBusiness('+2348120000203');
    await withBusiness(db, businessId, async (tx) => {
      const product = await stockRepo.findOrCreateProduct(tx, businessId, 'Head tie');
      await stockRepo.recordMovement(tx, {
        businessId,
        productId: product.id,
        delta: 40,
        reason: 'adjustment',
        sourceType: 'chat',
        sourceId: null,
      });
    });

    const moved = await withBusiness(db, businessId, (tx) =>
      stockRepo.recordSaleMovements(tx, businessId, [{ name: 'Head tie', quantity: 2 }], 'INV-2'),
    );
    expect(moved).toEqual({ moved: 1, costK: 0, uncosted: 1 });
  });

  /* A count that goes up without the cost following it averages the new goods
   * in at the old price, silently. One call, so the two cannot separate. */
  it('moves the count and the cost in the same call', async () => {
    const businessId = await seedBusiness('+2348120000204');
    await withBusiness(db, businessId, async (tx) => {
      const product = await stockRepo.findOrCreateProduct(tx, businessId, 'Lace');
      await stockRepo.recordDelivery(tx, {
        businessId,
        product,
        quantity: 4,
        costK: 40_000_00,
        sourceType: 'chat',
        sourceId: 'd1',
      });
    });
    const product = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'Lace'),
    );
    expect(product).toMatchObject({ onHand: 4, unitCostK: 10_000_00 });
  });
});
