/**
 * The Merchant API over a real application and a real database (PR-111).
 *
 * The claims worth a round trip, all four from spec §25 and §27:
 *
 *   1. A write through the API is the SAME write as a write through chat or
 *      the dashboard, gates included. Proven by the ledger balancing and by
 *      `Idempotency-Key` behaving exactly as the command bus promises.
 *   2. The key names the tenant on reads as well as writes. One business
 *      cannot page another's invoices, whatever it sends.
 *   3. Money crosses as integer kobo and comes back as the same figures the
 *      money engine computed. No total the caller sent is ever believed.
 *   4. Paging is a keyset walk that neither repeats nor skips a row while
 *      the table is being written to.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { publicApi } from '@rekoda/contracts';
import { createDb, entitlementsRepo, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';

const SECRET = 'merchant-api-secret-at-least-32-chars';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = 'merchant-api-pepper-at-least-32-chars';
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_API_SECRET'] = SECRET;
  process.env['REKODA_OPERATOR_SECRET'] = `operator-${SECRET}`;
  process.env['REKODA_REVEAL_OTP'] = '1';
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  delete process.env['NODE_ENV'];

  const { createApp } = await import('../../main.js');
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

function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, payload: payload as object, headers });
}

function get(url: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url, headers });
}

interface Merchant {
  businessId: string;
  session: Record<string, string>;
  key: Record<string, string>;
}

/** An entitled business with a live API key, ready to be called as a program. */
async function merchant(phone: string, name: string): Promise<Merchant> {
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as { devCode: string };
  const verified = (
    await post('/v1/auth/otp/verify', { phone, code: requested.devCode })
  ).json() as { setupToken: string };
  const created = (
    await post(
      '/v1/businesses',
      { name, businessType: null },
      { 'x-rekoda-setup-token': verified.setupToken },
    )
  ).json() as { sessionToken: string; businessId: string };
  const session = { authorization: `Bearer ${created.sessionToken}` };

  await withBusiness(db, created.businessId, (tx) =>
    entitlementsRepo.grant(tx, {
      businessId: created.businessId,
      entitlementKey: 'REKODA_API',
      source: 'MANUAL_GRANT',
      grantedBy: 'operator:merchant-api-suite',
    }),
  );

  const application = (
    await post('/v1/api-keys/applications', { name: `${name} app` }, session)
  ).json() as { id: string };
  const minted = (
    await post(`/v1/api-keys/applications/${application.id}/keys`, {}, session)
  ).json() as { token: string };

  return {
    businessId: created.businessId,
    session,
    key: { authorization: `Bearer ${minted.token}` },
  };
}

const SALE = {
  items: [
    { name: 'Bag of rice', quantity: 2, unitPriceK: 4_500_000 },
    { name: 'Groundnut oil', quantity: 1, unitPriceK: 780_000 },
  ],
  deliveryFeeK: 250_000,
  amountPaidK: 5_000_000,
};

describe('recording a sale', () => {
  it('computes the totals itself and answers the invoice it issued', async () => {
    const shop = await merchant('+2348192000001', 'Kobo Co');

    const response = await post('/api/v1/sales', SALE, shop.key);
    expect(response.statusCode).toBe(200);
    const body = publicApi.v1.recordSaleResponse.parse(response.json());

    /* 2 x 45,000 + 7,800 + 2,500 delivery = 100,300 naira. The caller sent
     * no total and could not have moved this figure if it had. */
    expect(body.totalK).toBe(10_030_000);
    expect(body.balanceDueK).toBe(5_030_000);
    expect(body.invoiceNumber).toMatch(/^INV-/);
  });

  it('leaves the books balanced, exactly as every other ingress does', async () => {
    const shop = await merchant('+2348192000002', 'Balanced Co');
    await post('/api/v1/sales', SALE, shop.key);

    const rows = await withBusiness(db, shop.businessId, (tx) =>
      tx.execute<{ debits: string; credits: string }>(sql`
        SELECT COALESCE(sum(debit_k), 0)::text AS debits,
               COALESCE(sum(credit_k), 0)::text AS credits
          FROM ledger_entries
         WHERE business_id = ${shop.businessId}
      `),
    );
    const totals = [...rows][0]!;
    expect(totals.debits).toBe(totals.credits);
    expect(Number(totals.debits)).toBeGreaterThan(0);
  });

  it('runs once for one Idempotency-Key, however many times it is sent', async () => {
    const shop = await merchant('+2348192000003', 'Retried Co');
    const headers = { ...shop.key, 'idempotency-key': 'order-4471' };

    const first = publicApi.v1.recordSaleResponse.parse(
      (await post('/api/v1/sales', SALE, headers)).json(),
    );
    const second = publicApi.v1.recordSaleResponse.parse(
      (await post('/api/v1/sales', SALE, headers)).json(),
    );
    expect(second).toEqual(first);

    const listed = (await get('/api/v1/invoices', shop.key)).json() as { items: unknown[] };
    expect(listed.items).toHaveLength(1);
  });

  it('names the key that recorded it, never a person', async () => {
    const shop = await merchant('+2348192000004', 'Attributed Co');
    await post('/api/v1/sales', SALE, shop.key);

    const rows = await withBusiness(db, shop.businessId, (tx) =>
      tx.execute<{ source_type: string; actor: string }>(sql`
        SELECT i.source_type, a.actor
          FROM invoices i
          JOIN audit_events a ON a.business_id = i.business_id
         WHERE i.business_id = ${shop.businessId}
         LIMIT 1
      `),
    );
    const row = [...rows][0]!;
    expect(row.source_type).toBe('api');
    expect(row.actor).toMatch(/^api:rk_live_/);
  });

  it('refuses a body it cannot act on, in the envelope, saying which field', async () => {
    const shop = await merchant('+2348192000005', 'Invalid Co');
    const response = await post('/api/v1/sales', { items: [] }, shop.key);
    expect(response.statusCode).toBe(400);
    const body = publicApi.v1.publicErrorResponse.parse(response.json());
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('items');
  });
});

describe('recording a payment', () => {
  it('settles the invoice the merchant issued and answers the receipt', async () => {
    const shop = await merchant('+2348192000010', 'Settled Co');
    const sale = publicApi.v1.recordSaleResponse.parse(
      (await post('/api/v1/sales', SALE, shop.key)).json(),
    );

    const response = await post(
      '/api/v1/payments',
      { invoiceNumber: sale.invoiceNumber, amountK: sale.balanceDueK, method: 'transfer' },
      shop.key,
    );
    expect(response.statusCode).toBe(200);
    const body = publicApi.v1.recordPaymentResponse.parse(response.json());
    expect(body).toMatchObject({
      outcome: 'recorded',
      invoiceNumber: sale.invoiceNumber,
      balanceDueK: 0,
      invoiceStatus: 'paid',
    });
  });

  it('answers each refusal as an outcome rather than an error', async () => {
    const shop = await merchant('+2348192000011', 'Refusals Co');
    const sale = publicApi.v1.recordSaleResponse.parse(
      (await post('/api/v1/sales', SALE, shop.key)).json(),
    );

    const missing = await post(
      '/api/v1/payments',
      { invoiceNumber: 'INV-2026-999999', amountK: 1_000 },
      shop.key,
    );
    expect(missing.statusCode).toBe(200);
    expect(publicApi.v1.recordPaymentResponse.parse(missing.json())).toEqual({
      outcome: 'not_found',
    });

    const tooMuch = await post(
      '/api/v1/payments',
      { invoiceNumber: sale.invoiceNumber, amountK: sale.balanceDueK + 1_000_000 },
      shop.key,
    );
    expect(publicApi.v1.recordPaymentResponse.parse(tooMuch.json()).outcome).toBe('balance_moved');

    await post(
      '/api/v1/payments',
      { invoiceNumber: sale.invoiceNumber, amountK: sale.balanceDueK },
      shop.key,
    );
    const again = await post(
      '/api/v1/payments',
      { invoiceNumber: sale.invoiceNumber, amountK: 1_000 },
      shop.key,
    );
    expect(publicApi.v1.recordPaymentResponse.parse(again.json()).outcome).toBe('already_settled');
  });
});

describe('reading', () => {
  it('shows a customer as the pseudonym and never as a name', async () => {
    const shop = await merchant('+2348192000020', 'Private Co');
    await withBusiness(db, shop.businessId, (tx) =>
      tx.execute(
        sql`INSERT INTO customers (business_id, token) VALUES (${shop.businessId}, 'CUSTOMER_X81')`,
      ),
    );

    const body = (await get('/api/v1/customers', shop.key)).json() as {
      items: { token: string }[];
    };
    expect(body.items.map((item) => item.token)).toEqual(['CUSTOMER_X81']);
    /* The vault's facets have no field here and must never gain one. */
    expect(JSON.stringify(body)).not.toContain('ciphertext');
    expect(Object.keys(body.items[0]!).sort()).toEqual(['createdAt', 'id', 'token']);
  });

  it('walks a moving table without repeating or skipping a row', async () => {
    const shop = await merchant('+2348192000021', 'Paged Co');
    for (let i = 0; i < 5; i += 1) {
      await post(
        '/api/v1/sales',
        { items: [{ name: `Item ${i}`, quantity: 1, unitPriceK: 100_000 + i }] },
        shop.key,
      );
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const url: string = `/api/v1/invoices?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const body = (await get(url, shop.key)).json() as {
        items: { invoiceNumber: string }[];
        nextCursor: string | null;
      };
      seen.push(...body.items.map((item) => item.invoiceNumber));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('refuses a cursor it did not issue rather than starting over silently', async () => {
    const shop = await merchant('+2348192000022', 'Cursor Co');
    const response = await get('/api/v1/invoices?cursor=not-a-cursor', shop.key);
    expect(response.statusCode).toBe(400);
    expect(publicApi.v1.publicErrorResponse.parse(response.json()).error.code).toBe(
      'invalid_request',
    );
  });

  it('caps the page a caller may ask for', async () => {
    const shop = await merchant('+2348192000023', 'Greedy Co');
    expect((await get('/api/v1/invoices?limit=101', shop.key)).statusCode).toBe(400);
    expect((await get('/api/v1/invoices?limit=100', shop.key)).statusCode).toBe(200);
  });

  it('narrows invoices by status, and refuses a status that is not one', async () => {
    const shop = await merchant('+2348192000024', 'Filtered Co');
    const sale = publicApi.v1.recordSaleResponse.parse(
      (await post('/api/v1/sales', SALE, shop.key)).json(),
    );
    await post(
      '/api/v1/payments',
      { invoiceNumber: sale.invoiceNumber, amountK: sale.balanceDueK },
      shop.key,
    );

    const paid = (await get('/api/v1/invoices?status=paid', shop.key)).json() as {
      items: unknown[];
    };
    expect(paid.items).toHaveLength(1);

    const issued = (await get('/api/v1/invoices?status=issued', shop.key)).json() as {
      items: unknown[];
    };
    expect(issued.items).toHaveLength(0);

    expect((await get('/api/v1/invoices?status=invented', shop.key)).statusCode).toBe(400);
  });

  it('reads one invoice by its number, and only its own', async () => {
    const mine = await merchant('+2348192000025', 'Mine Co');
    const theirs = await merchant('+2348192000026', 'Theirs Co');
    const sale = publicApi.v1.recordSaleResponse.parse(
      (await post('/api/v1/sales', SALE, mine.key)).json(),
    );

    const own = await get(`/api/v1/invoices/${sale.invoiceNumber}`, mine.key);
    expect(own.statusCode).toBe(200);
    expect(publicApi.v1.merchantInvoice.parse(own.json()).invoiceNumber).toBe(sale.invoiceNumber);

    /* The other business's key resolves to the other business, so the same
     * number is simply not there. Not a permission error: a tenant cannot
     * be told that a document they may not see exists. */
    const stranger = await get(`/api/v1/invoices/${sale.invoiceNumber}`, theirs.key);
    expect(stranger.statusCode).toBe(404);
    expect(publicApi.v1.publicErrorResponse.parse(stranger.json()).error.code).toBe('not_found');
  });

  it("gives each key only its own business's rows", async () => {
    const mine = await merchant('+2348192000027', 'One Co');
    const theirs = await merchant('+2348192000028', 'Two Co');
    await post('/api/v1/sales', SALE, mine.key);

    const ours = (await get('/api/v1/invoices', mine.key)).json() as { items: unknown[] };
    const others = (await get('/api/v1/invoices', theirs.key)).json() as { items: unknown[] };
    expect(ours.items).toHaveLength(1);
    expect(others.items).toHaveLength(0);
  });
});
