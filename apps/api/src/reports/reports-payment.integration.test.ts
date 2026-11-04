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
import { reportsInvoicesResponse, recordPaymentResponse } from '@rekoda/contracts';
import { customersRepo, issueRepo, settleRepo, withBusiness, sql, reportsRepo } from '@rekoda/db';
import { app, db, onboard, post, useReportsHarness } from './reports.fixtures.js';

useReportsHarness();

/**
 * The record an accountant asks for by name.
 *
 * Written since M1 by five repos and read by nothing until now, which is why
 * the assertion that matters here is not the shape: it is that a real trail,
 * built from a real sale and a real withdrawal, comes out as sentences a
 * person can check and carries no token from the sale that produced it.
 */
/**
 * Recording money that came in, from the dashboard.
 *
 * This existed only on WhatsApp. What matters here is that the receipt is
 * issued, the balance falls, the payment reads as RECORDED rather than
 * VERIFIED (ADR 0014), and no customer token crosses the border.
 */
describe('recording a payment from the dashboard', () => {
  async function unpaidSale(businessId: string, totalK = 15_000_000) {
    return withBusiness(db, businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_9M4',
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
        sourceId: `draft-pay-${totalK}`,
        actor: 'system',
      });
      return sale.invoiceNumber;
    });
  }

  it('books ONE payment when the same form arrives twice (clientRef)', async () => {
    const { auth, businessId } = await onboard('+2348177000109');
    const invoiceNumber = await unpaidSale(businessId);
    const clientRef = '2f9d3c34-6f5a-4b4e-9a89-27d5f0a01a55';

    const first = recordPaymentResponse.parse(
      (
        await post(
          '/v1/reports/payments/record',
          { invoiceNumber, amountK: 6_000_000, method: 'cash', clientRef },
          auth,
        )
      ).json(),
    );
    expect(first.outcome).toBe('recorded');

    /* The dropped-response retry: same form, same key. */
    const second = recordPaymentResponse.parse(
      (
        await post(
          '/v1/reports/payments/record',
          { invoiceNumber, amountK: 6_000_000, method: 'cash', clientRef },
          auth,
        )
      ).json(),
    );
    expect(second.outcome).toBe('duplicate');

    const receipts = await withBusiness(db, businessId, (tx) =>
      reportsRepo.receiptsFor(tx, businessId, 10),
    );
    expect(receipts.rows).toHaveLength(1);
  });

  it('issues a receipt, and takes it off what is owed', async () => {
    const { auth, businessId } = await onboard('+2348177000101');
    const invoiceNumber = await unpaidSale(businessId);

    const res = await post(
      '/v1/reports/payments/record',
      { invoiceNumber, amountK: 6_000_000, method: 'cash' },
      auth,
    );
    expect(res.statusCode).toBe(200);
    const outcome = recordPaymentResponse.parse(res.json());
    expect(outcome).toMatchObject({
      outcome: 'recorded',
      invoiceNumber,
      amountK: 6_000_000,
      balanceDueK: 9_000_000,
    });
    expect(outcome.outcome === 'recorded' && outcome.receiptNumber).toMatch(/^RCT-\d{4}-\d{6}$/);

    const register = reportsInvoicesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/invoices', headers: auth })).json(),
    );
    expect(register.invoices[0]).toMatchObject({ paidK: 6_000_000, balanceDueK: 9_000_000 });
    expect(register.outstandingK).toBe(9_000_000);
    /* The sale carried a token. It must not come back out here. */
    expect(res.body).not.toContain('CUSTOMER_');
  });

  /**
   * ADR 0014, at the border. Merchant testimony is RECORDED; only a provider
   * makes a payment VERIFIED, and letting this one wear that badge would
   * destroy the distinction the product sells.
   */
  it('marks it reported, never verified', async () => {
    const { auth, businessId } = await onboard('+2348177000102');
    const invoiceNumber = await unpaidSale(businessId);
    await post(
      '/v1/reports/payments/record',
      { invoiceNumber, amountK: 15_000_000, method: 'transfer' },
      auth,
    );

    const { rows: paid } = await withBusiness(db, businessId, (tx) => settleRepo.paymentsFor(tx));
    expect(paid).toHaveLength(1);
    /* 0 is RECORDED. A provider payment would be 1, and it would carry a
     * settlement status; this one has neither because nobody but the
     * merchant says it happened. */
    expect(paid[0]).toMatchObject({
      verified: 0,
      method: 'transfer',
      amountK: 15_000_000,
      settlementStatus: null,
      rekodaReference: null,
    });
  });

  /** Every row the two steps could write, counted. */
  async function footprint(businessId: string) {
    const [row] = [
      ...(await withBusiness(db, businessId, (tx) =>
        tx.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*)::int FROM payments WHERE business_id = ${businessId}) AS payments,
            (SELECT count(*)::int FROM payment_allocations
              WHERE business_id = ${businessId}) AS allocations,
            (SELECT count(*)::int FROM receipts WHERE business_id = ${businessId}) AS receipts,
            (SELECT count(*)::int FROM customer_credits
              WHERE business_id = ${businessId}) AS credits,
            (SELECT count(*)::int FROM reconciliations
              WHERE business_id = ${businessId}) AS reconciliations,
            (SELECT count(*)::int FROM ledger_transactions
              WHERE business_id = ${businessId}) AS postings,
            (SELECT count(*)::int FROM jobs WHERE business_id = ${businessId}) AS jobs,
            (SELECT count(*)::int FROM idempotency_records
              WHERE business_id = ${businessId}) AS claims,
            (SELECT count(*)::int FROM usage_events WHERE business_id = ${businessId}) AS usage
        `),
      )),
    ];
    return row;
  }

  /**
   * G-49, OWN-16: more than is owed is a question first. The first submit
   * writes nothing at all and answers the server's own figures; only the
   * confirmed second submit, at the balance it was shown, books it.
   */
  it('asks before an overpayment, writing nothing, not even the form key', async () => {
    const { auth, businessId } = await onboard('+2348177000103');
    const invoiceNumber = await unpaidSale(businessId);
    const before = await footprint(businessId);
    const clientRef = '6c0e7f1a-2b3d-4c5e-8f90-a1b2c3d4e5f6';

    const asked = recordPaymentResponse.parse(
      (
        await post(
          '/v1/reports/payments/record',
          { invoiceNumber, amountK: 18_000_000, method: 'cash', clientRef },
          auth,
        )
      ).json(),
    );
    expect(asked).toEqual({
      outcome: 'confirm_overpayment',
      invoiceNumber,
      balanceDueK: 15_000_000,
      amountReceivedK: 18_000_000,
      allocatedK: 15_000_000,
      creditK: 3_000_000,
      customerLinked: false,
    });
    expect(await footprint(businessId)).toEqual(before);

    /* Confirmed, with the SAME form key: nothing consumed it. */
    const booked = recordPaymentResponse.parse(
      (
        await post(
          '/v1/reports/payments/record',
          {
            invoiceNumber,
            amountK: 18_000_000,
            method: 'cash',
            clientRef,
            confirmOverpayment: true,
            expectedBalanceK: 15_000_000,
            /* Browser figures are never read. */
            allocatedK: 1,
            creditK: 17_999_999,
          },
          auth,
        )
      ).json(),
    );
    expect(booked).toMatchObject({
      outcome: 'recorded',
      invoiceNumber,
      amountK: 15_000_000,
      receivedK: 18_000_000,
      creditK: 3_000_000,
      balanceDueK: 0,
    });
    const { rows: paid } = await withBusiness(db, businessId, (tx) => settleRepo.paymentsFor(tx));
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ verified: 0, amountK: 18_000_000 });
    const after = await footprint(businessId);
    expect(after).toMatchObject({
      payments: 1,
      allocations: 1,
      receipts: 1,
      /* No customer on this invoice: the excess is a liability, unlinked. */
      credits: 0,
      reconciliations: 1,
    });

    /* The dropped-response retry of the confirmation books nothing twice. */
    const again = recordPaymentResponse.parse(
      (
        await post(
          '/v1/reports/payments/record',
          {
            invoiceNumber,
            amountK: 18_000_000,
            method: 'cash',
            clientRef,
            confirmOverpayment: true,
            expectedBalanceK: 15_000_000,
          },
          auth,
        )
      ).json(),
    );
    /* Answered as the duplicate it is, never "already paid, nothing recorded". */
    expect(again.outcome).toBe('duplicate');
    expect(await footprint(businessId)).toEqual(after);
  });

  it('an overpayment on a named customer becomes their credit', async () => {
    const { auth, businessId } = await onboard('+2348177000106');
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      businessId,
      'CUSTOMER_9M5',
      [{ facet: 'phone', ciphertext: 'sealed', matchKey: 'mk-g49-dash' }],
    );
    const invoiceNumber = await withBusiness(
      db,
      businessId,
      async (tx) =>
        (
          await issueRepo.issueSale(tx, {
            businessId,
            customerId: customer.id,
            customerToken: 'CUSTOMER_9M5',
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
            sourceId: 'draft-named',
            actor: 'system',
          })
        ).invoiceNumber,
    );
    const asked = recordPaymentResponse.parse(
      (
        await post(
          '/v1/reports/payments/record',
          { invoiceNumber, amountK: 16_000_000, method: 'transfer' },
          auth,
        )
      ).json(),
    );
    expect(asked).toMatchObject({ outcome: 'confirm_overpayment', customerLinked: true });
    await post(
      '/v1/reports/payments/record',
      {
        invoiceNumber,
        amountK: 16_000_000,
        method: 'transfer',
        confirmOverpayment: true,
        expectedBalanceK: 15_000_000,
      },
      auth,
    );
    const credits = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ customer_id: string; amount_minor: string; source_type: string }>(
        sql`SELECT customer_id, amount_minor::text, source_type FROM customer_credits
            WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...credits]).toEqual([
      { customer_id: customer.id, amount_minor: '1000000', source_type: 'overpayment' },
    ]);
  });

  it('a confirmation made stale by a balance change books nothing', async () => {
    const { auth, businessId } = await onboard('+2348177000107');
    const invoiceNumber = await unpaidSale(businessId);
    const asked = recordPaymentResponse.parse(
      (
        await post(
          '/v1/reports/payments/record',
          { invoiceNumber, amountK: 18_000_000, method: 'cash' },
          auth,
        )
      ).json(),
    );
    expect(asked.outcome).toBe('confirm_overpayment');

    /* Money lands while the merchant reads the question. */
    await post(
      '/v1/reports/payments/record',
      { invoiceNumber, amountK: 5_000_000, method: 'transfer' },
      auth,
    );
    const before = await footprint(businessId);

    const stale = recordPaymentResponse.parse(
      (
        await post(
          '/v1/reports/payments/record',
          {
            invoiceNumber,
            amountK: 18_000_000,
            method: 'cash',
            confirmOverpayment: true,
            expectedBalanceK: 15_000_000,
          },
          auth,
        )
      ).json(),
    );
    expect(stale).toMatchObject({ outcome: 'balance_moved', balanceDueK: 10_000_000 });
    expect(await footprint(businessId)).toEqual(before);
  });

  it('refuses a half-formed confirmation, and one that is not an overpayment', async () => {
    const { auth, businessId } = await onboard('+2348177000108');
    const invoiceNumber = await unpaidSale(businessId);
    for (const body of [
      { invoiceNumber, amountK: 18_000_000, method: 'cash', confirmOverpayment: true },
      { invoiceNumber, amountK: 18_000_000, method: 'cash', expectedBalanceK: 15_000_000 },
      {
        invoiceNumber,
        amountK: 15_000_000,
        method: 'cash',
        confirmOverpayment: true,
        expectedBalanceK: 15_000_000,
      },
    ]) {
      expect((await post('/v1/reports/payments/record', body, auth)).statusCode).toBe(400);
    }
    const register = reportsInvoicesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/invoices', headers: auth })).json(),
    );
    expect(register.invoices[0]).toMatchObject({ paidK: 0, balanceDueK: 15_000_000 });
  });

  it('says when an invoice is already settled, and when there is none', async () => {
    const { auth, businessId } = await onboard('+2348177000104');
    const invoiceNumber = await unpaidSale(businessId);
    await post(
      '/v1/reports/payments/record',
      { invoiceNumber, amountK: 15_000_000, method: 'cash' },
      auth,
    );

    expect(
      (
        await post(
          '/v1/reports/payments/record',
          { invoiceNumber, amountK: 100_000, method: 'cash' },
          auth,
        )
      ).json(),
    ).toEqual({ outcome: 'already_settled', invoiceNumber });

    expect(
      (
        await post(
          '/v1/reports/payments/record',
          { invoiceNumber: 'INV-2026-999999', amountK: 100_000, method: 'cash' },
          auth,
        )
      ).json(),
    ).toEqual({ outcome: 'not_found' });
  });

  it('refuses a stranger, and a body that is not a payment', async () => {
    expect((await post('/v1/reports/payments/record', {})).statusCode).toBe(401);

    const { auth } = await onboard('+2348177000105');
    expect((await post('/v1/reports/payments/record', {}, auth)).statusCode).toBe(400);
    expect(
      (
        await post(
          '/v1/reports/payments/record',
          { invoiceNumber: 'INV-1', amountK: 0, method: 'cash' },
          auth,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post(
          '/v1/reports/payments/record',
          { invoiceNumber: 'INV-1', amountK: 100, method: 'cheque' },
          auth,
        )
      ).statusCode,
    ).toBe(400);
  });

  /* One tenant's invoice is not another's to settle. RLS is what refuses:
   * the number simply does not resolve under the wrong session. */
  it('is one tenant at a time', async () => {
    const ada = await onboard('+2348177000106');
    const bola = await onboard('+2348177000107');
    const invoiceNumber = await unpaidSale(ada.businessId);

    expect(
      (
        await post(
          '/v1/reports/payments/record',
          { invoiceNumber, amountK: 100_000, method: 'cash' },
          bola.auth,
        )
      ).json(),
    ).toEqual({ outcome: 'not_found' });
  });
});
