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
import {
  bankPositionResponse,
  classifyLineResponse,
  reconcileResponse,
  matchLineResponse,
} from '@rekoda/contracts';
import { app, onboard, post, useBankHarness } from './bank.fixtures.js';

useBankHarness();

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

  it('classifies what the books do not explain: judgement and pairing in one door (§22.2)', async () => {
    const { auth } = await onboard('+2348177000092');
    await post('/v1/bank/statement', { csv: AUG }, auth);

    const before = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    const line = before.lines.find((l) => l.amountK === 15_000_000)!;
    expect(line.matchedTo).toBeNull();

    const classified = classifyLineResponse.parse(
      (
        await post(
          '/v1/bank/classify',
          { lineId: line.id, classification: 'OWNER_CAPITAL', note: 'my savings' },
          auth,
        )
      ).json(),
    );
    expect(classified).toEqual({ outcome: 'classified', journalNumber: 'JNL-2026-000001' });

    /* The line now carries the merchant's judgement as a tier-4 decision
     * with their words on it, and the journal it implied is the match. */
    const after = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    expect(after.lines.find((l) => l.id === line.id)!.matchedTo).toMatchObject({
      decidedBy: 'manual',
      tier: 4,
      reason: 'Classified as owner capital: my savings',
      memo: 'JNL-2026-000001: Owner capital: my savings',
    });

    /* Saying it twice is refused, not doubled. */
    expect(
      classifyLineResponse.parse(
        (
          await post(
            '/v1/bank/classify',
            { lineId: line.id, classification: 'OWNER_CAPITAL' },
            auth,
          )
        ).json(),
      ),
    ).toEqual({ outcome: 'refused', reason: 'line_already_matched' });
  });

  /* Build 9: a line released and classified again is classified again: a
   * new journal and a new match, never a replay of the first answer. Since
   * G-95 the release reverses the first journal; the money is asserted in
   * the "releasing a classification (G-95)" block below. */
  it('classifies a released line again, with a new journal and a new match', async () => {
    const { auth } = await onboard('+2348177000093');
    await post('/v1/bank/statement', { csv: AUG }, auth);
    const before = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    const line = before.lines.find((l) => l.amountK === 15_000_000)!;
    const classify = async () =>
      classifyLineResponse.parse(
        (
          await post(
            '/v1/bank/classify',
            { lineId: line.id, classification: 'OWNER_CAPITAL' },
            auth,
          )
        ).json(),
      );

    expect(await classify()).toEqual({ outcome: 'classified', journalNumber: 'JNL-2026-000001' });
    expect((await post('/v1/bank/unmatch', { lineId: line.id }, auth)).json()).toEqual({
      outcome: 'released_classification',
      released: 1,
    });
    expect(await classify()).toEqual({ outcome: 'classified', journalNumber: 'JNL-2026-000002' });

    const after = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    expect(after.lines.find((l) => l.id === line.id)!.matchedTo).toMatchObject({
      memo: expect.stringContaining('JNL-2026-000002'),
    });
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
      outcome: 'released_match',
      released: 1,
    });

    const released = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    const same = released.lines.find((l) => l.id === line.id)!;
    expect(same.matchedTo).toBeNull();
    expect(same).toMatchObject({
      amountK: line.amountK,
      paymentReferences: line.paymentReferences,
      bankRef: line.bankRef,
    });
    expect(released.reconciliation).toMatchObject({ matched: 0, pairable: 1 });
  });

  /* Build 9: a hand match released and made again is made again. The pair is
   * not a request: a replay of the first "matched" would leave it unmatched. */
  it('matches a released pair again by hand, and it is matched', async () => {
    const { auth } = await onboard('+2348177000088');
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
    const seen = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    const line = seen.lines.find((l) => l.amountK === 15_000_000)!;
    const movement = seen.openMovements.find((m) => m.amountK === 15_000_000)!;
    const match = async () =>
      matchLineResponse.parse(
        (
          await post(
            '/v1/bank/match',
            { lineId: line.id, transactionId: movement.transactionId },
            auth,
          )
        ).json(),
      );

    expect(await match()).toMatchObject({ outcome: 'matched' });
    expect((await post('/v1/bank/unmatch', { lineId: line.id }, auth)).json()).toEqual({
      outcome: 'released_match',
      released: 1,
    });
    expect(await match()).toMatchObject({ outcome: 'matched' });

    const after = bankPositionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
    );
    expect(after.lines.find((l) => l.id === line.id)!.matchedTo).not.toBeNull();
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
