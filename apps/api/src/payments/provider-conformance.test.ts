/**
 * The provider conformance suite (spec §18; P3, PR-069 — and P3's
 * completion gate: TWO providers pass the SAME suite).
 *
 * These are the behavioural claims every collector adapter owes the hub,
 * whatever its wire looks like: kobo cross the wire unmultiplied under
 * the adapter's own credential header; a missing customer email is a
 * product state and NO request; a provider refusal is an error, never a
 * checkout URL; verification is normalised with kobo kept as kobo, a
 * failed charge found-but-not-succeeded, an unknown reference found:false,
 * and an outage thrown; and settlement listing is either genuinely polled
 * or HONESTLY absent — never an invented empty day, never an invented
 * batch. Each adapter supplies only its fixtures; the assertions are one
 * set, which is what "provider neutrality" means when it is true.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PaymentProviderPort } from './provider.port.js';
import { PaystackProvider } from './paystack.provider.js';
import { MonoDirectPayProvider } from './mono-directpay.provider.js';

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

interface ConformanceKit {
  providerType: string;
  make(baseUrl: string): PaymentProviderPort;
  /** The credential must ride every request, however this wire spells it. */
  assertAuth(recorded: Recorded): void;
  initialize: {
    ok(res: ServerResponse): void;
    refusal(res: ServerResponse): void;
    checkoutUrl: string;
    /** What the wire carried as the amount — must be the kobo, untouched. */
    amountOnWire(body: unknown): unknown;
  };
  verify: {
    success(res: ServerResponse): void;
    failed(res: ServerResponse): void;
    notFound(res: ServerResponse): void;
  };
  /** 'polled' providers must surface an outage as an error; 'none'
   * providers must answer an empty list WITHOUT a request. */
  settlements: 'polled' | 'none';
}

const paystackKit: ConformanceKit = {
  providerType: 'paystack',
  make: (baseUrl) => new PaystackProvider('sk_test_secret', baseUrl),
  assertAuth: (recorded) => {
    expect(recorded.headers['authorization']).toBe('Bearer sk_test_secret');
  },
  initialize: {
    ok: (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: true,
          data: {
            authorization_url: 'https://checkout.paystack.com/x1',
            access_code: 'x1',
            reference: 'RKD-PAY-20260827-CONFRM',
          },
        }),
      );
    },
    refusal: (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: false, message: 'Invalid subaccount' }));
    },
    checkoutUrl: 'https://checkout.paystack.com/x1',
    amountOnWire: (body) => (body as { amount?: unknown }).amount,
  },
  verify: {
    success: (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: true,
          data: {
            status: 'success',
            reference: 'RKD-PAY-20260827-CONFRM',
            amount: 4_500_000,
            currency: 'NGN',
            id: 991,
            fees: 67_500,
            channel: 'bank_transfer',
            paid_at: '2026-08-27T10:00:00.000Z',
          },
        }),
      );
    },
    failed: (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: true,
          data: {
            status: 'failed',
            reference: 'RKD-PAY-20260827-CONFRM',
            amount: 4_500_000,
            currency: 'NGN',
            id: 992,
          },
        }),
      );
    },
    notFound: (res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: false, message: 'Transaction reference not found' }));
    },
  },
  settlements: 'polled',
};

const monoKit: ConformanceKit = {
  providerType: 'mono',
  make: (baseUrl) => new MonoDirectPayProvider('test_sk_mono', baseUrl),
  assertAuth: (recorded) => {
    expect(recorded.headers['mono-sec-key']).toBe('test_sk_mono');
  },
  initialize: {
    ok: (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'successful',
          data: { id: 'txreq_1', mono_url: 'https://checkout.mono.co/txreq_1' },
        }),
      );
    },
    refusal: (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'failed', message: 'invalid beneficiary' }));
    },
    checkoutUrl: 'https://checkout.mono.co/txreq_1',
    amountOnWire: (body) => (body as { amount?: unknown }).amount,
  },
  verify: {
    success: (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'successful',
          data: {
            id: 'txn_1',
            status: 'successful',
            amount: 4_500_000,
            fee: 67_500,
            currency: 'NGN',
            created_at: '2026-08-27T10:00:00.000Z',
          },
        }),
      );
    },
    failed: (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'successful',
          data: { id: 'txn_2', status: 'failed', amount: 4_500_000, currency: 'NGN' },
        }),
      );
    },
    notFound: (res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'failed', message: 'payment not found' }));
    },
  },
  settlements: 'none',
};

for (const kit of [paystackKit, monoKit]) {
  describe(`provider conformance: ${kit.providerType}`, () => {
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
            headers: req.headers,
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
        res.writeHead(500);
        res.end();
      };
    });

    const input = {
      reference: 'RKD-PAY-20260827-CONFRM',
      amountK: 4_500_000,
      currency: 'NGN',
      customerEmail: 'adaeze@example.com',
    };

    it('carries kobo UNMULTIPLIED under its own credential', async () => {
      respond = (_req, res) => kit.initialize.ok(res);
      const outcome = await kit.make(baseUrl).initializeTransaction(input);
      expect(outcome).toMatchObject({
        state: 'initialized',
        checkoutUrl: kit.initialize.checkoutUrl,
      });
      expect(requests).toHaveLength(1);
      kit.assertAuth(requests[0]!);
      expect(kit.initialize.amountOnWire(requests[0]!.body)).toBe(4_500_000);
    });

    it('answers a missing email as a product state, with NO request', async () => {
      const outcome = await kit
        .make(baseUrl)
        .initializeTransaction({ ...input, customerEmail: null });
      expect(outcome).toEqual({ state: 'requires_customer_information', missing: ['email'] });
      expect(requests).toHaveLength(0);
    });

    it('surfaces a provider refusal as an error, never a checkout URL', async () => {
      respond = (_req, res) => kit.initialize.refusal(res);
      await expect(kit.make(baseUrl).initializeTransaction(input)).rejects.toThrow();
    });

    it('normalises a successful verification, keeping kobo as kobo', async () => {
      respond = (_req, res) => kit.verify.success(res);
      const outcome = await kit.make(baseUrl).verifyTransaction(input.reference);
      if (!outcome.found) throw new Error('expected found');
      expect(outcome.transaction).toMatchObject({
        succeeded: true,
        amountK: 4_500_000,
        currency: 'NGN',
        providerFeeK: 67_500,
      });
      expect(outcome.transaction.providerStatus.length).toBeGreaterThan(0);
    });

    it('reports a failed charge as found-but-not-succeeded — the judgement decides', async () => {
      respond = (_req, res) => kit.verify.failed(res);
      const outcome = await kit.make(baseUrl).verifyTransaction(input.reference);
      if (!outcome.found) throw new Error('expected found');
      expect(outcome.transaction.succeeded).toBe(false);
    });

    it('answers found:false for an unknown reference instead of throwing', async () => {
      respond = (_req, res) => kit.verify.notFound(res);
      expect(await kit.make(baseUrl).verifyTransaction('RKD-PAY-20260827-NOBODY')).toEqual({
        found: false,
      });
    });

    it('lets a verification outage surface as an error', async () => {
      respond = (_req, res) => {
        res.writeHead(503);
        res.end();
      };
      await expect(kit.make(baseUrl).verifyTransaction(input.reference)).rejects.toThrow();
    });

    it(
      kit.settlements === 'polled'
        ? 'lets a settlement outage surface as an error — never an invented empty day'
        : 'answers no settlement batches HONESTLY: an empty list, and no request',
      async () => {
        if (kit.settlements === 'polled') {
          respond = (_req, res) => {
            res.writeHead(503);
            res.end();
          };
          await expect(kit.make(baseUrl).listSettlements('2026-08-20')).rejects.toThrow();
        } else {
          expect(await kit.make(baseUrl).listSettlements('2026-08-20')).toEqual([]);
          expect(requests).toHaveLength(0);
        }
      },
    );
  });
}
