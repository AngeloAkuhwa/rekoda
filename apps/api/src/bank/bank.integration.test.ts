/**
 * The bank surface, end to end.
 *
 * The parsing is proven in packages/core/src/bank-statement.test.ts and the
 * storage in packages/db/src/bank.integration.test.ts. What this pins is the
 * border: that a stranger is refused, that an unreadable file arrives as an
 * outcome the page can explain rather than a status code, and that a
 * merchant's lines reach that merchant and nobody else.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bankPositionResponse,
  classifyLineResponse,
  importStatementResponse,
  reconcileResponse,
  matchLineResponse,
  unmatchLineResponse,
} from '@rekoda/contracts';
import { KEY_BY_CODE, lagosDay, postJournal, reversal, type AccountKey } from '@rekoda/core';
import {
  bankRepo,
  closeRepo,
  createDb,
  issueRepo,
  sql,
  withBusiness,
  type Db,
  type TenantDb,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  CLASSIFICATIONS,
  confirmReconciliationWork,
  prepareClassification,
  type Classification,
} from '../commands/bank-commands.js';
import { postJournalWork } from '../commands/ledger-commands.js';
import { CONFIG, type ApiConfig } from '../config.js';

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

/* Shared by the classification suites below (G-95 release, G-97 forget):
 * they assert the money, not the number of journals. */
const ONE_CREDIT = `Date,Description,Amount
03/08/2026,TRF FROM ADEBAYO O,150000.00
`;
const CREDIT_AND_DEBIT = `Date,Description,Amount
03/08/2026,TRF FROM ADEBAYO O,150000.00
05/08/2026,POS PURCHASE SHOPRITE,-20000.00
`;

/** Each account's net (debit minus credit) in kobo, keyed by chart key. */
async function nets(businessId: string): Promise<Partial<Record<AccountKey, number>>> {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ code: string; net: string }>(sql`
        SELECT a.code, SUM(e.debit_k - e.credit_k)::bigint AS net
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid
        GROUP BY a.code
      `),
  );
  return Object.fromEntries(
    [...rows]
      .filter((r) => Number(r.net) !== 0)
      .map((r) => [KEY_BY_CODE[r.code] ?? r.code, Number(r.net)]),
  );
}

/** Every posting's provenance, oldest first. */
async function postings(businessId: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{
      id: string;
      source_type: string;
      source_id: string | null;
      reverses_id: string | null;
      month: string;
    }>(sql`
        SELECT id, source_type, source_id, reverses_id,
               to_char(created_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM') AS month
        FROM ledger_transactions WHERE business_id = ${businessId}::uuid
        ORDER BY created_at, id
      `),
  );
  return [...rows];
}

/** What the audit trail says happened to the pairing. */
async function releaseAudits(businessId: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ action: string; old_value: unknown; new_value: unknown }>(sql`
        SELECT action, old_value, new_value FROM audit_events
        WHERE business_id = ${businessId}::uuid AND entity = 'bank_line_match'
          AND action IN ('released', 'classification_released')
        ORDER BY created_at, id
      `),
  );
  return [...rows];
}

async function position(auth: Record<string, string>) {
  return bankPositionResponse.parse(
    (await app.inject({ method: 'GET', url: '/v1/bank/position', headers: auth })).json(),
  );
}

const matchedTo = async (auth: Record<string, string>, lineId: string) =>
  (await position(auth)).lines.find((l) => l.id === lineId)!.matchedTo;

const classify = async (
  auth: Record<string, string>,
  lineId: string,
  classification: Classification = 'OWNER_CAPITAL',
) =>
  classifyLineResponse.parse(
    (await post('/v1/bank/classify', { lineId, classification }, auth)).json(),
  );

const release = async (auth: Record<string, string>, lineId: string) =>
  unmatchLineResponse.parse((await post('/v1/bank/unmatch', { lineId }, auth)).json());

/** One statement, one business, the line of the amount asked for. */
async function setUp(phone: string, csv = ONE_CREDIT, amountK = 15_000_000) {
  const { businessId, auth } = await onboard(phone);
  await post('/v1/bank/statement', { csv }, auth);
  const line = (await position(auth)).lines.find((l) => l.amountK === amountK)!;
  return { businessId, auth, line };
}

/**
 * A transaction held open after its work, so a second one can be started
 * against it for real rather than run one after the other.
 */
const held: (() => void)[] = [];
/* A test that fails while holding a transaction must not hold it into the
 * next test: every gate opens when the test ends, pass or fail. */
afterEach(() => {
  for (const letGo of held.splice(0)) letGo();
});

function holdOpen<T>(businessId: string, work: (tx: TenantDb) => Promise<T>) {
  let letGo!: () => void;
  const gate = new Promise<void>((resolve) => (letGo = resolve));
  held.push(letGo);
  let reached!: (value: T) => void;
  const workDone = new Promise<T>((resolve) => (reached = resolve));
  const committed = withBusiness(db, businessId, async (tx) => {
    const value = await work(tx);
    reached(value);
    await gate;
    return value;
  });
  return {
    ready: Promise.race([workDone, committed]),
    commit: () => {
      letGo();
      return committed;
    },
  };
}

/* Long enough for the second transaction to reach the lock it waits on. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/** Whether `pending` is still waiting after a settle: proof of overlap. */
const stillWaiting = (pending: Promise<unknown>) =>
  Promise.race([pending.then(() => false), settle().then(() => true)]);

/**
 * Releasing a classification (G-95, OD-24 Option A).
 *
 * A classification is not a pairing of two facts that existed apart: the
 * journal exists BECAUSE the merchant said what this line was. Releasing it
 * used to unpair the line and leave that journal standing, so classifying
 * the line again booked the same money a second time. These tests assert
 * the money, not the number of journals.
 */
describe('releasing a classification (G-95)', () => {
  it('books one bank credit once after it is classified, released and classified again', async () => {
    const { businessId, auth, line } = await setUp('+2348177000201');
    expect(await nets(businessId)).toEqual({});

    expect(await classify(auth, line.id)).toMatchObject({ outcome: 'classified' });
    const first = (await matchedTo(auth, line.id))!;
    expect(await nets(businessId)).toEqual({ BANK: 15_000_000, OWNERS_EQUITY: -15_000_000 });

    expect((await post('/v1/bank/unmatch', { lineId: line.id }, auth)).json()).toMatchObject({
      released: 1,
    });
    expect(await matchedTo(auth, line.id)).toBeNull();

    expect(await classify(auth, line.id)).toMatchObject({ outcome: 'classified' });
    const second = (await matchedTo(auth, line.id))!;
    expect(second.transactionId).not.toBe(first.transactionId);

    /* One ₦150,000 credit: the bank went up ₦150,000 and the owner put in
     * ₦150,000. Not ₦300,000 of either. */
    expect(await nets(businessId)).toEqual({ BANK: 15_000_000, OWNERS_EQUITY: -15_000_000 });

    /* Structurally: the first journal, its reversal, and the second. Both
     * classifications carry the line's day; the reversal is today's. */
    const rows = await postings(businessId);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.transactionId, reverses_id: null }),
        expect.objectContaining({ reverses_id: first.transactionId }),
        expect.objectContaining({ id: second.transactionId, reverses_id: null }),
      ]),
    );
  });

  /* B */
  it('reverses the journal it wrote, exactly, and leaves the line unmatched', async () => {
    const { businessId, auth, line } = await setUp('+2348177000202');
    expect(await classify(auth, line.id)).toEqual({
      outcome: 'classified',
      journalNumber: 'JNL-2026-000001',
    });
    const original = (await matchedTo(auth, line.id))!;

    expect(await release(auth, line.id)).toEqual({
      outcome: 'released_classification',
      released: 1,
    });
    expect(await matchedTo(auth, line.id)).toBeNull();
    /* Back to the books before the classification: nothing, net. */
    expect(await nets(businessId)).toEqual({});

    const [kept, reversal] = await postings(businessId);
    /* The classification is the line's own, by provenance, not by memo. */
    expect(kept).toMatchObject({
      id: original.transactionId,
      source_type: 'bank_classification',
      source_id: line.id,
      reverses_id: null,
      month: '2026-08',
    });
    expect(reversal).toMatchObject({
      source_type: 'bank_classification',
      source_id: line.id,
      reverses_id: original.transactionId,
    });

    /* The original is untouched: its own two lines, still there. */
    const entries = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ transaction_id: string; code: string; debit_k: string; credit_k: string }>(sql`
        SELECT e.transaction_id, a.code, e.debit_k, e.credit_k
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid ORDER BY e.transaction_id, a.code
      `),
    );
    const of = (id: string) =>
      [...entries]
        .filter((e) => e.transaction_id === id)
        .map((e) => [KEY_BY_CODE[e.code], Number(e.debit_k), Number(e.credit_k)]);
    expect(of(original.transactionId)).toEqual(
      expect.arrayContaining([
        ['BANK', 15_000_000, 0],
        ['OWNERS_EQUITY', 0, 15_000_000],
      ]),
    );
    expect(of(reversal!.id)).toEqual(
      expect.arrayContaining([
        ['BANK', 0, 15_000_000],
        ['OWNERS_EQUITY', 15_000_000, 0],
      ]),
    );

    /* The journal number is still minted, still on the memo and the draft. */
    const draft = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ memo: string; created_by: string; lines: number }>(sql`
        SELECT d.memo, d.created_by,
               (SELECT count(*)::int FROM journal_draft_lines l WHERE l.draft_id = d.id) AS lines
        FROM journal_drafts d
        WHERE d.business_id = ${businessId}::uuid AND d.posted_journal_id = ${original.transactionId}::uuid
      `),
    );
    expect([...draft]).toEqual([
      {
        memo: 'JNL-2026-000001: Owner capital',
        created_by: expect.stringMatching(/^user:/),
        lines: 2,
      },
    ]);

    /* And the trail names both postings, so the release can be traced. */
    expect(await releaseAudits(businessId)).toEqual([
      {
        action: 'classification_released',
        old_value: { transactionId: original.transactionId },
        new_value: {
          lineId: line.id,
          originalLedgerTransactionId: original.transactionId,
          reversalLedgerTransactionId: reversal!.id,
        },
      },
    ]);
  });

  /* A */
  it('releases an ordinary match without touching the posting', async () => {
    const { businessId, auth, line } = await setUp('+2348177000203');
    await post(
      '/v1/reports/journal',
      {
        /* Written to look like a classification. Identity is the ledger's
         * provenance, never the words, so this is still an ordinary entry. */
        memo: 'Owner capital',
        amountK: 15_000_000,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
        occurredOn: '2026-08-03',
      },
      auth,
    );
    const [entry] = await postings(businessId);
    /* A journal somebody wrote keeps the journal's own provenance. */
    expect(entry).toMatchObject({ source_type: 'journal', source_id: 'JNL-2026-000001' });
    expect(
      (await post('/v1/bank/match', { lineId: line.id, transactionId: entry!.id }, auth)).json(),
    ).toEqual({ outcome: 'matched' });
    const before = await nets(businessId);

    expect(await release(auth, line.id)).toEqual({ outcome: 'released_match', released: 1 });
    expect(await matchedTo(auth, line.id)).toBeNull();
    expect(await nets(businessId)).toEqual(before);
    expect(await postings(businessId)).toEqual([entry]);
    expect(await releaseAudits(businessId)).toEqual([
      { action: 'released', old_value: { transactionId: entry!.id }, new_value: null },
    ]);
    /* Still there to be matched again, because it is still a real entry. */
    expect((await position(auth)).openMovements.map((m) => m.transactionId)).toContain(entry!.id);
  });

  /* The provenance is the server's: a merchant cannot send it. */
  it('does not let the journal form claim to be a classification', async () => {
    const { businessId, auth, line } = await setUp('+2348177000204');
    await post(
      '/v1/reports/journal',
      {
        memo: 'Pretending',
        amountK: 15_000_000,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
        occurredOn: '2026-08-03',
        origin: { kind: 'bank_classification', lineId: line.id },
        sourceType: 'bank_classification',
        sourceId: line.id,
      },
      auth,
    );
    const [entry] = await postings(businessId);
    expect(entry).toMatchObject({ source_type: 'journal', source_id: 'JNL-2026-000001' });

    await post('/v1/bank/match', { lineId: line.id, transactionId: entry!.id }, auth);
    expect(await release(auth, line.id)).toMatchObject({ outcome: 'released_match' });
    expect(await postings(businessId)).toHaveLength(1);
  });

  /* B, C, D, E: every classification, both directions. The expected journal
   * comes from the classify door's own builder, never from this test. */
  it.each([
    ['OWNER_CAPITAL', 15_000_000],
    ['SUPPLIER_REFUND', 15_000_000],
    ['INTERNAL_TRANSFER', 15_000_000],
    ['OWNER_CAPITAL', -2_000_000],
    ['SUPPLIER_REFUND', -2_000_000],
    ['INTERNAL_TRANSFER', -2_000_000],
  ] as const)(
    'reverses a %s classification of a %i kobo line exactly, and classifies it again once',
    async (classification, amountK) => {
      const phone = `+23481770003${String(Object.keys(CLASSIFICATIONS).indexOf(classification))}${amountK > 0 ? 1 : 2}`;
      const { businessId, auth, line } = await setUp(phone, CREDIT_AND_DEBIT, amountK);

      const prepared = await withBusiness(db, businessId, (tx) =>
        prepareClassification(tx, { businessId, lineId: line.id, classification, actor: 'test' }),
      );
      if (prepared.outcome !== 'ready') throw new Error(prepared.outcome);
      const once = {
        [prepared.journal.intoAccount]: prepared.journal.amountK,
        [prepared.journal.outOfAccount]: -prepared.journal.amountK,
      };
      /* The sign is the line's: a debit line moves money OUT of the bank. */
      expect(once['BANK']).toBe(amountK);

      expect(await classify(auth, line.id, classification)).toMatchObject({
        outcome: 'classified',
      });
      expect(await nets(businessId)).toEqual(once);

      expect(await release(auth, line.id)).toMatchObject({
        outcome: 'released_classification',
      });
      expect(await nets(businessId)).toEqual({});

      expect(await classify(auth, line.id, classification)).toMatchObject({
        outcome: 'classified',
      });
      expect(await nets(businessId)).toEqual(once);
    },
  );

  /* F */
  it('reverses once however many times it is released', async () => {
    const { businessId, auth, line } = await setUp('+2348177000205');
    await classify(auth, line.id);
    expect(await release(auth, line.id)).toMatchObject({ outcome: 'released_classification' });
    expect(await release(auth, line.id)).toEqual({ outcome: 'not_matched', released: 0 });
    expect(await release(auth, line.id)).toEqual({ outcome: 'not_matched', released: 0 });
    expect((await postings(businessId)).filter((p) => p.reverses_id !== null)).toHaveLength(1);
    expect(await nets(businessId)).toEqual({});
  });

  /* G */
  it('reverses once when two releases arrive together', async () => {
    const { businessId, auth, line } = await setUp('+2348177000206');
    await classify(auth, line.id);

    const first = holdOpen(businessId, (tx) =>
      bankRepo.releaseLine(tx, { businessId, lineId: line.id, actor: 'user:first' }),
    );
    expect(await first.ready).toMatchObject({ outcome: 'released_classification' });
    /* The second, through the real door, waits on the first's claim. */
    const second = release(auth, line.id);
    expect(await stillWaiting(second)).toBe(true);
    await first.commit();

    expect(await second).toEqual({ outcome: 'not_matched', released: 0 });
    expect((await postings(businessId)).filter((p) => p.reverses_id !== null)).toHaveLength(1);
    expect(await nets(businessId)).toEqual({});
  });

  /* H */
  it('does not classify a line again while its release is still in flight', async () => {
    const { businessId, auth, line } = await setUp('+2348177000207');
    await classify(auth, line.id);

    const releasing = holdOpen(businessId, (tx) =>
      bankRepo.releaseLine(tx, { businessId, lineId: line.id, actor: 'user:first' }),
    );
    await releasing.ready;
    /* A classification takes turns with the release (G-97 put every pairing
     * under one lock): it waits rather than reading a line mid-release. */
    const classifying = classify(auth, line.id);
    expect(await stillWaiting(classifying)).toBe(true);
    await releasing.commit();

    /* Once the release has committed, the classification is one journal. */
    expect(await classifying).toMatchObject({ outcome: 'classified' });
    expect(await nets(businessId)).toEqual({ BANK: 15_000_000, OWNERS_EQUITY: -15_000_000 });
    expect((await postings(businessId)).filter((p) => p.reverses_id !== null)).toHaveLength(1);
  });

  /* I */
  it('ends with one pairing when a hand match races the release', async () => {
    const { businessId, auth, line } = await setUp('+2348177000209');
    await post(
      '/v1/reports/journal',
      {
        memo: 'What it really was',
        amountK: 15_000_000,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
        occurredOn: '2026-08-03',
      },
      auth,
    );
    const [written] = await postings(businessId);
    await classify(auth, line.id);

    const releasing = holdOpen(businessId, (tx) =>
      bankRepo.releaseLine(tx, { businessId, lineId: line.id, actor: 'user:first' }),
    );
    await releasing.ready;
    const matching = post('/v1/bank/match', { lineId: line.id, transactionId: written!.id }, auth);
    expect(await stillWaiting(matching)).toBe(true);
    await releasing.commit();

    expect((await matching).json()).toEqual({ outcome: 'matched' });
    expect((await matchedTo(auth, line.id))!.transactionId).toBe(written!.id);
    /* The classification is reversed; the hand-written entry is what explains
     * the line now. One ₦150,000 of each, not two. */
    expect(await nets(businessId)).toEqual({ BANK: 15_000_000, OWNERS_EQUITY: -15_000_000 });
  });

  /* J, and L's refusal: the reversal is dated today, and today closed. */
  it('changes nothing when the reversal cannot be written', async () => {
    const { businessId, auth, line } = await setUp('+2348177000210');
    await classify(auth, line.id);
    const original = (await matchedTo(auth, line.id))!;
    const before = await nets(businessId);
    /* Close the month we are in, through the real close, from a future
     * vantage point; the release's reversal then falls in a closed month. */
    const thisMonth = lagosDay(new Date()).slice(0, 7);
    await withBusiness(db, businessId, (tx) =>
      closeRepo.closeBooks(tx, {
        businessId,
        through: thisMonth,
        actor: 'user:test',
        now: new Date('2099-01-15T12:00:00Z'),
      }),
    );

    expect(await release(auth, line.id)).toEqual({
      outcome: 'period_closed',
      released: 0,
      closedThrough: thisMonth,
    });
    expect((await matchedTo(auth, line.id))!.transactionId).toBe(original.transactionId);
    expect(await nets(businessId)).toEqual(before);
    expect(await postings(businessId)).toHaveLength(1);
    expect(await releaseAudits(businessId)).toEqual([]);
  });

  /* L: the original sits in a closed month; the correction is today's. */
  it('reverses a classification from a closed month today, leaving the month alone', async () => {
    const { businessId, auth, line } = await setUp('+2348177000211');
    await classify(auth, line.id);
    await withBusiness(db, businessId, (tx) =>
      closeRepo.closeBooks(tx, { businessId, through: '2026-08', actor: 'user:test' }),
    );

    expect(await release(auth, line.id)).toMatchObject({ outcome: 'released_classification' });
    const [original, reversal] = await postings(businessId);
    expect(original).toMatchObject({ month: '2026-08', reverses_id: null });
    expect(reversal).toMatchObject({
      month: lagosDay(new Date()).slice(0, 7),
      reverses_id: original!.id,
    });
    expect(await nets(businessId)).toEqual({});
  });

  /* Reviewer B, P2-1: the id is matched to the uuid column whatever its
   * case, and the classification must be recognised the same way. */
  it('reverses a classification released with the line id in capitals', async () => {
    const { businessId, auth, line } = await setUp('+2348177000216');
    await classify(auth, line.id);
    const original = (await matchedTo(auth, line.id))!;

    expect(await release(auth, line.id.toUpperCase())).toEqual({
      outcome: 'released_classification',
      released: 1,
    });
    expect(await nets(businessId)).toEqual({});
    const reversal = (await postings(businessId)).find((p) => p.reverses_id !== null)!;
    /* Recorded under the line's own id, as the database spells it. */
    expect(reversal).toMatchObject({ source_id: line.id, reverses_id: original.transactionId });
    expect(await classify(auth, line.id)).toMatchObject({ outcome: 'classified' });
    expect(await nets(businessId)).toEqual({ BANK: 15_000_000, OWNERS_EQUITY: -15_000_000 });
  });

  /* Reviewer B, P2-2: a reconcile that read the books before the release
   * and the pairings after it would pair the line with the journal being
   * reversed. They take turns, and the reconcile sees the release whole. */
  it('does not let a reconcile pair the line with the journal being reversed', async () => {
    const { businessId, auth, line } = await setUp('+2348177000217');
    await classify(auth, line.id);

    const releasing = holdOpen(businessId, (tx) =>
      bankRepo.releaseLine(tx, { businessId, lineId: line.id, actor: 'user:first' }),
    );
    expect(await releasing.ready).toMatchObject({ outcome: 'released_classification' });
    const reconciling = post('/v1/bank/reconcile', {}, auth);
    expect(await stillWaiting(reconciling)).toBe(true);
    await releasing.commit();

    expect((await reconciling).statusCode).toBe(200);
    expect(await matchedTo(auth, line.id)).toBeNull();
    expect(await nets(businessId)).toEqual({});
    /* And the line can still be classified, once. */
    expect(await classify(auth, line.id)).toMatchObject({ outcome: 'classified' });
    expect(await nets(businessId)).toEqual({ BANK: 15_000_000, OWNERS_EQUITY: -15_000_000 });
  });

  /* K */
  it('cannot release another business`s line', async () => {
    const mine = await setUp('+2348177000212');
    const theirs = await setUp('+2348177000213');
    await classify(mine.auth, mine.line.id);

    expect(await release(theirs.auth, mine.line.id)).toEqual({
      outcome: 'not_matched',
      released: 0,
    });
    /* Even naming this business in the call, the session's tenant decides. */
    expect(
      await withBusiness(db, theirs.businessId, (tx) =>
        bankRepo.releaseLine(tx, {
          businessId: theirs.businessId,
          lineId: mine.line.id,
          actor: 'user:theirs',
        }),
      ),
    ).toEqual({ outcome: 'not_matched' });

    expect(await matchedTo(mine.auth, mine.line.id)).not.toBeNull();
    expect(await nets(mine.businessId)).toEqual({
      BANK: 15_000_000,
      OWNERS_EQUITY: -15_000_000,
    });
    expect(await postings(theirs.businessId)).toEqual([]);
  });

  /* M */
  it('keeps a released classification and its reversal off the reconciliation', async () => {
    const { auth, line } = await setUp('+2348177000214');
    await classify(auth, line.id);
    const original = (await matchedTo(auth, line.id))!;
    await release(auth, line.id);

    const seen = await position(auth);
    expect(seen.openMovements).toEqual([]);
    expect(seen.reconciliation).toMatchObject({ unmatchedMovements: 0, unmatchedLines: 1 });
    /* Nor can the reversed journal be picked to explain the line. */
    expect(
      (
        await post(
          '/v1/bank/match',
          { lineId: line.id, transactionId: original.transactionId },
          auth,
        )
      ).json(),
    ).toEqual({ outcome: 'refused', reason: 'no_such_movement' });
  });

  /* N */
  it('leaves every other reversed bank posting exactly as visible as before', async () => {
    const { businessId, auth } = await setUp('+2348177000215');
    /* A bank payment and its void, through the same reversal convention the
     * voids use: neither is a classification, so both stay on the page. */
    const [paid, voided] = await withBusiness(db, businessId, async (tx) => {
      const paidId = await issueRepo.writePosting(
        tx,
        businessId,
        postJournal({
          memo: 'Expense: generator fuel',
          amountK: 500_000,
          intoAccount: 'EXPENSES',
          outOfAccount: 'BANK',
        }),
        'dashboard',
        'expense-1',
      );
      const voidId = await issueRepo.writePosting(
        tx,
        businessId,
        reversal(
          postJournal({
            memo: 'Expense: generator fuel',
            amountK: 500_000,
            intoAccount: 'EXPENSES',
            outOfAccount: 'BANK',
          }),
          'Void expense: generator fuel',
        ),
        'dashboard',
        'expense-1',
        { reversesId: paidId },
      );
      return [paidId, voidId];
    });

    const open = await withBusiness(db, businessId, (tx) => bankRepo.openMovements(tx, businessId));
    expect(open.map((m) => m.transactionId).sort()).toEqual([paid, voided].sort());
    expect((await position(auth)).reconciliation).toMatchObject({ unmatchedMovements: 2 });
  });

  /* O: the classify door above ran on the bus, as Build 9 made the default. */
  it('ran every classification here through the command bus', () => {
    const config = app.get<ApiConfig>(CONFIG);
    expect(config.commandPostJournal).toBe(true);
    expect(config.commandConfirmReconciliation).toBe(true);
  });
});

/**
 * Forgetting a statement day that holds a classification (G-97).
 *
 * Forgetting deletes the day's lines and their matches go with them. A
 * classification's journal exists only because a line was classified, so it
 * used to outlive the evidence that created it: re-import the same day,
 * classify the fresh line, and one physical movement was booked twice.
 */
describe('forgetting a statement day (G-97)', () => {
  const forget = async (auth: Record<string, string>, postedOn: string) =>
    (await post('/v1/bank/statement/forget', { postedOn }, auth)).json() as Record<string, unknown>;

  it('books one bank credit once after it is classified, forgotten, re-imported and classified again', async () => {
    const { businessId, auth, line } = await setUp('+2348177000401');
    expect(await classify(auth, line.id)).toMatchObject({ outcome: 'classified' });
    expect(await nets(businessId)).toEqual({ BANK: 15_000_000, OWNERS_EQUITY: -15_000_000 });

    expect(await forget(auth, '2026-08-03')).toMatchObject({ removed: 1 });

    expect(
      importStatementResponse.parse(
        (await post('/v1/bank/statement', { csv: ONE_CREDIT }, auth)).json(),
      ),
    ).toMatchObject({ imported: 1, duplicates: 0 });
    const again = (await position(auth)).lines.find((l) => l.amountK === 15_000_000)!;
    expect(again.id).not.toBe(line.id);
    expect(await classify(auth, again.id)).toMatchObject({ outcome: 'classified' });

    /* One ₦150,000 credit, one owner contribution. Not ₦300,000 of either. */
    expect(await nets(businessId)).toEqual({ BANK: 15_000_000, OWNERS_EQUITY: -15_000_000 });

    /* Structurally: the first classification, its reversal under the
     * forgotten line's id, and the current one under the fresh line's. */
    const rows = await postings(businessId);
    expect(rows).toHaveLength(3);
    /* Found by structure: both classifications carry their line's day, so
     * the order of creation says nothing here. */
    const first = rows.find((r) => r.source_id === line.id && r.reverses_id === null);
    const reversalOfFirst = rows.find((r) => r.reverses_id !== null);
    const current = rows.find((r) => r.source_id === again.id);
    expect(first).toMatchObject({ source_type: 'bank_classification', source_id: line.id });
    expect(reversalOfFirst).toMatchObject({
      source_type: 'bank_classification',
      source_id: line.id,
      reverses_id: first!.id,
    });
    expect(current).toMatchObject({ source_id: again.id, reverses_id: null });
    expect((await matchedTo(auth, again.id))!.transactionId).toBe(current!.id);
    /* The forgotten pair is off the reconciliation: nothing left to explain. */
    expect((await position(auth)).reconciliation).toMatchObject({
      unmatchedMovements: 0,
      unmatchedLines: 0,
    });
  });

  /** The day's lines, as the database holds them. */
  async function linesOn(businessId: string, postedOn: string) {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT id FROM bank_statement_lines
        WHERE business_id = ${businessId}::uuid AND posted_on = ${postedOn}::date ORDER BY id
      `),
    );
    return [...rows].map((r) => r.id);
  }

  async function matchCount(businessId: string) {
    const [row] = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM bank_line_matches WHERE business_id = ${businessId}::uuid
      `),
    );
    return row!.n;
  }

  /** The forget audit rows, stored values as written. */
  async function forgetAudits(businessId: string) {
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ entity_id: string; new_value: Record<string, unknown> }>(sql`
        SELECT entity_id, new_value FROM audit_events
        WHERE business_id = ${businessId}::uuid AND entity = 'bank_statement'
          AND action = 'forgotten'
        ORDER BY created_at, id
      `),
    );
    return [...rows];
  }

  /** The classify door's own work, in a transaction the test holds open. */
  async function classifyIn(tx: TenantDb, businessId: string, lineId: string) {
    const prepared = await prepareClassification(tx, {
      businessId,
      lineId,
      classification: 'OWNER_CAPITAL',
      actor: 'user:held',
    });
    if (prepared.outcome !== 'ready') throw new Error(prepared.reason);
    const posted = await postJournalWork(tx, prepared.journal);
    return confirmReconciliationWork(tx, {
      businessId,
      lineId,
      transactionId: posted.ledgerTransactionId,
      actor: 'user:held',
      reason: prepared.reason,
    });
  }

  /* A */
  it('forgets an unmatched day and touches no posting', async () => {
    const { businessId, auth } = await setUp('+2348177000402');
    expect(await forget(auth, '2026-08-03')).toEqual({
      outcome: 'forgotten',
      removed: 1,
      reversedClassifications: 0,
    });
    expect(await linesOn(businessId, '2026-08-03')).toEqual([]);
    expect(await postings(businessId)).toEqual([]);
    expect(await forgetAudits(businessId)).toEqual([
      { entity_id: '2026-08-03', new_value: { removed: 1, reversedClassifications: 0 } },
    ]);
  });

  /* B, P: an entry that existed apart from the statement is never reversed,
   * even a hand-written journal that reads exactly like a classification
   * (the same shape a pre-G-95 classification has: `journal`, no line). */
  it('leaves an ordinarily matched posting untouched, even one worded like a classification', async () => {
    const { businessId, auth, line } = await setUp('+2348177000403');
    await post(
      '/v1/reports/journal',
      {
        memo: 'Owner capital',
        amountK: 15_000_000,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
        occurredOn: '2026-08-03',
      },
      auth,
    );
    const [entry] = await postings(businessId);
    expect(entry).toMatchObject({ source_type: 'journal' });
    await post('/v1/bank/match', { lineId: line.id, transactionId: entry!.id }, auth);
    const before = await nets(businessId);

    expect(await forget(auth, '2026-08-03')).toEqual({
      outcome: 'forgotten',
      removed: 1,
      reversedClassifications: 0,
    });
    expect(await matchCount(businessId)).toBe(0);
    expect(await nets(businessId)).toEqual(before);
    expect(await postings(businessId)).toEqual([entry]);
    /* Still a real entry, so it is an open movement again, waiting for a line. */
    const open = await withBusiness(db, businessId, (tx) => bankRepo.openMovements(tx, businessId));
    expect(open.map((m) => m.transactionId)).toContain(entry!.id);
  });

  /* C, D, E: each classification, both directions, reversed from its stored
   * entries; the expected journal is the classify door's own. */
  it.each([
    ['OWNER_CAPITAL', 15_000_000, '2026-08-03'],
    ['SUPPLIER_REFUND', 15_000_000, '2026-08-03'],
    ['INTERNAL_TRANSFER', 15_000_000, '2026-08-03'],
    ['OWNER_CAPITAL', -2_000_000, '2026-08-05'],
    ['SUPPLIER_REFUND', -2_000_000, '2026-08-05'],
    ['INTERNAL_TRANSFER', -2_000_000, '2026-08-05'],
  ] as const)(
    'reverses a %s classification of a %i kobo line when its day is forgotten',
    async (classification, amountK, day) => {
      const phone = `+23481770005${String(Object.keys(CLASSIFICATIONS).indexOf(classification))}${amountK > 0 ? 1 : 2}`;
      const { businessId, auth, line } = await setUp(phone, CREDIT_AND_DEBIT, amountK);
      expect(await classify(auth, line.id, classification)).toMatchObject({
        outcome: 'classified',
      });
      const original = (await matchedTo(auth, line.id))!;
      expect((await nets(businessId))['BANK']).toBe(amountK);

      expect(await forget(auth, day)).toEqual({
        outcome: 'forgotten',
        removed: 1,
        reversedClassifications: 1,
      });
      expect(await nets(businessId)).toEqual({});
      expect(await linesOn(businessId, day)).toEqual([]);
      expect(await matchCount(businessId)).toBe(0);

      const rows = await postings(businessId);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: original.transactionId, reverses_id: null });
      expect(rows[1]).toMatchObject({
        source_type: 'bank_classification',
        source_id: line.id,
        reverses_id: original.transactionId,
        month: lagosDay(new Date()).slice(0, 7),
      });
      expect(await forgetAudits(businessId)).toEqual([
        {
          entity_id: day,
          new_value: {
            removed: 1,
            reversedClassifications: 1,
            classificationReversals: [
              {
                lineId: line.id,
                originalLedgerTransactionId: original.transactionId,
                reversalLedgerTransactionId: rows[1]!.id,
              },
            ],
          },
        },
      ]);
    },
  );

  /* F, G: a mixed day. Only the classifications move the books. */
  it('reverses only the classifications on a mixed day, and leaves every other entry and day alone', async () => {
    const MIXED = `Date,Description,Amount
03/08/2026,TRF FROM UNKNOWN,10000.00
03/08/2026,TRF FROM CUSTOMER,150000.00
03/08/2026,POS GENERATOR FUEL,-5000.00
03/08/2026,TRF FROM OWNER,30000.00
03/08/2026,TRF FROM SUPPLIER,20000.00
04/08/2026,TRF FROM NEXT DAY,70000.00
`;
    const { businessId, auth } = await onboard('+2348177000410');
    await post('/v1/bank/statement', { csv: MIXED }, auth);
    const lineOf = async (amountK: number) =>
      (await position(auth)).lines.find((l) => l.amountK === amountK)!;

    /* B: a real sale, paid by transfer from the dashboard. */
    const invoiceNumber = await withBusiness(db, businessId, async (tx) => {
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_9X1',
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
        sourceId: 'g97-mixed',
        actor: 'system',
      });
      return sale.invoiceNumber;
    });
    await post(
      '/v1/reports/payments/record',
      { invoiceNumber, amountK: 15_000_000, method: 'transfer' },
      auth,
    );
    /* C: an expense paid from the bank. */
    await withBusiness(db, businessId, (tx) =>
      issueRepo.writePosting(
        tx,
        businessId,
        postJournal({
          memo: 'Expense: generator fuel',
          amountK: 500_000,
          intoAccount: 'EXPENSES',
          outOfAccount: 'BANK',
        }),
        'dashboard',
        'expense-g97',
      ),
    );
    const open = (await position(auth)).openMovements;
    const payment = open.find((m) => m.amountK === 15_000_000)!;
    const expense = open.find((m) => m.amountK === -500_000)!;
    for (const [amountK, transactionId] of [
      [15_000_000, payment.transactionId],
      [-500_000, expense.transactionId],
    ] as const) {
      expect(
        (
          await post('/v1/bank/match', { lineId: (await lineOf(amountK)).id, transactionId }, auth)
        ).json(),
      ).toEqual({ outcome: 'matched' });
    }
    const ordinary = await postings(businessId);
    const beforeClassifying = await nets(businessId);

    /* D, E: two classifications on the same day; the next day's line too. */
    await classify(auth, (await lineOf(3_000_000)).id, 'OWNER_CAPITAL');
    await classify(auth, (await lineOf(2_000_000)).id, 'SUPPLIER_REFUND');
    const nextDay = await lineOf(7_000_000);
    await classify(auth, nextDay.id, 'OWNER_CAPITAL');
    const classifications = (await postings(businessId)).filter(
      (p) => p.source_type === 'bank_classification',
    );
    expect(classifications).toHaveLength(3);

    expect(await forget(auth, '2026-08-03')).toEqual({
      outcome: 'forgotten',
      removed: 5,
      reversedClassifications: 2,
    });
    expect(await linesOn(businessId, '2026-08-03')).toEqual([]);

    /* The sale, the payment and the expense: still there, never reversed. */
    const after = await postings(businessId);
    for (const p of ordinary) {
      expect(after).toContainEqual(p);
      expect(after.some((r) => r.reverses_id === p.id)).toBe(false);
    }
    /* Exactly the day's two classifications reversed, once each. */
    const reversals = after.filter((p) => p.reverses_id !== null);
    expect(reversals.map((r) => r.reverses_id).sort()).toEqual(
      classifications
        .filter((c) => c.source_id !== nextDay.id)
        .map((c) => c.id)
        .sort(),
    );
    /* The books are what they were before the day's classifications, plus
     * the next day's classification, which is still matched and standing. */
    expect(await nets(businessId)).toEqual({
      ...beforeClassifying,
      BANK: (beforeClassifying['BANK'] ?? 0) + 7_000_000,
      OWNERS_EQUITY: (beforeClassifying['OWNERS_EQUITY'] ?? 0) - 7_000_000,
    });
    expect((await matchedTo(auth, nextDay.id))!.transactionId).toBe(
      classifications.find((c) => c.source_id === nextDay.id)!.id,
    );
    expect(await matchCount(businessId)).toBe(1);
    const [audit] = await forgetAudits(businessId);
    expect(audit!.new_value).toMatchObject({ removed: 5, reversedClassifications: 2 });
    expect(audit!.new_value['classificationReversals']).toHaveLength(2);
  });

  /* H: a classification already released is not reversed a second time. */
  it('does not reverse a classification that was already released', async () => {
    const { businessId, auth, line } = await setUp('+2348177000411');
    await classify(auth, line.id);
    expect(await release(auth, line.id)).toMatchObject({ outcome: 'released_classification' });

    expect(await forget(auth, '2026-08-03')).toEqual({
      outcome: 'forgotten',
      removed: 1,
      reversedClassifications: 0,
    });
    expect((await postings(businessId)).filter((p) => p.reverses_id !== null)).toHaveLength(1);
    expect(await nets(businessId)).toEqual({});
  });

  it('reverses only the standing classification after a release and a second classification', async () => {
    const { businessId, auth, line } = await setUp('+2348177000412');
    await classify(auth, line.id);
    const first = (await matchedTo(auth, line.id))!;
    await release(auth, line.id);
    await classify(auth, line.id);
    const second = (await matchedTo(auth, line.id))!;

    expect(await forget(auth, '2026-08-03')).toMatchObject({ reversedClassifications: 1 });
    const reversed = (await postings(businessId))
      .filter((p) => p.reverses_id !== null)
      .map((p) => p.reverses_id)
      .sort();
    expect(reversed).toEqual([first.transactionId, second.transactionId].sort());
    expect(await nets(businessId)).toEqual({});
  });

  /* J: the second of two reversals fails. Nothing of the day is changed. */
  it('rolls the whole day back when one reversal fails', async () => {
    const TWO = `Date,Description,Amount
03/08/2026,TRF FROM OWNER,30000.00
03/08/2026,TRF FROM SUPPLIER,20000.00
`;
    const { businessId, auth } = await onboard('+2348177000413');
    await post('/v1/bank/statement', { csv: TWO }, auth);
    const ids = await linesOn(businessId, '2026-08-03');
    for (const id of ids) await classify(auth, id);
    const before = await nets(businessId);
    const beforePostings = await postings(businessId);
    /* Reversals run in line order: fail the second line's. */
    const second = ids[1]!;
    expect(second).toMatch(/^[0-9a-f-]{36}$/);

    const { db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 1 });
    await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g97_fail_second ON ledger_transactions`);
    await ownerDb.execute(sql`
      CREATE OR REPLACE FUNCTION g97_fail_second() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.reverses_id IS NOT NULL AND NEW.source_id = '${sql.raw(second)}' THEN
          RAISE EXCEPTION 'g97: forced failure on the second reversal';
        END IF;
        RETURN NEW;
      END $$`);
    await ownerDb.execute(sql`
      CREATE TRIGGER g97_fail_second BEFORE INSERT ON ledger_transactions
      FOR EACH ROW EXECUTE FUNCTION g97_fail_second()`);
    try {
      expect(
        (await post('/v1/bank/statement/forget', { postedOn: '2026-08-03' }, auth)).statusCode,
      ).toBe(500);
    } finally {
      await ownerDb.execute(sql`DROP TRIGGER IF EXISTS g97_fail_second ON ledger_transactions`);
      await ownerDb.execute(sql`DROP FUNCTION IF EXISTS g97_fail_second()`);
      await closeOwner();
    }

    expect(await linesOn(businessId, '2026-08-03')).toEqual(ids);
    expect(await matchCount(businessId)).toBe(2);
    expect(await postings(businessId)).toEqual(beforePostings);
    expect(await nets(businessId)).toEqual(before);
    expect(await forgetAudits(businessId)).toEqual([]);

    /* With nothing in the way, the same forget goes through whole. */
    expect(await forget(auth, '2026-08-03')).toMatchObject({
      removed: 2,
      reversedClassifications: 2,
    });
    expect(await nets(businessId)).toEqual({});
  });

  /* K: today's month closed, so no reversal can be dated. Nothing goes. */
  it('refuses, and removes nothing, when the reversal would fall in a closed month', async () => {
    const { businessId, auth, line } = await setUp('+2348177000414');
    await classify(auth, line.id);
    const original = (await matchedTo(auth, line.id))!;
    const before = await nets(businessId);
    const thisMonth = lagosDay(new Date()).slice(0, 7);
    await withBusiness(db, businessId, (tx) =>
      closeRepo.closeBooks(tx, {
        businessId,
        through: thisMonth,
        actor: 'user:test',
        now: new Date('2099-01-15T12:00:00Z'),
      }),
    );

    expect(await forget(auth, '2026-08-03')).toEqual({
      outcome: 'period_closed',
      removed: 0,
      reversedClassifications: 0,
      closedThrough: thisMonth,
    });
    expect(await linesOn(businessId, '2026-08-03')).toEqual([line.id]);
    expect((await matchedTo(auth, line.id))!.transactionId).toBe(original.transactionId);
    expect(await nets(businessId)).toEqual(before);
    expect(await postings(businessId)).toHaveLength(1);
    expect(await forgetAudits(businessId)).toEqual([]);
  });

  /* An unclassified day forgets normally even with today's month closed:
   * nothing has to be reversed, so nothing is refused. */
  it('still forgets a day with no classification while the month is closed', async () => {
    const { businessId, auth } = await setUp('+2348177000415');
    const thisMonth = lagosDay(new Date()).slice(0, 7);
    await withBusiness(db, businessId, (tx) =>
      closeRepo.closeBooks(tx, {
        businessId,
        through: thisMonth,
        actor: 'user:test',
        now: new Date('2099-01-15T12:00:00Z'),
      }),
    );
    expect(await forget(auth, '2026-08-03')).toMatchObject({ outcome: 'forgotten', removed: 1 });
  });

  /* L */
  it('forgets one business`s day and nobody else`s', async () => {
    const mine = await setUp('+2348177000416');
    const theirs = await setUp('+2348177000417');
    await classify(mine.auth, mine.line.id);

    expect(await forget(theirs.auth, '2026-08-03')).toEqual({
      outcome: 'forgotten',
      removed: 1,
      reversedClassifications: 0,
    });
    expect(await linesOn(mine.businessId, '2026-08-03')).toEqual([mine.line.id]);
    expect(await nets(mine.businessId)).toEqual({
      BANK: 15_000_000,
      OWNERS_EQUITY: -15_000_000,
    });
    expect(await postings(theirs.businessId)).toEqual([]);
    /* Naming the other business at the repo changes nothing: RLS decides. */
    expect(
      await withBusiness(db, theirs.businessId, (tx) =>
        bankRepo.forgetStatementDay(tx, {
          businessId: mine.businessId,
          postedOn: '2026-08-03',
          actor: 'user:theirs',
        }),
      ),
    ).toEqual({ removed: 0, reversed: [] });
    expect(await linesOn(mine.businessId, '2026-08-03')).toEqual([mine.line.id]);
  });

  /* M: a classification in flight commits first, and the forget reverses it. */
  it('reverses a classification that commits while the forget waits', async () => {
    const { businessId, auth, line } = await setUp('+2348177000418');
    const classifying = holdOpen(businessId, (tx) => classifyIn(tx, businessId, line.id));
    expect(await classifying.ready).toEqual({ outcome: 'matched' });

    const forgetting = forget(auth, '2026-08-03');
    expect(await stillWaiting(forgetting)).toBe(true);
    await classifying.commit();

    expect(await forgetting).toEqual({
      outcome: 'forgotten',
      removed: 1,
      reversedClassifications: 1,
    });
    expect(await nets(businessId)).toEqual({});
    expect(await matchCount(businessId)).toBe(0);
  });

  /* M, the other order: the forget goes first, the classification finds no
   * line and posts nothing. */
  it('refuses a classification that arrives while the forget is committing', async () => {
    const { businessId, auth, line } = await setUp('+2348177000419');
    const forgetting = holdOpen(businessId, (tx) =>
      bankRepo.forgetStatementDay(tx, { businessId, postedOn: '2026-08-03', actor: 'user:held' }),
    );
    expect(await forgetting.ready).toEqual({ removed: 1, reversed: [] });

    const classifying = classify(auth, line.id);
    expect(await stillWaiting(classifying)).toBe(true);
    await forgetting.commit();

    expect(await classifying).toEqual({ outcome: 'refused', reason: 'no_such_line' });
    expect(await postings(businessId)).toEqual([]);
    expect(await nets(businessId)).toEqual({});
  });

  /* B under a race: a hand match arriving behind the forget finds no line. */
  it('refuses a hand match that arrives while the forget is committing', async () => {
    const { businessId, auth, line } = await setUp('+2348177000420');
    await post(
      '/v1/reports/journal',
      {
        memo: 'Capital',
        amountK: 15_000_000,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
        occurredOn: '2026-08-03',
      },
      auth,
    );
    const [entry] = await postings(businessId);
    const forgetting = holdOpen(businessId, (tx) =>
      bankRepo.forgetStatementDay(tx, { businessId, postedOn: '2026-08-03', actor: 'user:held' }),
    );
    await forgetting.ready;
    const matching = post('/v1/bank/match', { lineId: line.id, transactionId: entry!.id }, auth);
    expect(await stillWaiting(matching)).toBe(true);
    await forgetting.commit();

    expect((await matching).json()).toEqual({ outcome: 'refused', reason: 'no_such_line' });
    expect(await matchCount(businessId)).toBe(0);
    expect(await postings(businessId)).toEqual([entry]);
  });

  /* N: a committing reconcile and a forget take turns. */
  it('takes turns with a reconcile, and leaves the reconciled posting alone', async () => {
    const { businessId, auth } = await setUp('+2348177000421');
    await post(
      '/v1/reports/journal',
      {
        memo: 'Capital',
        amountK: 15_000_000,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
        occurredOn: '2026-08-03',
      },
      auth,
    );
    const [entry] = await postings(businessId);
    const reconciling = holdOpen(businessId, (tx) =>
      bankRepo.reconcile(tx, { businessId, commit: true }),
    );
    expect(await reconciling.ready).toMatchObject({ matched: 1 });

    const forgetting = forget(auth, '2026-08-03');
    expect(await stillWaiting(forgetting)).toBe(true);
    await reconciling.commit();

    expect(await forgetting).toEqual({
      outcome: 'forgotten',
      removed: 1,
      reversedClassifications: 0,
    });
    expect(await matchCount(businessId)).toBe(0);
    expect(await postings(businessId)).toEqual([entry]);
    expect(await linesOn(businessId, '2026-08-03')).toEqual([]);
  });

  it('makes a reconcile wait for a forget, then find nothing of the day', async () => {
    const { businessId, auth } = await setUp('+2348177000422');
    await classify(auth, (await position(auth)).lines[0]!.id);
    const forgetting = holdOpen(businessId, (tx) =>
      bankRepo.forgetStatementDay(tx, { businessId, postedOn: '2026-08-03', actor: 'user:held' }),
    );
    expect(await forgetting.ready).toMatchObject({ removed: 1 });

    const reconciling = post('/v1/bank/reconcile', {}, auth);
    expect(await stillWaiting(reconciling)).toBe(true);
    await forgetting.commit();

    expect((await reconciling).json()).toMatchObject({ matched: 0, unmatchedMovements: 0 });
    expect(await nets(businessId)).toEqual({});
  });

  /* Forget vs release, both orders: one reversal, never two. */
  it('reverses once when a release commits while the forget waits', async () => {
    const { businessId, auth, line } = await setUp('+2348177000424');
    await classify(auth, line.id);
    const releasing = holdOpen(businessId, (tx) =>
      bankRepo.releaseLine(tx, { businessId, lineId: line.id, actor: 'user:held' }),
    );
    expect(await releasing.ready).toMatchObject({ outcome: 'released_classification' });

    const forgetting = forget(auth, '2026-08-03');
    expect(await stillWaiting(forgetting)).toBe(true);
    await releasing.commit();

    expect(await forgetting).toEqual({
      outcome: 'forgotten',
      removed: 1,
      reversedClassifications: 0,
    });
    expect((await postings(businessId)).filter((p) => p.reverses_id !== null)).toHaveLength(1);
    expect(await nets(businessId)).toEqual({});
  });

  it('finds nothing to release once the forget has committed', async () => {
    const { businessId, auth, line } = await setUp('+2348177000425');
    await classify(auth, line.id);
    const forgetting = holdOpen(businessId, (tx) =>
      bankRepo.forgetStatementDay(tx, { businessId, postedOn: '2026-08-03', actor: 'user:held' }),
    );
    expect(await forgetting.ready).toMatchObject({ removed: 1 });

    const releasing = release(auth, line.id);
    expect(await stillWaiting(releasing)).toBe(true);
    await forgetting.commit();

    expect(await releasing).toEqual({ outcome: 'not_matched', released: 0 });
    expect((await postings(businessId)).filter((p) => p.reverses_id !== null)).toHaveLength(1);
    expect(await nets(businessId)).toEqual({});
  });

  /* Forget vs re-import, after the forget's DELETE: the unique index makes
   * the import wait and then insert afresh. This pins the outcome; the next
   * test pins the lock that covers the earlier window. */
  it('imports the day afresh when the upload arrives while the forget is committing', async () => {
    const { businessId, auth, line } = await setUp('+2348177000426');
    const forgetting = holdOpen(businessId, (tx) =>
      bankRepo.forgetStatementDay(tx, { businessId, postedOn: '2026-08-03', actor: 'user:held' }),
    );
    expect(await forgetting.ready).toMatchObject({ removed: 1 });

    const importing = post('/v1/bank/statement', { csv: ONE_CREDIT }, auth);
    expect(await stillWaiting(importing)).toBe(true);
    await forgetting.commit();

    expect(importStatementResponse.parse((await importing).json())).toMatchObject({
      imported: 1,
      duplicates: 0,
    });
    const [fresh] = await linesOn(businessId, '2026-08-03');
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(line.id);
  });

  /* The window the index does not cover: a forget that holds the lock and
   * has not yet deleted (it is still writing reversals). Parked there for
   * real, then let run in the SAME transaction. Without the import taking
   * the pairing lock, the import answers at once that every line is a
   * duplicate, and then the forget deletes them: the day is gone. */
  it('makes an import wait for a forget that has not yet deleted, then imports afresh', async () => {
    const { businessId, auth, line } = await setUp('+2348177000427');
    let resume!: () => void;
    const midGate = new Promise<void>((resolve) => (resume = resolve));
    held.push(resume);
    let parked!: () => void;
    const isParked = new Promise<void>((resolve) => (parked = resolve));
    const forgetting = withBusiness(db, businessId, async (tx) => {
      await bankRepo.lockBankPairings(tx, businessId);
      parked();
      await midGate;
      return bankRepo.forgetStatementDay(tx, {
        businessId,
        postedOn: '2026-08-03',
        actor: 'user:held',
      });
    });
    await isParked;

    const importing = post('/v1/bank/statement', { csv: ONE_CREDIT }, auth);
    expect(await stillWaiting(importing)).toBe(true);
    resume();

    expect(await forgetting).toEqual({ removed: 1, reversed: [] });
    expect(importStatementResponse.parse((await importing).json())).toMatchObject({
      imported: 1,
      duplicates: 0,
    });
    const after = await linesOn(businessId, '2026-08-03');
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(line.id);
  });

  /* O: two forgets of the same day. One does the work; the other finds none. */
  it('reverses once when two forgets of the same day arrive together', async () => {
    const { businessId, auth, line } = await setUp('+2348177000423');
    await classify(auth, line.id);
    const first = holdOpen(businessId, (tx) =>
      bankRepo.forgetStatementDay(tx, { businessId, postedOn: '2026-08-03', actor: 'user:first' }),
    );
    expect(await first.ready).toMatchObject({ removed: 1 });

    const second = forget(auth, '2026-08-03');
    expect(await stillWaiting(second)).toBe(true);
    await first.commit();

    expect(await second).toEqual({ outcome: 'forgotten', removed: 0, reversedClassifications: 0 });
    expect((await postings(businessId)).filter((p) => p.reverses_id !== null)).toHaveLength(1);
    expect(await nets(businessId)).toEqual({});
    expect(await forgetAudits(businessId)).toHaveLength(1);
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
