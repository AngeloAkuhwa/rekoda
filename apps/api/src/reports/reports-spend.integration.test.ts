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
  reportsExpensesResponse,
  reportsStatementsResponse,
  disposeAssetResponse,
  recordAssetResponse,
  withdrawAssetResponse,
  voidExpenseResponse,
} from '@rekoda/contracts';
import { spendRepo, withBusiness } from '@rekoda/db';
import { app, db, onboard, post, recordedAsset, useReportsHarness } from './reports.fixtures.js';

useReportsHarness();

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
        method: 'cash',
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
      const equipment = after.balanceSheet.assets.find((l) => l.code === '1300');
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
      const recorded = recordedAsset(await post('/v1/reports/assets', GENERATOR, auth));

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
      expect(after.balanceSheet.assets.find((l) => l.code === '1300')?.amountK ?? 0).toBe(0);
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
      const recorded = recordedAsset(await post('/v1/reports/assets', GENERATOR, auth));

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
      expect(after.balanceSheet.assets.find((l) => l.code === '1300')?.amountK ?? 0).toBe(0);
      expect(after.profitAndLoss.expenses.find((l) => l.code === '6200')?.amountK).toBe(25_000_000);
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
      const recorded = recordedAsset(await post('/v1/reports/assets', GENERATOR, auth));
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
      const recorded = recordedAsset(await post('/v1/reports/assets', GENERATOR, auth));
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
      const recorded = recordedAsset(await post('/v1/reports/assets', GENERATOR, ada.auth));

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
