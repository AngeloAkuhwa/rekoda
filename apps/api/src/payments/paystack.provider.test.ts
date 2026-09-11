/**
 * The Paystack adapter (docs/payments-v1.md §6, §20), against a real HTTP
 * server — because the claims worth having are about what actually goes over
 * the wire: the kobo that must not be multiplied, the header that must carry
 * the secret, the channels that must lead with bank_transfer, and the email
 * that must never be invented.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaystackApiError, PaystackProvider, disputeOutcome } from './paystack.provider.js';

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

describe('listing settlements (§26–28)', () => {
  it('asks with the secret and the from date, and translates the vocabulary', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: true,
          data: [
            {
              id: 91,
              status: 'success',
              settlement_date: '2026-08-19T04:00:00.000Z',
              total_amount: 6_500_000,
              effective_amount: 6_397_750,
            },
            { id: 92, status: 'processing', effective_date: '2026-08-20T04:00:00.000Z' },
            { id: 93, status: 'dancing', settlement_date: '2026-08-20T04:00:00.000Z' },
          ],
        }),
      );
    };
    const settlements = await provider().listSettlements('2026-08-13T00:00:00.000Z');

    expect(requests[0]?.authorization).toBe('Bearer sk_test_secret');
    expect(requests[0]?.url).toContain('/settlement?from=2026-08-13');

    expect(settlements[0]).toEqual({
      settlementId: '91',
      status: 'settled',
      providerStatus: 'success',
      settledAtIso: '2026-08-19T04:00:00.000Z',
      /* Kobo, verbatim off GET /settlement (PR-064): the provider's own
       * totals, or null where a row never stated them. */
      grossK: 6_500_000,
      netK: 6_397_750,
    });
    expect(settlements[1]?.grossK).toBeNull();
    expect(settlements[1]?.netK).toBeNull();
    // Still moving: no settled date is claimed for money not yet landed.
    expect(settlements[1]?.status).toBe('processing');
    expect(settlements[1]?.settledAtIso).toBeNull();
    // A word this adapter has never seen becomes held — NEVER settled or failed.
    expect(settlements[2]?.status).toBe('held');
    expect(settlements[2]?.settledAtIso).toBeNull();
  });

  it('returns the references a batch carried, skipping entries without one', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: true,
          data: [{ reference: 'RKD-PAY-20260819-AAAAAA' }, { reference: null }, {}],
        }),
      );
    };
    const references = await provider().listSettlementTransactions('91');
    expect(requests[0]?.url).toContain('/settlement/91/transactions');
    expect(references).toEqual(['RKD-PAY-20260819-AAAAAA']);
  });

  it('throws on a 5xx so the sweep logs an outage instead of inventing an empty day', async () => {
    respond = (_req, res) => {
      res.writeHead(503);
      res.end();
    };
    await expect(provider().listSettlements('2026-08-13T00:00:00.000Z')).rejects.toBeInstanceOf(
      PaystackApiError,
    );
  });

  it('follows the pager past the first hundred settlements instead of dropping the rest', async () => {
    respond = (req, res) => {
      const page = Number(new URL(req.url ?? '', 'http://x').searchParams.get('page') ?? '1');
      const data =
        page === 1
          ? Array.from({ length: 100 }, (_, i) => ({
              id: i + 1,
              status: 'success',
              settlement_date: '2026-08-19T04:00:00.000Z',
            }))
          : [{ id: 999, status: 'success', settlement_date: '2026-08-20T04:00:00.000Z' }];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: true, data, meta: { page, pageCount: 2, perPage: 100 } }));
    };

    const settlements = await provider().listSettlements('2026-08-13T00:00:00.000Z');
    expect(settlements).toHaveLength(101);
    expect(settlements.at(-1)?.settlementId).toBe('999');
    expect(requests.map((r) => r.url)).toEqual([
      expect.stringContaining('page=1'),
      expect.stringContaining('page=2'),
    ]);
  });

  it('stops the moment a page comes back short, so it never over-asks the provider', async () => {
    respond = (req, res) => {
      const page = Number(new URL(req.url ?? '', 'http://x').searchParams.get('page') ?? '1');
      /* The pager claims three pages, but page two is short: a lying count
       * must not make the sweep hammer pages that will never fill. */
      const data =
        page === 1
          ? Array.from({ length: 100 }, (_, i) => ({
              id: i + 1,
              status: 'success',
              settlement_date: '2026-08-19T04:00:00.000Z',
            }))
          : [{ id: 500, status: 'success', settlement_date: '2026-08-20T04:00:00.000Z' }];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: true, data, meta: { page, pageCount: 9, perPage: 100 } }));
    };

    const settlements = await provider().listSettlements('2026-08-13T00:00:00.000Z');
    expect(settlements).toHaveLength(101);
    expect(requests).toHaveLength(2);
  });

  it('collects settlement references across every page, not just the first', async () => {
    respond = (req, res) => {
      const page = Number(new URL(req.url ?? '', 'http://x').searchParams.get('page') ?? '1');
      const data =
        page === 1
          ? Array.from({ length: 200 }, (_, i) => ({ reference: `RKD-PAY-P1-${i}` }))
          : [{ reference: 'RKD-PAY-P2-LAST' }];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: true, data, meta: { page, pageCount: 2, perPage: 200 } }));
    };

    const references = await provider().listSettlementTransactions('91');
    expect(references).toHaveLength(201);
    expect(references).toContain('RKD-PAY-P2-LAST');
    expect(requests.map((r) => r.url)).toEqual([
      expect.stringContaining('page=1'),
      expect.stringContaining('page=2'),
    ]);
  });
});

describe('reading a refund and a dispute (G-06)', () => {
  it('reads a refund the way it reads a charge: kobo as kobo, the charge it refunds, verbatim status', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: true,
          data: {
            id: 501,
            status: 'processed',
            amount: 4_000_000,
            currency: 'NGN',
            transaction: { id: 4099260516, reference: 'RKD-PAY-20260819-A83F92' },
            refunded_at: '2026-09-11T10:00:00.000Z',
          },
        }),
      );
    };
    const result = await provider().verifyRefund('501');
    if (!result.found) throw new Error('expected found');
    expect(result.refund).toEqual({
      succeeded: true,
      providerRefundId: '501',
      transactionReference: 'RKD-PAY-20260819-A83F92',
      transactionId: '4099260516',
      amountK: 4_000_000,
      currency: 'NGN',
      providerStatus: 'processed',
      refundedAtIso: '2026-09-11T10:00:00.000Z',
    });
    expect(requests[0]?.url).toBe('/refund/501');
    expect(requests[0]?.authorization).toBe('Bearer sk_test_secret');
  });

  it('reads the DOCUMENTED Fetch Refund response: the charge is a bare transaction id, no reference', async () => {
    /* Verbatim from paystack.com/docs/api/refund/#fetch (sample response). */
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: true,
          message: 'Refund retrieved',
          data: {
            integration: 100982,
            transaction: 1641,
            dispute: null,
            settlement: null,
            domain: 'live',
            amount: 500000,
            deducted_amount: 500000,
            fully_deducted: true,
            currency: 'NGN',
            channel: 'migs',
            status: 'processed',
            refunded_by: 'eseyinwale@gmail.com',
            refunded_at: '2018-01-12T10:54:47.000Z',
            expected_at: '2017-10-01T21:10:59.000Z',
            customer_note: 'xxx',
            merchant_note: 'xxx',
            id: 1,
            createdAt: '2017-09-24T21:10:59.000Z',
            updatedAt: '2018-01-18T11:59:56.000Z',
          },
        }),
      );
    };
    const result = await provider().verifyRefund('1');
    if (!result.found) throw new Error('expected found');
    expect(result.refund).toMatchObject({
      succeeded: true,
      providerRefundId: '1',
      transactionReference: null,
      transactionId: '1641',
      amountK: 500000,
      currency: 'NGN',
      providerStatus: 'processed',
    });
  });

  it('lists the refunds against one charge by transaction id, each read the same way', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: true,
          message: 'Refunds retrieved',
          data: [
            { id: 7, transaction: 1641, amount: 300000, currency: 'NGN', status: 'processed' },
            { id: 8, transaction: 1641, amount: 200000, currency: 'NGN', status: 'pending' },
          ],
        }),
      );
    };
    const listed = await provider().listRefunds('1641', 'NGN');
    expect(
      listed.map((r) => [r.providerRefundId, r.transactionId, r.amountK, r.succeeded]),
    ).toEqual([
      ['7', '1641', 300000, true],
      ['8', '1641', 200000, false],
    ]);
    expect(requests[0]?.url).toBe('/refund?transaction=1641&currency=NGN&perPage=50');
  });

  it('a pending refund is found-but-not-succeeded; an unknown one is found:false; an outage throws', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: true, data: { id: 502, status: 'pending', amount: 100 } }));
    };
    const pending = await provider().verifyRefund('502');
    if (!pending.found) throw new Error('expected found');
    expect(pending.refund.succeeded).toBe(false);

    respond = (_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: false, message: 'Refund not found' }));
    };
    expect(await provider().verifyRefund('503')).toEqual({ found: false });

    respond = (_req, res) => {
      res.writeHead(503);
      res.end();
    };
    await expect(provider().verifyRefund('504')).rejects.toBeInstanceOf(PaystackApiError);
  });

  it('translates the dispute lifecycle: lost only when resolved against the merchant, won when declined, otherwise open', () => {
    expect(disputeOutcome('awaiting-merchant-feedback', null)).toBe('open');
    expect(disputeOutcome('pending', 'merchant-accepted')).toBe('open');
    expect(disputeOutcome('resolved', 'merchant-accepted')).toBe('lost');
    expect(disputeOutcome('resolved', 'auto-accepted')).toBe('lost');
    expect(disputeOutcome('resolved', 'declined')).toBe('won');
    expect(disputeOutcome('resolved', 'something-new')).toBe('open');
    expect(disputeOutcome('resolved', null)).toBe('open');
  });

  it('reads a dispute and reports the provider words verbatim beside the translation', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: true,
          data: {
            id: 602,
            status: 'resolved',
            resolution: 'merchant-accepted',
            refund_amount: 15_000_000,
            currency: 'NGN',
            transaction: { id: 1, reference: 'RKD-PAY-20260819-A83F92', amount: 15_000_000 },
          },
        }),
      );
    };
    const result = await provider().verifyDispute('602');
    if (!result.found) throw new Error('expected found');
    expect(result.dispute).toEqual({
      providerDisputeId: '602',
      transactionReference: 'RKD-PAY-20260819-A83F92',
      transactionId: '1',
      amountK: 15_000_000,
      currency: 'NGN',
      providerStatus: 'resolved',
      providerResolution: 'merchant-accepted',
      outcome: 'lost',
    });
    expect(requests[0]?.url).toBe('/dispute/602');
  });

  it("a dispute read without refund_amount reports NO amount, never the charge's", async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: true,
          data: {
            id: 603,
            status: 'resolved',
            resolution: 'merchant-accepted',
            currency: 'NGN',
            transaction: { id: 1, reference: 'RKD-PAY-20260819-A83F92', amount: 15_000_000 },
          },
        }),
      );
    };
    const result = await provider().verifyDispute('603');
    if (!result.found) throw new Error('expected found');
    expect(result.dispute.amountK).toBeNull();
    expect(result.dispute.outcome).toBe('lost');
  });
});
