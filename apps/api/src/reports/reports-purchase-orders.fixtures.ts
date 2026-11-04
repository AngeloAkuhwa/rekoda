/**
 * Shared helpers for the purchase-order suites
 * (reports-purchase-orders-*.integration.test.ts), split from reports.integration.test.ts: the
 * order under test, the books it should change, the receive call and the counts that prove a
 * receive wrote nothing. The Chat purchase helpers that advance a per-suite message counter
 * stay in each suite with that counter.
 */
import { randomUUID } from 'node:crypto';
import {
  createPurchaseOrderResponse,
  receivePurchaseOrderResponse,
  reportsExpensesResponse,
  reportsStatementsResponse,
} from '@rekoda/contracts';
import { stockRepo, withBusiness, sql, type Db } from '@rekoda/db';
import { app, db, post } from './reports.fixtures.js';
import { recordPurchaseWork } from '../commands/spend-commands.js';

export const PO = {
  items: [
    { name: 'Ankara bale', quantity: 10, unitPriceK: 500_000 },
    { name: 'Thread spools', quantity: 5, unitPriceK: 20_000 },
  ],
};

export const PO_TOTAL_K = 5_100_000;

/* G-61: receiving a PO funds the paid part from the account the merchant
 * chose, and a paid receive with no account is refused before anything. */
export async function openPo(auth: Record<string, string>) {
  const created = createPurchaseOrderResponse.parse(
    (await post('/v1/reports/purchase-orders', { ...PO, clientRef: randomUUID() }, auth)).json(),
  );
  if (created.outcome !== 'created') throw new Error('purchase order not created');
  return created.poNumber;
}

export async function books(auth: Record<string, string>) {
  const st = reportsStatementsResponse.parse(
    (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
  );
  const asset = (code: string) => st.balanceSheet.assets.find((l) => l.code === code)?.amountK ?? 0;
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

/**
 * The yes on a chat preview: the purchase work, exactly as chat runs it.
 */
export function chatYes(on: Db, businessId: string, draftId: string) {
  return withBusiness(on, businessId, (tx) =>
    recordPurchaseWork(tx, {
      businessId,
      description: '10 Ankara bales and 5 thread spools',
      amountK: PO_TOTAL_K,
      paidK: PO_TOTAL_K,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: draftId,
      supplierId: null,
      arrivals: [{ product: 'Ankara bale', quantity: 10, costK: PO_TOTAL_K }],
    }),
  );
}

export async function counts(businessId: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<Record<string, string>>(sql`
          SELECT
            (SELECT count(*) FROM expenses WHERE business_id = ${businessId}::uuid)::text AS expenses,
            (SELECT count(*) FROM ledger_transactions WHERE business_id = ${businessId}::uuid)::text AS postings,
            (SELECT count(*) FROM inventory_movements WHERE business_id = ${businessId}::uuid)::text AS movements,
            (SELECT count(*) FROM bills WHERE business_id = ${businessId}::uuid)::text AS bills`),
  );
  const row = [...rows][0]!;
  return {
    expenses: Number(row['expenses']),
    postings: Number(row['postings']),
    movements: Number(row['movements']),
    bills: Number(row['bills']),
  };
}

export async function poRow(businessId: string, poNumber: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ status: string; received_expense_id: string | null }>(sql`
          SELECT status, received_expense_id::text AS received_expense_id FROM orders
           WHERE business_id = ${businessId}::uuid AND order_number = ${poNumber}`),
  );
  return [...rows][0]!;
}

export const onHand = async (businessId: string, name: string) =>
  (await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId))).rows.find(
    (r) => r.name === name,
  )?.onHand ?? 0;

export async function receive(auth: Record<string, string>, body: Record<string, unknown>) {
  return receivePurchaseOrderResponse.parse(
    (await post('/v1/reports/purchase-orders/receive', body, auth)).json(),
  );
}
