/**
 * Goods returns with disposition (spec §14.3, Appendix B.2/B.2a; F2,
 * PR-080) — the return tests the build plan mandates, including the
 * appendix's own worked example. Physical quantity and financial
 * valuation are asserted SEPARATELY throughout.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, returnsRepo, stockRepo } from './index.js';
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

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481895${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** The Appendix B worked example, in kobo: buy 10 @ 100, sell 5, buy 5
 * @ 200. Leaves 10 units, value 1,500, average 150. */
async function workedExample(businessId: string) {
  return withBusiness(db, businessId, async (tx) => {
    const product = await stockRepo.findOrCreateProduct(tx, businessId, 'ankara');
    await stockRepo.recordDelivery(tx, {
      businessId,
      product,
      quantity: 10,
      costK: 1_000,
      sourceType: 'chat',
      sourceId: 'buy-1',
    });
    const afterBuy = (await stockRepo.productByName(tx, businessId, 'ankara'))!;
    await stockRepo.recordSaleMovements(tx, businessId, [{ name: 'ankara', quantity: 5 }], 'inv-1');
    const afterSale = (await stockRepo.productByName(tx, businessId, 'ankara'))!;
    await stockRepo.recordDelivery(tx, {
      businessId,
      product: afterSale,
      quantity: 5,
      costK: 1_000,
      sourceType: 'chat',
      sourceId: 'buy-2',
    });
    const now = (await stockRepo.productByName(tx, businessId, 'ankara'))!;
    return { product: now, afterBuyAvg: afterBuy.unitCostK };
  });
}

const productState = (businessId: string) =>
  withBusiness(db, businessId, (tx) => stockRepo.productByName(tx, businessId, 'ankara'));

const ledgerFor = (businessId: string, transactionId: string) =>
  withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{ code: string; debit_k: string; credit_k: string }>(sql`
      SELECT acc.code, e.debit_k, e.credit_k
      FROM ledger_entries e JOIN accounts acc ON acc.id = e.account_id
      WHERE e.business_id = ${businessId}::uuid AND e.transaction_id = ${transactionId}::uuid
      ORDER BY acc.code
    `);
    return [...rows].map((r) => ({
      code: r.code,
      debitK: Number(r.debit_k),
      creditK: Number(r.credit_k),
    }));
  });

describe('RESALABLE: the worked example, to the kobo (Appendix B.2)', () => {
  it('restores at the ORIGINAL issue cost, reverses COGS at it, then MOVES the average', async () => {
    const businessId = await seedBusiness();
    const { product } = await workedExample(businessId);
    /* 10 units, value 1,500, average 150. */
    expect(product).toMatchObject({ onHand: 10, unitCostK: 150 });

    const returned = await withBusiness(db, businessId, (tx) =>
      returnsRepo.recordGoodsReturn(tx, {
        businessId,
        productId: product.id,
        invoiceId: null,
        quantity: 1,
        disposition: 'RESALABLE',
        sourceType: 'chat',
        sourceId: 'return-1',
        actor: 'user:1',
      }),
    );
    if (returned.outcome !== 'returned') throw new Error('expected a return');
    /* The outbound movement carried 100 — NOT today's 150. */
    expect(returned.originalIssueCostK).toBe(100);
    /* 11 units, value 1,600, average 145.45… → 145. The average MOVES,
     * and it must: 11 × 150 = 1,650 ≠ 1,600. */
    expect(returned.averageCostK).toBe(145);
    const after = await productState(businessId);
    expect(after).toMatchObject({ onHand: 11, unitCostK: 145 });

    /* DR Inventory / CR COGS at the original issue cost. */
    expect(await ledgerFor(businessId, returned.ledgerTransactionId!)).toEqual([
      { code: '1200', debitK: 100, creditK: 0 },
      { code: '5000', debitK: 0, creditK: 100 },
    ]);
  });
});

describe('DAMAGED, QUARANTINED, SCRAPPED: never sellable stock (B.2a)', () => {
  it('a zero-value damaged return moves NO quantity and posts NOTHING', async () => {
    const businessId = await seedBusiness();
    const { product } = await workedExample(businessId);

    const returned = await withBusiness(db, businessId, (tx) =>
      returnsRepo.recordGoodsReturn(tx, {
        businessId,
        productId: product.id,
        quantity: 2,
        disposition: 'DAMAGED',
        sourceType: 'chat',
        actor: 'user:1',
      }),
    );
    if (returned.outcome !== 'returned') throw new Error('expected a return');
    expect(returned.ledgerTransactionId).toBeNull();
    /* Quantity balance is NOT served by broken goods: on-hand unchanged,
     * average unchanged. The row is the holding location. */
    expect(await productState(businessId)).toMatchObject({ onHand: 10, unitCostK: 150 });
  });

  it('salvage records the SUPPORTED value, the difference as a NAMED loss', async () => {
    const businessId = await seedBusiness();
    const { product } = await workedExample(businessId);

    const returned = await withBusiness(db, businessId, (tx) =>
      returnsRepo.recordGoodsReturn(tx, {
        businessId,
        productId: product.id,
        quantity: 1,
        disposition: 'QUARANTINED',
        salvageValueK: 40,
        sourceType: 'chat',
        actor: 'user:1',
      }),
    );
    if (returned.outcome !== 'returned') throw new Error('expected a return');
    /* DR Inventory 40 (supported value) + DR Expenses 60 (named loss)
     * = CR COGS 100 (the original issue cost). Sellable stock and its
     * average are untouched: value is a different book from quantity. */
    expect(await ledgerFor(businessId, returned.ledgerTransactionId!)).toEqual([
      { code: '1200', debitK: 40, creditK: 0 },
      { code: '5000', debitK: 0, creditK: 100 },
      { code: '6000', debitK: 60, creditK: 0 },
    ]);
    expect(await productState(businessId)).toMatchObject({ onHand: 10, unitCostK: 150 });
  });

  it('salvage on SCRAPPED is unrepresentable, and above the original cost refused', async () => {
    const businessId = await seedBusiness();
    const { product } = await workedExample(businessId);

    expect(
      await withBusiness(db, businessId, (tx) =>
        returnsRepo.recordGoodsReturn(tx, {
          businessId,
          productId: product.id,
          quantity: 1,
          disposition: 'SCRAPPED',
          salvageValueK: 10,
          sourceType: 'chat',
          actor: 'user:1',
        }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'salvage_needs_damaged_or_quarantined' });

    expect(
      await withBusiness(db, businessId, (tx) =>
        returnsRepo.recordGoodsReturn(tx, {
          businessId,
          productId: product.id,
          quantity: 1,
          disposition: 'DAMAGED',
          salvageValueK: 500,
          sourceType: 'chat',
          actor: 'user:1',
        }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'salvage_exceeds_cost' });
  });
});

describe('supplier returns reverse the receipt at its own cost (B.2)', () => {
  it('removes at the receipt cost, recomputes the average, credits inventory', async () => {
    const businessId = await seedBusiness();
    const { product } = await workedExample(businessId);

    /* Return 2 of the ₦2 units to the supplier: value 1,500 − 400 =
     * 1,100 over 8 units → average 137.5 → 138. */
    const returned = await withBusiness(db, businessId, (tx) =>
      returnsRepo.recordSupplierReturn(tx, {
        businessId,
        productId: product.id,
        quantity: 2,
        unitCostK: 200,
        settledVia: 'ACCOUNTS_PAYABLE',
        sourceType: 'chat',
        actor: 'user:1',
      }),
    );
    if (returned.outcome !== 'returned') throw new Error('expected a return');
    expect(returned.averageCostK).toBe(138);
    expect(await productState(businessId)).toMatchObject({ onHand: 8, unitCostK: 138 });
    expect(await ledgerFor(businessId, returned.ledgerTransactionId)).toEqual([
      { code: '1200', debitK: 0, creditK: 400 },
      { code: '2000', debitK: 400, creditK: 0 },
    ]);
  });

  it('refuses to take stock below zero — a negative average survives no statement', async () => {
    const businessId = await seedBusiness();
    const { product } = await workedExample(businessId);
    expect(
      await withBusiness(db, businessId, (tx) =>
        returnsRepo.recordSupplierReturn(tx, {
          businessId,
          productId: product.id,
          quantity: 11,
          unitCostK: 200,
          settledVia: 'CASH',
          sourceType: 'chat',
          actor: 'user:1',
        }),
      ),
    ).toEqual({ outcome: 'refused', reason: 'more_than_on_hand' });
  });
});

describe('uncosted history stays honest', () => {
  it('a RESALABLE return of an uncosted sale restores quantity, posts nothing, invents nothing', async () => {
    const businessId = await seedBusiness();
    const product = await withBusiness(db, businessId, async (tx) => {
      const p = await stockRepo.findOrCreateProduct(tx, businessId, 'ankara');
      /* Stock arrives by adjustment with no cost ever stated. */
      await stockRepo.recordMovement(tx, {
        businessId,
        productId: p.id,
        delta: 5,
        reason: 'adjustment',
        sourceType: 'chat',
      });
      await stockRepo.recordSaleMovements(
        tx,
        businessId,
        [{ name: 'ankara', quantity: 2 }],
        'inv-9',
      );
      return p;
    });

    const returned = await withBusiness(db, businessId, (tx) =>
      returnsRepo.recordGoodsReturn(tx, {
        businessId,
        productId: product.id,
        invoiceId: null,
        quantity: 1,
        disposition: 'RESALABLE',
        sourceType: 'chat',
        actor: 'user:1',
      }),
    );
    if (returned.outcome !== 'returned') throw new Error('expected a return');
    expect(returned.originalIssueCostK).toBeNull();
    expect(returned.ledgerTransactionId).toBeNull();
    expect(await productState(businessId)).toMatchObject({ onHand: 4, unitCostK: null });
  });
});
