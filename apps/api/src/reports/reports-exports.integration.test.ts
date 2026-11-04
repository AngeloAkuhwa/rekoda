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
import {
  customersRepo,
  issueRepo,
  settleRepo,
  spendRepo,
  suppliersRepo,
  withBusiness,
} from '@rekoda/db';
import { app, db, onboard, useReportsHarness } from './reports.fixtures.js';

useReportsHarness();

/**
 * The export a merchant takes with them.
 *
 * Two things are being asserted: that the file is complete and openable, and
 * that it is SHUT — a whole business's books behind a session, never cached,
 * and never another tenant's.
 */
describe('exporting the books as CSV', () => {
  const EMPTY_INVOICES = 'Invoice,Issued,Due,Status,Days late,Total,Paid,Credited,Balance\r\n';

  const download = (path: string, auth: Record<string, string>) =>
    app.inject({ method: 'GET', url: path, headers: auth });

  /** One ₦150,000 invoice with ₦60,000 recorded against it, and its receipt. */
  async function seedOneOfEach(businessId: string) {
    await withBusiness(db, businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_7K2',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 15_000_000 }],
        subtotalK: 15_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 15_000_000,
        paidK: 0,
        balanceDueK: 15_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-export',
        actor: 'system',
      });
      await settleRepo.recordMerchantPayment(tx, {
        businessId,
        invoiceId: sale.invoiceId,
        amountK: 6_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'pay-export',
        actor: 'system',
      });
    });
  }

  it('refuses without a session, like every other report', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/reports/invoices.csv' })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ method: 'GET', url: '/v1/reports/receipts.csv' })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ method: 'GET', url: '/v1/reports/expenses.csv' })).statusCode).toBe(
      401,
    );
  });

  it('hands over a file a browser saves, never one a cache keeps', async () => {
    const { auth } = await onboard('+2348120000021');
    const res = await download('/v1/reports/invoices.csv', auth);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('rekoda-invoices-');
    /* A merchant's whole book in a shared cache is a cross-tenant leak with
     * a friendly name. */
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('writes a header row even when there is nothing to export', async () => {
    const { auth } = await onboard('+2348120000022');
    expect((await download('/v1/reports/invoices.csv', auth)).body).toBe(EMPTY_INVOICES);
  });

  /**
   * Never `formatKobo`. `₦150,000` is four things a spreadsheet reads as
   * text, and an export whose money column will not add up is an export
   * nobody can do anything with.
   */
  it('exports money as a decimal a spreadsheet will sum, not as naira text', async () => {
    const { auth, businessId } = await onboard('+2348120000023');
    await seedOneOfEach(businessId);

    const body = (await download('/v1/reports/invoices.csv', auth)).body;
    expect(body).toContain('150000.00');
    expect(body).not.toContain('₦');
    expect(body).not.toContain('150,000');
  });

  it('marks each receipt with the basis it was issued on (ADR 0014)', async () => {
    const { auth, businessId } = await onboard('+2348120000024');
    await seedOneOfEach(businessId);

    const body = (await download('/v1/reports/receipts.csv', auth)).body;
    expect(body).toContain('Receipt,Date,Invoice,Amount,Basis');
    expect(body).toMatch(/verified|recorded/);
  });

  it('names the spend export and labels stock apart from cost', async () => {
    const { auth, businessId } = await onboard('+2348120000027');
    await withBusiness(db, businessId, async (tx) => {
      await spendRepo.recordExpense(tx, {
        businessId,
        description: 'diesel',
        category: 'utilities',
        amountK: 800_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'csv-1',
      });
      await spendRepo.recordPurchase(tx, {
        businessId,
        description: 'ankara bales',
        amountK: 5_000_000,
        paidK: 5_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'csv-2',
      });
    });

    const res = await download('/v1/reports/expenses.csv', auth);
    expect(res.headers['content-disposition']).toContain('rekoda-expenses-');
    expect(res.body).toContain('Date,Type,Description,Category,Method,Source,Status,Amount');
    /* Without this column a spreadsheet totals 58,000 of cost against a shop
     * that spent 8,000 and still holds 50,000 of stock. */
    expect(res.body).toContain('Stock purchase,ankara bales,Stock,cash,chat,recorded,50000.00');
    /* "Power and fuel", not "utilities": the export names a category the way
     * the statements do, so an accountant pivoting one against the other is
     * matching the same words. */
    expect(res.body).toContain('Expense,diesel,Power and fuel,cash,chat,recorded,8000.00');
    expect(res.body).toContain('8000.00');
    expect(res.body).not.toContain('₦');
  });

  it('exports only the signed-in business books', async () => {
    const mine = await onboard('+2348120000025');
    const theirs = await onboard('+2348120000026');
    await seedOneOfEach(theirs.businessId);

    // Their register exists; none of it may appear in my file.
    expect((await download('/v1/reports/invoices.csv', mine.auth)).body).toBe(EMPTY_INVOICES);
  });
});

describe('customer and supplier statements (D1, PR-096)', () => {
  it('serves a customer statement whose closing balance is the balances page', async () => {
    const ada = await onboard('+2348055500061');
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      ada.businessId,
      'CHI96',
      [],
    );
    const sale = await withBusiness(db, ada.businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId: ada.businessId,
        customerId: customer.id,
        customerToken: 'CHI96',
        items: [{ name: 'gown', quantity: 1, unitPriceK: 8_000_000 }],
        subtotalK: 8_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 8_000_000,
        paidK: 0,
        balanceDueK: 8_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-st',
        actor: 'owner',
      }),
    );
    await withBusiness(db, ada.businessId, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId: ada.businessId,
        invoiceId: sale.invoiceId,
        amountK: 3_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'pay-st',
        actor: 'owner',
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/reports/customers/${customer.id}/statement`,
      headers: ada.auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      openingK: number;
      closingK: number;
      entries: Array<{ kind: string; amountK: number; balanceK: number; reference: string }>;
    };
    expect(body.entries.map((e) => [e.kind, e.amountK, e.balanceK])).toEqual([
      ['invoice', 8_000_000, 8_000_000],
      ['payment', -3_000_000, 5_000_000],
    ]);
    expect(body.closingK).toBe(5_000_000);
    /* Numbers and figures only: no customer name crosses this wire. */
    expect(JSON.stringify(body)).not.toContain('Chidi');
  });

  it('serves a supplier statement over bills and payments, and refuses no member', async () => {
    const ada = await onboard('+2348055500062');
    const { supplierId } = await withBusiness(db, ada.businessId, (tx) =>
      suppliersRepo.findOrCreateSupplier(tx, ada.businessId, {
        nameCipher: 'cipher-mama',
        matchKey: 'mk-mama-96',
      }),
    );
    const purchase = await withBusiness(db, ada.businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId: ada.businessId,
        description: 'bales',
        amountK: 20_000_000,
        paidK: 5_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'purch-st',
        supplierId,
      }),
    );
    await withBusiness(db, ada.businessId, (tx) =>
      spendRepo.paySupplier(tx, {
        businessId: ada.businessId,
        expenseId: purchase.expenseId,
        amountK: 4_000_000,
        method: 'transfer',
        actor: 'owner',
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/reports/suppliers/${supplierId}/statement`,
      headers: ada.auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      closingK: number;
      entries: Array<{ kind: string; amountK: number }>;
    };
    expect(body.entries.map((e) => [e.kind, e.amountK])).toEqual([
      ['bill', 15_000_000],
      ['supplier_payment', -4_000_000],
    ]);
    expect(body.closingK).toBe(11_000_000);
  });
});

describe('exports on the kernel (D1, PR-098)', () => {
  it('a customer statement downloads as the same story the page tells, closing row included', async () => {
    const ada = await onboard('+2348055500063');
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      ada.businessId,
      'CHI98',
      [],
    );
    const sale = await withBusiness(db, ada.businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId: ada.businessId,
        customerId: customer.id,
        customerToken: 'CHI98',
        items: [{ name: 'gown', quantity: 1, unitPriceK: 8_000_000 }],
        subtotalK: 8_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 8_000_000,
        paidK: 0,
        balanceDueK: 8_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-x98',
        actor: 'owner',
      }),
    );
    await withBusiness(db, ada.businessId, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId: ada.businessId,
        invoiceId: sale.invoiceId,
        amountK: 3_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'pay-x98',
        actor: 'owner',
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/reports/customers/${customer.id}/statement.csv`,
      headers: ada.auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body.trim().split(/\r?\n/);
    expect(lines[0]).toBe('Date,Entry,Reference,Amount,Balance');
    expect(lines[1]).toContain('invoice');
    expect(lines[1]).toContain('80000.00');
    expect(lines[2]).toContain('payment');
    expect(lines[lines.length - 1]).toContain('Balance now');
    expect(lines[lines.length - 1]).toContain('50000.00');
    expect(res.body).not.toContain('Chidi');
  });

  it('a supplier statement downloads over bills and payments', async () => {
    const ada = await onboard('+2348055500064');
    const { supplierId } = await withBusiness(db, ada.businessId, (tx) =>
      suppliersRepo.findOrCreateSupplier(tx, ada.businessId, {
        nameCipher: 'cipher-mama-98',
        matchKey: 'mk-mama-98',
      }),
    );
    await withBusiness(db, ada.businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId: ada.businessId,
        description: 'bales',
        amountK: 20_000_000,
        paidK: 5_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'purch-x98',
        supplierId,
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/v1/reports/suppliers/${supplierId}/statement.csv`,
      headers: ada.auth,
    });
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split(/\r?\n/);
    expect(lines[1]).toContain('bill');
    expect(lines[1]).toContain('150000.00');
    expect(lines[lines.length - 1]).toContain('150000.00');
  });
});
