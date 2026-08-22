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
import { paymentReference, postCostOfSale } from '@rekoda/core';
import {
  reportsActivityResponse,
  reportsCashflowResponse,
  reportsDebtorsResponse,
  creditInvoiceResponse,
  reportsAuditResponse,
  reportsExpensesResponse,
  reportsInvoicesResponse,
  reportsOverviewResponse,
  reportsReceiptsResponse,
  reportsStatementsResponse,
  stockCountResponse,
  closeBooksResponse,
  journalEntryResponse,
  disposeAssetResponse,
  recordAssetResponse,
  recordPaymentResponse,
  withdrawAssetResponse,
  reopenBooksResponse,
  voidExpenseResponse,
  voidInvoiceResponse,
} from '@rekoda/contracts';
import {
  createDb,
  issueRepo,
  paymentsHub,
  settleRepo,
  spendRepo,
  stockRepo,
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
  '/v1/reports/expenses',
  '/v1/reports/audit',
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

/**
 * Money out.
 *
 * The register itself is proven against hand arithmetic in packages/db; what
 * is pinned here is that the two totals stay APART all the way to the wire.
 * A response that summed them would parse fine and read wrong.
 */
describe('the spend register', () => {
  async function seedSpend(businessId: string) {
    await withBusiness(db, businessId, async (tx) => {
      await spendRepo.recordExpense(tx, {
        businessId,
        description: 'diesel',
        category: 'utilities',
        amountK: 800_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'spend-1',
      });
      await spendRepo.recordPurchase(tx, {
        businessId,
        description: 'ankara bales',
        amountK: 5_000_000,
        paidK: 2_000_000,
        sourceType: 'chat',
        sourceId: 'spend-2',
      });
    });
  }

  it('a fresh business gets an empty register, never an error', async () => {
    const { auth } = await onboard('+2348177000031');
    const spend = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
    );
    expect(spend).toMatchObject({
      entries: [],
      count: 0,
      expensesK: 0,
      purchasesK: 0,
      payableK: 0,
      payableAgeing: { d0_30K: 0, d31_60K: 0, d61_90K: 0, d90PlusK: 0, unlinkedK: 0, totalK: 0 },
      outstanding: [],
    });
  });

  it('keeps expenses, stock and what is still owed as three separate figures', async () => {
    const { auth, businessId } = await onboard('+2348177000032');
    await seedSpend(businessId);

    const spend = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
    );
    expect(spend.count).toBe(2);
    expect(spend.expensesK).toBe(800_000);
    expect(spend.purchasesK).toBe(5_000_000);
    expect(spend.payableK).toBe(3_000_000);
    /* The ageing and the balance are derived from the same ledger entries, so
     * the day they disagree a merchant cannot tell which one is lying. */
    expect(spend.payableAgeing.totalK).toBe(spend.payableK);
    expect(spend.payableAgeing.d0_30K).toBe(3_000_000);

    const kinds = Object.fromEntries(spend.entries.map((e) => [e.description, e.kind]));
    expect(kinds).toEqual({ diesel: 'expense', 'ankara bales': 'purchase' });
  });

  /**
   * Things the business keeps and uses (ADR 0026), across the border.
   *
   * The claim is not that a row was written. It is that the four statements a
   * merchant reads change in the right direction: the balance sheet gains the
   * equipment, and this month's profit and loss does not move at all.
   */
  describe('buying something the business keeps', () => {
    const GENERATOR = {
      description: 'Generator, 5.5kVA',
      costK: 45_000_000,
      paidK: 45_000_000,
      usefulLifeMonths: 60,
      method: 'transfer' as const,
    };

    const statementsOf = async (auth: Record<string, string>) =>
      reportsStatementsResponse.parse(
        (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
      );

    it('lands on the balance sheet, and not in this month`s profit', async () => {
      const { auth } = await onboard('+2348177000121');
      const before = await statementsOf(auth);

      const res = await post('/v1/reports/assets', GENERATOR, auth);
      expect(res.statusCode).toBe(200);
      expect(recordAssetResponse.parse(res.json())).toMatchObject({ owedK: 0 });

      const after = await statementsOf(auth);
      const equipment = after.balanceSheet.assets.find((l) => l.account === 'EQUIPMENT');
      expect(equipment?.amountK).toBe(45_000_000);
      /* The whole reason ADR 0026 exists: profit does not move. */
      expect(after.profitAndLoss.totalExpensesK).toBe(before.profitAndLoss.totalExpensesK);
      expect(after.profitAndLoss.netProfitK).toBe(before.profitAndLoss.netProfitK);
      /* And the identity still holds with two new accounts in the chart. */
      expect(after.balanceSheet.balanced).toBe(true);
    });

    it('puts the unpaid part onto what is owed to suppliers', async () => {
      const { auth } = await onboard('+2348177000122');
      expect(
        recordAssetResponse.parse(
          (
            await post(
              '/v1/reports/assets',
              { ...GENERATOR, costK: 30_000_000, paidK: 10_000_000 },
              auth,
            )
          ).json(),
        ),
      ).toMatchObject({ owedK: 20_000_000 });

      const spend = reportsExpensesResponse.parse(
        (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
      );
      expect(spend.payableK).toBe(20_000_000);
      expect(spend.assets[0]).toMatchObject({
        description: 'Generator, 5.5kVA',
        costK: 30_000_000,
        usefulLifeMonths: 60,
        chargedK: 0,
        bookValueK: 30_000_000,
      });
    });

    it('refuses figures that make no sense, and a stranger', async () => {
      expect((await post('/v1/reports/assets', GENERATOR)).statusCode).toBe(401);

      const { auth } = await onboard('+2348177000123');
      const bad = async (over: Record<string, unknown>) =>
        (await post('/v1/reports/assets', { ...GENERATOR, ...over }, auth)).statusCode;

      expect(await bad({ costK: 0 })).toBe(400);
      /* Paying more than it cost. */
      expect(await bad({ paidK: 45_000_001 })).toBe(400);
      expect(await bad({ usefulLifeMonths: 0 })).toBe(400);
      /* A century is a typo, not a generator. */
      expect(await bad({ usefulLifeMonths: 1200 })).toBe(400);
      expect(await bad({ description: 'x' })).toBe(400);
    });

    it('takes one back out, and the balance sheet returns to where it was', async () => {
      const { auth } = await onboard('+2348177000124');
      const recorded = recordAssetResponse.parse(
        (await post('/v1/reports/assets', GENERATOR, auth)).json(),
      );

      expect(
        withdrawAssetResponse.parse(
          (
            await post(
              '/v1/reports/assets/withdraw',
              { assetId: recorded.assetId, reason: 'recorded twice' },
              auth,
            )
          ).json(),
        ),
      ).toMatchObject({ outcome: 'withdrawn', reversedK: 45_000_000 });

      const after = await statementsOf(auth);
      expect(after.balanceSheet.assets.find((l) => l.account === 'EQUIPMENT')?.amountK ?? 0).toBe(
        0,
      );
      expect(after.balanceSheet.balanced).toBe(true);
    });

    /**
     * The event #113 could not record. Its copy pointed a merchant at a manual
     * journal, which is strictly two accounts and one amount: a disposal needs
     * four lines and a gain-or-loss account that did not exist. The page was
     * offering a workaround the product could not perform.
     */
    it('sells one, and takes the wear off with it', async () => {
      const { auth } = await onboard('+2348177000131');
      const recorded = recordAssetResponse.parse(
        (await post('/v1/reports/assets', GENERATOR, auth)).json(),
      );

      const sold = disposeAssetResponse.parse(
        (
          await post(
            '/v1/reports/assets/dispose',
            { assetId: recorded.assetId, proceedsK: 20_000_000, method: 'transfer' },
            auth,
          )
        ).json(),
      );
      /* Nothing charged yet, so book value is still the cost and the loss is
       * the whole gap. */
      expect(sold).toMatchObject({
        outcome: 'sold',
        bookValueK: 45_000_000,
        resultK: -25_000_000,
      });

      const after = await statementsOf(auth);
      expect(after.balanceSheet.assets.find((l) => l.account === 'EQUIPMENT')?.amountK ?? 0).toBe(
        0,
      );
      expect(
        after.profitAndLoss.expenses.find((l) => l.account === 'DISPOSAL_RESULT')?.amountK,
      ).toBe(25_000_000);
      expect(after.balanceSheet.balanced).toBe(true);

      const spend = reportsExpensesResponse.parse(
        (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
      );
      expect(spend.assets[0]).toMatchObject({
        status: 'sold',
        bookValueK: 0,
        proceedsK: 20_000_000,
      });
    });

    it('accepts nothing coming back, which is a scrapping', async () => {
      const { auth } = await onboard('+2348177000132');
      const recorded = recordAssetResponse.parse(
        (await post('/v1/reports/assets', GENERATOR, auth)).json(),
      );
      expect(
        disposeAssetResponse.parse(
          (
            await post(
              '/v1/reports/assets/dispose',
              { assetId: recorded.assetId, proceedsK: 0, method: 'cash' },
              auth,
            )
          ).json(),
        ),
      ).toMatchObject({ resultK: -45_000_000 });
    });

    it('refuses one already gone, a bad body, and a stranger', async () => {
      expect((await post('/v1/reports/assets/dispose', {})).statusCode).toBe(401);

      const { auth } = await onboard('+2348177000133');
      const recorded = recordAssetResponse.parse(
        (await post('/v1/reports/assets', GENERATOR, auth)).json(),
      );
      const sell = () =>
        post(
          '/v1/reports/assets/dispose',
          { assetId: recorded.assetId, proceedsK: 1_000_000, method: 'cash' },
          auth,
        );

      expect((await sell()).json()).toMatchObject({ outcome: 'sold' });
      expect((await sell()).json()).toEqual({ outcome: 'not_owned' });
      expect((await post('/v1/reports/assets/dispose', {}, auth)).statusCode).toBe(400);
      expect(
        (
          await post(
            '/v1/reports/assets/dispose',
            { assetId: recorded.assetId, proceedsK: -1, method: 'cash' },
            auth,
          )
        ).statusCode,
      ).toBe(400);
    });

    it('is one tenant at a time', async () => {
      const ada = await onboard('+2348177000125');
      const bola = await onboard('+2348177000126');
      const recorded = recordAssetResponse.parse(
        (await post('/v1/reports/assets', GENERATOR, ada.auth)).json(),
      );

      const theirs = reportsExpensesResponse.parse(
        (
          await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: bola.auth })
        ).json(),
      );
      expect(theirs.assets).toEqual([]);
      expect(
        (
          await post(
            '/v1/reports/assets/withdraw',
            { assetId: recorded.assetId, reason: 'not mine' },
            bola.auth,
          )
        ).json(),
      ).toEqual({ outcome: 'not_found' });
    });
  });

  describe('paying a supplier back', () => {
    const outstandingOf = async (auth: Record<string, string>) =>
      reportsExpensesResponse.parse(
        (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
      );

    it('offers what is still owed, and settles it against the purchase', async () => {
      const { auth, businessId } = await onboard('+2348177000091');
      await seedSpend(businessId);

      const before = await outstandingOf(auth);
      expect(before.outstanding).toHaveLength(1);
      expect(before.outstanding[0]).toMatchObject({
        description: 'ankara bales',
        owedK: 3_000_000,
      });

      const res = await post(
        '/v1/reports/suppliers/pay',
        { expenseId: before.outstanding[0]!.expenseId, amountK: 3_000_000, method: 'transfer' },
        auth,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ outcome: 'paid', owedK: 0 });

      const after = await outstandingOf(auth);
      /* Both figures moved, which is the whole point: before this shipped the
       * balance dropped and the ageing did not. */
      expect(after.payableK).toBe(0);
      expect(after.payableAgeing).toMatchObject({ d0_30K: 0, unlinkedK: 0, totalK: 0 });
      expect(after.outstanding).toEqual([]);
    });

    it('names the figure when a merchant tries to pay more than is owed', async () => {
      const { auth, businessId } = await onboard('+2348177000092');
      await seedSpend(businessId);
      const before = await outstandingOf(auth);

      const res = await post(
        '/v1/reports/suppliers/pay',
        { expenseId: before.outstanding[0]!.expenseId, amountK: 3_000_001, method: 'cash' },
        auth,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        outcome: 'refused',
        reason: 'more_than_owed',
        owedK: 3_000_000,
      });
      expect((await outstandingOf(auth)).payableK).toBe(3_000_000);
    });

    it('refuses a stranger, and a body that is not a payment', async () => {
      expect((await post('/v1/reports/suppliers/pay', {})).statusCode).toBe(401);

      const { auth } = await onboard('+2348177000093');
      expect((await post('/v1/reports/suppliers/pay', {}, auth)).statusCode).toBe(400);
      expect(
        (await post('/v1/reports/suppliers/pay', { expenseId: 'nope', amountK: 1 }, auth))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await post(
            '/v1/reports/suppliers/pay',
            { expenseId: '00000000-0000-4000-8000-000000000000', amountK: 0, method: 'cash' },
            auth,
          )
        ).statusCode,
      ).toBe(400);
    });

    /* One tenant's purchase is not another's to settle, uuid in hand or not. */
    it('is one tenant at a time', async () => {
      const ada = await onboard('+2348177000094');
      const bola = await onboard('+2348177000095');
      await seedSpend(ada.businessId);
      const theirs = await outstandingOf(ada.auth);

      expect((await outstandingOf(bola.auth)).outstanding).toEqual([]);
      expect(
        (
          await post(
            '/v1/reports/suppliers/pay',
            { expenseId: theirs.outstanding[0]!.expenseId, amountK: 1_000_000, method: 'cash' },
            bola.auth,
          )
        ).json(),
      ).toMatchObject({ outcome: 'refused', reason: 'no_such_purchase' });
    });
  });

  it('withdraws an entry, and the totals stop counting it', async () => {
    const { auth, businessId } = await onboard('+2348177000035');
    await seedSpend(businessId);

    const before = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
    );
    const diesel = before.entries.find((e) => e.description === 'diesel')!;

    const res = await post(
      '/v1/reports/expenses/void',
      { expenseId: diesel.id, reason: 'recorded twice' },
      auth,
    );
    expect(res.statusCode).toBe(200);
    expect(voidExpenseResponse.parse(res.json())).toMatchObject({
      outcome: 'voided',
      description: 'diesel',
      kind: 'expense',
      reversedK: 800_000,
    });

    const after = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: auth })).json(),
    );
    expect(after.expensesK).toBe(0);
    /* Still on the page. Dropping the row would leave a merchant wondering
     * where their entry went. */
    expect(after.entries.find((e) => e.id === diesel.id)?.status).toBe('voided');
  });

  it('refuses a withdrawal without a reason, and one for another tenant`s entry', async () => {
    const ada = await onboard('+2348177000036');
    const bola = await onboard('+2348177000037');
    await seedSpend(ada.businessId);

    const list = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: ada.auth })).json(),
    );
    const entry = list.entries[0]!;

    expect(
      (await post('/v1/reports/expenses/void', { expenseId: entry.id, reason: 'no' }, ada.auth))
        .statusCode,
    ).toBe(400);

    /* Another tenant holding a real id must get nothing back but a shrug.
     * Row-level security is what makes it a shrug rather than a leak. */
    const theirs = await post(
      '/v1/reports/expenses/void',
      { expenseId: entry.id, reason: 'not mine at all' },
      bola.auth,
    );
    expect(voidExpenseResponse.parse(theirs.json())).toEqual({ outcome: 'not_found' });
  });

  it('is scoped to the SESSION tenant', async () => {
    const ada = await onboard('+2348177000033');
    const bola = await onboard('+2348177000034');
    await seedSpend(ada.businessId);

    const theirs = reportsExpensesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/expenses', headers: bola.auth })).json(),
    );
    expect(theirs.count).toBe(0);
    expect(theirs.payableK).toBe(0);
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

    const paid = await withBusiness(db, businessId, (tx) => settleRepo.paymentsFor(tx));
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

  it('refuses more than is owed without posting anything', async () => {
    const { auth, businessId } = await onboard('+2348177000103');
    const invoiceNumber = await unpaidSale(businessId);

    const outcome = recordPaymentResponse.parse(
      (
        await post(
          '/v1/reports/payments/record',
          { invoiceNumber, amountK: 15_000_001, method: 'cash' },
          auth,
        )
      ).json(),
    );
    /* The excess is named rather than clamped away: it is real money and it
     * belongs somewhere. */
    expect(outcome).toEqual({
      outcome: 'balance_moved',
      invoiceNumber,
      balanceDueK: 15_000_000,
      excessK: 1,
    });

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

/**
 * The other half of the pair the void opens.
 *
 * What matters here is that the two instruments cover every invoice between
 * them and overlap on none: a merchant refused by one is always sent to the
 * other, and the pair of refusals below is what proves there is no gap.
 */
describe('crediting an invoice', () => {
  async function paidSale(businessId: string) {
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
      balanceDueK: 0,
      owedToCustomerK: 0,
    });

    const register = reportsInvoicesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/invoices', headers: auth })).json(),
    );
    expect(register.invoices[0]).toMatchObject({ balanceDueK: 0, creditedK: 9_000_000 });
    /* Nothing is outstanding any more, so it leaves the ageing. */
    expect(register.outstandingK).toBe(0);
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
    expect(outcome).toMatchObject({ owedToCustomerK: 6_000_000 });
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

    expect(
      voidInvoiceResponse.parse(
        (
          await post('/v1/reports/invoices/void', { invoiceNumber: paid, reason: 'mistake' }, auth)
        ).json(),
      ),
    ).toMatchObject({ outcome: 'has_payments' });
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

    const res = await post(
      '/v1/reports/invoices/void',
      { invoiceNumber, reason: 'duplicate' },
      auth,
    );
    expect(res.statusCode).toBe(200);

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
    await post(
      '/v1/reports/invoices/void',
      { invoiceNumber: 'INV-2026-000001', reason: 'wrong' },
      auth,
    );

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

    /* And the schedule underneath it, labelled the way the statement is:
     * the merchant said "fuel" and named no category at all, and the books
     * say "Power and fuel" in every place that prints it. */
    expect(statements.expenseSchedule.lines).toEqual([
      { category: 'power', label: 'Power and fuel', amountK: 1_200_000 },
    ]);
    expect(statements.expenseSchedule.totalK).toBe(statements.profitAndLoss.totalExpensesK);
  });

  it('a month with nothing spent gets an empty schedule rather than no schedule', async () => {
    const { auth } = await onboard('+2348177000007');
    const res = await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth });
    const statements = reportsStatementsResponse.parse(res.json());
    expect(statements.expenseSchedule).toEqual({ lines: [], totalK: 0 });
    expect(statements.revenueSchedule).toEqual({ lines: [], totalK: 0 });
  });

  /**
   * The channel a sale was made on, in the merchant's words, tying to the
   * income line above it. `sale_source` has been recorded since the chat
   * slice and this is the first thing that reads it.
   */
  it('says which channel the sales came from, and what nobody named', async () => {
    const { auth, businessId } = await onboard('+2348177000008');
    const sell = (saleSource: string | null, totalK: number, ref: string) =>
      withBusiness(db, businessId, (tx) =>
        issueRepo.issueSale(tx, {
          businessId,
          customerId: null,
          customerToken: null,
          items: [{ name: 'wig', quantity: 1, unitPriceK: totalK }],
          subtotalK: totalK,
          discountK: 0,
          deliveryFeeK: 0,
          vatK: 0,
          totalK,
          paidK: 0,
          balanceDueK: totalK,
          method: 'cash',
          sourceType: 'chat',
          sourceId: ref,
          saleSource,
          actor: 'test',
        }),
      );
    await sell('instagram', 3_000_000, 'r1');
    await sell(null, 1_000_000, 'r2');

    const res = await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth });
    const statements = reportsStatementsResponse.parse(res.json());
    expect(statements.revenueSchedule.lines).toEqual([
      { source: 'instagram', label: 'Instagram', amountK: 3_000_000 },
      /* Last whatever its size, and named for what it is rather than for
       * something the merchant failed to do. */
      { source: null, label: 'Not recorded', amountK: 1_000_000 },
    ]);
    expect(statements.revenueSchedule.totalK).toBe(statements.profitAndLoss.totalIncomeK);
  });
});

/**
 * Opening the books.
 *
 * The only write on this surface that records something already true. What
 * matters is that it happens once, that it lands on the day the merchant
 * named, and that it fixes the figure it exists for.
 */
describe('what the business was already holding', () => {
  const open = (auth: Record<string, string>, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/reports/opening-balances',
      payload: body,
      headers: { 'content-type': 'application/json', ...auth },
    });

  it('refuses a caller with no session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/reports/opening-balances',
      payload: { asAt: '2026-07-31', cashK: 1, bankK: 0, stockK: 0 },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  /**
   * The whole reason this exists, end to end. Before it, a merchant who
   * joined with ₦200,000 in the till and spent ₦120,000 of it read
   * "Cash on Hand: minus ₦120,000" and total assets to match.
   */
  it('turns a negative cash balance into the truth', async () => {
    const { auth, businessId } = await onboard('+2348177000021');
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description: 'diesel',
        category: null,
        amountK: 12_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'd1',
      }),
    );

    const before = reportsStatementsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
    );
    expect(before.openingBalances).toBeNull();
    expect(before.balanceSheet.totalAssetsK).toBe(-12_000_000);

    expect(
      (
        await open(auth, {
          asAt: '2026-07-31',
          cashK: 20_000_000,
          bankK: 0,
          stockK: 0,
        })
      ).json(),
    ).toEqual({ outcome: 'recorded', asAt: '2026-07-31', equityK: 20_000_000 });

    const after = reportsStatementsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
    );
    expect(after.balanceSheet.totalAssetsK).toBe(8_000_000);
    expect(after.balanceSheet.balanced).toBe(true);
    expect(after.openingBalances).toEqual({
      asAt: '2026-07-31',
      cashK: 20_000_000,
      bankK: 0,
      stockK: 0,
    });
  });

  /**
   * Dated before the period, so it is the month's OPENING balance rather than
   * money that arrived in it. Every balance-sheet account is cumulative and
   * would not care; the cash flow statement would, and would report a
   * merchant's existing till as income.
   */
  it("does not report a merchant's own till as money that came in", async () => {
    const { auth } = await onboard('+2348177000022');
    await open(auth, { asAt: '2020-01-15', cashK: 5_000_000, bankK: 0, stockK: 0 });

    const now = reportsStatementsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
    );
    expect(now.cashflow.openingK).toBe(5_000_000);
    expect(now.cashflow.inK).toBe(0);
    expect(now.cashflow.closingK).toBe(5_000_000);
  });

  it('opens once, and says so plainly the second time', async () => {
    const { auth } = await onboard('+2348177000023');
    expect(
      (await open(auth, { asAt: '2026-07-31', cashK: 1_000, bankK: 0, stockK: 0 })).json(),
    ).toMatchObject({ outcome: 'recorded' });
    expect(
      (await open(auth, { asAt: '2026-06-30', cashK: 9_000, bankK: 0, stockK: 0 })).json(),
    ).toEqual({ outcome: 'already_set' });
  });

  it('refuses an entry of nothing, and a day that has not happened', async () => {
    const { auth } = await onboard('+2348177000024');
    expect(
      (await open(auth, { asAt: '2026-07-31', cashK: 0, bankK: 0, stockK: 0 })).json(),
    ).toEqual({ outcome: 'nothing_to_open' });
    expect(
      (await open(auth, { asAt: '2099-01-01', cashK: 1_000, bankK: 0, stockK: 0 })).json(),
    ).toEqual({ outcome: 'not_yet' });

    /* And neither wrote anything. */
    const statements = reportsStatementsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
    );
    expect(statements.openingBalances).toBeNull();
  });

  it('is one business at a time', async () => {
    const ada = await onboard('+2348177000025');
    const bola = await onboard('+2348177000026');
    await open(ada.auth, { asAt: '2026-07-31', cashK: 20_000_000, bankK: 0, stockK: 0 });

    const theirs = reportsStatementsResponse.parse(
      (
        await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: bola.auth })
      ).json(),
    );
    expect(theirs.openingBalances).toBeNull();
    expect(theirs.balanceSheet.totalAssetsK).toBe(0);
  });
});

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

/**
 * The statements as a file.
 *
 * A dashboard is not a deliverable: a merchant asked for a loan or a grant
 * needs something dated they can forward. Asserted here as bytes rather than
 * as text, because the whole point is that it survives the wire.
 */
describe('the statements PDF', () => {
  const get = (path: string, auth: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: path, headers: auth });

  it('refuses without a session, like every other report', async () => {
    expect((await get('/v1/reports/statements.pdf')).statusCode).toBe(401);
  });

  it('refuses a period that is not a month', async () => {
    const { auth } = await onboard('+2348120000031');
    expect((await get('/v1/reports/statements.pdf?period=august', auth)).statusCode).toBe(400);
    expect((await get('/v1/reports/statements.pdf?period=2026-13', auth)).statusCode).toBe(400);
  });

  it('hands over a real PDF a browser saves and no cache keeps', async () => {
    const { auth } = await onboard('+2348120000032');
    const res = await get('/v1/reports/statements.pdf?period=2026-08', auth);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('rekoda-statements-2026-08.pdf');
    expect(res.headers['cache-control']).toBe('no-store');
    /* The magic bytes, not merely a 200. A route that answered with an error
     * page and the right headers would pass every assertion above. */
    expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(res.rawPayload.length).toBeGreaterThan(1_000);
  });

  it('builds a month with no trading rather than failing on it', async () => {
    const { auth } = await onboard('+2348120000033');
    const res = await get('/v1/reports/statements.pdf?period=2020-01', auth);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('builds from the books once there are books', async () => {
    const { auth, businessId } = await onboard('+2348120000034');
    await seedStatements(businessId);

    const period = new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);
    const res = await get(`/v1/reports/statements.pdf?period=${period}`, auth);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBeGreaterThan(1_000);
  });

  it('defaults to the current month when none is asked for', async () => {
    const { auth } = await onboard('+2348120000035');
    const period = new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);
    const res = await get('/v1/reports/statements.pdf', auth);
    expect(res.headers['content-disposition']).toContain(`rekoda-statements-${period}.pdf`);
  });

  it('agrees with the JSON the dashboard renders', async () => {
    const { auth, businessId } = await onboard('+2348120000036');
    await seedStatements(businessId);

    const period = new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);
    const json = (await get(`/v1/reports/statements?period=${period}`, auth)).json();
    const pdf = await get(`/v1/reports/statements.pdf?period=${period}`, auth);

    /* Both come from one `sumsFor`, so this is a guard against them drifting
     * apart later rather than a claim about today's arithmetic. */
    expect(json.trialBalance.balanced).toBe(true);
    expect(pdf.statusCode).toBe(200);
  });

  /** One ₦150,000 sale with ₦60,000 recorded, so the statements are not empty. */
  async function seedStatements(businessId: string) {
    await withBusiness(db, businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_PDF',
        items: [{ name: 'Bag of rice', quantity: 3, unitPriceK: 5_000_000 }],
        subtotalK: 15_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 15_000_000,
        paidK: 0,
        balanceDueK: 15_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'sale-pdf',
        actor: 'system',
      });
      await settleRepo.recordMerchantPayment(tx, {
        businessId,
        invoiceId: sale.invoiceId,
        amountK: 6_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'pay-pdf',
        actor: 'system',
      });
    });
  }
});

/**
 * The stock register.
 *
 * `products` and `inventory_movements` have existed since migration 0000 and
 * nothing wrote to either until now, so every figure below is a sum over an
 * append-only ledger rather than a stored count.
 */
describe('the stock register', () => {
  const get = (auth: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/v1/reports/stock', headers: auth });

  async function count(businessId: string, name: string, delta: number) {
    await withBusiness(db, businessId, async (tx) => {
      const product = await stockRepo.findOrCreateProduct(tx, businessId, name);
      await stockRepo.recordMovement(tx, {
        businessId,
        productId: product.id,
        delta,
        reason: 'adjustment',
        sourceType: 'chat',
        sourceId: null,
      });
    });
  }

  it('refuses without a session, like every other report', async () => {
    expect((await get()).statusCode).toBe(401);
  });

  it('is empty for a shop that counts nothing', async () => {
    const { auth } = await onboard('+2348120000041');
    expect((await get(auth)).json()).toEqual({ products: [], outOfStock: 0, withoutCost: 0 });
  });

  it('sums the movements and puts what is running out first', async () => {
    const { auth, businessId } = await onboard('+2348120000042');
    await count(businessId, 'Bags of rice', 40);
    await count(businessId, 'Bags of rice', -5);
    await count(businessId, 'Wigs', 2);

    const body = (await get(auth)).json();
    expect(body.products).toEqual([
      { name: 'Wigs', onHand: 2, unitCostK: null },
      { name: 'Bags of rice', onHand: 35, unitCostK: null },
    ]);
    expect(body.outOfStock).toBe(0);
    /* Counted by hand and never bought through Rekoda, so neither has a cost.
     * The page says so rather than showing a zero. */
    expect(body.withoutCost).toBe(2);
  });

  it('counts what has run out, and keeps it in the list', async () => {
    const { auth, businessId } = await onboard('+2348120000043');
    await count(businessId, 'Wigs', 4);
    await count(businessId, 'Wigs', -4);

    const body = (await get(auth)).json();
    /* Still listed: something counted and sold down to nothing is exactly the
     * row a merchant needs to see, and dropping it would hide the restock. */
    expect(body.products).toEqual([{ name: 'Wigs', onHand: 0, unitCostK: null }]);
    expect(body.outOfStock).toBe(1);
  });

  it('shows one business nothing of another', async () => {
    const mine = await onboard('+2348120000044');
    const theirs = await onboard('+2348120000045');
    await count(theirs.businessId, 'Their product', 50);

    expect((await get(mine.auth)).json().products).toEqual([]);
  });

  /**
   * The rule changed, on purpose, and this is the new boundary.
   *
   * A unit cost is here now because deliveries maintain one and it is real.
   * A TOTAL valuation still is not: inventory on the balance sheet is the
   * ledger figure and includes purchases that named no product, so a column
   * summed here would be a second answer to the same question, differing by
   * exactly the purchases nobody itemised.
   */
  it('carries what a unit cost, and never a valuation or a selling price', async () => {
    const { auth, businessId } = await onboard('+2348120000046');
    await count(businessId, 'Wigs', 3);

    const body = (await get(auth)).json();
    expect(body.products[0]).toEqual({ name: 'Wigs', onHand: 3, unitCostK: null });
    const raw = (await get(auth)).body;
    for (const absent of ['price', 'valuation', 'totalCost', 'valueK']) {
      expect(raw).not.toContain(absent);
    }
  });
});

/**
 * The statements as a workbook.
 *
 * The PDF is for somebody who will read it; this is for somebody who will
 * work with it. So the assertions are about the archive being real and the
 * figures being numbers, not about bytes existing.
 */
describe('the statements workbook', () => {
  const get = (path: string, auth: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: path, headers: auth });

  /**
   * Read one part out of the zip, by WALKING the local headers.
   *
   * Not by searching for the filename: `[Content_Types].xml` lists every part
   * by path and sorts first in the archive, so a search finds the name inside
   * that part's data and reads the wrong bytes entirely. Entries are stored,
   * so once found there is nothing to inflate.
   */
  function part(zip: Buffer, name: string): string {
    let at = 0;
    while (at + 30 <= zip.length && zip.readUInt32LE(at) === 0x04034b50) {
      const size = zip.readUInt32LE(at + 18);
      const nameLength = zip.readUInt16LE(at + 26);
      const extraLength = zip.readUInt16LE(at + 28);
      const entry = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8');
      const start = at + 30 + nameLength + extraLength;
      if (entry === name) return zip.subarray(start, start + size).toString('utf8');
      at = start + size;
    }
    throw new Error(`${name} is not in the archive`);
  }

  it('refuses without a session, like every other report', async () => {
    expect((await get('/v1/reports/statements.xlsx')).statusCode).toBe(401);
  });

  it('refuses a period that is not a month', async () => {
    const { auth } = await onboard('+2348120000051');
    expect((await get('/v1/reports/statements.xlsx?period=2026-13', auth)).statusCode).toBe(400);
  });

  it('hands over a real archive a browser saves and no cache keeps', async () => {
    const { auth } = await onboard('+2348120000052');
    const res = await get('/v1/reports/statements.xlsx?period=2026-08', auth);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain('rekoda-statements-2026-08.xlsx');
    expect(res.headers['cache-control']).toBe('no-store');
    /* The zip local-header signature, not merely a 200. */
    expect([...res.rawPayload.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('carries four named sheets in the order an accountant reads them', async () => {
    const { auth } = await onboard('+2348120000053');
    const res = await get('/v1/reports/statements.xlsx?period=2026-08', auth);
    const workbook = part(res.rawPayload, 'xl/workbook.xml');

    expect(workbook).toContain('name="Profit and loss"');
    expect(workbook).toContain('name="Balance sheet"');
    expect(workbook).toContain('name="Cash flow"');
    expect(workbook).toContain('name="Trial balance"');
    expect(workbook.indexOf('Profit and loss')).toBeLessThan(workbook.indexOf('Balance sheet'));
  });

  it('writes the figures as numbers a spreadsheet can total', async () => {
    const { auth, businessId } = await onboard('+2348120000054');
    await seedWorkbook(businessId);

    const period = new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);
    const res = await get(`/v1/reports/statements.xlsx?period=${period}`, auth);
    const sheet = part(res.rawPayload, 'xl/worksheets/sheet1.xml');

    /* Naira, not kobo, and in a value cell rather than an inline string. A
     * figure written as text is a figure nobody can sum, which is the entire
     * reason to ship this instead of another PDF. */
    expect(sheet).toContain('<v>150000</v>');
    expect(sheet).not.toContain('15000000');
    expect(sheet).not.toContain('₦');
  });

  it('agrees with the PDF built from the same month', async () => {
    const { auth, businessId } = await onboard('+2348120000055');
    await seedWorkbook(businessId);

    const period = new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);
    const [pdf, xlsx] = await Promise.all([
      get(`/v1/reports/statements.pdf?period=${period}`, auth),
      get(`/v1/reports/statements.xlsx?period=${period}`, auth),
    ]);

    /* Both come from one `sumsFor` and one `buildAll`, so this guards against
     * them drifting apart later rather than claiming anything about today. */
    expect(pdf.statusCode).toBe(200);
    expect(xlsx.statusCode).toBe(200);
  });

  it('builds a month with no trading rather than failing on it', async () => {
    const { auth } = await onboard('+2348120000056');
    const res = await get('/v1/reports/statements.xlsx?period=2020-01', auth);
    expect(res.statusCode).toBe(200);
    expect([...res.rawPayload.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  async function seedWorkbook(businessId: string) {
    await withBusiness(db, businessId, async (tx) => {
      await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_XLS',
        items: [{ name: 'wig', quantity: 3, unitPriceK: 5_000_000 }],
        subtotalK: 15_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 15_000_000,
        paidK: 0,
        balanceDueK: 15_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'sale-xls',
        actor: 'system',
      });
    });
  }
});

/**
 * The prior-period column.
 *
 * Every accounting package puts one beside a profit and loss, because
 * "₦150,000 of sales" is a figure and "₦150,000, up from ₦92,000" is the
 * thing a merchant actually wanted to know.
 */
describe('comparing against the month before', () => {
  const statements = (period: string, auth: Record<string, string>) =>
    app
      .inject({ method: 'GET', url: `/v1/reports/statements?period=${period}`, headers: auth })
      .then((r) => r.json());

  it('names the month before, rolling back across a year', async () => {
    const { auth } = await onboard('+2348120000061');
    expect((await statements('2026-08', auth)).comparison.period).toBe('2026-07');
    expect((await statements('2026-01', auth)).comparison.period).toBe('2025-12');
  });

  it('is zero for a business that was not trading, not absent', async () => {
    const { auth } = await onboard('+2348120000062');
    const body = await statements('2026-08', auth);
    /* Zero under a column labelled July says what it is. Omitting the column
     * would make the current month look like it had nothing to beat. */
    expect(body.comparison).toMatchObject({
      totalIncomeK: 0,
      totalExpensesK: 0,
      netProfitK: 0,
      lines: {},
    });
  });

  it('reads the prior month from the ledger, not from this one', async () => {
    const { auth, businessId } = await onboard('+2348120000063');
    await seedExpense(businessId, 'fuel', 1_200_000);

    const period = new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);
    const thisMonth = await statements(period, auth);
    expect(thisMonth.profitAndLoss.totalExpensesK).toBe(1_200_000);
    /* The expense landed today, so the month before must not see it. */
    expect(thisMonth.comparison.totalExpensesK).toBe(0);

    /* And asking about NEXT month puts the same expense in the comparison. */
    const next = await statements(nextPeriod(period), auth);
    expect(next.profitAndLoss.totalExpensesK).toBe(0);
    expect(next.comparison.totalExpensesK).toBe(1_200_000);
  });

  it('carries a per-account lookup the page reads line by line', async () => {
    const { auth, businessId } = await onboard('+2348120000064');
    await seedExpense(businessId, 'fuel for generator', 1_200_000);

    const period = new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);
    const next = await statements(nextPeriod(period), auth);

    const accounts = Object.keys(next.comparison.lines);
    expect(accounts.length).toBeGreaterThan(0);
    expect(Object.values(next.comparison.lines)).toContain(1_200_000);
  });

  it('never leaks another tenant into the comparison', async () => {
    const mine = await onboard('+2348120000065');
    const theirs = await onboard('+2348120000066');
    await seedExpense(theirs.businessId, 'their fuel', 9_900_000);

    const period = new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);
    const next = await statements(nextPeriod(period), mine.auth);
    expect(next.comparison.totalExpensesK).toBe(0);
  });

  function nextPeriod(period: string): string {
    const [year, month] = period.split('-').map(Number);
    return new Date(Date.UTC(year!, month!, 1)).toISOString().slice(0, 7);
  }

  async function seedExpense(businessId: string, description: string, amountK: number) {
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description,
        category: 'utilities',
        amountK,
        method: 'cash',
        sourceType: 'chat',
        sourceId: `cmp-${description}`,
      }),
    );
  }
});

/**
 * Withdrawing an invoice, over the wire.
 *
 * The ledger claim is proven in packages/db/src/issue.integration.test.ts.
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
    const res = await voidIt({ invoiceNumber: 'INV-2026-999999', reason: 'wrong one' }, auth);

    /* The register renders this as a sentence. A 404 would make an ordinary
     * mistyped number look like the product breaking. */
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: 'not_found' });
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

    const res = await voidIt({ invoiceNumber: sale.invoiceNumber, reason: 'wrong customer' }, auth);
    expect(res.json()).toEqual({
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

/**
 * The shelf against the books, end to end.
 *
 * The arithmetic is proven in packages/db/src/stocktake.integration.test.ts;
 * what this pins is that the two figures reach the page that shows them, that
 * the endpoint refuses a stranger, and that nothing it posts is computed from
 * anything the caller sent.
 */
describe('counting the shelf', () => {
  const countIt = (auth: Record<string, string>, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/reports/stock-count',
      payload: body,
      headers: { 'content-type': 'application/json', ...auth },
    });

  const today = () => new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 10);

  it('refuses a caller with no session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/reports/stock-count',
      payload: { countedOn: today() },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  /**
   * The drift, and the correction, as a merchant meets them. A lump-sum
   * restock debits stock against no product, so the balance sheet claims
   * goods nobody is holding and nothing ever credits them back.
   */
  it('shows the gap on the balance sheet, then closes it', async () => {
    const { auth, businessId } = await onboard('+2348177000041');
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'restocked the shop',
        amountK: 5_000_000,
        paidK: 5_000_000,
        sourceType: 'chat',
        sourceId: 'p1',
      }),
    );

    const before = reportsStatementsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
    );
    expect(before.stockValuation).toEqual({
      ledgerK: 5_000_000,
      countedK: 0,
      differenceK: -5_000_000,
      uncosted: 0,
    });

    const posted = stockCountResponse.parse((await countIt(auth, { countedOn: today() })).json());
    expect(posted).toEqual({ outcome: 'adjusted', differenceK: -5_000_000, countedK: 0 });

    const after = reportsStatementsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
    );
    expect(after.stockValuation).toMatchObject({ ledgerK: 0, differenceK: 0 });
    expect(after.balanceSheet.balanced).toBe(true);
    /* And the write-down is a cost, where stock that left without a sale
     * belongs, rather than vanishing off the sheet unexplained. */
    expect(after.profitAndLoss.costOfSalesK).toBe(5_000_000);
  });

  it('says so plainly when there is nothing to post', async () => {
    const { auth } = await onboard('+2348177000042');
    expect((await countIt(auth, { countedOn: today() })).json()).toEqual({
      outcome: 'agrees',
      countedK: 0,
    });
  });

  it('refuses a day that has not happened, and a body without one', async () => {
    const { auth } = await onboard('+2348177000043');
    expect((await countIt(auth, { countedOn: '2099-01-01' })).json()).toEqual({
      outcome: 'not_yet',
    });
    expect((await countIt(auth, { countedOn: 'today' })).statusCode).toBe(400);
  });

  /**
   * The refusal that keeps the instrument honest. Goods on the shelf with no
   * cost are missing from the count by an unknown amount, so posting it would
   * write off stock the business is still holding.
   */
  it('refuses while a product holds stock nobody has priced', async () => {
    const { auth, businessId } = await onboard('+2348177000044');
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'restocked the shop',
        amountK: 5_000_000,
        paidK: 5_000_000,
        sourceType: 'chat',
        sourceId: 'p1',
      }),
    );
    await withBusiness(db, businessId, async (tx) => {
      const product = await stockRepo.findOrCreateProduct(tx, businessId, 'Ankara');
      await stockRepo.recordMovement(tx, {
        businessId,
        productId: product.id,
        delta: 6,
        reason: 'adjustment',
        sourceType: 'chat',
        sourceId: 'counted',
      });
    });

    expect((await countIt(auth, { countedOn: today() })).json()).toEqual({
      outcome: 'costs_missing',
      uncosted: 1,
    });

    const still = reportsStatementsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
    );
    expect(still.stockValuation).toMatchObject({ ledgerK: 5_000_000, uncosted: 1 });
    expect(still.profitAndLoss.costOfSalesK).toBe(0);
  });

  /**
   * A cost typed onto a product that was never delivered lets a sale credit
   * INVENTORY straight through zero, and the statements response has to
   * carry that. Pinned end to end because the failure mode is not a wrong
   * figure: an unsigned schema would reject the whole payload and take the
   * reports page down over the very books this exists to repair.
   */
  it('carries a stock account that has gone below zero', async () => {
    const { auth, businessId } = await onboard('+2348177000047');
    await withBusiness(db, businessId, (tx) =>
      issueRepo.writePosting(
        tx,
        businessId,
        postCostOfSale({ memo: 'Sold goods nobody bought', costK: 1_500_000 }),
        'invoice',
        'INV-1',
      ),
    );

    const seen = reportsStatementsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
    );
    expect(seen.stockValuation).toEqual({
      ledgerK: -1_500_000,
      countedK: 0,
      differenceK: 1_500_000,
      uncosted: 0,
    });

    expect((await countIt(auth, { countedOn: today() })).json()).toMatchObject({
      outcome: 'adjusted',
      differenceK: 1_500_000,
    });
  });

  it('is one tenant at a time', async () => {
    const ada = await onboard('+2348177000045');
    const bola = await onboard('+2348177000046');
    await withBusiness(db, ada.businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId: ada.businessId,
        description: 'restocked the shop',
        amountK: 5_000_000,
        paidK: 5_000_000,
        sourceType: 'chat',
        sourceId: 'p1',
      }),
    );

    const theirs = reportsStatementsResponse.parse(
      (
        await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: bola.auth })
      ).json(),
    );
    expect(theirs.stockValuation).toEqual({
      ledgerK: 0,
      countedK: 0,
      differenceK: 0,
      uncosted: 0,
    });
  });
});

/**
 * Closing a month, end to end.
 *
 * The refusal is proven against the database in
 * packages/db/src/close.integration.test.ts. What this pins is the wiring:
 * that the endpoints exist, refuse strangers, scope to the session's tenant,
 * and that a closed month reaches the page which is supposed to show it.
 */
describe('closing a month', () => {
  const closeIt = (auth: Record<string, string>, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/reports/close',
      payload: body,
      headers: { 'content-type': 'application/json', ...auth },
    });

  const reopenIt = (auth: Record<string, string>, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/reports/reopen',
      payload: body,
      headers: { 'content-type': 'application/json', ...auth },
    });

  const statements = async (auth: Record<string, string>, period?: string) =>
    reportsStatementsResponse.parse(
      (
        await app.inject({
          method: 'GET',
          url: period ? `/v1/reports/statements?period=${period}` : '/v1/reports/statements',
          headers: auth,
        })
      ).json(),
    );

  const OLD = '2026-03';

  it('refuses a caller with no session', async () => {
    for (const url of ['/v1/reports/close', '/v1/reports/reopen']) {
      const res = await app.inject({
        method: 'POST',
        url,
        payload: { through: OLD, from: OLD },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('reports the books open until they are closed, then says through when', async () => {
    const { auth } = await onboard('+2348177000051');
    expect((await statements(auth)).booksClosedThrough).toBeNull();

    expect(closeBooksResponse.parse((await closeIt(auth, { through: OLD })).json())).toEqual({
      outcome: 'closed',
      through: OLD,
    });
    expect((await statements(auth)).booksClosedThrough).toBe(OLD);
  });

  /**
   * The whole point, reached through the API a merchant actually uses: an
   * expense dated into a month that has been closed is refused, and the
   * statement for that month does not move.
   */
  it('will not let a backdated entry change a month that was closed', async () => {
    const { auth, businessId } = await onboard('+2348177000052');
    await closeIt(auth, { through: OLD });

    await expect(
      withBusiness(db, businessId, (tx) =>
        spendRepo.recordExpense(tx, {
          businessId,
          description: 'diesel',
          category: null,
          amountK: 1_200_000,
          method: 'cash',
          sourceType: 'chat',
          sourceId: 'late',
          recordedAt: new Date('2026-03-15T11:00:00Z'),
        }),
      ),
    ).rejects.toBeTruthy();

    const march = await statements(auth, OLD);
    expect(march.profitAndLoss.totalExpensesK).toBe(0);
  });

  it('refuses a month that has not ended, and a body without one', async () => {
    const { auth } = await onboard('+2348177000053');
    const current = new Date().toISOString().slice(0, 7);
    expect((await closeIt(auth, { through: current })).json()).toEqual({ outcome: 'not_ended' });
    expect((await closeIt(auth, { through: 'August' })).statusCode).toBe(400);
    expect((await reopenIt(auth, {})).statusCode).toBe(400);
  });

  it('opens a month back up, and says what else came open with it', async () => {
    const { auth } = await onboard('+2348177000054');
    await closeIt(auth, { through: '2026-05' });

    expect(reopenBooksResponse.parse((await reopenIt(auth, { from: '2026-03' })).json())).toEqual({
      outcome: 'reopened',
      from: '2026-03',
      wasClosedThrough: '2026-05',
    });
    expect((await statements(auth)).booksClosedThrough).toBe('2026-02');
  });

  /**
   * An opening balance dated into a month the merchant closed. Rare, and
   * named rather than left to become a 500 on a page they cannot get past.
   */
  it('names a closed period rather than failing when the books are opened late', async () => {
    const { auth } = await onboard('+2348177000055');
    await closeIt(auth, { through: OLD });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/reports/opening-balances',
      payload: { asAt: '2026-03-31', cashK: 20_000_000, bankK: 0, stockK: 0 },
      headers: { 'content-type': 'application/json', ...auth },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: 'period_closed', closedThrough: OLD });
  });

  it('is one tenant at a time', async () => {
    const ada = await onboard('+2348177000056');
    const bola = await onboard('+2348177000057');
    await closeIt(ada.auth, { through: OLD });
    expect((await statements(bola.auth)).booksClosedThrough).toBeNull();
  });
});

/**
 * A correction written by hand, end to end.
 *
 * The posting itself is proven in packages/db/src/journal.integration.test.ts.
 * What this pins is the border: that the endpoint refuses a stranger, that
 * every refusal arrives as an outcome rather than a 500, and that a
 * correction reaches the statements it is supposed to move.
 */
describe('a correction written by hand', () => {
  const journal = (auth: Record<string, string>, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/reports/journal',
      payload: body,
      headers: { 'content-type': 'application/json', ...auth },
    });

  const ENTRY = {
    memo: "Took the day's takings to the bank",
    amountK: 5_000_000,
    intoAccount: 'BANK_PAYSTACK',
    outOfAccount: 'CASH',
  };

  it('refuses a caller with no session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/reports/journal',
      payload: ENTRY,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
  });

  /**
   * The cases the ten-account chart can describe and no write path produces.
   * Cash carried to the bank moves two assets and changes no profit, which is
   * exactly what a merchant would expect and exactly what nothing else in
   * Rekoda could have recorded.
   */
  it('moves money between two accounts without inventing profit', async () => {
    const { auth } = await onboard('+2348177000061');
    const posted = journalEntryResponse.parse((await journal(auth, ENTRY)).json());
    expect(posted).toEqual({
      outcome: 'recorded',
      journalNumber: expect.stringMatching(/^JNL-\d{4}-000001$/),
    });

    const seen = reportsStatementsResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: auth })).json(),
    );
    expect(seen.balanceSheet.balanced).toBe(true);
    expect(seen.profitAndLoss.netProfitK).toBe(0);
    const bank = seen.balanceSheet.assets.find((a) => a.account === 'BANK_PAYSTACK');
    const cash = seen.balanceSheet.assets.find((a) => a.account === 'CASH');
    expect(bank?.amountK).toBe(5_000_000);
    expect(cash?.amountK).toBe(-5_000_000);
  });

  it('names every refusal instead of failing', async () => {
    const { auth } = await onboard('+2348177000062');
    expect((await journal(auth, { ...ENTRY, intoAccount: 'CASH' })).json()).toEqual({
      outcome: 'same_account',
    });
    expect((await journal(auth, { ...ENTRY, occurredOn: '2099-01-01' })).json()).toEqual({
      outcome: 'not_yet',
    });
  });

  it('refuses a body the form should have caught', async () => {
    const { auth } = await onboard('+2348177000063');
    /* No reason, an account that is not in the chart, and nothing at all. */
    expect((await journal(auth, { ...ENTRY, memo: '' })).statusCode).toBe(400);
    expect((await journal(auth, { ...ENTRY, intoAccount: 'PETTY_CASH' })).statusCode).toBe(400);
    expect((await journal(auth, { ...ENTRY, amountK: 0 })).statusCode).toBe(400);
  });

  /* The escape hatch is not an escape from the close. */
  it('cannot reach into a month that has been closed', async () => {
    const { auth } = await onboard('+2348177000064');
    await app.inject({
      method: 'POST',
      url: '/v1/reports/close',
      payload: { through: '2026-03' },
      headers: { 'content-type': 'application/json', ...auth },
    });

    const res = await journal(auth, { ...ENTRY, occurredOn: '2026-03-15' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: 'period_closed', closedThrough: '2026-03' });
  });

  it('is one tenant at a time', async () => {
    const ada = await onboard('+2348177000065');
    const bola = await onboard('+2348177000066');
    await journal(ada.auth, ENTRY);

    const theirs = reportsStatementsResponse.parse(
      (
        await app.inject({ method: 'GET', url: '/v1/reports/statements', headers: bola.auth })
      ).json(),
    );
    expect(theirs.trialBalance.rows).toEqual([]);
  });
});
