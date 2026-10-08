/**
 * The dashboard overpayment two-step on the RecordPayment command bus, the
 * default since Build 9 (OD-4, OWN-22), G-49 / OWN-16.
 *
 * Since Build 9 the dashboard payment passes the bus NO idempotency key: a
 * resubmitted form is a `duplicate` through the pre-check and the payment's
 * unique client reference, exactly as on the direct path, and a key would
 * only have replayed an old answer. So this proves the bargain the form
 * relies on without one: the question books nothing, the confirmed submit
 * books once, a retry of it is a duplicate, a stale confirmation books
 * nothing however often it is sent, and a FRESH key re-asks and books.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordPaymentResponse } from '@rekoda/contracts';
import { createDb, issueRepo, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

let urls: Urls;
let app: NestFastifyApplication;
let db: Db;
let closeDb: () => Promise<void>;

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
  process.env['REKODA_COMMAND_RECORD_PAYMENT'] = '1';
  delete process.env['NODE_ENV'];

  const { createApp } = await import('../main.js');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
});

afterAll(async () => {
  delete process.env['REKODA_COMMAND_RECORD_PAYMENT'];
  await app?.close();
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

function post(path: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: path,
    payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function onboard(phone: string) {
  const requested = (await post('/v1/auth/otp/request', { phone })).json() as {
    devCode?: string;
  };
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

async function unpaidSale(businessId: string) {
  return withBusiness(db, businessId, async (tx) => {
    const sale = await issueRepo.issueSale(tx, {
      businessId,
      customerId: null,
      customerToken: null,
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
      sourceId: 'draft-bus',
      actor: 'system',
    });
    return sale.invoiceNumber;
  });
}

async function counts(businessId: string) {
  const [row] = [
    ...(await withBusiness(db, businessId, (tx) =>
      tx.execute<Record<string, number>>(sql`
        SELECT
          (SELECT count(*)::int FROM payments WHERE business_id = ${businessId}) AS payments,
          (SELECT count(*)::int FROM customer_credits WHERE business_id = ${businessId}) AS credits,
          (SELECT count(*)::int FROM reconciliations WHERE business_id = ${businessId}) AS marks,
          (SELECT count(*)::int FROM receipts WHERE business_id = ${businessId}) AS receipts,
          (SELECT count(*)::int FROM idempotency_records
            WHERE business_id = ${businessId} AND command_name = 'RecordPayment') AS claims
      `),
    )),
  ];
  return row;
}

async function record(auth: Record<string, string>, body: Record<string, unknown>) {
  const res = await post('/v1/reports/payments/record', body, auth);
  expect(res.statusCode).toBe(200);
  return recordPaymentResponse.parse(res.json());
}

describe('the dashboard overpayment two-step, command bus on (G-49)', () => {
  it('the question books nothing; the confirmation books once; a retry is a duplicate', async () => {
    const { auth, businessId } = await onboard('+2348177000201');
    const invoiceNumber = await unpaidSale(businessId);
    const clientRef = randomUUID();
    const ask = { invoiceNumber, amountK: 18_000_000, method: 'cash', clientRef };

    expect(await record(auth, ask)).toMatchObject({ outcome: 'confirm_overpayment' });
    expect(await counts(businessId)).toEqual({
      payments: 0,
      credits: 0,
      marks: 0,
      receipts: 0,
      claims: 0,
    });

    const confirm = { ...ask, confirmOverpayment: true, expectedBalanceK: 15_000_000 };
    expect(await record(auth, confirm)).toMatchObject({
      outcome: 'recorded',
      amountK: 15_000_000,
      receivedK: 18_000_000,
      creditK: 3_000_000,
    });
    const booked = await counts(businessId);
    /* No bus key, so no claim row: the payment itself is the record. */
    expect(booked).toEqual({ payments: 1, credits: 0, marks: 1, receipts: 1, claims: 0 });

    expect(await record(auth, confirm)).toEqual({ outcome: 'duplicate' });
    expect(await counts(businessId)).toEqual(booked);
  });

  it('after a stale confirmation, a fresh key re-asks and books; the stale key books nothing', async () => {
    const { auth, businessId } = await onboard('+2348177000202');
    const invoiceNumber = await unpaidSale(businessId);
    const staleKey = randomUUID();
    const ask = { invoiceNumber, amountK: 18_000_000, method: 'cash', clientRef: staleKey };

    expect(await record(auth, ask)).toMatchObject({ outcome: 'confirm_overpayment' });
    /* Money lands while the merchant reads the question. */
    expect(
      await record(auth, {
        invoiceNumber,
        amountK: 5_000_000,
        method: 'transfer',
        clientRef: randomUUID(),
      }),
    ).toMatchObject({ outcome: 'recorded' });
    const before = await counts(businessId);

    expect(
      await record(auth, { ...ask, confirmOverpayment: true, expectedBalanceK: 15_000_000 }),
    ).toMatchObject({ outcome: 'balance_moved', balanceDueK: 10_000_000 });
    /* Nothing booked. */
    expect(await counts(businessId)).toEqual(before);
    /* The same stale confirmation again is refused again, never booked: with
     * no key, nothing replays an old answer, and the balance is re-checked. */
    expect(
      await record(auth, { ...ask, confirmOverpayment: true, expectedBalanceK: 15_000_000 }),
    ).toMatchObject({ outcome: 'balance_moved', balanceDueK: 10_000_000 });
    expect(await counts(businessId)).toEqual(before);

    /* The form rotates its key after that refusal (freshKey): re-asked, then booked. */
    const freshKey = randomUUID();
    const reask = { ...ask, clientRef: freshKey };
    expect(await record(auth, reask)).toMatchObject({
      outcome: 'confirm_overpayment',
      balanceDueK: 10_000_000,
      creditK: 8_000_000,
    });
    expect(
      await record(auth, { ...reask, confirmOverpayment: true, expectedBalanceK: 10_000_000 }),
    ).toMatchObject({ outcome: 'recorded', amountK: 10_000_000, creditK: 8_000_000 });
    expect(await counts(businessId)).toMatchObject({
      payments: (before?.payments ?? 0) + 1,
      marks: 1,
    });
  });
});
