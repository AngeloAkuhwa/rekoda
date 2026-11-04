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
import { reportsStatementsResponse, journalEntryResponse } from '@rekoda/contracts';
import { customersRepo, spendRepo, stockRepo, withBusiness } from '@rekoda/db';
import { app, db, onboard, useReportsHarness } from './reports.fixtures.js';

useReportsHarness();

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
    ).toEqual({
      outcome: 'recorded',
      asAt: '2026-07-31',
      equityK: 20_000_000,
      stockValueK: 0,
      invoices: [],
    });

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
      receivablesK: 0,
    });
  });

  /**
   * The kernel shapes (PR-083), through the same door: receivables become
   * open invoices the response names, counted stock becomes products, and
   * a shelf stated twice — a value AND lines — is refused at the border.
   */
  it('opens with invoices behind the debts and products behind the shelf', async () => {
    const { auth, businessId } = await onboard('+2348177000027');
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      businessId,
      'CUSTOMER_OB1',
      [],
    );

    const res = (
      await open(auth, {
        asAt: '2026-07-31',
        cashK: 1_000_000,
        bankK: 0,
        stockK: 0,
        stock: [{ name: 'ankara', quantity: 10, unitCostK: 150_000 }],
        receivables: [{ customerId: customer.id, amountK: 3_000_000 }],
      })
    ).json() as {
      outcome: string;
      equityK: number;
      stockValueK: number;
      invoices: { invoiceNumber: string; amountK: number }[];
    };
    expect(res.outcome).toBe('recorded');
    expect(res.equityK).toBe(5_500_000);
    expect(res.stockValueK).toBe(1_500_000);
    expect(res.invoices).toEqual([
      { invoiceNumber: expect.stringMatching(/^INV-2026-/), amountK: 3_000_000 },
    ]);

    const shelf = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'ankara'),
    );
    expect(shelf).toMatchObject({ onHand: 10, unitCostK: 150_000 });
  });

  it('refuses a shelf stated twice: a value and counted lines together', async () => {
    const { auth } = await onboard('+2348177000028');
    expect(
      (
        await open(auth, {
          asAt: '2026-07-31',
          cashK: 0,
          bankK: 0,
          stockK: 1_000_000,
          stock: [{ name: 'ankara', quantity: 1, unitCostK: 100 }],
        })
      ).statusCode,
    ).toBe(400);
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

  /* Build 9: the SAME request again is answered exactly as the direct path
   * answers it. Once-only is the database's, so the bus must not replay the
   * first answer as if it were new. */
  it('opens once, and says so plainly when the same request comes again', async () => {
    const { auth } = await onboard('+2348177000025');
    const body = { asAt: '2026-07-31', cashK: 1_000, bankK: 0, stockK: 0 };
    expect((await open(auth, body)).json()).toMatchObject({ outcome: 'recorded' });
    expect((await open(auth, body)).json()).toEqual({ outcome: 'already_set' });
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
 * A correction written by hand, end to end.
 *
 * The posting itself is proven in packages/db/src/ledger/journal.integration.test.ts.
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
    const bank = seen.balanceSheet.assets.find((a) => a.code === '1010');
    const cash = seen.balanceSheet.assets.find((a) => a.code === '1000');
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
