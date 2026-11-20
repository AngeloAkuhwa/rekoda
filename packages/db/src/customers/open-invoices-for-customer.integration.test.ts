/**
 * What one customer still owes (`issueRepo.openInvoicesForCustomer`), the figure a
 * balance question answers from (G-135, owner directive on #437, 20 Nov 2026).
 *
 * The reply lists at most 20 invoices, but the total and the count are every open
 * invoice of theirs; a partly paid or partly credited invoice counts at what is
 * still due; a paid or voided one does not count; another customer's or another
 * business's never does; the listed order is stable when two invoices share a
 * timestamp; and a total past the safe-integer range is refused, never rounded.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  customersRepo,
  identity,
  issueRepo,
  settleRepo,
  sql,
  withBusiness,
  type Db,
} from '../index.js';
import { migrate, ownerDb, requireUrls, truncateAll, type Urls } from '../testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));
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
  const user = await identity.upsertUserByPhone(db, `+23481851${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function seedCustomer(businessId: string, label: string) {
  return customersRepo.createCustomerWithIdentities(db, businessId, `CUSTOMER_${label}`, []);
}

async function invoice(
  businessId: string,
  customer: { id: string; token: string },
  totalK: number,
): Promise<string> {
  seq += 1;
  const sale = await withBusiness(db, businessId, (tx) =>
    issueRepo.issueSale(tx, {
      businessId,
      customerId: customer.id,
      customerToken: customer.token,
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
      sourceId: `draft-oi-${seq}`,
      saleSource: null,
      dueDate: null,
      actor: 'system',
    }),
  );
  return sale.invoiceNumber;
}

const owed = (businessId: string, token: string) =>
  withBusiness(db, businessId, (tx) => issueRepo.openInvoicesForCustomer(tx, businessId, token));

describe('what one customer still owes', () => {
  /**
   * A credit note on a part-paid invoice leaves the invoice's balance as it was
   * (spec §14.1: an unapplied credit reduces no invoice; it is owed to the
   * customer until applied), so the balance counts it at what the invoice still
   * says is due.
   */
  it('counts a partly paid or credited invoice at what it still says is due, and no paid or voided one', async () => {
    const businessId = await seedBusiness();
    const ada = await seedCustomer(businessId, 'ADA1');
    const unpaid = await invoice(businessId, ada, 100_000);
    const partPaid = await invoice(businessId, ada, 100_000);
    const paid = await invoice(businessId, ada, 100_000);
    const voided = await invoice(businessId, ada, 100_000);
    const credited = await invoice(businessId, ada, 100_000);

    await withBusiness(db, businessId, async (tx) => {
      expect(
        (
          await settleRepo.recordPaymentByNumber(tx, {
            businessId,
            invoiceNumber: partPaid,
            amountK: 30_000,
            method: 'cash',
            actor: 'system',
          })
        ).outcome,
      ).toBe('recorded');
      expect(
        (
          await settleRepo.recordPaymentByNumber(tx, {
            businessId,
            invoiceNumber: paid,
            amountK: 100_000,
            method: 'cash',
            actor: 'system',
          })
        ).outcome,
      ).toBe('recorded');
      expect(
        (await issueRepo.voidInvoice(tx, businessId, voided, 'entered twice', 'system')).outcome,
      ).toBe('voided');
      expect(
        (
          await settleRepo.recordPaymentByNumber(tx, {
            businessId,
            invoiceNumber: credited,
            amountK: 40_000,
            method: 'cash',
            actor: 'system',
          })
        ).outcome,
      ).toBe('recorded');
      expect(
        (
          await issueRepo.issueCreditNote(tx, {
            businessId,
            invoiceNumber: credited,
            amountK: 20_000,
            reason: 'one returned',
            actor: 'system',
          })
        ).outcome,
      ).toBe('credited');
    });

    const result = await owed(businessId, ada.token);
    expect(result.count).toBe(3);
    expect(result.totalK).toBe(100_000 + 70_000 + 60_000);
    expect(result.rows.map((r) => [r.invoiceNumber, r.balanceDueK])).toEqual([
      [unpaid, 100_000],
      [partPaid, 70_000],
      [credited, 60_000],
    ]);
  });

  it("never counts another customer's or another business's invoice", async () => {
    const businessId = await seedBusiness();
    const other = await seedBusiness();
    const ada = await seedCustomer(businessId, 'ADA2');
    const bola = await seedCustomer(businessId, 'BOLA2');
    const elsewhere = await seedCustomer(other, 'ADA2X');
    await invoice(businessId, ada, 100_000);
    await invoice(businessId, bola, 500_000);
    await invoice(other, elsewhere, 900_000);

    expect(await owed(businessId, ada.token)).toMatchObject({ count: 1, totalK: 100_000 });
    /* Another business's customer token, asked about here, names nobody here. */
    expect(await owed(businessId, elsewhere.token)).toEqual({ rows: [], totalK: 0, count: 0 });
  });

  it('lists invoices that share a timestamp in one stable order, by number', async () => {
    const businessId = await seedBusiness();
    const ada = await seedCustomer(businessId, 'ADA3');
    const numbers: string[] = [];
    for (let n = 0; n < 5; n += 1) numbers.push(await invoice(businessId, ada, 10_000 * (n + 1)));
    /* One instant for all five, and physical order scrambled, so only the
     * query's own ORDER BY can decide the listing. */
    const owner = ownerDb();
    await owner.execute(sql`
      UPDATE invoices SET created_at = '2026-11-20T10:00:00Z'
      WHERE business_id = ${businessId}::uuid
    `);
    /* Each row moved to a new physical position, in this order: a change to an
     * indexed column is never a HOT update, so a scan meets them as 4, 0, 3, 1, 2. */
    for (const n of [4, 0, 3, 1, 2]) {
      for (const step of [sql`invoice_number || '~'`, sql`rtrim(invoice_number, '~')`]) {
        await owner.execute(sql`
          UPDATE invoices SET invoice_number = ${step}
          WHERE business_id = ${businessId}::uuid AND rtrim(invoice_number, '~') = ${numbers[n]!}
        `);
      }
    }

    const first = await owed(businessId, ada.token);
    expect(first.rows.map((r) => r.invoiceNumber)).toEqual([...numbers].sort());
    const again = await owed(businessId, ada.token);
    expect(again.rows.map((r) => r.invoiceNumber)).toEqual(first.rows.map((r) => r.invoiceNumber));
  });

  it('refuses a total past the safe-integer range rather than rounding kobo away', async () => {
    const businessId = await seedBusiness();
    const ada = await seedCustomer(businessId, 'ADA4');
    await invoice(businessId, ada, 100_000);
    await invoice(businessId, ada, 100_000);
    /* Each balance is a safe integer; their sum (2^53 + 3) is not, and as a
     * JavaScript number would silently read as 2^53 + 4. */
    const owner = ownerDb();
    await owner.execute(sql`
      UPDATE invoices SET balance_due_k = 4503599627370497 + (row_number - 1)
      FROM (SELECT id, row_number() OVER (ORDER BY invoice_number) AS row_number
            FROM invoices WHERE business_id = ${businessId}::uuid) n
      WHERE invoices.id = n.id
    `);

    await expect(owed(businessId, ada.token)).rejects.toThrow(/integer kobo/);
  });
});
