/**
 * The Mono adapter, against a real HTTP server — because the claims worth
 * having are about what goes over the wire: the header that must carry the
 * secret, the kobo that must not be multiplied, the debit that must come out
 * negative, and the lapsed consent that must come out as a product state
 * rather than an exception.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MonoApiError, MonoProvider } from './mono.provider.js';

interface Recorded {
  method: string;
  url: string;
  secKey: string | undefined;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let requests: Recorded[];
let respond: (req: IncomingMessage, res: ServerResponse) => void;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        secKey: req.headers['mono-sec-key'] as string | undefined,
        body: raw ? JSON.parse(raw) : null,
      });
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
});

const provider = () => new MonoProvider('test_sk_mono', baseUrl);

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

describe('being configured', () => {
  it('is a fact about the key, decided at the adapter', () => {
    expect(provider().configured).toBe(true);
    expect(new MonoProvider('', baseUrl).configured).toBe(false);
  });
});

describe('linking an account', () => {
  it('exchanges the code under the secret header and labels the card', async () => {
    respond = (req, res) => {
      if (req.url === '/v2/accounts/auth') return json(res, 200, { data: { id: 'acc_123' } });
      return json(res, 200, {
        data: {
          account: {
            id: 'acc_123',
            account_number: '0123456789',
            institution: { name: 'GTBank' },
          },
        },
      });
    };

    const linked = await provider().linkAccount('code_abc');
    expect(linked).toEqual({
      state: 'linked',
      accountRef: 'acc_123',
      bankName: 'GTBank',
      accountLast4: '6789',
    });
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: '/v2/accounts/auth',
      secKey: 'test_sk_mono',
      body: { code: 'code_abc' },
    });
    expect(requests[1]?.secKey).toBe('test_sk_mono');
  });

  it('a rejected code is a product state carrying the provider word', async () => {
    respond = (_req, res) => json(res, 400, { message: 'code expired' });
    expect(await provider().linkAccount('stale')).toEqual({
      state: 'rejected',
      reason: 'code expired',
    });
  });

  it('a link still stands when the label lookup fails', async () => {
    respond = (req, res) => {
      if (req.url === '/v2/accounts/auth') return json(res, 200, { data: { id: 'acc_9' } });
      return json(res, 500, {});
    };
    expect(await provider().linkAccount('code')).toEqual({
      state: 'linked',
      accountRef: 'acc_9',
      bankName: 'Linked bank',
      accountLast4: '',
    });
  });

  it('an outage is an exception, never a silent shrug', async () => {
    respond = (_req, res) => json(res, 503, {});
    await expect(provider().linkAccount('code')).rejects.toBeInstanceOf(MonoApiError);
  });
});

describe('fetching transactions', () => {
  it('keeps kobo as kobo and puts the sign where the type said', async () => {
    respond = (_req, res) =>
      json(res, 200, {
        data: [
          {
            id: 'txn_1',
            narration: 'TRF FROM ADA',
            amount: 850_000,
            type: 'credit',
            date: '2026-08-20T09:15:00.000Z',
          },
          {
            id: 'txn_2',
            narration: 'POS CHARGE',
            amount: 5_000,
            type: 'debit',
            date: '2026-08-21T10:00:00.000Z',
          },
          {
            id: 'txn_3',
            narration: 'ZERO NOISE',
            amount: 0,
            type: 'credit',
            date: '2026-08-21T10:00:00.000Z',
          },
        ],
      });

    const fetched = await provider().fetchTransactions('acc_123', '2026-08-01');
    expect(fetched).toEqual({
      state: 'ok',
      transactions: [
        {
          postedOn: '2026-08-20',
          amountK: 850_000,
          narration: 'TRF FROM ADA',
          bankRef: 'txn_1',
        },
        { postedOn: '2026-08-21', amountK: -5_000, narration: 'POS CHARGE', bankRef: 'txn_2' },
      ],
    });
    /* Mono spells the start day DD-MM-YYYY; the adapter owns that spelling. */
    expect(requests[0]?.url).toBe(
      '/v2/accounts/acc_123/transactions?start=01-08-2026&paginate=false',
    );
    expect(requests[0]?.secKey).toBe('test_sk_mono');
  });

  it('lapsed consent is unlinked, not an exception', async () => {
    respond = (_req, res) => json(res, 401, { message: 'reauthorisation required' });
    expect(await provider().fetchTransactions('acc_123', '2026-08-01')).toEqual({
      state: 'unlinked',
    });
  });

  it('an outage is an exception here too', async () => {
    respond = (_req, res) => json(res, 502, {});
    await expect(provider().fetchTransactions('acc_123', '2026-08-01')).rejects.toBeInstanceOf(
      MonoApiError,
    );
  });
});
