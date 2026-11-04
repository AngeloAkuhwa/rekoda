/**
 * The year in a document number, at the turn of the year in Lagos.
 *
 * A document is numbered with the Lagos year of the instant it is issued (`lagosYear` in
 * @rekoda/core): Lagos is UTC+1 all year, so 23:00 UTC on 31 December is already the new year.
 * The pure rule is pinned in packages/core/src/reconciliation.test.ts and the order writer in
 * packages/db/src/stock/orders.integration.test.ts. This proves that the invoice, receipt,
 * credit-note, journal, quote, purchase-order and supplier-bill writers pass their issue instant
 * through: one millisecond before the boundary is the old year, the boundary itself is the new one,
 * and the new year's counter starts again at one. Quote, purchase order and bill also store that
 * one instant (`created_at`, and the bill's `billed_on` Lagos day). (The receipt for a verified
 * payment, settle.ts, takes `bookedAt` the same way and is not pinned here.)
 *
 * The instants are passed in. No clock is faked or moved: the database and the test process both
 * keep the real date, and the year comes only from the instant each writer was given.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, withBusiness, type Db } from '../client.js';
import { sql } from 'drizzle-orm';
import {
  customersRepo,
  identity,
  issueRepo,
  journalRepo,
  ordersRepo,
  spendRepo,
} from '../index.js';
import { migrate, requireUrls, truncateAll, type Urls } from '../testing.js';

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

// fixed date: the last millisecond of 2026 in Lagos, and the first millisecond of 2027.
const LAST_OF_2026 = new Date('2026-12-31T22:59:59.999Z');
const FIRST_OF_2027 = new Date('2026-12-31T23:00:00.000Z');

async function seedBusiness(phone = '+2348100000901'): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Year End Ltd',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

let seq = 0;
/** A sale to a named customer with part paid: an invoice, a receipt, and something to credit. */
async function saleAt(businessId: string, issuedAt: Date) {
  seq += 1;
  const customer = await customersRepo.createCustomerWithIdentities(
    db,
    businessId,
    `CUSTOMER_YE${seq}`,
    [],
  );
  return withBusiness(db, businessId, (tx) =>
    issueRepo.issueSale(tx, {
      businessId,
      customerId: customer.id,
      customerToken: `CUSTOMER_YE${seq}`,
      items: [{ name: 'wig', quantity: 1, unitPriceK: 5_000_000 }],
      subtotalK: 5_000_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 5_000_000,
      paidK: 2_000_000,
      balanceDueK: 3_000_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: `draft-ye-${seq}`,
      actor: 'system',
      issuedAt,
    }),
  );
}

const creditAt = (businessId: string, invoiceNumber: string, issuedAt: Date) =>
  withBusiness(db, businessId, (tx) =>
    issueRepo.issueCreditNote(tx, {
      businessId,
      invoiceNumber,
      amountK: 500_000,
      reason: 'returned',
      actor: 'user:ada',
      issuedAt,
    }),
  );

const journalAt = (businessId: string, occurredAt: Date) =>
  withBusiness(db, businessId, (tx) =>
    journalRepo.recordJournal(tx, {
      businessId,
      memo: "Took the day's takings to the bank",
      amountK: 1_000_000,
      intoAccount: 'BANK',
      outOfAccount: 'CASH',
      actor: 'user:1',
      occurredAt,
    }),
  );

const LINES = [
  { productId: null, name: 'wig', quantity: 1, unitPriceK: 5_000_000, lineTotalK: 5_000_000 },
];

const quoteAt = (businessId: string, issuedAt: Date) =>
  withBusiness(db, businessId, (tx) =>
    ordersRepo.createQuote(tx, {
      businessId,
      customerId: null,
      lines: LINES,
      totalK: 5_000_000,
      validUntil: null,
      clientRef: null,
      sourceId: 'user:1',
      issuedAt,
    }),
  );

const purchaseOrderAt = (businessId: string, issuedAt: Date) =>
  withBusiness(db, businessId, (tx) =>
    ordersRepo.createPurchaseOrder(tx, {
      businessId,
      lines: LINES,
      totalK: 5_000_000,
      expectedOn: null,
      clientRef: null,
      sourceId: 'user:1',
      issuedAt,
    }),
  );

/** A stock purchase with part left owed, so it raises a supplier bill. */
const purchaseAt = (businessId: string, recordedAt: Date) => {
  seq += 1;
  return withBusiness(db, businessId, (tx) =>
    spendRepo.recordPurchase(tx, {
      businessId,
      description: 'wigs from the market',
      amountK: 5_000_000,
      paidK: 2_000_000,
      method: 'cash',
      sourceType: 'chat',
      sourceId: `draft-ye-po-${seq}`,
      recordedAt,
    }),
  );
};

/** `{ documentNumber: createdAt ISO }` for a register's rows. */
function createdAtOf<K extends string>(
  rows: ({ createdAt: Date } & Record<K, string>)[],
  key: K,
): Record<string, string> {
  return Object.fromEntries(rows.map((r) => [r[key], r.createdAt.toISOString()]));
}

/** The stored timestamps of a purchase's bill, expense row and ledger posting. */
async function storedInstants(
  businessId: string,
  recorded: { expenseId: string; ledgerTransactionId: string; billNumber: string | null },
) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ bill: Date; expense: Date; posting: Date }>(sql`
      SELECT b.created_at AS bill, e.created_at AS expense, t.created_at AS posting
      FROM bills b
      JOIN expenses e ON e.business_id = b.business_id AND e.id = b.expense_id
      JOIN ledger_transactions t ON t.business_id = e.business_id AND t.id = e.ledger_transaction_id
      WHERE b.business_id = ${businessId}::uuid
        AND b.bill_number = ${recorded.billNumber}
        AND e.id = ${recorded.expenseId}::uuid
        AND t.id = ${recorded.ledgerTransactionId}::uuid
    `),
  );
  const [row] = [...rows];
  if (!row) throw new Error('storedInstants: no bill, expense and posting for that purchase');
  return {
    bill: new Date(row.bill).toISOString(),
    expense: new Date(row.expense).toISOString(),
    posting: new Date(row.posting).toISOString(),
  };
}

describe('the document year at the turn of the year in Lagos', () => {
  it('numbers an invoice and its receipt by the Lagos year of the sale', async () => {
    const businessId = await seedBusiness();
    const before = await saleAt(businessId, LAST_OF_2026);
    const after = await saleAt(businessId, FIRST_OF_2027);

    // fixed date: both sales are issued at the injected instants above.
    expect(before.invoiceNumber).toBe('INV-2026-000001');
    expect(before.receiptNumber).toBe('RCT-2026-000001');
    // fixed date: a new year's counter starts again at one.
    expect(after.invoiceNumber).toBe('INV-2027-000001');
    expect(after.receiptNumber).toBe('RCT-2027-000001');
  });

  it('numbers a credit note by the Lagos year it is issued, not the year of its invoice', async () => {
    const businessId = await seedBusiness();
    const sale = await saleAt(businessId, LAST_OF_2026);

    const before = await creditAt(businessId, sale.invoiceNumber, LAST_OF_2026);
    const after = await creditAt(businessId, sale.invoiceNumber, FIRST_OF_2027);

    // fixed date: credit notes issued at the injected instants above.
    expect(before).toMatchObject({ outcome: 'credited', creditNoteNumber: 'CRN-2026-000001' });
    expect(after).toMatchObject({ outcome: 'credited', creditNoteNumber: 'CRN-2027-000001' });
  });

  it('numbers a journal by the Lagos year it is dated', async () => {
    const businessId = await seedBusiness();
    const before = await journalAt(businessId, LAST_OF_2026);
    const after = await journalAt(businessId, FIRST_OF_2027);

    // fixed date: journals dated at the injected instants above.
    expect(before.journalNumber).toBe('JNL-2026-000001');
    expect(after.journalNumber).toBe('JNL-2027-000001');
  });

  it('numbers a quote by the Lagos year it is issued, and stores that instant', async () => {
    const businessId = await seedBusiness();
    const before = await quoteAt(businessId, LAST_OF_2026);
    const after = await quoteAt(businessId, FIRST_OF_2027);
    const next = await quoteAt(businessId, FIRST_OF_2027);

    // fixed date: quotes issued at the injected instants above.
    expect(before.orderNumber).toBe('QUO-2026-000001');
    expect(after.orderNumber).toBe('QUO-2027-000001');
    expect(next.orderNumber).toBe('QUO-2027-000002');

    const register = await withBusiness(db, businessId, (tx) =>
      ordersRepo.quotesFor(tx, businessId),
    );
    expect(register.count).toBe(3);
    expect(createdAtOf(register.rows, 'quoteNumber')).toEqual({
      [before.orderNumber]: LAST_OF_2026.toISOString(),
      [after.orderNumber]: FIRST_OF_2027.toISOString(),
      [next.orderNumber]: FIRST_OF_2027.toISOString(),
    });

    // Another business at the same instant has its own counter and sees only its own quote.
    const other = await seedBusiness('+2348100000902');
    // fixed date: the other business's first quote at the injected instant.
    expect((await quoteAt(other, FIRST_OF_2027)).orderNumber).toBe('QUO-2027-000001');
    expect((await withBusiness(db, other, (tx) => ordersRepo.quotesFor(tx, other))).count).toBe(1);
  });

  it('numbers a purchase order by the Lagos year it is issued, and stores that instant', async () => {
    const businessId = await seedBusiness();
    const before = await purchaseOrderAt(businessId, LAST_OF_2026);
    const after = await purchaseOrderAt(businessId, FIRST_OF_2027);
    const next = await purchaseOrderAt(businessId, FIRST_OF_2027);

    // fixed date: purchase orders issued at the injected instants above.
    expect(before.orderNumber).toBe('PO-2026-000001');
    expect(after.orderNumber).toBe('PO-2027-000001');
    expect(next.orderNumber).toBe('PO-2027-000002');

    const register = await withBusiness(db, businessId, (tx) =>
      ordersRepo.purchaseOrdersFor(tx, businessId),
    );
    expect(register.count).toBe(3);
    expect(createdAtOf(register.rows, 'poNumber')).toEqual({
      [before.orderNumber]: LAST_OF_2026.toISOString(),
      [after.orderNumber]: FIRST_OF_2027.toISOString(),
      [next.orderNumber]: FIRST_OF_2027.toISOString(),
    });

    const other = await seedBusiness('+2348100000902');
    // fixed date: the other business's first purchase order at the injected instant.
    expect((await purchaseOrderAt(other, FIRST_OF_2027)).orderNumber).toBe('PO-2027-000001');
    expect(
      (await withBusiness(db, other, (tx) => ordersRepo.purchaseOrdersFor(tx, other))).count,
    ).toBe(1);
  });

  it('numbers a supplier bill by the Lagos year of the purchase, and dates it that Lagos day', async () => {
    const businessId = await seedBusiness();
    const before = await purchaseAt(businessId, LAST_OF_2026);
    const after = await purchaseAt(businessId, FIRST_OF_2027);
    const next = await purchaseAt(businessId, FIRST_OF_2027);

    // fixed date: bills raised by purchases recorded at the injected instants above.
    expect(before.billNumber).toBe('BILL-2026-000001');
    expect(after.billNumber).toBe('BILL-2027-000001');
    expect(next.billNumber).toBe('BILL-2027-000002');

    const bills = await withBusiness(db, businessId, (tx) => spendRepo.billsFor(tx, businessId));
    expect(Object.fromEntries(bills.map((b) => [b.billNumber, b.billedOn]))).toEqual({
      [before.billNumber!]: '2026-12-31',
      [after.billNumber!]: '2027-01-01',
      [next.billNumber!]: '2027-01-01',
    });
    // The bill, its expense row and its ledger posting all carry the one captured instant.
    for (const [recorded, at] of [
      [before, LAST_OF_2026],
      [after, FIRST_OF_2027],
      [next, FIRST_OF_2027],
    ] as const) {
      expect(await storedInstants(businessId, recorded)).toEqual({
        bill: at.toISOString(),
        expense: at.toISOString(),
        posting: at.toISOString(),
      });
    }

    const other = await seedBusiness('+2348100000902');
    // fixed date: the other business's first bill at the injected instant.
    expect((await purchaseAt(other, FIRST_OF_2027)).billNumber).toBe('BILL-2027-000001');
    expect(await withBusiness(db, other, (tx) => spendRepo.billsFor(tx, other))).toHaveLength(1);
  });
});
