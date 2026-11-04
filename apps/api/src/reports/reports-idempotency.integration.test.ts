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
import {
  creditInvoiceResponse,
  reportsExpensesResponse,
  reportsInvoicesResponse,
  reportsStatementsResponse,
  journalEntryResponse,
  createRecurringResponse,
  paySupplierResponse,
  recordAssetResponse,
} from '@rekoda/contracts';
import { customersRepo, issueRepo, spendRepo, withBusiness } from '@rekoda/db';
import { app, db, onboard, post, useReportsHarness } from './reports.fixtures.js';

useReportsHarness();

/**
 * The one-shot keys on the owner writes (FIX-PLAN-2 B4).
 *
 * Every test here is the same story: the identical form reaches the API
 * twice — a dropped response, an impatient second press — and the second
 * arrival answers `duplicate` while the books hold exactly one of the thing.
 * Before these keys existed, each of these writes booked twice.
 */
describe('one-shot keys on the owner writes', () => {
  it('a resubmitted journal posts once', async () => {
    const { auth } = await onboard('+2348177000200');
    const body = {
      memo: "Took the day's takings to the bank",
      amountK: 500_000,
      intoAccount: 'BANK_PAYSTACK',
      outOfAccount: 'CASH',
      clientRef: randomUUID(),
    };

    const first = journalEntryResponse.parse(
      (await post('/v1/reports/journal', body, auth)).json(),
    );
    expect(first.outcome).toBe('recorded');
    const second = journalEntryResponse.parse(
      (await post('/v1/reports/journal', body, auth)).json(),
    );
    expect(second).toEqual({ outcome: 'duplicate' });

    /* The trial balance is where a double post would show: 500,000 into the
     * bank, not a million. */
    const statements = reportsStatementsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
    );
    const bank = statements.trialBalance.rows.find((row) => row.code === '1010');
    expect(bank?.debitK).toBe(500_000);
  });

  it('a resubmitted credit note credits once', async () => {
    const { auth, businessId } = await onboard('+2348177000201');
    const dupCustomer = await customersRepo.createCustomerWithIdentities(
      db,
      businessId,
      'CUSTOMER_DUP1',
      [],
    );
    const invoiceNumber = await withBusiness(db, businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: dupCustomer.id,
        customerToken: 'CUSTOMER_7K2',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 15_000_000 }],
        subtotalK: 15_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 15_000_000,
        paidK: 6_000_000,
        balanceDueK: 9_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-dup-credit',
        actor: 'system',
      });
      return sale.invoiceNumber;
    });

    const body = {
      invoiceNumber,
      amountK: 2_000_000,
      reason: 'goods returned',
      clientRef: randomUUID(),
    };
    const first = creditInvoiceResponse.parse(
      (await post('/v1/reports/invoices/credit', body, auth)).json(),
    );
    expect(first.outcome).toBe('credited');
    const second = creditInvoiceResponse.parse(
      (await post('/v1/reports/invoices/credit', body, auth)).json(),
    );
    expect(second).toEqual({ outcome: 'duplicate' });

    const register = reportsInvoicesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/invoices', headers: auth })).json(),
    );
    expect(register.invoices[0]).toMatchObject({ creditedK: 2_000_000 });
  });

  it('a resubmitted asset records once', async () => {
    const { auth } = await onboard('+2348177000202');
    const body = {
      description: 'Generator',
      costK: 45_000_000,
      paidK: 45_000_000,
      usefulLifeMonths: 60,
      method: 'transfer',
      clientRef: randomUUID(),
    };

    const first = recordAssetResponse.parse((await post('/v1/reports/assets', body, auth)).json());
    expect(first.outcome).toBe('recorded');
    const second = recordAssetResponse.parse((await post('/v1/reports/assets', body, auth)).json());
    expect(second).toEqual({ outcome: 'duplicate' });

    const spend = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
    );
    expect(spend.assets).toHaveLength(1);
  });

  it('a resubmitted supplier payment pays once', async () => {
    const { auth, businessId } = await onboard('+2348177000203');
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'ankara bales',
        amountK: 5_000_000,
        paidK: 2_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'dup-spend',
      }),
    );
    const before = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
    );
    const body = {
      expenseId: before.outstanding[0]!.expenseId,
      amountK: 1_000_000,
      method: 'transfer',
      clientRef: randomUUID(),
    };

    const first = paySupplierResponse.parse(
      (await post('/v1/reports/suppliers/pay', body, auth)).json(),
    );
    expect(first.outcome).toBe('paid');
    const second = paySupplierResponse.parse(
      (await post('/v1/reports/suppliers/pay', body, auth)).json(),
    );
    expect(second).toEqual({ outcome: 'duplicate' });

    const after = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
    );
    /* One million paid once: two would have left one million owing. */
    expect(after.outstanding[0]).toMatchObject({ owedK: 2_000_000 });
  });

  it('a resubmitted schedule is created once', async () => {
    const { auth } = await onboard('+2348177000204');
    const body = {
      description: 'Shop rent',
      category: 'Rent',
      amountK: 15_000_000,
      method: 'transfer',
      anchorDay: 1,
      clientRef: randomUUID(),
    };

    const first = createRecurringResponse.parse(
      (await post('/v1/reports/expenses/recurring', body, auth)).json(),
    );
    expect(first.outcome).toBe('created');
    const second = createRecurringResponse.parse(
      (await post('/v1/reports/expenses/recurring', body, auth)).json(),
    );
    expect(second).toEqual({ outcome: 'duplicate' });

    const spend = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
    );
    expect(spend.recurring).toHaveLength(1);
    expect(spend.recurringTotal).toBe(1);
  });
});
