/**
 * Two customers, one item left (PR-138).
 *
 * The race this closes is the oldest one in retail software: read the shelf,
 * decide, then write. Every order path in Rekoda did exactly that, and the
 * storefront skipped the reading entirely. Two transactions could both see
 * one wig and both sell it.
 *
 * These tests run REAL concurrent transactions against real PostgreSQL. A
 * test that awaited one order and then the other would pass against the
 * broken code and prove nothing, so the two are started together and only
 * settled at the end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, sql, stockRepo, withBusiness, type Db } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  /* Room for both orders to hold a connection at once. A pool of one would
   * serialise them and quietly turn every race test into a sequential one. */
  ({ db, close } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function shopWith(onHand: number, unitCostK: number | null = 100_000) {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481770${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const businessId = business.id;
  const productId = await withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      INSERT INTO products (business_id, name, unit_price_k, unit_cost_k)
      VALUES (${businessId}::uuid, 'wig', 150000, ${unitCostK})
      RETURNING id`);
    const id = [...rows][0]!.id;
    if (onHand > 0) {
      await tx.execute(sql`
        INSERT INTO inventory_movements (business_id, product_id, delta, reason, source_type)
        VALUES (${businessId}::uuid, ${id}::uuid, ${onHand}, 'opening', 'seed')`);
    }
    return id;
  });
  return { businessId, productId };
}

const onHandOf = async (businessId: string, productId: string) => {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ n: number }>(sql`
      SELECT coalesce(sum(delta), 0)::int AS n
        FROM inventory_movements WHERE product_id = ${productId}::uuid`),
  );
  return [...rows][0]!.n;
};

/** One order, in its own transaction, exactly as a request would. */
const order = (businessId: string, quantity: number, ref: string) =>
  withBusiness(db, businessId, (tx) =>
    stockRepo.reserveStockForOrder(tx, businessId, [{ name: 'wig', quantity }], ref),
  );

describe('the last item', () => {
  it('is sold exactly once when two customers race for it', async () => {
    const { businessId, productId } = await shopWith(1);

    /* Started together, settled together. This is the whole test: awaiting
     * the first before starting the second would serialise them by hand. */
    const [a, b] = await Promise.all([
      order(businessId, 1, 'INV-A'),
      order(businessId, 1, 'INV-B'),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['insufficient', 'reserved']);
    expect(await onHandOf(businessId, productId)).toBe(0);
  });

  it('never goes negative, however many customers arrive at once', async () => {
    const { businessId, productId } = await shopWith(3);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => order(businessId, 1, `INV-${i}`)),
    );

    /* Three on the shelf, eight customers: three win. The count lands on
     * zero and not on minus five, which is what it did before. */
    expect(results.filter((r) => r.outcome === 'reserved')).toHaveLength(3);
    expect(results.filter((r) => r.outcome === 'insufficient')).toHaveLength(5);
    expect(await onHandOf(businessId, productId)).toBe(0);
  });

  it('refuses the whole order rather than part of it', async () => {
    const { businessId, productId } = await shopWith(1);

    const result = await order(businessId, 2, 'INV-BIG');

    expect(result.outcome).toBe('insufficient');
    if (result.outcome === 'insufficient') {
      expect(result.shortfalls).toEqual([{ productId, name: 'wig', wanted: 2, onHand: 1 }]);
    }
    /* Nothing moved. A customer shown a partial order they did not compose
     * would pay for a guess. */
    expect(await onHandOf(businessId, productId)).toBe(1);
  });
});

describe('what the reservation counts', () => {
  it('adds up the same product named twice in one cart', async () => {
    const { businessId, productId } = await shopWith(3);

    /* Two lines of two on a shelf of three. Checking each line against the
     * whole shelf would let this pass and leave the count at minus one. */
    const result = await withBusiness(db, businessId, (tx) =>
      stockRepo.reserveStockForOrder(
        tx,
        businessId,
        [
          { name: 'wig', quantity: 2 },
          { name: 'wig', quantity: 2 },
        ],
        'INV-DUP',
      ),
    );

    expect(result.outcome).toBe('insufficient');
    expect(await onHandOf(businessId, productId)).toBe(3);
  });

  it('rounds a part-unit up, as the shelf always has', async () => {
    const { businessId, productId } = await shopWith(3);

    await order(businessId, 2.5, 'INV-RICE');

    /* 2.5 takes 3, not 2: believing the shop holds more than it does is the
     * error that makes a merchant promise what is not there. */
    expect(await onHandOf(businessId, productId)).toBe(0);
  });

  it('sells a product nobody has ever counted, and starts counting it', async () => {
    /*
     * The distinction `onHandByIds` has always drawn, and which the first
     * version of this function lost: a product with NO movement history is
     * not stock-tracked. Inventing an empty shelf for it would refuse a
     * service nobody counts, which is most of what a new merchant lists.
     * Four api integration tests caught this before it left the branch.
     */
    const { businessId, productId } = await shopWith(0);
    expect(await onHandOf(businessId, productId)).toBe(0);

    const result = await order(businessId, 3, 'INV-UNCOUNTED');

    expect(result.outcome).toBe('reserved');
    /* The sale still moves it, so from now on the shelf IS counted - at
     * minus three, which is the honest record of what happened. */
    expect(await onHandOf(businessId, productId)).toBe(-3);
  });

  it('refuses once the shelf is counted, even at zero', async () => {
    const { businessId, productId } = await shopWith(1);
    await order(businessId, 1, 'INV-FIRST');
    expect(await onHandOf(businessId, productId)).toBe(0);

    /* Counted and empty is a different fact from never counted, and this is
     * the one that refuses. */
    const result = await order(businessId, 1, 'INV-SECOND');
    expect(result.outcome).toBe('insufficient');
    expect(await onHandOf(businessId, productId)).toBe(0);
  });

  it('ignores a product the shop does not track', async () => {
    const { businessId, productId } = await shopWith(1);

    const result = await withBusiness(db, businessId, (tx) =>
      stockRepo.reserveStockForOrder(
        tx,
        businessId,
        [{ name: 'something never counted', quantity: 99 }],
        'INV-UNTRACKED',
      ),
    );

    /* A merchant who never told Rekoda they stock something has not asked
     * Rekoda to count it, and refusing the sale would stop them selling what
     * they actually have. */
    expect(result.outcome).toBe('reserved');
    if (result.outcome === 'reserved') expect(result.movements.moved).toBe(0);
    expect(await onHandOf(businessId, productId)).toBe(1);
  });

  it('reports the cost of what left the shelf, and what had none', async () => {
    const { businessId } = await shopWith(5, 100_000);
    const priced = await order(businessId, 2, 'INV-COST');
    expect(priced.outcome).toBe('reserved');
    if (priced.outcome === 'reserved') {
      expect(priced.movements.costK).toBe(200_000);
      expect(priced.movements.uncosted).toBe(0);
    }

    const { businessId: other } = await shopWith(5, null);
    const free = await order(other, 2, 'INV-NOCOST');
    if (free.outcome === 'reserved') {
      expect(free.movements.costK).toBe(0);
      /* Counted, not swallowed: revenue with no cost against it overstates
       * profit, and the merchant is owed the fact. */
      expect(free.movements.uncosted).toBe(1);
    }
  });
});

describe('two products at once', () => {
  it('takes them in a stable order, so orders cannot deadlock on each other', async () => {
    const { businessId } = await shopWith(5);
    await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO products (business_id, name, unit_price_k, unit_cost_k)
        VALUES (${businessId}::uuid, 'scarf', 50000, 20000)`),
    );
    const scarf = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ id: string }>(
        sql`SELECT id FROM products WHERE business_id = ${businessId}::uuid AND name = 'scarf'`,
      ),
    );
    const scarfId = [...scarf][0]!.id;
    await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO inventory_movements (business_id, product_id, delta, reason, source_type)
        VALUES (${businessId}::uuid, ${scarfId}::uuid, 5, 'opening', 'seed')`),
    );

    /* The same two products, named in opposite orders. Locking in cart order
     * would let these take each other's rows and wait forever; locking by id
     * makes the order the same for both. */
    const [a, b] = await Promise.all([
      withBusiness(db, businessId, (tx) =>
        stockRepo.reserveStockForOrder(
          tx,
          businessId,
          [
            { name: 'wig', quantity: 1 },
            { name: 'scarf', quantity: 1 },
          ],
          'INV-1',
        ),
      ),
      withBusiness(db, businessId, (tx) =>
        stockRepo.reserveStockForOrder(
          tx,
          businessId,
          [
            { name: 'scarf', quantity: 1 },
            { name: 'wig', quantity: 1 },
          ],
          'INV-2',
        ),
      ),
    ]);

    expect(a.outcome).toBe('reserved');
    expect(b.outcome).toBe('reserved');
  });
});
