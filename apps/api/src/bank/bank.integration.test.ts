/**
 * The bank surface, end to end.
 *
 * The parsing is proven in packages/core/src/bank-statement.test.ts and the
 * storage in packages/db/src/bank.integration.test.ts. What this pins is the
 * border: that a stranger is refused, that an unreadable file arrives as an
 * outcome the page can explain rather than a status code, and that a
 * merchant's narrations reach that merchant and nobody else.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bankPositionResponse,
  importStatementResponse,
  reconcileResponse,
  matchLineResponse,
} from '@rekoda/contracts';
import { lagosDay } from '@rekoda/core';
import { createDb, issueRepo, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_REVEAL_OTP'] = '1';
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  /* This file pins the UNCONFIGURED feed posture; the configured one boots
   * its own app in feed.integration.test.ts. */
  delete process.env['MONO_SECRET_KEY'];
  delete process.env['NODE_ENV'];

  const { createApp } = await import('../main.js');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

const post = (
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method: 'POST',
    url,
    payload,
    headers: { 'content-type': 'application/json', ...headers },
  });

async function onboard(phone: string) {
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as { devCode?: string };
  const verified = (
    await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
  ).json() as {
    setupToken: string;
  };
  const created = await post(
    '/v1/businesses',
    { name: 'Mama Chidi Stores', businessType: 'Provisions & groceries' },
    { 'x-rekoda-setup-token': verified.setupToken },
  );
  const session = created.json() as { sessionToken: string; businessId: string };
  return {
    businessId: session.businessId,
    auth: { authorization: `Bearer ${session.sessionToken}` },
  };
}

const AUGUST = `Date,Description,Amount
03/08/2026,TRF FROM ADEBAYO O,150000.00
05/08/2026,POS PURCHASE SHOPRITE,-20000.00
31/08/2026,CLOSING BALANCE,
`;

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

  it('shows the two figures apart, with the bank`s own words', async () => {
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
    expect(seen.lines[0]).toMatchObject({ narration: 'POS PURCHASE SHOPRITE' });
  });

  it('takes a day back out, and lets it be imported again', async () => {
    const { auth } = await onboard('+2348177000075');
    await post('/v1/bank/statement', { csv: AUGUST }, auth);

    expect(
      (await post('/v1/bank/statement/forget', { postedOn: '2026-08-05' }, auth)).json(),
    ).toEqual({ removed: 1 });
    expect(
      importStatementResponse.parse(
        (await post('/v1/bank/statement', { csv: AUGUST }, auth)).json(),
      ),
    ).toMatchObject({ imported: 1, duplicates: 1 });
  });

  /**
   * The narration carries somebody's name. It reaches the merchant who
   * downloaded the statement and it must reach nobody else, which on this
   * surface means one tenant's lines never appearing under another's session.
   */
  it('is one tenant at a time, narrations included', async () => {
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

describe('pairing the two sides, end to end', () => {
  const AUG = `Date,Description,Amount
03/08/2026,TRF FROM ADEBAYO O,150000.00
05/08/2026,POS PURCHASE SHOPRITE,-20000.00
`;

  it('refuses a caller with no session', async () => {
    expect((await post('/v1/bank/reconcile', {})).statusCode).toBe(401);
  });

  /* A page load must never decide anything: pairing is a write. */
  it('reads the position without pairing anything', async () => {
    const { auth } = await onboard('+2348177000081');
    await post('/v1/bank/statement', { csv: AUG }, auth);

    const first = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    expect(first.reconciliation.matched).toBe(0);
    expect(first.reconciliation.pairable).toBe(0);
    expect(first.reconciliation.unmatchedLines).toBe(2);

    /* And reading it again has still stored nothing. */
    const again = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    expect(again.reconciliation.matched).toBe(0);
  });

  it('names what is left on each side when nothing can be paired', async () => {
    const { auth } = await onboard('+2348177000082');
    await post('/v1/bank/statement', { csv: AUG }, auth);

    const done = reconcileResponse.parse((await post('/v1/bank/reconcile', {}, auth)).json());
    expect(done).toMatchObject({
      matched: 0,
      unmatchedLines: 2,
      unmatchedMovements: 0,
      /* 150,000 in less 20,000 out: money the books have never heard of. */
      unmatchedLinesK: 13_000_000,
    });
  });

  /**
   * The page tells a merchant that when two entries both fit, Rekoda leaves
   * the line for them. This is the merchant taking it, through the border.
   */
  it('lets a merchant decide, and records it as their decision', async () => {
    const { auth } = await onboard('+2348177000085');
    await post('/v1/bank/statement', { csv: AUG }, auth);
    for (const memo of ['Transfer one', 'Transfer two']) {
      await post(
        '/v1/reports/journal',
        {
          memo,
          amountK: 15_000_000,
          intoAccount: 'BANK',
          outOfAccount: 'OWNERS_EQUITY',
          occurredOn: '2026-08-03',
        },
        auth,
      );
    }
    /* The rule refuses to choose. */
    expect((await post('/v1/bank/reconcile', {}, auth)).json()).toMatchObject({
      matched: 0,
      ambiguous: 1,
    });

    const before = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    const line = before.lines.find((l) => l.amountK === 15_000_000)!;
    expect(line.matchedTo).toBeNull();
    /* Both candidates offered, each carrying the journal number an accountant
     * writes down and the merchant's own words. Two identical transfers are
     * only tellable apart by what the merchant called them. */
    const options = before.openMovements.filter((m) => m.amountK === line.amountK);
    expect(options.map((o) => o.memo).sort()).toEqual([
      'JNL-2026-000001: Transfer one',
      'JNL-2026-000002: Transfer two',
    ]);

    expect(
      matchLineResponse.parse(
        (
          await post(
            '/v1/bank/match',
            { lineId: line.id, transactionId: options[0]!.transactionId },
            auth,
          )
        ).json(),
      ),
    ).toEqual({ outcome: 'matched' });

    const after = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    expect(after.lines.find((l) => l.id === line.id)!.matchedTo).toMatchObject({
      memo: options[0]!.memo,
      decidedBy: 'manual',
    });
    /* And the posting they chose is no longer on offer for anything else. */
    expect(after.openMovements.map((m) => m.transactionId)).not.toContain(
      options[0]!.transactionId,
    );
  });

  it('names why a hand-made match was refused', async () => {
    const { auth } = await onboard('+2348177000086');
    await post('/v1/bank/statement', { csv: AUG }, auth);
    /**
     * An entry that pairs with the OTHER line on this statement.
     *
     * It used to be an amount matching no line at all, taken straight off
     * `openMovements`. That stopped working when the endpoint began asking
     * only for the amounts its lines carry, and the test was the thing that
     * was wrong: the browser had always dropped such an entry before the
     * merchant saw it, so nobody could ever have clicked the refusal this
     * was covering. An entry belonging to the wrong line is one they CAN
     * click, from a stale page or a second tab, and it is the refusal that
     * has to say something.
     */
    await post(
      '/v1/reports/journal',
      {
        memo: 'The card purchase',
        amountK: 2_000_000,
        intoAccount: 'OWNERS_EQUITY',
        outOfAccount: 'BANK',
        occurredOn: '2026-08-05',
      },
      auth,
    );
    const seen = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    const line = seen.lines.find((l) => l.amountK === 15_000_000)!;
    const movement = seen.openMovements.find((m) => m.amountK === -2_000_000)!;

    const res = await post(
      '/v1/bank/match',
      { lineId: line.id, transactionId: movement.transactionId },
      auth,
    );
    expect(res.statusCode).toBe(200);
    expect(matchLineResponse.parse(res.json())).toEqual({
      outcome: 'refused',
      reason: 'amounts_differ',
    });
  });

  it('releases a match and leaves both sides as they were', async () => {
    const { auth } = await onboard('+2348177000087');
    await post('/v1/bank/statement', { csv: AUG }, auth);
    await post(
      '/v1/reports/journal',
      {
        memo: 'A transfer',
        amountK: 15_000_000,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
        occurredOn: '2026-08-03',
      },
      auth,
    );
    await post('/v1/bank/reconcile', {}, auth);

    const matched = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    const line = matched.lines.find((l) => l.matchedTo !== null)!;
    expect(line.matchedTo).toMatchObject({ decidedBy: 'auto' });

    expect((await post('/v1/bank/unmatch', { lineId: line.id }, auth)).json()).toEqual({
      released: 1,
    });

    const released = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    const same = released.lines.find((l) => l.id === line.id)!;
    expect(same.matchedTo).toBeNull();
    expect(same).toMatchObject({ amountK: line.amountK, narration: line.narration });
    expect(released.reconciliation).toMatchObject({ matched: 0, pairable: 1 });
  });

  it('refuses a caller with no session, and a body that is not a pairing', async () => {
    expect((await post('/v1/bank/match', {})).statusCode).toBe(401);
    expect((await post('/v1/bank/unmatch', {})).statusCode).toBe(401);

    const { auth } = await onboard('+2348177000088');
    expect((await post('/v1/bank/match', {}, auth)).statusCode).toBe(400);
    expect((await post('/v1/bank/match', { lineId: 'not-a-uuid' }, auth)).statusCode).toBe(400);
    expect((await post('/v1/bank/unmatch', {}, auth)).statusCode).toBe(400);
  });

  it('is one tenant at a time', async () => {
    const ada = await onboard('+2348177000083');
    const bola = await onboard('+2348177000084');
    await post('/v1/bank/statement', { csv: AUG }, ada.auth);
    await post('/v1/bank/reconcile', {}, ada.auth);

    expect((await post('/v1/bank/reconcile', {}, bola.auth)).json()).toMatchObject({
      matched: 0,
      unmatchedLines: 0,
    });
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
