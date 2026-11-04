/**
 * The year in a document number, at the turn of the year in Lagos.
 *
 * A document is numbered with the Lagos year of the instant it is issued (`lagosYear` in
 * @rekoda/core): Lagos is UTC+1 all year, so 23:00 UTC on 31 December is already the new year.
 * The pure rule is pinned in packages/core/src/reconciliation.test.ts and the order writer in
 * packages/db/src/stock/orders.integration.test.ts. This proves that the invoice, receipt,
 * credit-note and journal writers pass their issue instant through: one millisecond before the
 * boundary is the old year, the boundary itself is the new one, and the new year's counter starts
 * again at one. (The receipt for a verified payment, settle.ts, takes `bookedAt` the same way and
 * is not pinned here; quote, purchase order and bill take the clock and cannot be.)
 *
 * The instants are passed in. No clock is faked or moved: the database and the test process both
 * keep the real date, and the year comes only from the instant each writer was given.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, withBusiness, type Db } from '../client.js';
import { customersRepo, identity, issueRepo, journalRepo } from '../index.js';
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

async function seedBusiness(): Promise<string> {
  const user = await identity.upsertUserByPhone(db, '+2348100000901');
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
});
