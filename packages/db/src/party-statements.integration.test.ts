/**
 * Customer and supplier statements (D1, PR-096), against real PostgreSQL:
 * dated entries with a running balance, derived from the document tables
 * the kernel keeps honest, tying to the balances page by construction —
 * a customer's closing balance IS the sum of their open invoice balances,
 * and a supplier's IS the sum of their open bill balances.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  customersRepo,
  identity,
  issueRepo,
  partyStatementsRepo,
  settleRepo,
  spendRepo,
  sql,
  suppliersRepo,
  withBusiness,
  type Db,
} from './index.js';
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
  const user = await identity.upsertUserByPhone(db, `+23481900${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function seedCustomer(businessId: string): Promise<string> {
  const customer = await customersRepo.createCustomerWithIdentities(db, businessId, 'CHI91', []);
  return customer.id;
}

async function invoiceFor(
  businessId: string,
  customerId: string,
  totalK: number,
): Promise<{ invoiceId: string; invoiceNumber: string }> {
  return withBusiness(db, businessId, (tx) =>
    issueRepo.issueSale(tx, {
      businessId,
      customerId,
      customerToken: 'CHI91',
      items: [{ name: 'wig', quantity: 1, unitPriceK: totalK }],
      subtotalK: totalK,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK,
      paidK: 0,
      balanceDueK: totalK,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: `draft-${totalK}`,
      actor: 'owner',
    }),
  );
}

const openInvoiceTotal = (businessId: string, customerId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx
      .execute<{
        k: string;
      }>(
        sql`SELECT COALESCE(SUM(balance_due_k), 0)::bigint AS k FROM invoices
            WHERE business_id = ${businessId}::uuid AND customer_id = ${customerId}::uuid
              AND status <> 'voided'`,
      )
      .then((rows) => Number([...rows][0]!.k)),
  );

describe('the customer statement', () => {
  it('tells the story in order, and its closing balance IS the balances page', async () => {
    const businessId = await seedBusiness();
    const customerId = await seedCustomer(businessId);

    const first = await invoiceFor(businessId, customerId, 10_000_000);
    await invoiceFor(businessId, customerId, 5_000_000);
    await withBusiness(db, businessId, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId,
        invoiceId: first.invoiceId,
        amountK: 6_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'pay-1',
        actor: 'owner',
      }),
    );

    const statement = await withBusiness(db, businessId, (tx) =>
      partyStatementsRepo.customerStatementFor(tx, businessId, customerId),
    );

    expect(statement.openingK).toBe(0);
    expect(statement.entries.map((e) => [e.kind, e.amountK, e.balanceK])).toEqual([
      ['invoice', 10_000_000, 10_000_000],
      ['invoice', 5_000_000, 15_000_000],
      ['payment', -6_000_000, 9_000_000],
    ]);
    expect(statement.entries[0]!.reference).toBe(first.invoiceNumber);

    /* THE TIE: the statement and the balances page are one answer. */
    expect(statement.closingK).toBe(await openInvoiceTotal(businessId, customerId));
  });

  it('a window carries everything before it as the opening balance', async () => {
    const businessId = await seedBusiness();
    const customerId = await seedCustomer(businessId);
    await invoiceFor(businessId, customerId, 10_000_000);

    /* Tomorrow in LAGOS, which is the day the statement itself is cut in
     * (`created_at + interval '1 hour'`). Computing it in UTC made this
     * test fail for the hour before UTC midnight every day: the invoice
     * booked a moment ago is already on the next Lagos day, so a UTC
     * "tomorrow" was the same day and carried nothing forward. */
    const tomorrow = new Date(Date.now() + 3_600_000 + 86_400_000).toISOString().slice(0, 10);
    const statement = await withBusiness(db, businessId, (tx) =>
      partyStatementsRepo.customerStatementFor(tx, businessId, customerId, { from: tomorrow }),
    );
    expect(statement.openingK).toBe(10_000_000);
    expect(statement.entries).toHaveLength(0);
    expect(statement.closingK).toBe(10_000_000);
  });

  it('another business`s customer shows an empty account, never a neighbour`s figures', async () => {
    const businessId = await seedBusiness();
    const other = await seedBusiness();
    const customerId = await seedCustomer(businessId);
    await invoiceFor(businessId, customerId, 10_000_000);

    const statement = await withBusiness(db, other, (tx) =>
      partyStatementsRepo.customerStatementFor(tx, other, customerId),
    );
    expect(statement.entries).toHaveLength(0);
    expect(statement.closingK).toBe(0);
  });
});

describe('the supplier statement', () => {
  it('bills raise the balance, payments settle it, and the closing ties to open bills', async () => {
    const businessId = await seedBusiness();
    const { supplierId } = await withBusiness(db, businessId, (tx) =>
      suppliersRepo.findOrCreateSupplier(tx, businessId, {
        nameCipher: 'cipher-mama-nkechi',
        matchKey: 'mk-mama-nkechi',
      }),
    );

    const purchase = await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: '10 bales of ankara',
        amountK: 20_000_000,
        paidK: 5_000_000,
        sourceType: 'chat',
        sourceId: 'purchase-1',
        supplierId,
      }),
    );
    expect(purchase.billNumber).not.toBeNull();

    await withBusiness(db, businessId, (tx) =>
      spendRepo.paySupplier(tx, {
        businessId,
        expenseId: purchase.expenseId,
        amountK: 4_000_000,
        method: 'transfer',
        actor: 'owner',
      }),
    );

    const statement = await withBusiness(db, businessId, (tx) =>
      partyStatementsRepo.supplierStatementFor(tx, businessId, supplierId),
    );

    /* The bill is the CREDIT portion only: ₦150,000 owed, not the whole
     * ₦200,000 purchase — a part-cash purchase bills what is owed. */
    expect(statement.entries.map((e) => [e.kind, e.amountK, e.balanceK])).toEqual([
      ['bill', 15_000_000, 15_000_000],
      ['supplier_payment', -4_000_000, 11_000_000],
    ]);

    const openBills = await withBusiness(db, businessId, (tx) =>
      tx
        .execute<{
          k: string;
        }>(
          sql`SELECT COALESCE(SUM(balance_due_k), 0)::bigint AS k FROM bills
              WHERE business_id = ${businessId}::uuid AND supplier_id = ${supplierId}::uuid
                AND status <> 'voided'`,
        )
        .then((rows) => Number([...rows][0]!.k)),
    );
    expect(statement.closingK).toBe(openBills);
  });
});
