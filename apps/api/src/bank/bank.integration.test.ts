/**
 * The bank surface, end to end.
 *
 * The parsing is proven in packages/core/src/bank-statement.test.ts and the
 * storage in packages/db/src/bank/bank.integration.test.ts. What this pins is the
 * border: that a stranger is refused, that an unreadable file arrives as an
 * outcome the page can explain rather than a status code, and that a
 * merchant's lines reach that merchant and nobody else.
 */
// The bank surface, end to end. Split by concern across bank*.integration.test.ts; the shared setup is in
// bank.fixtures.ts.
import { describe, expect, it } from 'vitest';
import { bankPositionResponse, importStatementResponse } from '@rekoda/contracts';
import { lagosDay } from '@rekoda/core';
import { issueRepo, withBusiness } from '@rekoda/db';
import { AUGUST, app, db, onboard, post, useBankHarness } from './bank.fixtures.js';

useBankHarness();

describe('the bank surface', () => {
  it('refuses a caller with no session', async () => {
    expect((await post('/v1/bank/statement', { csv: AUGUST })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/bank/position' })).statusCode).toBe(401);
  });

  /**
   * What the page offers against a line, and where it comes from.
   *
   * The candidates used to be a page of two hundred open movements, newest
   * first, narrowed to a line's amount in the browser. A merchant with more
   * open entries than that got no candidate at all for any line whose entry
   * sat outside the page, and nothing on the screen said why. The endpoint
   * now asks for the amounts its own lines carry, so the page it returns is
   * bounded by the lines rather than by a number nobody chose.
   */
  it('offers only entries that could pair with a line it is showing', async () => {
    const { auth } = await onboard('+2348177000079');
    await post('/v1/bank/statement', { csv: AUGUST }, auth);
    /* One entry at a statement amount and one at an amount no line carries.
     * The second can never pair with anything on this page, and sending it
     * to a browser to be filtered out there is work and exposure for
     * nothing. */
    await post(
      '/v1/reports/journal',
      {
        memo: 'Matches a line',
        amountK: 15_000_000,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
        occurredOn: '2026-08-03',
      },
      auth,
    );
    await post(
      '/v1/reports/journal',
      {
        memo: 'Matches nothing here',
        amountK: 999_000,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
        occurredOn: '2026-08-04',
      },
      auth,
    );

    const seen = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    const offered = seen.openMovements.map((m) => m.amountK);
    expect(offered).toContain(15_000_000);
    expect(offered).not.toContain(999_000);
    /* And the entry nobody was offered is still counted as unexplained: it is
     * left out of the picker, not out of the books. */
    expect(seen.reconciliation.unmatchedMovements).toBeGreaterThan(0);
  });

  it('reads a statement and reports what it did with every row', async () => {
    const { auth } = await onboard('+2348177000071');
    const first = importStatementResponse.parse(
      (await post('/v1/bank/statement', { csv: AUGUST }, auth)).json(),
    );
    /* Two movements, and the closing-balance row named rather than silently
     * swallowed: a merchant checking three lines against three rows needs to
     * know where the third went. */
    expect(first).toEqual({ outcome: 'imported', imported: 2, duplicates: 0, skipped: 1 });

    const again = importStatementResponse.parse(
      (await post('/v1/bank/statement', { csv: AUGUST }, auth)).json(),
    );
    expect(again).toEqual({ outcome: 'imported', imported: 0, duplicates: 2, skipped: 1 });
  });

  /**
   * Six different ways a statement can be unreadable, and a merchant needs to
   * be told which one. A status code cannot carry that, so it is an outcome.
   */
  it('names why a file could not be read, without failing the request', async () => {
    const { auth } = await onboard('+2348177000072');
    for (const [csv, reason] of [
      ['just some prose\n', 'no_header'],
      ['Date,Description\n03/08/2026,A\n', 'no_amount_column'],
      ['Date,Description,Amount\n25/04/2026,A,1\n04/25/2026,B,2\n', 'mixed_date_order'],
    ] as const) {
      const res = await post('/v1/bank/statement', { csv }, auth);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ outcome: 'unreadable', reason });
    }
  });

  it('refuses a body that is not a statement at all', async () => {
    const { auth } = await onboard('+2348177000073');
    expect((await post('/v1/bank/statement', {}, auth)).statusCode).toBe(400);
    expect((await post('/v1/bank/statement', { csv: '' }, auth)).statusCode).toBe(400);
  });

  it('shows the two figures apart, and the line without the bank`s words', async () => {
    const { auth } = await onboard('+2348177000074');
    await post('/v1/bank/statement', { csv: AUGUST }, auth);

    const seen = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    expect(seen.position).toMatchObject({
      ledgerK: 0,
      statementK: 13_000_000,
      differenceK: 13_000_000,
      lines: 2,
      latestOn: '2026-08-05',
    });
    /* The line the merchant sees: a day, a signed amount, and whatever
     * reference it carried. The CSV said "POS PURCHASE SHOPRITE" and quoted
     * no Rekoda reference, so there is nothing kept from that sentence. */
    expect(seen.lines[0]).toMatchObject({
      postedOn: '2026-08-05',
      amountK: -2_000_000,
      paymentReferences: [],
    });
  });

  it('takes a day back out, and lets it be imported again', async () => {
    const { auth } = await onboard('+2348177000075');
    await post('/v1/bank/statement', { csv: AUGUST }, auth);

    expect(
      (await post('/v1/bank/statement/forget', { postedOn: '2026-08-05' }, auth)).json(),
    ).toEqual({ outcome: 'forgotten', removed: 1, reversedClassifications: 0 });
    expect(
      importStatementResponse.parse(
        (await post('/v1/bank/statement', { csv: AUGUST }, auth)).json(),
      ),
    ).toMatchObject({ imported: 1, duplicates: 1 });
  });

  /**
   * A statement line is still one merchant's business even now that the
   * bank's words are gone from it: the day, the amount and the reference say
   * who paid what, and none of it may appear under another tenant's session.
   */
  it('is one tenant at a time', async () => {
    const ada = await onboard('+2348177000076');
    const bola = await onboard('+2348177000077');
    await post('/v1/bank/statement', { csv: AUGUST }, ada.auth);

    const theirs = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: bola.auth })).json(),
    );
    expect(theirs.lines).toEqual([]);
    expect(theirs.position.lines).toBe(0);
  });
});

/**
 * The whole point, in one test.
 *
 * Three features shipped separately: reading a statement, recording a payment
 * from the dashboard, and pairing the two sides. Each half is proven on its
 * own. What nothing proved until now is the SEAM, and the seam is where this
 * breaks: a payment posted to the settlement account instead of the bank
 * (ADR 0025), a day derived in UTC instead of Lagos, or a sign convention
 * that disagrees between the parser and the ledger would leave every
 * per-feature test green and the merchant's line permanently unexplained.
 *
 * This is also the story the product is sold on: your bank says money came
 * in, your books did not know, now they do, and the two agree.
 */
describe('the loop, end to end', () => {
  /* The Lagos day, derived the way the product derives it. Reading the UTC
   * date here would pass all day and fail between 23:00 and midnight UTC,
   * when Lagos has already turned over: the statement row would carry
   * yesterday and the posting today, and the rule would refuse a pair it
   * should make. A test that is wrong for one hour a day is worse than none. */
  const TODAY = lagosDay(new Date());
  const [Y, M, D] = TODAY.split('-') as [string, string, string];
  const STATEMENT = `Date,Description,Amount
${D}/${M}/${Y},TRF FROM ADEBAYO O,150000.00
`;

  it('goes from an unexplained transfer to a matched line', async () => {
    const { auth, businessId } = await onboard('+2348177000111');

    /* A sale nobody has paid for. */
    const invoiceNumber = await withBusiness(db, businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_5X1',
        items: [{ name: 'wig, 20 inch', quantity: 1, unitPriceK: 15_000_000 }],
        subtotalK: 15_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 15_000_000,
        paidK: 0,
        balanceDueK: 15_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'loop-1',
        actor: 'system',
      });
      return sale.invoiceNumber;
    });

    /* 1. The bank says money came in. The books have never heard of it. */
    await post('/v1/bank/statement', { csv: STATEMENT }, auth);
    const unexplained = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    expect(unexplained.reconciliation).toMatchObject({
      matched: 0,
      pairable: 0,
      unmatchedLines: 1,
      unmatchedLinesK: 15_000_000,
    });
    /* Nothing to offer, because there is nothing in the books to offer. */
    expect(unexplained.openMovements).toEqual([]);

    /* 2. The merchant records it, from the dashboard, against the invoice. */
    const paid = await post(
      '/v1/reports/payments/record',
      { invoiceNumber, amountK: 15_000_000, method: 'transfer' },
      auth,
    );
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ outcome: 'recorded', balanceDueK: 0 });

    /* 3. The payment is now a bank movement the rule can see. `transfer`
     *    must reach BANK and not the settlement account: a settlement has
     *    its own statement behind it and would never appear on this one. */
    const offered = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    expect(offered.openMovements).toHaveLength(1);
    expect(offered.openMovements[0]).toMatchObject({ amountK: 15_000_000, occurredOn: TODAY });
    /* And the rule can pair it on its own, which is the seam working. */
    expect(offered.reconciliation).toMatchObject({ pairable: 1, unmatchedLines: 0 });

    /* 4. Pair them. */
    expect((await post('/v1/bank/reconcile', {}, auth)).json()).toMatchObject({
      matched: 1,
      pairable: 0,
      unmatchedLines: 0,
      unmatchedMovements: 0,
    });

    /* 5. The books and the bank now agree, and say the same figure. */
    const settled = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    expect(settled.position).toMatchObject({
      ledgerK: 15_000_000,
      statementK: 15_000_000,
      differenceK: 0,
    });
    expect(settled.lines[0]!.matchedTo).toMatchObject({ decidedBy: 'auto' });
    expect(settled.reconciliation).toMatchObject({ matched: 1, unmatchedLines: 0 });
  });

  /* A cash payment is NOT a bank movement, and must never be offered as one:
   * the bank has no record of money that never went near it. */
  it('keeps cash out of the bank reconciliation', async () => {
    const { auth, businessId } = await onboard('+2348177000112');
    const invoiceNumber = await withBusiness(db, businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_5X2',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 15_000_000 }],
        subtotalK: 15_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 15_000_000,
        paidK: 0,
        balanceDueK: 15_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'loop-2',
        actor: 'system',
      });
      return sale.invoiceNumber;
    });

    await post('/v1/bank/statement', { csv: STATEMENT }, auth);
    await post(
      '/v1/reports/payments/record',
      { invoiceNumber, amountK: 15_000_000, method: 'cash' },
      auth,
    );

    const seen = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    /* The same amount, the same day, and still nothing to pair it with. */
    expect(seen.openMovements).toEqual([]);
    expect(seen.reconciliation).toMatchObject({ pairable: 0, unmatchedLines: 1 });
  });
});

describe('the feed door on a deployment with no aggregator key', () => {
  it('answers not_configured everywhere instead of pretending', async () => {
    const { auth } = await onboard('+2348177000083');
    expect(
      (await app.inject({ method: 'GET', url: '/v1/bank/feed', headers: auth })).json(),
    ).toEqual({ state: 'not_configured' });
    expect((await post('/v1/bank/feed/connect', { exchangeCode: 'code_x' }, auth)).json()).toEqual({
      outcome: 'not_configured',
    });
    expect((await post('/v1/bank/feed/sync', {}, auth)).json()).toEqual({
      outcome: 'not_configured',
    });
  });
});
