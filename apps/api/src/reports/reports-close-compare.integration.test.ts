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
  reportsCompareResponse,
  reportsStatementsResponse,
  closeBooksResponse,
  reopenBooksResponse,
} from '@rekoda/contracts';
import { customersRepo, journalRepo, openingRepo, spendRepo, withBusiness, sql } from '@rekoda/db';
import { app, db, hash, onboard, useReportsHarness } from './reports.fixtures.js';

useReportsHarness();

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
 * Closing a month, end to end.
 *
 * The refusal is proven against the database in
 * packages/db/src/ledger/close.integration.test.ts. What this pins is the wiring:
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

  /**
   * Two calls, on the DEFAULT configuration.
   *
   * This used to be one call, and that was the defect: `ReopenAccountingPeriod`
   * is HIGH_RISK, and a rollout flag defaulting off sent the request straight
   * to `reopenPeriodWork` with no confirmation, no consequence shown and no
   * audit record. The flag is gone. The ceremony is not a deployment choice,
   * so this suite runs the shape a default deployment actually serves.
   */
  it('asks before it opens a month back up, and says what else comes open', async () => {
    const { auth, businessId } = await onboard('+2348177000054');
    await closeIt(auth, { through: '2026-05' });

    const asked = reopenBooksResponse.parse((await reopenIt(auth, { from: '2026-03' })).json());
    expect(asked.outcome).toBe('confirm');
    if (asked.outcome !== 'confirm') throw new Error('expected a confirmation');
    expect(asked.consequence).toContain('2026-03');

    /* Nothing moved on the ask. A confirmation that reopened the books
     * before the merchant answered would make the second step decoration. */
    expect((await statements(auth)).booksClosedThrough).toBe('2026-05');

    expect(
      reopenBooksResponse.parse(
        (await reopenIt(auth, { from: '2026-03', confirmationId: asked.confirmationId })).json(),
      ),
    ).toEqual({ outcome: 'reopened', from: '2026-03', wasClosedThrough: '2026-05' });
    expect((await statements(auth)).booksClosedThrough).toBe('2026-02');

    /* And the ceremony left a record naming what was agreed to. */
    const claimed = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ command: string; claimed_at: Date | null }>(
        sql`SELECT command, claimed_at FROM pending_confirmations
            WHERE business_id = ${businessId}::uuid AND command = 'ReopenAccountingPeriod'`,
      ),
    );
    expect([...claimed]).toHaveLength(1);
    expect([...claimed][0]!.claimed_at).not.toBeNull();
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
 * Period comparison, over the wire (N2, OWN-44). The arithmetic is proven in
 * @rekoda/core and the window figures in packages/db; this pins the endpoint:
 * it parses, scopes to the session's tenant, and refuses a range it cannot
 * draw with a sentence, never a 500.
 */
describe('the period comparison (N2)', () => {
  const lagosToday = () => new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
  const get = (auth: Record<string, string>, query = '') =>
    app.inject({ method: 'GET', url: `/v1/reports/compare${query}`, headers: auth });

  async function spend(businessId: string, description: string, amountK: number) {
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description,
        category: 'utilities',
        amountK,
        method: 'cash',
        sourceType: 'chat',
        sourceId: `n2-${description}`,
      }),
    );
  }

  it('answers a fresh business with zeros, and says there is nothing to compare with', async () => {
    const { auth } = await onboard('+2348177100001');
    const res = await get(auth);
    expect(res.statusCode).toBe(200);
    const body = reportsCompareResponse.parse(res.json());
    expect(body.sales.current).toBe(0);
    expect(body.sales.change.percent).toBeNull();
    expect(body.previousIsEmpty).toBe(true);
    expect(body.clampedToToday).toBe(false);
  });

  it("counts today's spending in today's window and not in the one before", async () => {
    const { auth, businessId } = await onboard('+2348177100002');
    await spend(businessId, 'generator fuel', 1_200_000);
    const today = lagosToday();
    const body = reportsCompareResponse.parse(
      (await get(auth, `?from=${today}&to=${today}`)).json(),
    );
    expect(body.spent.current).toBe(1_200_000);
    expect(body.spent.previous).toBe(0);
    expect(body.spent.change).toEqual({ absoluteK: 1_200_000, percent: null });
    /* Cash movement is money in less money out: here, minus the fuel. It is
     * not a profit and the response has no profit field. */
    expect(body.cashMovement.current).toBe(-1_200_000);
    expect(body).not.toHaveProperty('profit');
    expect(body.previousIsEmpty).toBe(true);
  });

  it('never counts spending from another tenant', async () => {
    const ada = await onboard('+2348177100003');
    const bola = await onboard('+2348177100004');
    await spend(ada.businessId, 'fuel', 400_000);
    await spend(bola.businessId, 'rent', 9_000_000);
    const today = lagosToday();
    const body = reportsCompareResponse.parse(
      (await get(ada.auth, `?from=${today}&to=${today}`)).json(),
    );
    expect(body.spent.current).toBe(400_000);
  });

  it('reports what the ledger holds: an opening receivable is not a sale, a fee posted to expenses is spending (G-118)', async () => {
    const { auth, businessId } = await onboard('+2348177100006');
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      businessId,
      'CUSTOMER_G118C',
      [],
    );
    await withBusiness(db, businessId, (tx) =>
      openingRepo.recordOpeningBalances(tx, {
        businessId,
        asAt: lagosToday(),
        cashK: 0,
        bankK: 0,
        stockK: 0,
        receivables: [{ customerId: customer.id, amountK: 5_000_000, dueDate: null }],
        actor: 'test',
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      journalRepo.recordJournal(tx, {
        businessId,
        memo: 'provider fee',
        amountK: 50_000,
        intoAccount: 'EXPENSES',
        outOfAccount: 'CASH',
        actor: 'user:1',
      }),
    );
    const today = lagosToday();
    const body = reportsCompareResponse.parse(
      (await get(auth, `?from=${today}&to=${today}`)).json(),
    );
    expect(body.sales.current).toBe(0);
    expect(body.spent.current).toBe(50_000);
  });

  it('stops a range that runs past today at the end of today and says so', async () => {
    const { auth } = await onboard('+2348177100005');
    /* Derived from today, so the test cannot age into the 366-day limit. */
    const start = new Date(Date.now() + 3_600_000 - 30 * 86_400_000).toISOString().slice(0, 10);
    const res = await get(auth, `?from=${start}&to=2099-12-31`);
    expect(res.statusCode).toBe(200);
    const body = reportsCompareResponse.parse(res.json());
    expect(body.clampedToToday).toBe(true);
  });

  it.each([
    ['?from=2026-10-01', 'both'],
    ['?to=2026-10-01', 'both'],
    ['?from=2026-13-01&to=2026-13-05', 'real dates'],
    ['?from=2026-10-07&to=2026-10-01', 'before'],
    ['?from=2099-01-01&to=2099-01-05', 'future'],
    ['?from=2020-01-01&to=2026-01-01', 'longer than a year'],
  ])('refuses %s with a sentence, not a crash', async (query, word) => {
    const { auth } = await onboard(
      `+23481771${String(Math.abs(hash(query)))
        .slice(0, 5)
        .padStart(5, '0')}`,
    );
    const res = await get(auth, query);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain(word);
  });
});
