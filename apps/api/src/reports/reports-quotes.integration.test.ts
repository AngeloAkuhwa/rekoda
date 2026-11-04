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
  cancelQuoteResponse,
  convertQuoteResponse,
  createQuoteResponse,
  reportsInvoicesResponse,
} from '@rekoda/contracts';
import {
  jobsRepo,
  ordersRepo,
  usageRepo,
  catalogueRepo,
  issueRepo,
  stockRepo,
  withBusiness,
} from '@rekoda/db';
import { app, db, onboard, post, useReportsHarness } from './reports.fixtures.js';

useReportsHarness();

/**
 * Quotes: the offer before the sale (fix-plan 4, G3).
 *
 * The claims worth having: an offer posts NOTHING until converted;
 * converting issues the same invoice+stock+ledger a chat order does and
 * costs the same document unit; the status machine, not a client key, makes
 * a second convert answer with the first one's invoice; and QUO rows never
 * leak into the orders register.
 */
describe('quotes, and what converting one does', () => {
  async function seedPricedProduct(businessId: string) {
    await withBusiness(db, businessId, async (tx) => {
      const bale = await stockRepo.findOrCreateProduct(tx, businessId, 'Ankara bale');
      await stockRepo.recordMovement(tx, {
        businessId,
        productId: bale.id,
        delta: 10,
        reason: 'adjustment',
        sourceType: 'chat',
        sourceId: 'seed',
      });
      await catalogueRepo.editProduct(tx, businessId, bale.id, { unitPriceK: 850_000 });
    });
  }

  const QUOTE = {
    customerName: 'Ada Obi',
    items: [{ name: 'Ankara bale', quantity: 2, unitPriceK: 850_000 }],
  };

  it('creates an offer that posts nothing, and lists it apart from orders', async () => {
    const { auth, businessId } = await onboard('+2348177000210');
    const created = createQuoteResponse.parse(
      (await post('/v1/reports/quotes', { ...QUOTE, clientRef: randomUUID() }, auth)).json(),
    );
    expect(created).toMatchObject({ outcome: 'created', totalK: 1_700_000 });
    if (created.outcome !== 'created') return;
    expect(created.quoteNumber).toMatch(/^QUO-\d{4}-000001$/);

    const register = reportsInvoicesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/invoices', headers: auth })).json(),
    );
    expect(register.quotes).toHaveLength(1);
    expect(register.quotes[0]).toMatchObject({ status: 'quoted', totalK: 1_700_000 });
    /* An offer is not an order and not a sale: nothing anywhere else. */
    expect(register.orders).toEqual([]);
    expect(register.invoices).toEqual([]);

    /* The paper is queued in the same breath, carrying the token the PDF
     * prints as "Prepared for" — never the name itself. */
    const renderQueued = await withBusiness(db, businessId, async (tx) => {
      const quote = await ordersRepo.quoteByNumber(tx, businessId, created.quoteNumber);
      return quote
        ? jobsRepo.hasJobForSingleton(tx, businessId, 'document.render', `render:quote:${quote.id}`)
        : false;
    });
    expect(renderQueued).toBe(true);
  });

  it('a resubmitted quote form creates once', async () => {
    const { auth } = await onboard('+2348177000211');
    const clientRef = randomUUID();
    const first = createQuoteResponse.parse(
      (await post('/v1/reports/quotes', { ...QUOTE, clientRef }, auth)).json(),
    );
    expect(first.outcome).toBe('created');
    const second = createQuoteResponse.parse(
      (await post('/v1/reports/quotes', { ...QUOTE, clientRef }, auth)).json(),
    );
    expect(second).toEqual({ outcome: 'duplicate' });
  });

  it('converting issues the invoice, moves the stock, balances the books and spends a document', async () => {
    const { auth, businessId } = await onboard('+2348177000212');
    await seedPricedProduct(businessId);
    const created = createQuoteResponse.parse(
      (await post('/v1/reports/quotes', QUOTE, auth)).json(),
    );
    if (created.outcome !== 'created') throw new Error('quote not created');

    const converted = convertQuoteResponse.parse(
      (await post('/v1/reports/quotes/convert', { quoteNumber: created.quoteNumber }, auth)).json(),
    );
    expect(converted).toMatchObject({ outcome: 'converted', totalK: 1_700_000 });
    if (converted.outcome !== 'converted') return;
    expect(converted.invoiceNumber).toMatch(/^INV-/);

    const register = reportsInvoicesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/invoices', headers: auth })).json(),
    );
    expect(register.invoices[0]).toMatchObject({ totalK: 1_700_000, balanceDueK: 1_700_000 });
    expect(register.quotes[0]).toMatchObject({
      status: 'confirmed',
      invoiceNumber: converted.invoiceNumber,
    });
    /* Still not an order: the registers stay disjoint after conversion too. */
    expect(register.orders).toEqual([]);

    const stock = await withBusiness(db, businessId, (tx) => stockRepo.stockList(tx, businessId));
    expect(stock.rows.find((p) => p.name === 'Ankara bale')?.onHand).toBe(8);

    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    const debits = entries.reduce((n, e) => n + e.debitK, 0);
    expect(debits).toBe(entries.reduce((n, e) => n + e.creditK, 0));

    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used).toBe(1);
  });

  it('a second convert is handed the first one`s invoice, and pays nothing', async () => {
    const { auth, businessId } = await onboard('+2348177000213');
    const created = createQuoteResponse.parse(
      (await post('/v1/reports/quotes', QUOTE, auth)).json(),
    );
    if (created.outcome !== 'created') throw new Error('quote not created');
    const first = convertQuoteResponse.parse(
      (await post('/v1/reports/quotes/convert', { quoteNumber: created.quoteNumber }, auth)).json(),
    );
    if (first.outcome !== 'converted') throw new Error('first convert failed');

    const second = convertQuoteResponse.parse(
      (await post('/v1/reports/quotes/convert', { quoteNumber: created.quoteNumber }, auth)).json(),
    );
    expect(second).toEqual({
      outcome: 'already_converted',
      invoiceNumber: first.invoiceNumber,
    });

    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used).toBe(1);
  });

  it('refuses a dead offer: expired converts nothing, withdrawn converts nothing', async () => {
    const { auth, businessId } = await onboard('+2348177000214');
    const expired = createQuoteResponse.parse(
      (await post('/v1/reports/quotes', { ...QUOTE, validUntil: '2026-01-31' }, auth)).json(),
    );
    if (expired.outcome !== 'created') throw new Error('quote not created');
    expect(
      convertQuoteResponse.parse(
        (
          await post('/v1/reports/quotes/convert', { quoteNumber: expired.quoteNumber }, auth)
        ).json(),
      ),
    ).toEqual({ outcome: 'expired', validUntil: '2026-01-31' });

    const open = createQuoteResponse.parse((await post('/v1/reports/quotes', QUOTE, auth)).json());
    if (open.outcome !== 'created') throw new Error('quote not created');
    expect(
      cancelQuoteResponse.parse(
        (await post('/v1/reports/quotes/cancel', { quoteNumber: open.quoteNumber }, auth)).json(),
      ),
    ).toEqual({ outcome: 'cancelled' });
    expect(
      convertQuoteResponse.parse(
        (await post('/v1/reports/quotes/convert', { quoteNumber: open.quoteNumber }, auth)).json(),
      ),
    ).toEqual({ outcome: 'cancelled' });

    /* Nothing was ever issued, and nothing was ever charged. */
    const usage = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, usagePeriod(new Date())),
    );
    expect(usage.find((r) => r.unit === 'DOCUMENT_GENERATION')?.used ?? 0).toBe(0);
  });
});
