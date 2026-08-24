/**
 * Pay with Transfer on the merchant's own key, end to end (ADR 0016 + 0019,
 * fix-plan 6 M5c).
 *
 * Booted like the merchant-key suite: CONNECTION_KEY set and
 * PAYSTACK_BASE_URL pointed at a local stub, so the claims under test are
 * the real ones — the charge goes out on the MERCHANT's key, the temporary
 * account is re-shown rather than re-minted while it lives, `paid` is only
 * ever Paystack's own answer, and a lapsed number leaves the invoice open
 * for a fresh one.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  paymentConnectionResponse,
  payWithTransferResponse,
  publicOrderResponse,
  reportsInvoicesResponse,
  transferStatusResponse,
} from '@rekoda/contracts';
import { PAYMENT_REFERENCE_PATTERN } from '@rekoda/core';
import {
  createDb,
  issueRepo,
  jobsRepo,
  paymentsHub,
  settleRepo,
  stockRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import {
  lapseTransferIntents,
  migrate,
  requireUrls,
  truncateAll,
  type Urls,
} from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

let paystack: Server;
interface SeenCall {
  method: string;
  url: string;
  auth: string;
  body: Record<string, unknown> | null;
}
let seen: SeenCall[];
/** What GET /transaction/verify answers. Reset per test to "not found". */
let verifyAnswer: (reference: string) => { status: number; body: unknown };
let nextAccount: number;

beforeAll(async () => {
  paystack = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      const url = req.url ?? '';
      seen.push({
        method: req.method ?? '',
        url,
        auth: String(req.headers.authorization ?? ''),
        body,
      });
      respond(req, res, url, body);
    });
  });
  await new Promise<void>((resolve) => paystack.listen(0, '127.0.0.1', resolve));
  const address = paystack.address();
  if (!address || typeof address === 'string') throw new Error('no address');

  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['CONNECTION_KEY'] = randomBytes(32).toString('hex');
  process.env['PAYSTACK_BASE_URL'] = `http://127.0.0.1:${address.port}`;
  /* The graduation view is cross-tenant and operator-gated (M5d). */
  process.env['WORKER_DATABASE_URL'] = urls.worker;
  process.env['REKODA_OPERATOR_SECRET'] = `operator-${randomBytes(24).toString('hex')}`;
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
  await closeDb?.();
  await new Promise((resolve) => paystack.close(resolve));
  delete process.env['CONNECTION_KEY'];
  delete process.env['PAYSTACK_BASE_URL'];
  delete process.env['WORKER_DATABASE_URL'];
  delete process.env['REKODA_OPERATOR_SECRET'];
});

beforeEach(async () => {
  await truncateAll(urls);
  seen = [];
  nextAccount = 7_042_318_856;
  verifyAnswer = () => ({ status: 404, body: { status: false, message: 'not found' } });
});

/** The stub's routes: key check, charge, verify. Anything else is a 404. */
function respond(
  _req: IncomingMessage,
  res: ServerResponse,
  url: string,
  body: Record<string, unknown> | null,
): void {
  const json = (status: number, payload: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  if (url.startsWith('/balance')) return json(200, { status: true, data: [] });
  if (url.startsWith('/charge')) {
    const accountNumber = String(nextAccount++);
    return json(200, {
      status: true,
      message: 'Charge attempted',
      data: {
        reference: body?.['reference'],
        status: 'pending_bank_transfer',
        bank_transfer: {
          account_number: accountNumber,
          account_name: 'PAYSTACK-ADA FASHION',
          account_expires_at: body?.['bank_transfer']
            ? ((body['bank_transfer'] as Record<string, unknown>)['account_expires_at'] ?? null)
            : null,
          bank: { name: 'Wema Bank' },
        },
      },
    });
  }
  const verifyMatch = url.match(/^\/transaction\/verify\/([^?]+)/);
  if (verifyMatch) {
    const answer = verifyAnswer(decodeURIComponent(verifyMatch[1]!));
    return json(answer.status, answer.body);
  }
  json(404, { status: false, message: 'unknown route' });
}

/** Paystack's verify envelope for a confirmed transfer of `amountK`. */
function verifiedSuccess(reference: string, amountK: number) {
  return {
    status: 200,
    body: {
      status: true,
      data: {
        /* Unique per transaction, as Paystack's real ids are: provider_ref
         * carries a per-business unique index and the test pays twice. */
        id: `tx-${reference}`,
        status: 'success',
        reference,
        amount: amountK,
        currency: 'NGN',
        fees: 25_000,
        channel: 'bank_transfer',
        paid_at: '2026-08-24T12:00:00.000Z',
      },
    },
  };
}

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', ...headers },
  });

const fakeKey = (label: string) => ['sk', 'test', label].join('_');

async function onboard(phone: string) {
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as { devCode?: string };
  const verified = (
    await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
  ).json() as { setupToken: string };
  const created = await post(
    '/v1/businesses',
    { name: 'Ada Fashion', businessType: 'Fashion & clothing' },
    { 'x-rekoda-setup-token': verified.setupToken },
  );
  const session = created.json() as { sessionToken: string; businessId: string };
  return {
    businessId: session.businessId,
    auth: { authorization: `Bearer ${session.sessionToken}` },
  };
}

/** A published shop with one priced product and, optionally, a merchant key. */
async function openShop(phone: string, slug: string, withKey = true, priceK = 850_000) {
  const { businessId, auth } = await onboard(phone);
  const productId = await withBusiness(db, businessId, async (tx) => {
    const product = await stockRepo.findOrCreateProduct(tx, businessId, 'Ankara bale');
    await stockRepo.recordMovement(tx, {
      businessId,
      productId: product.id,
      delta: 10,
      reason: 'adjustment',
      sourceType: 'chat',
      sourceId: 'seed',
    });
    return product.id;
  });
  await post('/v1/catalogue/product', { id: productId, unitPriceK: priceK }, auth);
  expect(
    (
      await post(
        '/v1/shop-settings',
        { slug, displayName: 'Ada Fashion', tagline: null, published: true },
        auth,
      )
    ).json(),
  ).toMatchObject({ outcome: 'saved' });
  if (withKey) {
    expect(
      (await post('/v1/payments/merchant-key', { secretKey: fakeKey('pay_4821') }, auth)).json(),
    ).toMatchObject({ state: 'connected' });
  }
  return { businessId, auth, productId };
}

async function placeOrder(slug: string, productId: string) {
  const clientRef = randomUUID();
  const placed = publicOrderResponse.parse(
    (
      await post(`/v1/shop/${slug}/orders`, {
        items: [{ productId, quantity: 2 }],
        customerName: 'Chidi Okafor',
        customerPhone: '0803 555 1234',
        clientRef,
      })
    ).json(),
  );
  expect(placed.outcome).toBe('placed');
  return clientRef;
}

const askTransfer = (slug: string, clientRef: string, email = 'chidi@example.com') =>
  post(`/v1/shop/${slug}/pay-with-transfer`, { clientRef, email });

const askStatus = (slug: string, clientRef: string) =>
  app.inject({
    method: 'GET',
    url: `/v1/shop/${slug}/transfer-status?clientRef=${clientRef}`,
  });

describe('paying a storefront order by transfer (fix-plan 6, M5c)', () => {
  it('charges on the merchant key, re-shows the same account, and books only what Paystack confirms', async () => {
    const { businessId, auth, productId } = await openShop('+2348199300001', 'ada-pay');
    const clientRef = await placeOrder('ada-pay', productId);

    const account = payWithTransferResponse.parse((await askTransfer('ada-pay', clientRef)).json());
    expect(account).toMatchObject({
      outcome: 'account',
      bankName: 'Wema Bank',
      accountNumber: '7042318856',
      amountK: 1_700_000,
    });
    if (account.outcome !== 'account') return;
    expect(account.reference).toMatch(PAYMENT_REFERENCE_PATTERN);

    /* The charge went out on the MERCHANT's key, with the server's figures
     * and the customer's email — which is the only place that email goes. */
    const charge = seen.find((c) => c.url.startsWith('/charge'));
    expect(charge?.auth).toBe(`Bearer ${fakeKey('pay_4821')}`);
    expect(charge?.body).toMatchObject({
      amount: 1_700_000,
      currency: 'NGN',
      email: 'chidi@example.com',
      reference: account.reference,
    });

    /* Asking again re-shows the SAME number. One obligation, one account. */
    const again = payWithTransferResponse.parse((await askTransfer('ada-pay', clientRef)).json());
    expect(again).toMatchObject({ outcome: 'account', accountNumber: '7042318856' });
    expect(seen.filter((c) => c.url.startsWith('/charge'))).toHaveLength(1);

    /* "I have sent it" before any money exists stays pending. */
    expect(transferStatusResponse.parse((await askStatus('ada-pay', clientRef)).json())).toEqual({
      state: 'pending',
    });

    /* Paystack confirms; the poll books it VERIFIED, at Paystack's figure. */
    verifyAnswer = (reference) => verifiedSuccess(reference, 1_700_000);
    expect(
      transferStatusResponse.parse((await askStatus('ada-pay', clientRef)).json()),
    ).toMatchObject({ state: 'paid' });

    const register = reportsInvoicesResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/reports/invoices', headers: auth })).json(),
    );
    expect(register.invoices[0]).toMatchObject({ balanceDueK: 0, status: 'paid' });

    /* Booked once, and idempotently: a second tap changes nothing. */
    expect(
      transferStatusResponse.parse((await askStatus('ada-pay', clientRef)).json()),
    ).toMatchObject({ state: 'paid' });
    const payments = await withBusiness(db, businessId, (tx) => settleRepo.paymentCount(tx));
    expect(payments).toBe(1);

    /* And the books still balance around the fee split. */
    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    expect(entries.reduce((n, e) => n + e.debitK, 0)).toBe(
      entries.reduce((n, e) => n + e.creditK, 0),
    );
  });

  it('a shop without a merchant key answers not_available, and a stray ref order_gone', async () => {
    const { productId } = await openShop('+2348199300002', 'ada-nokey', false);
    const clientRef = await placeOrder('ada-nokey', productId);

    expect(
      payWithTransferResponse.parse((await askTransfer('ada-nokey', clientRef)).json()),
    ).toEqual({ outcome: 'not_available' });
    /* No provider traffic happened for it, either. */
    expect(seen.filter((c) => c.url.startsWith('/charge'))).toHaveLength(0);

    const { productId: paidProduct } = await openShop('+2348199300003', 'ada-strays');
    await placeOrder('ada-strays', paidProduct);
    expect(
      payWithTransferResponse.parse((await askTransfer('ada-strays', randomUUID())).json()),
    ).toEqual({ outcome: 'order_gone' });
  });

  it('crossing the graduation threshold nudges the merchant once, and the operator sees it', async () => {
    /* Two bales of N800,000: one order carries lifetime collections past the
     * N1.5M nudge line, and a second past the N2M Starter cap itself. */
    const { businessId, auth, productId } = await openShop(
      '+2348199300005',
      'ada-milestone',
      true,
      80_000_000,
    );
    verifyAnswer = (reference) => verifiedSuccess(reference, 160_000_000);

    const firstRef = await placeOrder('ada-milestone', productId);
    expect((await askTransfer('ada-milestone', firstRef)).statusCode).toBe(200);
    expect(
      transferStatusResponse.parse((await askStatus('ada-milestone', firstRef)).json()),
    ).toMatchObject({ state: 'paid' });

    /* The card now carries the figure the cap measures, and the one-time
     * nudge is claimed and queued in the same transaction that booked. */
    const connection = paymentConnectionResponse.parse(
      (await app.inject({ method: 'GET', url: '/v1/payments/connection', headers: auth })).json(),
    );
    expect(connection.collectedToDateK).toBe(160_000_000);
    const nudged = await withBusiness(db, businessId, async (tx) => ({
      queued: await jobsRepo.hasJobForSingleton(
        tx,
        businessId,
        'graduation.nudge',
        `graduation:${businessId}`,
      ),
      row: await paymentsHub.connectionFor(tx, businessId, 'paystack'),
      claimAgain: await paymentsHub.claimGraduationNudge(tx, businessId, 'paystack'),
    }));
    expect(nudged.queued).toBe(true);
    expect(nudged.row?.graduationNudgedAt).not.toBeNull();
    /* Already claimed: a second crossing can never mint a second milestone. */
    expect(nudged.claimAgain).toBe(false);

    /* A second big sale books normally and nudges nobody twice. */
    const secondRef = await placeOrder('ada-milestone', productId);
    expect((await askTransfer('ada-milestone', secondRef)).statusCode).toBe(200);
    expect(
      transferStatusResponse.parse((await askStatus('ada-milestone', secondRef)).json()),
    ).toMatchObject({ state: 'paid' });

    /* The operator's graduation view: id, lifetime figure, and the state
     * that says a human should be ready to help with registration. */
    const report = (
      await app.inject({
        method: 'GET',
        url: '/v1/ops/graduation',
        headers: { 'x-rekoda-operator-secret': process.env['REKODA_OPERATOR_SECRET']! },
      })
    ).json() as {
      capK: number;
      businesses: Array<{ businessId: string; collectedK: number; state: string }>;
    };
    const mine = report.businesses.find((b) => b.businessId === businessId);
    expect(mine).toMatchObject({ collectedK: 320_000_000, state: 'capped_risk' });

    /* And never without the secret. */
    expect((await app.inject({ method: 'GET', url: '/v1/ops/graduation' })).statusCode).toBe(403);
  });

  it('a lapsed number leaves the invoice open, and the next ask mints a fresh one', async () => {
    const { businessId, productId } = await openShop('+2348199300004', 'ada-lapse');
    const clientRef = await placeOrder('ada-lapse', productId);

    const first = payWithTransferResponse.parse((await askTransfer('ada-lapse', clientRef)).json());
    expect(first).toMatchObject({ outcome: 'account', accountNumber: '7042318856' });
    if (first.outcome !== 'account') return;

    /* Time passes: the account (and with it the intent) lapses unpaid. */
    await lapseTransferIntents(urls, businessId);

    expect(transferStatusResponse.parse((await askStatus('ada-lapse', clientRef)).json())).toEqual({
      state: 'expired',
    });

    /* One tap, one fresh number — a NEW reference, never the old one reused. */
    const second = payWithTransferResponse.parse(
      (await askTransfer('ada-lapse', clientRef)).json(),
    );
    expect(second).toMatchObject({ outcome: 'account', accountNumber: '7042318857' });
    if (second.outcome !== 'account') return;
    expect(second.reference).not.toBe(first.reference);
    expect(seen.filter((c) => c.url.startsWith('/charge'))).toHaveLength(2);
  });
});
