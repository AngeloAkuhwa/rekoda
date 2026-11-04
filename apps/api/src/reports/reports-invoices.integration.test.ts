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
  creditInvoiceResponse,
  reportsAuditResponse,
  reportsInvoicesResponse,
  voidInvoiceResponse,
} from '@rekoda/contracts';
import { customersRepo, issueRepo, withBusiness } from '@rekoda/db';
import { app, db, onboard, post, voidInvoice, useReportsHarness } from './reports.fixtures.js';

useReportsHarness();

/**
 * The other half of the pair the void opens.
 *
 * What matters here is that the two instruments cover every invoice between
 * them and overlap on none: a merchant refused by one is always sent to the
 * other, and the pair of refusals below is what proves there is no gap.
 */
describe('crediting an invoice', () => {
  let creditCustomerSeq = 0;
  async function paidSale(businessId: string) {
    creditCustomerSeq += 1;
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      businessId,
      `CUSTOMER_CN${creditCustomerSeq}`,
      [],
    );
    return withBusiness(db, businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: customer.id,
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
        sourceId: 'draft-credit',
        actor: 'system',
      });
      return sale.invoiceNumber;
    });
  }

  it('issues a numbered credit note and reduces what is owed', async () => {
    const { auth, businessId } = await onboard('+2348177000051');
    const invoiceNumber = await paidSale(businessId);

    const res = await post(
      '/v1/reports/invoices/credit',
      { invoiceNumber, amountK: 9_000_000, reason: 'goods returned' },
      auth,
    );
    expect(res.statusCode).toBe(200);
    const outcome = creditInvoiceResponse.parse(res.json());
    expect(outcome).toMatchObject({
      outcome: 'credited',
      invoiceNumber,
      amountK: 9_000_000,
      /* §14.1: an unapplied credit reduces no invoice. */
      balanceDueK: 9_000_000,
      /* The whole credit is owed to the customer until applied. */
      owedToCustomerK: 9_000_000,
    });

    const register = reportsInvoicesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/invoices', headers: auth })).json(),
    );
    expect(register.invoices[0]).toMatchObject({ balanceDueK: 9_000_000, creditedK: 9_000_000 });
    expect(register.outstandingK).toBe(9_000_000);
    expect(res.body).not.toContain('CUSTOMER_');
  });

  it('says when the merchant now owes the customer', async () => {
    const { auth, businessId } = await onboard('+2348177000052');
    const invoiceNumber = await paidSale(businessId);

    const outcome = creditInvoiceResponse.parse(
      (
        await post(
          '/v1/reports/invoices/credit',
          { invoiceNumber, amountK: 15_000_000, reason: 'all returned' },
          auth,
        )
      ).json(),
    );
    expect(outcome).toMatchObject({ owedToCustomerK: 15_000_000 });
  });

  /* The pair must leave no invoice without a path, and give none two. */
  it('sends an unpaid invoice to the void, and a paid one away from it', async () => {
    const { auth, businessId } = await onboard('+2348177000053');
    const paid = await paidSale(businessId);
    const unpaid = await withBusiness(db, businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: null,
        items: [{ name: 'bag', quantity: 1, unitPriceK: 2_000_000 }],
        subtotalK: 2_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 2_000_000,
        paidK: 0,
        balanceDueK: 2_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-unpaid',
        actor: 'system',
      });
      return sale.invoiceNumber;
    });

    expect(
      creditInvoiceResponse.parse(
        (
          await post(
            '/v1/reports/invoices/credit',
            { invoiceNumber: unpaid, amountK: 1_000_000, reason: 'wrong figure' },
            auth,
          )
        ).json(),
      ),
    ).toEqual({ outcome: 'unpaid' });

    expect(voidInvoiceResponse.parse(await voidInvoice(paid, 'mistake', auth))).toMatchObject({
      outcome: 'has_payments',
    });
  });

  it('refuses more than is left, and another tenant`s invoice', async () => {
    const ada = await onboard('+2348177000054');
    const bola = await onboard('+2348177000055');
    const invoiceNumber = await paidSale(ada.businessId);

    expect(
      creditInvoiceResponse.parse(
        (
          await post(
            '/v1/reports/invoices/credit',
            { invoiceNumber, amountK: 20_000_000, reason: 'too much' },
            ada.auth,
          )
        ).json(),
      ),
    ).toEqual({ outcome: 'exceeds_invoice', creditableK: 15_000_000 });

    expect(
      creditInvoiceResponse.parse(
        (
          await post(
            '/v1/reports/invoices/credit',
            { invoiceNumber, amountK: 1_000_000, reason: 'not mine' },
            bola.auth,
          )
        ).json(),
      ),
    ).toEqual({ outcome: 'not_found' });

    expect(
      (
        await post(
          '/v1/reports/invoices/credit',
          { invoiceNumber, amountK: 1_000_000, reason: 'no' },
          ada.auth,
        )
      ).statusCode,
    ).toBe(400);
  });

  it('shows up on the audit trail as a sentence', async () => {
    const { auth, businessId } = await onboard('+2348177000056');
    const invoiceNumber = await paidSale(businessId);
    await post(
      '/v1/reports/invoices/credit',
      { invoiceNumber, amountK: 1_000_000, reason: 'one came back' },
      auth,
    );

    const trail = reportsAuditResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/audit', headers: auth })).json(),
    );
    const credited = trail.events.find((e) => e.action === 'credited');
    expect(credited?.reason).toBe('one came back');
    expect(credited?.amountK).toBe(1_000_000);
    /* Where the merchant was standing, not what ran the code. Labelling a
     * deliberate correction 'system' put "Automatic" on the trail beside a
     * change a person made on purpose. */
    expect(credited?.source).toBe('dashboard');
    expect(credited?.actor).toMatch(/^Owner \d{4}$/);
  });
});

/**
 * Withdrawing an invoice, over the wire.
 *
 * The ledger claim is proven in packages/db/src/documents/issue.integration.test.ts.
 * What this pins is the border: who may ask, what a bad ask gets, and that a
 * refusal comes back as an ANSWER the register can render rather than an
 * error the merchant has to interpret.
 */
describe('voiding an invoice', () => {
  const voidIt = (body: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/reports/invoices/void',
      payload: body as Record<string, unknown>,
      headers: { 'content-type': 'application/json', ...headers },
    });

  it('refuses a caller with no session', async () => {
    expect((await voidIt({ invoiceNumber: 'INV-2026-000001', reason: 'typo' })).statusCode).toBe(
      401,
    );
  });

  it('insists on a reason, because the gap has to be explained', async () => {
    const { auth } = await onboard('+2348177200001');
    expect((await voidIt({ invoiceNumber: 'INV-2026-000001' }, auth)).statusCode).toBe(400);
    expect((await voidIt({ invoiceNumber: 'INV-2026-000001', reason: 'x' }, auth)).statusCode).toBe(
      400,
    );
  });

  it('answers not_found as a RESULT, not an error page', async () => {
    const { auth } = await onboard('+2348177200002');

    /* The register renders this as a sentence. A 404 would make an ordinary
     * mistyped number look like the product breaking.
     *
     * It arrives on the CLAIM rather than the ask, because the tier decides
     * before the work does: `VoidReceipt` is HIGH_RISK, so the endpoint opens
     * a confirmation before anything reads the invoice. A mistyped number
     * therefore costs the merchant one extra press and still never produces
     * an error page. */
    expect(await voidInvoice('INV-2026-999999', 'wrong one', auth)).toEqual({
      outcome: 'not_found',
    });
  });

  it('withdraws a real invoice and takes it out of what is owed', async () => {
    const { businessId, auth } = await onboard('+2348177200003');
    const sale = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
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
        sourceId: 'draft-v1',
        actor: 'system',
      }),
    );

    const before = reportsInvoicesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/invoices', headers: auth })).json(),
    );
    expect(before.outstandingK).toBe(15_000_000);

    /* The ask alone withdraws nothing. A confirmation that voided the invoice
     * before the merchant answered would make the second press decoration. */
    const asked = (
      await voidIt({ invoiceNumber: sale.invoiceNumber, reason: 'wrong customer' }, auth)
    ).json() as { outcome: string; consequence?: string };
    expect(asked.outcome).toBe('confirm');
    expect(asked.consequence).toContain(sale.invoiceNumber);
    expect(
      reportsInvoicesResponse.parse(
        (await app.inject({ method: 'GET', url: '/v1/reports/invoices', headers: auth })).json(),
      ).outstandingK,
    ).toBe(15_000_000);

    expect(await voidInvoice(sale.invoiceNumber, 'wrong customer', auth)).toEqual({
      outcome: 'voided',
      invoiceNumber: sale.invoiceNumber,
      reversedK: 15_000_000,
    });

    const after = reportsInvoicesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/invoices', headers: auth })).json(),
    );
    /* Still in the register, marked, and owed by nobody. A void that removed
     * the row would look exactly like a deleted invoice. */
    expect(after.invoices).toHaveLength(1);
    expect(after.invoices[0]).toMatchObject({ status: 'voided', balanceDueK: 0 });
    expect(after.outstandingK).toBe(0);
  });
});
