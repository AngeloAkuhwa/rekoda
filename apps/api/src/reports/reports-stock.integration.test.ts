/**
 * The reports surface, end to end: session guard → SQL → contract shape.
 *
 * The NUMBERS are proven in packages/db/src/ledger/reports.integration.test.ts
 * against hand arithmetic; what this suite pins is the wiring — that the
 * endpoints exist, refuse strangers, scope to the session's tenant, and
 * answer in exactly the shape the web tier's zod contracts will parse.
 */
// The reports surface, end to end. Split by concern across reports*.integration.test.ts; the shared setup is in
// reports.fixtures.ts.
import { describe, expect, it } from 'vitest';
import { postCostOfSale } from '@rekoda/core';
import { reportsStatementsResponse, stockCountResponse } from '@rekoda/contracts';
import { issueRepo, spendRepo, stockRepo, withBusiness } from '@rekoda/db';
import { app, db, onboard, useReportsHarness } from './reports.fixtures.js';

useReportsHarness();

/**
 * The stock register.
 *
 * `products` and `inventory_movements` have existed since migration 0000 and
 * nothing wrote to either until now, so every figure below is a sum over an
 * append-only ledger rather than a stored count.
 */
describe('the stock register', () => {
  const get = (auth: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/v1/reports/stock', headers: auth });

  async function count(businessId: string, name: string, delta: number) {
    await withBusiness(db, businessId, async (tx) => {
      const product = await stockRepo.findOrCreateProduct(tx, businessId, name);
      await stockRepo.recordMovement(tx, {
        businessId,
        productId: product.id,
        delta,
        reason: 'adjustment',
        sourceType: 'chat',
        sourceId: null,
      });
    });
  }

  it('refuses without a session, like every other report', async () => {
    expect((await get()).statusCode).toBe(401);
  });

  it('is empty for a shop that counts nothing', async () => {
    const { auth } = await onboard('+2348120000041');
    expect((await get(auth)).json()).toEqual({
      products: [],
      total: 0,
      outOfStock: 0,
      withoutCost: 0,
    });
  });

  it('sums the movements and puts what is running out first', async () => {
    const { auth, businessId } = await onboard('+2348120000042');
    await count(businessId, 'Bags of rice', 40);
    await count(businessId, 'Bags of rice', -5);
    await count(businessId, 'Wigs', 2);

    const body = (await get(auth)).json();
    expect(body.products).toEqual([
      { name: 'Wigs', onHand: 2, unitCostK: null },
      { name: 'Bags of rice', onHand: 35, unitCostK: null },
    ]);
    expect(body.outOfStock).toBe(0);
    /* Counted by hand and never bought through Rekoda, so neither has a cost.
     * The page says so rather than showing a zero. */
    expect(body.withoutCost).toBe(2);
  });

  it('counts what has run out, and keeps it in the list', async () => {
    const { auth, businessId } = await onboard('+2348120000043');
    await count(businessId, 'Wigs', 4);
    await count(businessId, 'Wigs', -4);

    const body = (await get(auth)).json();
    /* Still listed: something counted and sold down to nothing is exactly the
     * row a merchant needs to see, and dropping it would hide the restock. */
    expect(body.products).toEqual([{ name: 'Wigs', onHand: 0, unitCostK: null }]);
    expect(body.outOfStock).toBe(1);
  });

  /**
   * `total` and not `products.length`.
   *
   * The list is a page, capped at two hundred. A footer that counted its own
   * rows would tell a merchant with more products than that they have
   * exactly two hundred, in their own words, with nothing on the page to
   * contradict it. Same for the two counts beside it, which is why all three
   * are summed in SQL over the whole table.
   *
   * Two hundred and five products, because the cap is what has to be crossed
   * for the two numbers to differ at all. Seeded in one transaction so the
   * honesty costs a second rather than a minute.
   */
  it('counts the shop and not the page it returned', async () => {
    const { auth, businessId } = await onboard('+2348120000047');
    await withBusiness(db, businessId, async (tx) => {
      for (let i = 0; i < 205; i += 1) {
        const product = await stockRepo.findOrCreateProduct(tx, businessId, `Product ${i + 1}`);
        await stockRepo.recordMovement(tx, {
          businessId,
          productId: product.id,
          /* The first five shelves are empty, and lowest-first means they are
           * the five the page does show. The other two hundred are not. */
          delta: i < 5 ? 0 : i,
          reason: 'adjustment',
          sourceType: 'chat',
          sourceId: null,
        });
      }
    });

    const body = (await get(auth)).json();
    expect(body.products).toHaveLength(200);
    expect(body.total).toBe(205);
    expect(body.outOfStock).toBe(5);
    /* Nothing here was ever bought through Rekoda, so nothing has a cost.
     * Counting the page would say two hundred and understate it by five. */
    expect(body.withoutCost).toBe(205);
  });

  it('shows one business nothing of another', async () => {
    const mine = await onboard('+2348120000044');
    const theirs = await onboard('+2348120000045');
    await count(theirs.businessId, 'Their product', 50);

    expect((await get(mine.auth)).json().products).toEqual([]);
  });

  /**
   * The rule changed, on purpose, and this is the new boundary.
   *
   * A unit cost is here now because deliveries maintain one and it is real.
   * A TOTAL valuation still is not: inventory on the balance sheet is the
   * ledger figure and includes purchases that named no product, so a column
   * summed here would be a second answer to the same question, differing by
   * exactly the purchases nobody itemised.
   */
  it('carries what a unit cost, and never a valuation or a selling price', async () => {
    const { auth, businessId } = await onboard('+2348120000046');
    await count(businessId, 'Wigs', 3);

    const body = (await get(auth)).json();
    expect(body.products[0]).toEqual({ name: 'Wigs', onHand: 3, unitCostK: null });
    const raw = (await get(auth)).body;
    for (const absent of ['price', 'valuation', 'totalCost', 'valueK']) {
      expect(raw).not.toContain(absent);
    }
  });
});

/**
 * The shelf against the books, end to end.
 *
 * The arithmetic is proven in packages/db/src/stock/stocktake.integration.test.ts;
 * what this pins is that the two figures reach the page that shows them, that
 * the endpoint refuses a stranger, and that nothing it posts is computed from
 * anything the caller sent.
 */
describe('counting the shelf', () => {
  const countIt = (auth: Record<string, string>, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/reports/stock-count',
      payload: body,
      headers: { 'content-type': 'application/json', ...auth },
    });

  const today = () => new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);

  it('refuses a caller with no session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/reports/stock-count',
      payload: { countedOn: today() },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  /**
   * The drift, and the correction, as a merchant meets them. A lump-sum
   * restock debits stock against no product, so the balance sheet claims
   * goods nobody is holding and nothing ever credits them back.
   */
  it('shows the gap on the balance sheet, then closes it', async () => {
    const { auth, businessId } = await onboard('+2348177000041');
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'restocked the shop',
        amountK: 5_000_000,
        paidK: 5_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'p1',
      }),
    );

    const before = reportsStatementsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
    );
    expect(before.stockValuation).toEqual({
      ledgerK: 5_000_000,
      countedK: 0,
      differenceK: -5_000_000,
      uncosted: 0,
    });

    const posted = stockCountResponse.parse((await countIt(auth, { countedOn: today() })).json());
    expect(posted).toEqual({ outcome: 'adjusted', differenceK: -5_000_000, countedK: 0 });

    const after = reportsStatementsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
    );
    expect(after.stockValuation).toMatchObject({ ledgerK: 0, differenceK: 0 });
    expect(after.balanceSheet.balanced).toBe(true);
    /* And the write-down is a cost, where stock that left without a sale
     * belongs, rather than vanishing off the sheet unexplained. */
    expect(after.profitAndLoss.costOfSalesK).toBe(5_000_000);
  });

  it('says so plainly when there is nothing to post', async () => {
    const { auth } = await onboard('+2348177000042');
    expect((await countIt(auth, { countedOn: today() })).json()).toEqual({
      outcome: 'agrees',
      countedK: 0,
    });
  });

  it('refuses a day that has not happened, and a body without one', async () => {
    const { auth } = await onboard('+2348177000043');
    expect((await countIt(auth, { countedOn: '2099-01-01' })).json()).toEqual({
      outcome: 'not_yet',
    });
    expect((await countIt(auth, { countedOn: 'today' })).statusCode).toBe(400);
  });

  /**
   * The refusal that keeps the instrument honest. Goods on the shelf with no
   * cost are missing from the count by an unknown amount, so posting it would
   * write off stock the business is still holding.
   */
  it('refuses while a product holds stock nobody has priced', async () => {
    const { auth, businessId } = await onboard('+2348177000044');
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'restocked the shop',
        amountK: 5_000_000,
        paidK: 5_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'p1',
      }),
    );
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

    expect((await countIt(auth, { countedOn: today() })).json()).toEqual({
      outcome: 'costs_missing',
      uncosted: 1,
    });

    const still = reportsStatementsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
    );
    expect(still.stockValuation).toMatchObject({ ledgerK: 5_000_000, uncosted: 1 });
    expect(still.profitAndLoss.costOfSalesK).toBe(0);
  });

  /**
   * A cost typed onto a product that was never delivered lets a sale credit
   * INVENTORY straight through zero, and the statements response has to
   * carry that. Pinned end to end because the failure mode is not a wrong
   * figure: an unsigned schema would reject the whole payload and take the
   * reports page down over the very books this exists to repair.
   */
  it('carries a stock account that has gone below zero', async () => {
    const { auth, businessId } = await onboard('+2348177000047');
    await withBusiness(db, businessId, (tx) =>
      issueRepo.writePosting(
        tx,
        businessId,
        postCostOfSale({ memo: 'Sold goods nobody bought', costK: 1_500_000 }),
        'invoice',
        'INV-1',
      ),
    );

    const seen = reportsStatementsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
    );
    expect(seen.stockValuation).toEqual({
      ledgerK: -1_500_000,
      countedK: 0,
      differenceK: 1_500_000,
      uncosted: 0,
    });

    expect((await countIt(auth, { countedOn: today() })).json()).toMatchObject({
      outcome: 'adjusted',
      differenceK: 1_500_000,
    });
  });

  it('is one tenant at a time', async () => {
    const ada = await onboard('+2348177000045');
    const bola = await onboard('+2348177000046');
    await withBusiness(db, ada.businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId: ada.businessId,
        description: 'restocked the shop',
        amountK: 5_000_000,
        paidK: 5_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'p1',
      }),
    );

    const theirs = reportsStatementsResponse.parse(
      (
        await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: bola.auth })
      ).json(),
    );
    expect(theirs.stockValuation).toEqual({
      ledgerK: 0,
      countedK: 0,
      differenceK: 0,
      uncosted: 0,
    });
  });
});
