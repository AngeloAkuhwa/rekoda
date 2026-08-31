/**
 * The live bank feed, end to end (fix-plan 4, G5).
 *
 * The adapter's wire behaviour is proven in mono.provider.test.ts and the
 * connection row's storage in the repo. What this pins is the promise the
 * whole slice makes: that the feed is a second door into the SAME statement
 * table — a synced line reconciles exactly as an uploaded one does, a
 * re-sync duplicates nothing, and a lapsed consent becomes a sentence on
 * the page instead of an exception.
 *
 * Its own file rather than more describes in bank.integration.test.ts,
 * because the app here is booted CONFIGURED: MONO_* env is set before
 * createApp, pointing at a local stub. The not_configured posture is pinned
 * where the app boots without those keys.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bankFeedStateResponse,
  bankPositionResponse,
  connectBankFeedResponse,
  syncBankFeedResponse,
} from '@rekoda/contracts';
import { createDb, type Db } from '@rekoda/db';
import { sweepBankFeeds } from './feed-sync.js';
import { MonoProvider } from './mono.provider.js';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CommandBus } from '../commands/command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';

const testBus = new CommandBus(new RiskPolicyService());

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

let mono: Server;
let monoRespond: (req: IncomingMessage, res: ServerResponse) => void;

beforeAll(async () => {
  mono = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => monoRespond(req, res));
  });
  await new Promise<void>((resolve) => mono.listen(0, '127.0.0.1', resolve));
  const address = mono.address();
  if (!address || typeof address === 'string') throw new Error('no address');

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
  process.env['MONO_SECRET_KEY'] = 'test_sk_mono';
  process.env['MONO_BASE_URL'] = `http://127.0.0.1:${address.port}`;
  delete process.env['NODE_ENV'];

  const { createApp } = await import('../main.js');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  await new Promise((resolve) => mono.close(resolve));
  /* Other integration files in this process must boot unconfigured. */
  delete process.env['MONO_SECRET_KEY'];
  delete process.env['MONO_BASE_URL'];
});

beforeEach(async () => {
  await truncateAll(urls);
  monoRespond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({}));
  };
});

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The happy Mono: one account, two movements. */
function monoWithTransactions(transactions: unknown[]) {
  monoRespond = (req, res) => {
    if (req.url === '/v2/accounts/auth') return json(res, 200, { data: { id: 'acc_test_1' } });
    if (req.url?.startsWith('/v2/accounts/acc_test_1/transactions')) {
      return json(res, 200, { data: transactions });
    }
    return json(res, 200, {
      data: {
        account: {
          id: 'acc_test_1',
          account_number: '0123456789',
          institution: { name: 'GTBank' },
        },
      },
    });
  };
}

/**
 * Everything handed to a logger while `run` is in flight.
 *
 * Patched at `Logger.prototype` rather than at stdout, because the property
 * being asserted is about what the CODE passes to a log call. Where that
 * ends up — a terminal, a file, a shipper — is a deployment question, and a
 * test that watched stdout would pass for the wrong reason on any transport
 * that buffers or reformats. Both streams are captured as well, so anything
 * written around the logger is caught too.
 */
async function captureOutput(run: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const levels = ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const;
  const proto = Logger.prototype as unknown as Record<string, (...args: unknown[]) => void>;
  const original = new Map<string, (...args: unknown[]) => void>();
  for (const level of levels) {
    if (typeof proto[level] !== 'function') continue;
    original.set(level, proto[level]);
    proto[level] = (...args: unknown[]) => {
      written.push(args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '));
    };
  }

  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const swallow = ((chunk: unknown) => {
    written.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = swallow;
  process.stderr.write = swallow;
  try {
    await run();
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    for (const [level, fn] of original) proto[level] = fn;
  }
  return written.join('\n');
}

/** Distinctive enough that a substring match cannot be a coincidence. */
const SENSITIVE = 'R7-SENSITIVE-NARRATION-DO-NOT-LOG';

const MOVEMENTS = [
  {
    id: 'txn_1',
    narration: 'TRF FROM ADEBAYO O',
    amount: 150_000_00,
    type: 'credit',
    date: '2026-08-20T09:15:00.000Z',
  },
  {
    id: 'txn_2',
    narration: 'POS PURCHASE SHOPRITE',
    amount: 20_000_00,
    type: 'debit',
    date: '2026-08-21T10:00:00.000Z',
  },
];

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

const getJson = (url: string, headers: Record<string, string>) =>
  app.inject({ method: 'GET', url, headers });

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

describe('the live bank feed', () => {
  it('refuses a caller with no session', async () => {
    expect((await post('/v1/bank/feed/connect', { exchangeCode: 'code' })).statusCode).toBe(401);
    expect((await post('/v1/bank/feed/sync', {})).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/bank/feed' })).statusCode).toBe(401);
  });

  it('starts not linked, links on the exchanged code, and says who it linked', async () => {
    const { auth } = await onboard('+2348188000301');
    monoWithTransactions(MOVEMENTS);

    expect(bankFeedStateResponse.parse((await getJson('/v1/bank/feed', auth)).json())).toEqual({
      state: 'not_linked',
    });

    const linked = connectBankFeedResponse.parse(
      (await post('/v1/bank/feed/connect', { exchangeCode: 'code_ok' }, auth)).json(),
    );
    expect(linked).toEqual({ outcome: 'linked', bankName: 'GTBank', accountLast4: '6789' });

    expect(bankFeedStateResponse.parse((await getJson('/v1/bank/feed', auth)).json())).toEqual({
      state: 'linked',
      bankName: 'GTBank',
      accountLast4: '6789',
      lastSyncedOn: null,
    });
  });

  it('a rejected code is a sentence, and nothing is stored', async () => {
    const { auth } = await onboard('+2348188000302');
    monoRespond = (_req, res) => json(res, 400, { message: 'code expired' });

    const refused = connectBankFeedResponse.parse(
      (await post('/v1/bank/feed/connect', { exchangeCode: 'stale' }, auth)).json(),
    );
    expect(refused).toEqual({ outcome: 'rejected', reason: 'code expired' });
    expect(bankFeedStateResponse.parse((await getJson('/v1/bank/feed', auth)).json())).toEqual({
      state: 'not_linked',
    });
  });

  /**
   * The bank's words must not reach a log line (R7).
   *
   * They live in memory for exactly as long as it takes to pull the Rekoda
   * references out of them, and the row written from them does not carry
   * them. A log line is the one place that boundary could be crossed by
   * accident: an interpolated row in a warning would put a payer's name
   * into an operator's terminal and whatever ships that terminal onwards.
   *
   * The whole of stdout and stderr is searched rather than one logger,
   * because the property is about the CONTENT the bank supplied, not about
   * which logger might carry it. The field NAME is fair game and is not
   * asserted against.
   */
  it('never lets the bank`s own words reach a log line', async () => {
    const { auth } = await onboard('+2348188000320');
    monoWithTransactions([
      {
        id: 'txn_leak_1',
        narration: `TRF FROM ${SENSITIVE} 08031234567`,
        amount: 24_500_00,
        type: 'credit',
        date: '2026-08-22T09:00:00.000Z',
      },
      {
        id: 'txn_leak_2',
        narration: `POS ${SENSITIVE} LEKKI`,
        amount: 3_000_00,
        type: 'debit',
        date: '2026-08-23T09:00:00.000Z',
      },
    ]);

    const printed = await captureOutput(async () => {
      await post('/v1/bank/feed/connect', { exchangeCode: 'code_ok' }, auth);
      await post('/v1/bank/feed/sync', {}, auth);
      await getJson('/v1/bank/position', auth);
      /* The background door as well as the request one: the sweep logs on
       * its own account, and its own pool, exactly as the worker does. */
      const { db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 2 });
      try {
        await sweepBankFeeds({
          workerDb,
          appDb: db,
          feed: new MonoProvider(process.env['MONO_SECRET_KEY']!, process.env['MONO_BASE_URL']!),
          commandBus: testBus,
          commandIngestFinancialTransaction: false,
        });
      } finally {
        await closeWorker();
      }
    });

    expect(printed).not.toContain(SENSITIVE);
    expect(printed).not.toContain('08031234567');
    expect(printed).not.toContain('LEKKI');
  });

  /**
   * And on the paths that actually produce log lines.
   *
   * A healthy sync is quiet, so the case above could pass on a run that
   * logged nothing at all. This one makes the provider fail after the lines
   * are already in hand, which is where a warning gets written, and asserts
   * the same silence about the words.
   */
  it('says nothing about the words when the provider fails mid-sync', async () => {
    const { auth } = await onboard('+2348188000321');
    monoWithTransactions([
      {
        id: 'txn_leak_3',
        narration: `TRF FROM ${SENSITIVE}`,
        amount: 5_000_00,
        type: 'credit',
        date: '2026-08-24T09:00:00.000Z',
      },
    ]);
    await post('/v1/bank/feed/connect', { exchangeCode: 'code_ok' }, auth);

    const printed = await captureOutput(async () => {
      await post('/v1/bank/feed/sync', {}, auth);
      /* Now the provider breaks, and the adapter warns. */
      monoRespond = (_req, res) => json(res, 502, { message: 'upstream unavailable' });
      await post('/v1/bank/feed/sync', {}, auth);
      const { db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 2 });
      try {
        /* The sweep meets the same outage and warns on its own account. */
        await sweepBankFeeds({
          workerDb,
          appDb: db,
          feed: new MonoProvider(process.env['MONO_SECRET_KEY']!, process.env['MONO_BASE_URL']!),
          commandBus: testBus,
          commandIngestFinancialTransaction: false,
        }).catch(() => undefined);
      } finally {
        await closeWorker();
      }
    });

    /* Something WAS logged, or this proves nothing. */
    expect(printed.length).toBeGreaterThan(0);
    expect(printed).not.toContain(SENSITIVE);
  });

  it('syncing lands the lines in the same register the upload fills, once', async () => {
    const { auth } = await onboard('+2348188000303');
    monoWithTransactions(MOVEMENTS);
    await post('/v1/bank/feed/connect', { exchangeCode: 'code_ok' }, auth);

    const synced = syncBankFeedResponse.parse((await post('/v1/bank/feed/sync', {}, auth)).json());
    expect(synced).toMatchObject({ outcome: 'synced', imported: 2, duplicates: 0 });

    /* The same position the CSV upload feeds: signed kobo, both directions,
     * and none of the bank's words. */
    const raw = (await getJson('/v1/bank/position', auth)).json();
    const position = bankPositionResponse.parse(raw);
    expect(position.position.lines).toBe(2);
    expect(position.position.statementK).toBe(150_000_00 - 20_000_00);

    /* The debit is still a debit and the credit still a credit: minimising
     * what is kept about a movement never changed which way it went. */
    expect(position.lines.map((l) => l.amountK).sort((a, b) => a - b)).toEqual([
      -20_000_00, 150_000_00,
    ]);

    /* And the payer's name does not cross the border. Mono sent
     * "TRF FROM ADEBAYO O"; the whole response is searched rather than one
     * field, because a field added later would carry it just as far. */
    const body = JSON.stringify(raw);
    expect(body).not.toContain('ADEBAYO');
    expect(body).not.toContain('SHOPRITE');
    expect(body).not.toContain('narration');

    /* A second sync re-covers the overlap and books nothing twice. */
    const again = syncBankFeedResponse.parse((await post('/v1/bank/feed/sync', {}, auth)).json());
    expect(again).toMatchObject({ outcome: 'synced', imported: 0, duplicates: 2 });
    const after = bankPositionResponse.parse((await getJson('/v1/bank/position', auth)).json());
    expect(after.position.lines).toBe(2);

    /* The card now carries the cursor. */
    const state = bankFeedStateResponse.parse((await getJson('/v1/bank/feed', auth)).json());
    expect(state.state).toBe('linked');
    if (state.state === 'linked') expect(state.lastSyncedOn).not.toBeNull();
  });

  it('lapsed consent becomes a page state, and re-linking repairs it', async () => {
    const { auth } = await onboard('+2348188000304');
    monoWithTransactions(MOVEMENTS);
    await post('/v1/bank/feed/connect', { exchangeCode: 'code_ok' }, auth);

    monoRespond = (_req, res) => json(res, 401, { message: 'reauthorisation required' });
    expect(syncBankFeedResponse.parse((await post('/v1/bank/feed/sync', {}, auth)).json())).toEqual(
      { outcome: 'unlinked' },
    );
    expect(bankFeedStateResponse.parse((await getJson('/v1/bank/feed', auth)).json())).toEqual({
      state: 'lapsed',
      bankName: 'GTBank',
      accountLast4: '6789',
    });
    /* Lapsed is not linked: a sync now says so instead of trying. */
    expect(syncBankFeedResponse.parse((await post('/v1/bank/feed/sync', {}, auth)).json())).toEqual(
      { outcome: 'not_linked' },
    );

    monoWithTransactions(MOVEMENTS);
    const relinked = connectBankFeedResponse.parse(
      (await post('/v1/bank/feed/connect', { exchangeCode: 'code_again' }, auth)).json(),
    );
    expect(relinked.outcome).toBe('linked');
    expect(
      syncBankFeedResponse.parse((await post('/v1/bank/feed/sync', {}, auth)).json()),
    ).toMatchObject({ outcome: 'synced' });
  });

  it('the sweep pulls for a linked feed with nobody pressing a button', async () => {
    const { auth } = await onboard('+2348188000306');
    monoWithTransactions(MOVEMENTS);
    await post('/v1/bank/feed/connect', { exchangeCode: 'code_ok' }, auth);

    /* The sweep's own credentials, exactly as jobs.module hands them: the
     * worker lists linked feeds across tenants, the app pin does the work. */
    const { db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 2 });
    try {
      const feed = new MonoProvider(process.env['MONO_SECRET_KEY']!, process.env['MONO_BASE_URL']!);
      expect(
        await sweepBankFeeds({
          workerDb,
          appDb: db,
          feed,
          commandBus: testBus,
          commandIngestFinancialTransaction: false,
        }),
      ).toBe(2);
      /* A second pass re-covers the overlap and imports nothing twice. */
      expect(
        await sweepBankFeeds({
          workerDb,
          appDb: db,
          feed,
          commandBus: testBus,
          commandIngestFinancialTransaction: false,
        }),
      ).toBe(0);
    } finally {
      await closeWorker();
    }

    /* Same register, same lines, and the cursor moved — all without a
     * single call to the sync endpoint. */
    const position = bankPositionResponse.parse((await getJson('/v1/bank/position', auth)).json());
    expect(position.position.lines).toBe(2);
    const state = bankFeedStateResponse.parse((await getJson('/v1/bank/feed', auth)).json());
    expect(state.state).toBe('linked');
    if (state.state === 'linked') expect(state.lastSyncedOn).not.toBeNull();
  });

  it('syncing before linking is a sentence, not an error', async () => {
    const { auth } = await onboard('+2348188000305');
    expect(syncBankFeedResponse.parse((await post('/v1/bank/feed/sync', {}, auth)).json())).toEqual(
      { outcome: 'not_linked' },
    );
  });
});
