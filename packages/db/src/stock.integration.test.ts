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
import { postCostOfSale } from '@rekoda/core';
import { identity, issueRepo, stockRepo } from './index.js';
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
      (await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId))).rows,
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
    expect(
      (await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId))).rows,
    ).toEqual([]);
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
    expect(list.rows.map((p) => p.name)).toEqual(['Wigs', 'Bags of rice']);
  });

  it('shows one tenant nothing of another', async () => {
    const mine = await seedBusiness('+2348050000014');
    const theirs = await seedBusiness('+2348050000015');
    const product = await withBusiness(db, theirs, (tx) =>
      stockRepo.findOrCreateProduct(tx, theirs, 'Their secret product'),
    );
    await adjust(theirs, product.id, 99);

    expect((await withBusiness(db, mine, (tx) => stockRepo.stockList(tx, mine))).rows).toEqual([]);
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

/**
 * Voiding a sale that carried a cost.
 *
 * A sale writes two postings once products have costs. Reversing only the
 * revenue leaves COGS debited and inventory credited with no revenue against
 * them: books that balance perfectly and say the shop gave the goods away.
 */
describe('withdrawing a sale that cost something', () => {
  it('reverses the cost as well as the revenue', async () => {
    const businessId = await seedBusiness('+2348120000211');

    const invoiceNumber = await withBusiness(db, businessId, async (tx) => {
      const product = await stockRepo.findOrCreateProduct(tx, businessId, 'Rice bag');
      await stockRepo.recordDelivery(tx, {
        businessId,
        product,
        quantity: 10,
        costK: 20_000_00,
        sourceType: 'chat',
        sourceId: 'd1',
      });
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: null,
        items: [{ name: 'Rice bag', quantity: 3, unitPriceK: 3_000_00 }],
        subtotalK: 9_000_00,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 9_000_00,
        paidK: 0,
        balanceDueK: 9_000_00,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 's1',
        actor: 'test',
      });
      const moved = await stockRepo.recordSaleMovements(
        tx,
        businessId,
        [{ name: 'Rice bag', quantity: 3 }],
        sale.invoiceNumber,
      );
      await issueRepo.writePosting(
        tx,
        businessId,
        postCostOfSale({ memo: `Cost of goods on ${sale.invoiceNumber}`, costK: moved.costK }),
        'invoice',
        sale.invoiceNumber,
      );
      return sale.invoiceNumber;
    });

    const balance = async (account: string) => {
      const entries = await withBusiness(db, businessId, (tx) =>
        issueRepo.ledgerEntriesFor(tx, businessId),
      );
      return entries
        .filter((e) => e.account === account)
        .reduce((n, e) => n + Number(e.debitK) - Number(e.creditK), 0);
    };

    expect(await balance('COGS')).toBe(6_000_00);

    await withBusiness(db, businessId, (tx) =>
      issueRepo.voidInvoice(tx, businessId, invoiceNumber, 'never happened', 'user:1'),
    );

    /* Both postings mirrored: the sale, and what it said the goods cost. */
    expect(await balance('COGS')).toBe(0);
    expect(await balance('SALES_REVENUE')).toBe(0);
    /* Back to nothing, and that is right: this test recorded a DELIVERY,
     * which moves the count and the cost basis, and no purchase, which is
     * what moves the money. Inventory's only movements here were the credit
     * the cost posting made and the mirror that undid it. */
    expect(await balance('INVENTORY')).toBe(0);

    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    const debits = entries.reduce((n, e) => n + Number(e.debitK), 0);
    const credits = entries.reduce((n, e) => n + Number(e.creditK), 0);
    expect(debits).toBe(credits);
  });

  /* The count is not put back. Money is a bookkeeping fact and can be
   * mirrored; what is on the shelf is a physical fact only a merchant knows,
   * which is the same rule a voided purchase follows. */
  it('leaves the shelf alone, because only the merchant knows what is on it', async () => {
    const businessId = await seedBusiness('+2348120000212');
    const invoiceNumber = await withBusiness(db, businessId, async (tx) => {
      const product = await stockRepo.findOrCreateProduct(tx, businessId, 'Rice bag');
      await stockRepo.recordDelivery(tx, {
        businessId,
        product,
        quantity: 10,
        costK: 20_000_00,
        sourceType: 'chat',
        sourceId: 'd1',
      });
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: null,
        items: [{ name: 'Rice bag', quantity: 3, unitPriceK: 3_000_00 }],
        subtotalK: 9_000_00,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 9_000_00,
        paidK: 0,
        balanceDueK: 9_000_00,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 's1',
        actor: 'test',
      });
      await stockRepo.recordSaleMovements(
        tx,
        businessId,
        [{ name: 'Rice bag', quantity: 3 }],
        sale.invoiceNumber,
      );
      return sale.invoiceNumber;
    });

    await withBusiness(db, businessId, (tx) =>
      issueRepo.voidInvoice(tx, businessId, invoiceNumber, 'never happened', 'user:1'),
    );
    expect(
      (
        await withBusiness(db, businessId, (tx) =>
          stockRepo.productByName(tx, businessId, 'Rice bag'),
        )
      )?.onHand,
    ).toBe(7);
  });
});

/**
 * The fold, on both sides of the boundary.
 *
 * `foldProductName` in @rekoda/core and the expression in `productByName`
 * have to agree exactly. They did not: the TypeScript collapsed internal runs
 * of whitespace and the SQL did not, and the damage was not a missed match
 * but a duplicate row.
 */
describe('what counts as the same product name', () => {
  it('does not split a shop in two over a double space', async () => {
    const businessId = await seedBusiness('+2348050000034');
    const first = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Bags of rice'),
    );
    await adjust(businessId, first.id, 40);

    /* What a customer forwarding a message, or a merchant typing on a phone
     * keyboard, produces without noticing. */
    const again = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Bags  of   rice'),
    );

    expect(again.id).toBe(first.id);
    /* The register is the place a merchant would have seen it: two rows they
     * cannot tell apart, and forty bags on one of them. */
    const register = await withBusiness(db, businessId, (tx) =>
      stockRepo.stockList(tx, businessId),
    );
    expect(register.rows.map((r) => r.name)).toEqual(['Bags of rice']);
    expect(register.count).toBe(1);
    expect(register.rows[0]!.onHand).toBe(40);
  });

  it('still keeps genuinely different names apart', async () => {
    const businessId = await seedBusiness('+2348050000035');
    await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Rice'),
    );
    await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Bags of rice'),
    );
    /* Not fuzzy, on purpose: in some shops these are the same thing and in
     * others they are not, and only the merchant knows which. */
    const register = await withBusiness(db, businessId, (tx) =>
      stockRepo.stockList(tx, businessId),
    );
    expect(register.count).toBe(2);
  });

  it('moves stock for a sale line spelled with stray spaces', async () => {
    const businessId = await seedBusiness('+2348050000036');
    const product = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Ankara bale'),
    );
    await adjust(businessId, product.id, 10);

    /* Before the folds agreed this found nothing and returned `moved: 0`.
     * The sale was invoiced and the shelf never moved, silently. */
    const result = await withBusiness(db, businessId, (tx) =>
      stockRepo.recordSaleMovements(
        tx,
        businessId,
        [{ name: 'ankara  bale', quantity: 3 }],
        'INV-9',
      ),
    );
    expect(result.moved).toBe(1);
    expect(
      (
        await withBusiness(db, businessId, (tx) =>
          stockRepo.productByName(tx, businessId, 'Ankara bale'),
        )
      )?.onHand,
    ).toBe(7);
  });
});

/**
 * The counts under the list, which are about the shop and not about the page.
 *
 * Both callers show a page: twenty rows in chat, two hundred on the
 * dashboard. Both used to count the rows they were handed and report that as
 * the shop, which reads to a merchant as "the rest stopped being counted".
 */
describe('what the register leaves out', () => {
  it('counts every product even when it only returns a page of them', async () => {
    const businessId = await seedBusiness('+2348050000030');
    for (let i = 0; i < 7; i += 1) {
      const p = await withBusiness(db, businessId, (tx) =>
        stockRepo.findOrCreateProduct(tx, businessId, `Product ${i + 1}`),
      );
      await adjust(businessId, p.id, i);
    }

    const page = await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId, 3));
    expect(page.rows).toHaveLength(3);
    expect(page.count).toBe(7);
    /* Lowest first, so the page is the three emptiest shelves and the four
     * it left out are the fullest. That is what lets a caller say a number
     * and point at the dashboard. */
    expect(page.rows.map((r) => r.name)).toEqual(['Product 1', 'Product 2', 'Product 3']);
  });

  it('counts empty shelves the page never showed', async () => {
    const businessId = await seedBusiness('+2348050000031');
    for (let i = 0; i < 5; i += 1) {
      await withBusiness(db, businessId, (tx) =>
        stockRepo.findOrCreateProduct(tx, businessId, `Empty ${i + 1}`),
      );
    }
    const stocked = await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Stocked'),
    );
    await adjust(businessId, stocked.id, 40);

    const page = await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId, 2));
    expect(page.rows).toHaveLength(2);
    expect(page.outOfStock).toBe(5);
    expect(page.count).toBe(6);
  });

  it('counts products with no cost across all of them, not across the page', async () => {
    const businessId = await seedBusiness('+2348050000032');
    for (let i = 0; i < 4; i += 1) {
      const p = await withBusiness(db, businessId, (tx) =>
        stockRepo.findOrCreateProduct(tx, businessId, `Uncosted ${i + 1}`),
      );
      await adjust(businessId, p.id, i + 1);
    }
    /* One of the four has a cost, so three do not. A page of one would have
     * reported one, and the profit and loss explanation on the dashboard
     * would have been wrong by two products. A cost is set by a delivery,
     * which is the only way one is ever recorded. */
    await withBusiness(db, businessId, async (tx) => {
      const costed = await stockRepo.findOrCreateProduct(tx, businessId, 'Uncosted 1');
      await stockRepo.recordDelivery(tx, {
        businessId,
        product: costed,
        quantity: 1,
        costK: 12_000,
        sourceType: 'test',
      });
    });

    const page = await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId, 1));
    expect(page.rows).toHaveLength(1);
    expect(page.withoutCost).toBe(3);
    expect(page.count).toBe(4);
  });

  it('answers zero for a business counting nothing', async () => {
    const businessId = await seedBusiness('+2348050000033');
    const page = await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId));
    expect(page).toEqual({ rows: [], count: 0, outOfStock: 0, withoutCost: 0 });
  });
});
