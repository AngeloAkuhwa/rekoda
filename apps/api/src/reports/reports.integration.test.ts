/**
 * The reports surface, end to end: session guard → SQL → contract shape.
 *
 * The NUMBERS are proven in packages/db/src/reports.integration.test.ts
 * against hand arithmetic; what this suite pins is the wiring — that the
 * endpoints exist, refuse strangers, scope to the session's tenant, and
 * answer in exactly the shape the web tier's zod contracts will parse.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paymentReference } from '@rekoda/core';
import {
  reportsActivityResponse,
  reportsCashflowResponse,
  reportsDebtorsResponse,
  reportsInvoicesResponse,
  reportsOverviewResponse,
  reportsReceiptsResponse,
  reportsStatementsResponse,
} from '@rekoda/contracts';
import {
  createDb,
  issueRepo,
  paymentsHub,
  settleRepo,
  spendRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_REVEAL_OTP'] = '1';
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  delete process.env['NODE_ENV'];

  const { createApp } = await import('../main.js');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

function post(path: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: path,
    payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function onboard(phone: string) {
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as {
    devCode?: string;
  };
  const verified = (
    await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
  ).json() as { setupToken: string };
  const created = await post(
    '/v1/businesses',
    { name: 'Ada Fashion', businessType: 'Fashion & clothing' },
    { 'x-rekoda-setup-token': verified.setupToken },
  );
  const session = created.json() as { sessionToken: string; businessId: string };
  return {
    businessId: session.businessId,
    auth: { authorization: `Bearer ${session.sessionToken}` },
  };
}

const ENDPOINTS = [
  '/v1/reports/overview',
  '/v1/reports/cashflow',
  '/v1/reports/debtors',
  '/v1/reports/activity',
  '/v1/reports/statements',
  '/v1/reports/invoices',
  '/v1/reports/receipts',
] as const;

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

describe('the four statements (ADR 0015)', () => {
  it('a fresh business gets empty, balanced statements for the current month', async () => {
    const { auth } = await onboard('+2348177000004');
    const res = await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth });
    const statements = reportsStatementsResponse.parse(res.json());
    expect(statements.trialBalance.rows).toEqual([]);
    expect(statements.trialBalance.balanced).toBe(true);
    expect(statements.balanceSheet.balanced).toBe(true);
    expect(statements.profitAndLoss.netProfitK).toBe(0);
    expect(statements.cashflow.closingK).toBe(0);
  });

  it('refuses a malformed period with 400, never a crash', async () => {
    const { auth } = await onboard('+2348177000005');
    for (const bad of ['2026-13', 'now', '2026-1', "2026-08'--"]) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/reports/statements?period=${encodeURIComponent(bad)}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('an expense shows up in the P&L, the trial balance stays balanced', async () => {
    const { auth, businessId } = await onboard('+2348177000006');
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description: 'fuel',
        category: null,
        amountK: 1_200_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'd2',
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth });
    const statements = reportsStatementsResponse.parse(res.json());
    expect(statements.profitAndLoss.totalExpensesK).toBe(1_200_000);
    expect(statements.profitAndLoss.netProfitK).toBe(-1_200_000);
    expect(statements.trialBalance.balanced).toBe(true);
    expect(statements.balanceSheet.balanced).toBe(true);
    // Cash went negative (an expense with no income): it crosses to credit.
    const cash = statements.trialBalance.rows.find((r) => r.account === 'CASH');
    expect(cash?.creditK).toBe(1_200_000);
  });
});
