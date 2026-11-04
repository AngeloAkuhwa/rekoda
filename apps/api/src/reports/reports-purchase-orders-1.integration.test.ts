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
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { usagePeriod } from '@rekoda/core';
import {
  cancelPurchaseOrderResponse,
  createPurchaseOrderResponse,
  receivePurchaseOrderResponse,
  reportsExpensesResponse,
  reportsInvoicesResponse,
  reportsStatementsResponse,
} from '@rekoda/contracts';
import { usageRepo, issueRepo, stockRepo, withBusiness } from '@rekoda/db';
import { app, db, onboard, post, useReportsHarness } from './reports.fixtures.js';

useReportsHarness();

describe('purchase orders, and what receiving one does', () => {
  const PO = {
    items: [
      { name: 'Ankara bale', quantity: 10, unitPriceK: 500_000 },
      { name: 'Thread spools', quantity: 5, unitPriceK: 20_000 },
    ],
  };

  const PO_TOTAL_K = 5_100_000;

  it('creates a request that posts nothing, and lists it apart from everything', async () => {
    const { auth } = await onboard('+2348177000220');
    const created = createPurchaseOrderResponse.parse(
      (await post('/v1/reports/purchase-orders', { ...PO, clientRef: randomUUID() }, auth)).json(),
    );
    expect(created).toMatchObject({ outcome: 'created', totalK: PO_TOTAL_K, expectedOn: null });
    if (created.outcome !== 'created') return;
    expect(created.poNumber).toMatch(/^PO-\d{4}-000001$/);

    const spend = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
    );
    expect(spend.purchaseOrders).toHaveLength(1);
    expect(spend.purchaseOrders[0]).toMatchObject({ status: 'open', totalK: PO_TOTAL_K });
    /* A request for goods is not the goods: no spend row, nothing owed. */
    expect(spend.entries).toEqual([]);
    expect(spend.payableK).toBe(0);

    /* And it is not a customer's order or offer: those registers stay empty. */
    const register = reportsInvoicesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/invoices', headers: auth })).json(),
    );
    expect(register.orders).toEqual([]);
    expect(register.quotes).toEqual([]);
  });

  /* G-61: receiving a PO funds the paid part from the account the merchant
   * chose, and a paid receive with no account is refused before anything. */
  // Kept identical to the copy in reports-purchase-orders-2.integration.test.ts,
  // reports-purchase-orders-3.integration.test.ts. It belongs to this describe block's own
  // setup, which each part keeps as it was. Change them together.
  async function openPo(auth: Record<string, string>) {
    const created = createPurchaseOrderResponse.parse(
      (await post('/v1/reports/purchase-orders', { ...PO, clientRef: randomUUID() }, auth)).json(),
    );
    if (created.outcome !== 'created') throw new Error('purchase order not created');
    return created.poNumber;
  }

  // Kept identical to the copy in reports-purchase-orders-2.integration.test.ts,
  // reports-purchase-orders-3.integration.test.ts. It belongs to this describe block's own
  // setup, which each part keeps as it was. Change them together.
  async function books(auth: Record<string, string>) {
    const st = reportsStatementsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
    );
    const asset = (code: string) =>
      st.balanceSheet.assets.find((l) => l.code === code)?.amountK ?? 0;
    const liability = (code: string) =>
      st.balanceSheet.liabilities.find((l) => l.code === code)?.amountK ?? 0;
    const spend = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
    );
    return {
      cash: asset('1000'),
      bank: asset('1020'),
      payable: spend.payableK,
      cashOutK: st.cashflow.outK,
      balanced: st.balanceSheet.balanced,
      method: spend.entries[0]?.method ?? null,
      entries: spend.entries.length,
      ap: liability('2000'),
    };
  }

  for (const c of [
    {
      phone: '+2348177000391',
      name: 'fully paid by transfer',
      paidK: PO_TOTAL_K,
      method: 'transfer',
      bank: -PO_TOTAL_K,
      cash: 0,
    },
    {
      phone: '+2348177000392',
      name: 'fully paid by cash',
      paidK: PO_TOTAL_K,
      method: 'cash',
      bank: 0,
      cash: -PO_TOTAL_K,
    },
    {
      phone: '+2348177000393',
      name: 'part paid by transfer',
      paidK: 2_000_000,
      method: 'transfer',
      bank: -2_000_000,
      cash: 0,
    },
    {
      phone: '+2348177000394',
      name: 'wholly on credit',
      paidK: 0,
      method: undefined,
      bank: 0,
      cash: 0,
    },
  ] as const) {
    it(`G-61: a PO received ${c.name} funds only the paid part, from that account`, async () => {
      const { auth } = await onboard(c.phone);
      const poNumber = await openPo(auth);
      const received = receivePurchaseOrderResponse.parse(
        (
          await post(
            '/v1/reports/purchase-orders/receive',
            { poNumber, paidK: c.paidK, ...(c.method ? { method: c.method } : {}) },
            auth,
          )
        ).json(),
      );
      expect(received).toMatchObject({ outcome: 'received', owedK: PO_TOTAL_K - c.paidK });

      const b = await books(auth);
      /* A transfer never touches Cash, and cash never touches Bank. */
      expect(b.bank).toBe(c.bank);
      expect(b.cash).toBe(c.cash);
      expect(b.payable).toBe(PO_TOTAL_K - c.paidK);
      expect(b.cashOutK).toBe(c.paidK);
      expect(b.balanced).toBe(true);
      expect(b.method).toBe(c.paidK > 0 ? c.method : 'credit');
    });
  }

  it('G-61: a paid receive with no account is refused, and the order stays open', async () => {
    const { auth } = await onboard('+2348177000399');
    const poNumber = await openPo(auth);
    const refused = await post(
      '/v1/reports/purchase-orders/receive',
      { poNumber, paidK: 2_000_000 },
      auth,
    );
    expect(refused.statusCode).toBe(400);
    const b = await books(auth);
    expect(b.entries).toBe(0);
    expect(b.payable).toBe(0);
    const spend = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
    );
    expect(spend.purchaseOrders[0]).toMatchObject({ poNumber, status: 'open' });

    /* The same order received properly afterwards goes through once. */
    const received = receivePurchaseOrderResponse.parse(
      (
        await post(
          '/v1/reports/purchase-orders/receive',
          { poNumber, paidK: 2_000_000, method: 'transfer' },
          auth,
        )
      ).json(),
    );
    expect(received.outcome).toBe('received');
  });

  it('G-61: a repeated and a simultaneous receive make one purchase and one arrival', async () => {
    const { auth, businessId } = await onboard('+2348177000398');
    const poNumber = await openPo(auth);
    const body = { poNumber, paidK: 2_000_000, method: 'transfer' };
    const raced = await Promise.all([
      post('/v1/reports/purchase-orders/receive', body, auth),
      post('/v1/reports/purchase-orders/receive', body, auth),
    ]);
    const outcomes = raced.map((r) => receivePurchaseOrderResponse.parse(r.json()).outcome).sort();
    expect(outcomes).toEqual(['already_received', 'received']);
    const again = receivePurchaseOrderResponse.parse(
      (await post('/v1/reports/purchase-orders/receive', body, auth)).json(),
    );
    expect(again.outcome).toBe('already_received');

    const b = await books(auth);
    expect(b.entries).toBe(1);
    expect(b.bank).toBe(-2_000_000);
    expect(b.payable).toBe(PO_TOTAL_K - 2_000_000);
    const stock = await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId));
    expect(stock.rows.find((r) => r.name === 'Ankara bale')?.onHand).toBe(10);
  });

  it('a resubmitted purchase order form creates once', async () => {
    const { auth } = await onboard('+2348177000221');
    const clientRef = randomUUID();
    const first = createPurchaseOrderResponse.parse(
      (await post('/v1/reports/purchase-orders', { ...PO, clientRef }, auth)).json(),
    );
    expect(first.outcome).toBe('created');
    const second = createPurchaseOrderResponse.parse(
      (await post('/v1/reports/purchase-orders', { ...PO, clientRef }, auth)).json(),
    );
    expect(second).toEqual({ outcome: 'duplicate' });
  });

  it('receiving posts the purchase, counts the stock and owes the rest', async () => {
    const { auth, businessId } = await onboard('+2348177000222');
    const created = createPurchaseOrderResponse.parse(
      (await post('/v1/reports/purchase-orders', { ...PO, expectedOn: '2026-09-15' }, auth)).json(),
    );
    if (created.outcome !== 'created') throw new Error('purchase order not created');
    expect(created.expectedOn).toBe('2026-09-15');

    const received = receivePurchaseOrderResponse.parse(
      (
        await post(
          '/v1/reports/purchase-orders/receive',
          { poNumber: created.poNumber, paidK: 2_000_000, method: 'cash' },
          auth,
        )
      ).json(),
    );
    expect(received).toEqual({
      outcome: 'received',
      poNumber: created.poNumber,
      totalK: PO_TOTAL_K,
      owedK: 3_100_000,
      linesArrived: 2,
    });

    const spend = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
    );
    expect(spend.entries[0]).toMatchObject({
      kind: 'purchase',
      amountK: PO_TOTAL_K,
      sourceType: 'purchase_order',
      description: `Purchase order ${created.poNumber}`,
    });
    expect(spend.purchasesK).toBe(PO_TOTAL_K);
    expect(spend.payableK).toBe(3_100_000);
    /* The debt is attributed: the pay-a-supplier picker can settle it. */
    expect(spend.outstanding).toHaveLength(1);
    expect(spend.outstanding[0]).toMatchObject({ owedK: 3_100_000, amountK: PO_TOTAL_K });
    expect(spend.purchaseOrders[0]).toMatchObject({ status: 'received' });

    /* Every line is on the shelf, at its line cost. */
    const stock = await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId));
    expect(stock.rows.find((p) => p.name === 'Ankara bale')).toMatchObject({
      onHand: 10,
      unitCostK: 500_000,
    });
    expect(stock.rows.find((p) => p.name === 'Thread spools')).toMatchObject({
      onHand: 5,
      unitCostK: 20_000,
    });

    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    const debits = entries.reduce((n, e) => n + e.debitK, 0);
    expect(debits).toBe(entries.reduce((n, e) => n + e.creditK, 0));

    /* No customer document was issued, so no document unit was spent. */
    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
  });

  it('a second receive books nothing twice', async () => {
    const { auth, businessId } = await onboard('+2348177000223');
    const created = createPurchaseOrderResponse.parse(
      (await post('/v1/reports/purchase-orders', PO, auth)).json(),
    );
    if (created.outcome !== 'created') throw new Error('purchase order not created');
    const first = receivePurchaseOrderResponse.parse(
      (
        await post(
          '/v1/reports/purchase-orders/receive',
          { poNumber: created.poNumber, paidK: 0 },
          auth,
        )
      ).json(),
    );
    expect(first.outcome).toBe('received');

    const second = receivePurchaseOrderResponse.parse(
      (
        await post(
          '/v1/reports/purchase-orders/receive',
          { poNumber: created.poNumber, paidK: 0 },
          auth,
        )
      ).json(),
    );
    expect(second).toEqual({ outcome: 'already_received' });

    const spend = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
    );
    expect(spend.entries).toHaveLength(1);
    expect(spend.purchasesK).toBe(PO_TOTAL_K);
    const stock = await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId));
    expect(stock.rows.find((p) => p.name === 'Ankara bale')?.onHand).toBe(10);
  });

  it('refuses what the status machine or the arithmetic forbids', async () => {
    const { auth } = await onboard('+2348177000224');
    expect(
      receivePurchaseOrderResponse.parse(
        (
          await post(
            '/v1/reports/purchase-orders/receive',
            { poNumber: 'PO-2026-000099', paidK: 0 },
            auth,
          )
        ).json(),
      ),
    ).toEqual({ outcome: 'not_found' });

    const created = createPurchaseOrderResponse.parse(
      (await post('/v1/reports/purchase-orders', PO, auth)).json(),
    );
    if (created.outcome !== 'created') throw new Error('purchase order not created');

    /* Paying more than the order costs is a prepayment, and this is not that. */
    expect(
      receivePurchaseOrderResponse.parse(
        (
          await post(
            '/v1/reports/purchase-orders/receive',
            { poNumber: created.poNumber, paidK: PO_TOTAL_K + 1, method: 'cash' },
            auth,
          )
        ).json(),
      ),
    ).toEqual({ outcome: 'more_than_total', totalK: PO_TOTAL_K });

    expect(
      cancelPurchaseOrderResponse.parse(
        (
          await post('/v1/reports/purchase-orders/cancel', { poNumber: created.poNumber }, auth)
        ).json(),
      ),
    ).toEqual({ outcome: 'cancelled' });

    /* Cancelled means the goods never land and the books never move. */
    expect(
      receivePurchaseOrderResponse.parse(
        (
          await post(
            '/v1/reports/purchase-orders/receive',
            { poNumber: created.poNumber, paidK: 0 },
            auth,
          )
        ).json(),
      ),
    ).toEqual({ outcome: 'cancelled' });
    expect(
      cancelPurchaseOrderResponse.parse(
        (
          await post('/v1/reports/purchase-orders/cancel', { poNumber: created.poNumber }, auth)
        ).json(),
      ),
    ).toEqual({ outcome: 'already', status: 'cancelled' });

    const spend = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
    );
    expect(spend.entries).toEqual([]);
    expect(spend.payableK).toBe(0);
  });
});
