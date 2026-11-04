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
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { paymentReference } from '@rekoda/core';
import {
  reportsActivityResponse,
  reportsCashflowResponse,
  reportsDebtorsResponse,
  reportsAuditResponse,
  reportsInvoicesResponse,
  reportsOverviewResponse,
  reportsReceiptsResponse,
} from '@rekoda/contracts';
import {
  issueRepo,
  paymentsHub,
  settleRepo,
  spendRepo,
  stockRepo,
  withBusiness,
  reportsRepo,
} from '@rekoda/db';
import { ENDPOINTS, app, db, onboard, voidInvoice, useReportsHarness } from './reports.fixtures.js';

useReportsHarness();

describe('the guardrail', () => {
  it('every reports endpoint refuses a caller with no session', async () => {
    for (const url of ENDPOINTS) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });
});

describe('the shapes the web tier will parse', () => {
  it('a fresh business gets zeros, six months, empty lists — never an error', async () => {
    const { auth } = await onboard('+2348177000001');

    const overview = reportsOverviewResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/overview', headers: auth })).json(),
    );
    expect(overview.moneyInK).toBe(0);
    expect(overview.owedToYouK).toBe(0);

    const cashflow = reportsCashflowResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/cashflow', headers: auth })).json(),
    );
    expect(cashflow.months).toHaveLength(6);
    expect(cashflow.months.at(-1)?.period).toBe(overview.period);

    const debtors = reportsDebtorsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/debtors', headers: auth })).json(),
    );
    expect(debtors).toMatchObject({ rows: [], totalK: 0, count: 0 });

    const activity = reportsActivityResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/activity', headers: auth })).json(),
    );
    expect(activity.items).toEqual([]);
  });

  it('numbers are scoped to the SESSION tenant, never a neighbour', async () => {
    const ada = await onboard('+2348177000002');
    const bola = await onboard('+2348177000003');

    await withBusiness(db, ada.businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId: ada.businessId,
        description: 'fuel',
        category: null,
        amountK: 1_200_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'd1',
      }),
    );

    const adaView = reportsOverviewResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/overview', headers: ada.auth })).json(),
    );
    const bolaView = reportsOverviewResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/overview', headers: bola.auth })).json(),
    );
    expect(adaView.moneyOutK).toBe(1_200_000);
    expect(bolaView.moneyOutK).toBe(0);
  });
});

describe('the registers (§5.3.7)', () => {
  /** One tokenised sale, part-settled through the provider — invoice + receipt. */
  async function seedRegisters(businessId: string) {
    return withBusiness(db, businessId, async (tx) => {
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
        sourceId: 'draft-r1',
        actor: 'system',
      });
      const intent = await paymentsHub.createIntent(tx, {
        businessId,
        reference: paymentReference(new Date(), (n) => randomBytes(n)),
        expectedAmountK: 15_000_000,
        providerType: 'paystack',
        invoiceId: sale.invoiceId,
      });
      await settleRepo.bookVerifiedPayment(tx, {
        businessId,
        intent: {
          id: intent.id,
          reference: intent.reference,
          invoiceId: sale.invoiceId,
          customerId: null,
        },
        confirmedAmountK: 6_000_000,
        currency: 'NGN',
        providerType: 'paystack',
        providerRef: 'pst-reg1',
        providerStatus: 'success',
        providerFeeK: 0,
        feePolicy: 'merchant_bearing',
        method: 'transfer',
        actor: 'test',
        eventId: 'evt-reg1',
      });
      return { invoiceNumber: sale.invoiceNumber };
    });
  }

  it('a fresh business gets empty registers, never an error', async () => {
    const { auth } = await onboard('+2348177000007');
    const invoices = reportsInvoicesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/invoices', headers: auth })).json(),
    );
    expect(invoices).toMatchObject({ invoices: [], count: 0, outstandingK: 0 });

    const receipts = reportsReceiptsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/receipts', headers: auth })).json(),
    );
    expect(receipts).toMatchObject({ receipts: [], count: 0 });
  });

  it('serves both registers in contract shape, and NEVER leaks a customer token', async () => {
    const { auth, businessId } = await onboard('+2348177000008');
    const { invoiceNumber } = await seedRegisters(businessId);

    const invoicesRes = await app.inject({
      method: 'GET',
      url: '/v1/reports/invoices',
      headers: auth,
    });
    const invoices = reportsInvoicesResponse.parse(invoicesRes.json());
    expect(invoices.count).toBe(1);
    expect(invoices.invoices[0]).toMatchObject({
      invoiceNumber,
      status: 'partially_paid',
      /* Appendix E.3's dimensions, derived at read (PR-084): part settled,
       * nothing being chased — no due date was ever agreed. */
      paymentStatus: 'PARTIALLY_PAID',
      collectionStatus: 'CURRENT',
      totalK: 15_000_000,
      paidK: 6_000_000,
      balanceDueK: 9_000_000,
    });
    expect(invoices.outstandingK).toBe(9_000_000);
    // The sale was recorded with CUSTOMER_7K2; the register must not carry it.
    expect(invoicesRes.body).not.toContain('CUSTOMER_');

    const receiptsRes = await app.inject({
      method: 'GET',
      url: '/v1/reports/receipts',
      headers: auth,
    });
    const receipts = reportsReceiptsResponse.parse(receiptsRes.json());
    expect(receipts.count).toBe(1);
    expect(receipts.receipts[0]?.receiptNumber).toMatch(/^RCT-/);
    expect(receipts.receipts[0]?.amountK).toBe(6_000_000);
    expect(receipts.receipts[0]?.invoiceNumber).toBe(invoiceNumber);
    expect(receiptsRes.body).not.toContain('CUSTOMER_');
  });

  it('registers are scoped to the SESSION tenant', async () => {
    const ada = await onboard('+2348177000009');
    const bola = await onboard('+2348177000010');
    await seedRegisters(ada.businessId);

    const bolaInvoices = reportsInvoicesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/invoices', headers: bola.auth })).json(),
    );
    expect(bolaInvoices.count).toBe(0);
  });
});

/**
 * The record an accountant asks for by name.
 *
 * Written since M1 by five repos and read by nothing until now, which is why
 * the assertion that matters here is not the shape: it is that a real trail,
 * built from a real sale and a real withdrawal, comes out as sentences a
 * person can check and carries no token from the sale that produced it.
 */
describe('the audit trail', () => {
  it('a fresh business has an empty trail, never an error', async () => {
    const { auth } = await onboard('+2348177000041');
    const trail = reportsAuditResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/audit', headers: auth })).json(),
    );
    expect(trail).toEqual({ events: [], count: 0 });
  });

  it('records the sale and the withdrawal as sentences, newest first', async () => {
    const { auth, businessId } = await onboard('+2348177000042');
    const { invoiceNumber } = await withBusiness(db, businessId, async (tx) => {
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
        sourceId: 'draft-audit',
        actor: 'system',
      });
      return { invoiceNumber: sale.invoiceNumber };
    });

    expect(await voidInvoice(invoiceNumber, 'duplicate', auth)).toMatchObject({
      outcome: 'voided',
    });

    const trailRes = await app.inject({ method: 'GET', url: '/v1/reports/audit', headers: auth });
    const trail = reportsAuditResponse.parse(trailRes.json());

    expect(trail.count).toBe(2);
    expect(trail.events.map((e) => e.summary)).toEqual([
      `Invoice ${invoiceNumber} withdrawn`,
      `Invoice ${invoiceNumber} issued`,
    ]);
    expect(trail.events[0]?.reason).toBe('duplicate');
    expect(trail.events[1]?.amountK).toBe(15_000_000);

    /* The sale carried CUSTOMER_7K2 and the trail must not. Nothing any
     * writer stores in `new_value` is a customer reference today, and this is
     * the assertion that would notice the day one is. */
    expect(trailRes.body).not.toContain('CUSTOMER_');
  });

  /**
   * "Who did this" is the entire point, so a raw `user:<uuid>` on the page
   * would be the feature failing quietly. Two accountants both rendered
   * "Accountant" would be the same failure, which is why the tail travels.
   */
  it('resolves the actor to a role and a phone tail, not a uuid', async () => {
    const { auth, businessId } = await onboard('+2348177000043');
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: null,
        items: [{ name: 'wig', quantity: 1, unitPriceK: 1_000_000 }],
        subtotalK: 1_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 1_000_000,
        paidK: 0,
        balanceDueK: 1_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-actor',
        actor: 'system',
      }),
    );
    await voidInvoice('INV-2026-000001', 'wrong', auth);

    const trail = reportsAuditResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/audit', headers: auth })).json(),
    );
    const byUser = trail.events.find((e) => e.action === 'voided');
    expect(byUser?.actor).toMatch(/^Owner \d{4}$/);
    expect(byUser?.actor).not.toContain('user:');
  });

  it('is scoped to the SESSION tenant', async () => {
    const ada = await onboard('+2348177000044');
    const bola = await onboard('+2348177000045');
    await withBusiness(db, ada.businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId: ada.businessId,
        customerId: null,
        customerToken: null,
        items: [{ name: 'wig', quantity: 1, unitPriceK: 1_000_000 }],
        subtotalK: 1_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 1_000_000,
        paidK: 0,
        balanceDueK: 1_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-tenancy',
        actor: 'system',
      }),
    );

    const theirs = reportsAuditResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/audit', headers: bola.auth })).json(),
    );
    expect(theirs).toEqual({ events: [], count: 0 });
  });
});

describe('paging the registers, and the two exports the audit found missing', () => {
  async function seedThreeInvoices(businessId: string) {
    await withBusiness(db, businessId, async (tx) => {
      for (let i = 0; i < 3; i++) {
        await issueRepo.issueSale(tx, {
          businessId,
          customerId: null,
          customerToken: null,
          items: [{ name: `Ankara bale ${i}`, quantity: 1, unitPriceK: 100_000 * (i + 1) }],
          subtotalK: 100_000 * (i + 1),
          discountK: 0,
          deliveryFeeK: 0,
          vatK: 0,
          totalK: 100_000 * (i + 1),
          paidK: 0,
          balanceDueK: 100_000 * (i + 1),
          method: 'transfer',
          sourceType: 'chat',
          sourceId: `draft-page-${i}`,
          actor: 'system',
        });
      }
    });
  }

  it('walks a register in pages without losing the whole-table count', async () => {
    const { auth, businessId } = await onboard('+2348177000230');
    await seedThreeInvoices(businessId);

    /* The repo is where the arithmetic lives; the endpoint adds one line of
     * wiring. Both are pinned: offset against real rows here, and the wire
     * below. */
    const paged = await withBusiness(db, businessId, (tx) =>
      reportsRepo.invoicesFor(tx, businessId, 2, 2),
    );
    expect(paged.rows).toHaveLength(1);
    expect(paged.count).toBe(3);

    const wire = reportsInvoicesResponse.parse(
      (
        await app.inject({ method: 'GET', url: '/v1/reports/invoices?page=2', headers: auth })
      ).json(),
    );
    /* Three invoices fit on page one, so page two is honestly empty while
     * the count still describes the whole book. */
    expect(wire.invoices).toEqual([]);
    expect(wire.count).toBe(3);

    /* A mangled page is page one, never an error. */
    const mangled = reportsInvoicesResponse.parse(
      (
        await app.inject({ method: 'GET', url: '/v1/reports/invoices?page=abc', headers: auth })
      ).json(),
    );
    expect(mangled.invoices).toHaveLength(3);
  });

  it('exports the audit trail and the stock register as files', async () => {
    const { auth, businessId } = await onboard('+2348177000231');
    await seedThreeInvoices(businessId);
    await withBusiness(db, businessId, async (tx) => {
      const bale = await stockRepo.findOrCreateProduct(tx, businessId, 'Ankara bale');
      await stockRepo.recordMovement(tx, {
        businessId,
        productId: bale.id,
        delta: 4,
        reason: 'adjustment',
        sourceType: 'chat',
        sourceId: 'seed',
      });
    });

    const audit = await app.inject({ method: 'GET', url: '/v1/reports/audit.csv', headers: auth });
    expect(audit.statusCode).toBe(200);
    expect(audit.headers['content-type']).toContain('text/csv');
    /* toCsv ends lines CRLF for spreadsheets; trim the carriage return. */
    expect(audit.body.split('\n')[0]?.trim()).toBe('When,Who,What happened,Where,Why,Amount');
    expect(audit.body).toContain('INV-');

    const stock = await app.inject({ method: 'GET', url: '/v1/reports/stock.csv', headers: auth });
    expect(stock.statusCode).toBe(200);
    expect(stock.headers['content-type']).toContain('text/csv');
    expect(stock.body.split('\n')[0]?.trim()).toBe('Product,On hand,Unit price,Unit cost,Listed');
    expect(stock.body).toContain('Ankara bale,4');

    /* A stranger gets neither file. */
    expect((await app.inject({ method: 'GET', url: '/v1/reports/audit.csv' })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ method: 'GET', url: '/v1/reports/stock.csv' })).statusCode).toBe(
      401,
    );
  });
});

describe('the debtors page asks for the whole register', () => {
  it('the strip stays six rows and full=1 lifts the cap, count untouched', async () => {
    const { auth, businessId } = await onboard('+2348177000232');
    await withBusiness(db, businessId, async (tx) => {
      for (let i = 0; i < 8; i++) {
        await issueRepo.issueSale(tx, {
          businessId,
          customerId: null,
          customerToken: null,
          items: [{ name: `Bale ${i}`, quantity: 1, unitPriceK: 50_000 }],
          subtotalK: 50_000,
          discountK: 0,
          deliveryFeeK: 0,
          vatK: 0,
          totalK: 50_000,
          paidK: 0,
          balanceDueK: 50_000,
          method: 'transfer',
          sourceType: 'chat',
          sourceId: `draft-debt-${i}`,
          actor: 'system',
        });
      }
    });

    const strip = reportsDebtorsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/debtors', headers: auth })).json(),
    );
    expect(strip.rows).toHaveLength(6);
    expect(strip.count).toBe(8);

    const full = reportsDebtorsResponse.parse(
      (
        await app.inject({ method: 'GET', url: '/v1/reports/debtors?full=1', headers: auth })
      ).json(),
    );
    expect(full.rows).toHaveLength(8);
    expect(full.count).toBe(8);
    expect(full.totalK).toBe(8 * 50_000);
  });
});
