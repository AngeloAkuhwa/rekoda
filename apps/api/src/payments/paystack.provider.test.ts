/**
 * The Paystack adapter (docs/payments-v1.md §6, §20), against a real HTTP
 * server — because the claims worth having are about what actually goes over
 * the wire: the kobo that must not be multiplied, the header that must carry
 * the secret, the channels that must lead with bank_transfer, and the email
 * that must never be invented.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaystackApiError, PaystackProvider } from './paystack.provider.js';

interface Recorded {
  method: string;
  url: string;
  authorization: string | undefined;
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
        authorization: req.headers.authorization,
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
  respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: true }));
  };
});

const provider = () => new PaystackProvider('sk_test_secret', baseUrl);

describe('initialising a transaction', () => {
  const input = {
    reference: 'RKD-PAY-20260819-A83F92',
    amountK: 15_000_000, // ₦150,000, already kobo
    currency: 'NGN',
    customerEmail: 'adaeze@example.com',
    subaccountCode: 'ACCT_abc123',
  };

  it('passes kobo through UNMULTIPLIED, transfer-first, under the secret key', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: true,
          data: {
            authorization_url: 'https://checkout.paystack.com/x1',
            access_code: 'x1',
            reference: input.reference,
          },
        }),
      );
    };

    const result = await provider().initializeTransaction(input);

    expect(result).toEqual({
      state: 'initialized',
      checkoutUrl: 'https://checkout.paystack.com/x1',
      accessCode: 'x1',
    });
    const sent = requests[0];
    expect(sent?.url).toBe('/transaction/initialize');
    expect(sent?.authorization).toBe('Bearer sk_test_secret');
    const body = sent?.body as Record<string, unknown>;
    // THE number. 15_000_000 kobo in, 15_000_000 kobo out — a ×100 here
    // would ask the customer for ₦15,000,000.
    expect(body['amount']).toBe(15_000_000);
    expect(body['reference']).toBe(input.reference);
    expect(body['subaccount']).toBe('ACCT_abc123');
    // Nigerian V1 is transfer-first (§10).
    expect((body['channels'] as string[])[0]).toBe('bank_transfer');
  });

  it('answers requires_customer_information for a missing email — NO request, NO invented address', async () => {
    const result = await provider().initializeTransaction({ ...input, customerEmail: null });
    expect(result).toEqual({ state: 'requires_customer_information', missing: ['email'] });
    // The forbidden fix (customer123@rekoda.app) would show up here as a
    // request this assertion says never happened.
    expect(requests).toHaveLength(0);
  });

  it('surfaces a provider refusal as an error, never as a checkout URL', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: false, message: 'Invalid subaccount' }));
    };
    await expect(provider().initializeTransaction(input)).rejects.toBeInstanceOf(PaystackApiError);
  });
});

describe('verifying a transaction', () => {
  it('normalises the provider`s answer, keeping kobo as kobo', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: true,
          data: {
            id: 4099260516,
            status: 'success',
            reference: 'RKD-PAY-20260819-A83F92',
            amount: 15_000_000,
            currency: 'NGN',
            fees: 225_000,
            channel: 'bank_transfer',
            paid_at: '2026-08-19T12:00:00.000Z',
          },
        }),
      );
    };

    const result = await provider().verifyTransaction('RKD-PAY-20260819-A83F92');
    if (!result.found) throw new Error('expected found');
    expect(result.transaction).toEqual({
      succeeded: true,
      reference: 'RKD-PAY-20260819-A83F92',
      amountK: 15_000_000,
      currency: 'NGN',
      providerStatus: 'success',
      providerTransactionId: '4099260516',
      providerFeeK: 225_000,
      method: 'transfer',
      paidAtIso: '2026-08-19T12:00:00.000Z',
    });
    expect(requests[0]?.url).toBe('/transaction/verify/RKD-PAY-20260819-A83F92');
  });

  it('treats a failed charge as found-but-not-succeeded — the judgement decides, not the adapter', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: true,
          data: {
            id: 1,
            status: 'failed',
            reference: 'r',
            amount: 100,
            currency: 'NGN',
            fees: null,
          },
        }),
      );
    };
    const result = await provider().verifyTransaction('r');
    if (!result.found) throw new Error('expected found');
    expect(result.transaction.succeeded).toBe(false);
    expect(result.transaction.providerStatus).toBe('failed');
    expect(result.transaction.providerFeeK).toBe(0); // null fees → 0, not NaN
  });

  it('answers found:false for an unknown reference instead of throwing', async () => {
    respond = (_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: false, message: 'Transaction reference not found' }));
    };
    expect(await provider().verifyTransaction('RKD-PAY-20260819-ZZZZZZ')).toEqual({ found: false });
  });

  it('throws on a 5xx so the job retries — an outage is not "not found"', async () => {
    respond = (_req, res) => {
      res.writeHead(503);
      res.end();
    };
    await expect(provider().verifyTransaction('r')).rejects.toBeInstanceOf(PaystackApiError);
  });
});
