/**
 * The count on the shelf against the figure in the books, against real
 * PostgreSQL.
 *
 * Both halves of the comparison come from separate places — one from the
 * ledger, one from products joined to their movements — so the claims worth
 * proving are that the two are read as at one moment, that a product nobody
 * has priced the cost of stops the adjustment rather than silently shrinking
 * it, and that acting on a count leaves the books balanced.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { postCostOfSale, postPurchase } from '@rekoda/core';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, issueRepo, stockRepo, stocktakeRepo } from './index.js';
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

/** A purchase dictated as prose: money onto the shelf, against no product. */
function loosePurchase(businessId: string, amountK: number, ref = 'p1'): Promise<string> {
  return withBusiness(db, businessId, (tx) =>
    issueRepo.writePosting(
      tx,
      businessId,
      postPurchase({ memo: 'Restocked the shop', amountK }),
      'purchase',
      ref,
    ),
  );
}

/** Goods arriving against a product: the shelf and the cost basis both move. */
async function delivery(businessId: string, name: string, quantity: number, costK: number) {
  return withBusiness(db, businessId, async (tx) => {
    const product = await stockRepo.findOrCreateProduct(tx, businessId, name);
    await stockRepo.recordDelivery(tx, {
      businessId,
      product,
      quantity,
      costK,
      sourceType: 'chat',
    });
    return product.id;
  });
}

const valuation = (businessId: string) =>
  withBusiness(db, businessId, (tx) => stocktakeRepo.stockValuationFor(tx, businessId));

const count = (businessId: string, countedOn = '2026-08-21') =>
  withBusiness(db, businessId, (tx) =>
    stocktakeRepo.recordStockCount(tx, { businessId, countedOn, actor: 'user:1' }),
  );

describe('what the shelf is worth, against what the books say', () => {
  it('reports nothing on both sides for a business that has bought nothing', async () => {
    const businessId = await seedBusiness('+2348060000001');
    expect(await valuation(businessId)).toEqual({
      ledgerK: 0,
      countedK: 0,
      differenceK: 0,
      uncosted: 0,
    });
  });

  /**
   * The drift this whole instrument exists for. A lump-sum purchase debits
   * INVENTORY and names no product, so nothing ever credits it back: the
   * books claim stock nobody is holding, and the figure only climbs.
   */
  it('sees the gap a purchase in prose leaves behind', async () => {
    const businessId = await seedBusiness('+2348060000002');
    await loosePurchase(businessId, 5_000_000);

    expect(await valuation(businessId)).toEqual({
      ledgerK: 5_000_000,
      countedK: 0,
      differenceK: -5_000_000,
      uncosted: 0,
    });
  });

  it('agrees when every purchase arrived against a product', async () => {
    const businessId = await seedBusiness('+2348060000003');
    await withBusiness(db, businessId, (tx) =>
      issueRepo.writePosting(
        tx,
        businessId,
        postPurchase({ memo: 'Rice', amountK: 4_000_000 }),
        'purchase',
        'p1',
      ),
    );
    await delivery(businessId, 'Bags of rice', 10, 4_000_000);

    expect(await valuation(businessId)).toMatchObject({
      ledgerK: 4_000_000,
      countedK: 4_000_000,
      differenceK: 0,
    });
  });

  /**
   * Oversold stock is a counting error, never a negative asset. Valuing it
   * below zero would net it off against goods actually on another shelf and
   * report a total that is short by twice the mistake.
   */
  it('values stock below zero at nothing rather than at less than nothing', async () => {
    const businessId = await seedBusiness('+2348060000004');
    const productId = await delivery(businessId, 'Bags of rice', 10, 4_000_000);
    await withBusiness(db, businessId, (tx) =>
      stockRepo.recordMovement(tx, {
        businessId,
        productId,
        delta: -14,
        reason: 'sale',
        sourceType: 'chat',
        sourceId: 'oversold',
      }),
    );
    await delivery(businessId, 'Palm oil', 5, 900_000);

    /* Rice is at minus four and contributes nothing, so the total is the
     * oil alone. Valued as it stands it would come to minus ₦7,000. */
    expect(await valuation(businessId)).toMatchObject({ countedK: 900_000, uncosted: 0 });
  });

  it('counts the products holding stock nobody has said the cost of', async () => {
    const businessId = await seedBusiness('+2348060000005');
    await withBusiness(db, businessId, async (tx) => {
      const product = await stockRepo.findOrCreateProduct(tx, businessId, 'Ankara');
      await stockRepo.recordMovement(tx, {
        businessId,
        productId: product.id,
        delta: 6,
        reason: 'adjustment',
        sourceType: 'chat',
        sourceId: 'counted',
      });
    });

    expect(await valuation(businessId)).toMatchObject({ countedK: 0, uncosted: 1 });
  });

  /* A product with no cost and no stock is not a gap. Nothing of it is on the
   * shelf, so nothing of it is missing from the count. */
  it('does not call a product with no stock uncosted', async () => {
    const businessId = await seedBusiness('+2348060000006');
    await withBusiness(db, businessId, (tx) =>
      stockRepo.findOrCreateProduct(tx, businessId, 'Ankara'),
    );
    expect(await valuation(businessId)).toMatchObject({ uncosted: 0 });
  });

  /**
   * The account itself below zero, which is reachable and must not be
   * refused anywhere downstream. A cost typed onto a product that was never
   * delivered lets a sale credit INVENTORY through zero, and a reader that
   * treated the balance as unsigned would fail on exactly the books this is
   * meant to repair.
   */
  it('reads a stock account that has gone below zero', async () => {
    const businessId = await seedBusiness('+2348060000009');
    await withBusiness(db, businessId, (tx) =>
      issueRepo.writePosting(
        tx,
        businessId,
        postCostOfSale({ memo: 'Sold goods nobody bought', costK: 1_500_000 }),
        'invoice',
        'INV-1',
      ),
    );

    expect(await valuation(businessId)).toEqual({
      ledgerK: -1_500_000,
      countedK: 0,
      differenceK: 1_500_000,
      uncosted: 0,
    });

    /* And the count brings it back to nothing rather than refusing. */
    expect(await count(businessId)).toMatchObject({
      outcome: 'adjusted',
      differenceK: 1_500_000,
    });
    expect(await valuation(businessId)).toMatchObject({ ledgerK: 0, differenceK: 0 });
  });

  it('is one business at a time', async () => {
    const ada = await seedBusiness('+2348060000007');
    const bola = await seedBusiness('+2348060000008');
    await loosePurchase(ada, 5_000_000);
    await delivery(ada, 'Bags of rice', 10, 4_000_000);

    expect(await valuation(bola)).toEqual({
      ledgerK: 0,
      countedK: 0,
      differenceK: 0,
      uncosted: 0,
    });
  });
});

describe('acting on a count', () => {
  it('writes the shortfall to cost of goods sold and leaves the books balanced', async () => {
    const businessId = await seedBusiness('+2348060000010');
    await loosePurchase(businessId, 5_000_000);

    const result = await count(businessId);
    expect(result).toMatchObject({ outcome: 'adjusted', differenceK: -5_000_000, countedK: 0 });

    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    const debits = entries.reduce((n, e) => n + Number(e.debitK), 0);
    const credits = entries.reduce((n, e) => n + Number(e.creditK), 0);
    expect(debits).toBe(credits);
    expect(entries).toContainEqual(expect.objectContaining({ account: 'COGS', debitK: 5_000_000 }));

    /* And the books now say what the shelf says, which is the point. */
    expect(await valuation(businessId)).toMatchObject({ ledgerK: 0, differenceK: 0 });
  });

  it('writes a surplus back the other way', async () => {
    const businessId = await seedBusiness('+2348060000011');
    await delivery(businessId, 'Bags of rice', 10, 4_000_000);

    const result = await count(businessId);
    expect(result).toMatchObject({ outcome: 'adjusted', differenceK: 4_000_000 });

    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'INVENTORY', debitK: 4_000_000 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'COGS', creditK: 4_000_000 }),
    );
  });

  /**
   * The second press of the button. By then the ledger already says what the
   * shelf says, so there is no difference left to post, and the instrument
   * refuses rather than writing a pair of zero entries nobody can read.
   */
  it('posts nothing the second time', async () => {
    const businessId = await seedBusiness('+2348060000012');
    await loosePurchase(businessId, 5_000_000);
    await count(businessId);

    expect(await count(businessId)).toEqual({ outcome: 'agrees', countedK: 0 });
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string }>(sql`
        SELECT COUNT(*)::bigint AS n FROM ledger_transactions
        WHERE business_id = ${businessId}::uuid AND source_type = 'stock_count'
      `),
    );
    expect(Number([...rows][0]!.n)).toBe(1);
  });

  /**
   * The refusal that keeps this honest. Goods on the shelf with no cost are
   * missing from the count by an unknown amount, so bringing the ledger down
   * to it would write off stock the business is still holding.
   */
  it('refuses while any product holds stock with no cost recorded', async () => {
    const businessId = await seedBusiness('+2348060000013');
    await loosePurchase(businessId, 5_000_000);
    await withBusiness(db, businessId, async (tx) => {
      const product = await stockRepo.findOrCreateProduct(tx, businessId, 'Ankara');
      await stockRepo.recordMovement(tx, {
        businessId,
        productId: product.id,
        delta: 6,
        reason: 'adjustment',
        sourceType: 'chat',
        sourceId: 'counted',
      });
    });

    expect(await count(businessId)).toEqual({ outcome: 'costs_missing', uncosted: 1 });
    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    expect(entries.some((e) => e.account === 'COGS')).toBe(false);
  });

  it('stamps the entry with the day it was counted', async () => {
    const businessId = await seedBusiness('+2348060000014');
    await loosePurchase(businessId, 5_000_000);
    await count(businessId, '2026-08-19');

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ source_id: string; memo: string }>(sql`
        SELECT source_id, memo FROM ledger_transactions
        WHERE business_id = ${businessId}::uuid AND source_type = 'stock_count'
      `),
    );
    expect([...rows][0]).toMatchObject({
      source_id: '2026-08-19',
      memo: 'Stock count 2026-08-19',
    });
  });

  it('records who counted, in the audit trail', async () => {
    const businessId = await seedBusiness('+2348060000015');
    await loosePurchase(businessId, 5_000_000);
    await count(businessId);

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ entity: string; action: string; actor: string }>(sql`
        SELECT entity, action, actor FROM audit_events
        WHERE business_id = ${businessId}::uuid AND entity = 'stock_count'
      `),
    );
    expect([...rows][0]).toMatchObject({
      entity: 'stock_count',
      action: 'adjusted',
      actor: 'user:1',
    });
  });
});
