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
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

let urls: Urls;
let app: NestFastifyApplication;

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
});

afterAll(async () => {
  await app?.close();
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
    await post(
      '/v1/reports/journal',
      {
        memo: 'Nearly right',
        amountK: 14_995_000,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
        occurredOn: '2026-08-03',
      },
      auth,
    );
    const seen = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    const line = seen.lines.find((l) => l.amountK === 15_000_000)!;
    const movement = seen.openMovements[0]!;

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
