/**
 * PaymentCharge rows (spec §19.1; PR-057): every line a record, the
 * surcharge gate enforced at the write as well as in core, estimates
 * resolving to actual exactly once, and nothing ever deleted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SurchargeNotConfigured } from '@rekoda/core';
import {
  chargesRepo,
  createDb,
  identity,
  ordersRepo,
  sql,
  withBusiness,
  type Db,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedOrder(): Promise<{ businessId: string; orderId: string }> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481870${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const order = await withBusiness(db, business.id, (tx) =>
    ordersRepo.placeOrder(tx, {
      businessId: business.id,
      customerId: null,
      lines: [
        { productId: null, name: 'wig', quantity: 1, unitPriceK: 100_000, lineTotalK: 100_000 },
      ],
      totalK: 100_000,
      sourceType: 'chat',
      sourceId: `chg-ord-${seq}`,
    }),
  );
  return { businessId: business.id, orderId: order.id };
}

describe('every line is a record (§19.1)', () => {
  it('records a breakdown, and an estimate resolves to actual exactly once', async () => {
    const { businessId, orderId } = await seedOrder();
    await withBusiness(db, businessId, (tx) =>
      chargesRepo.recordCharge(tx, {
        businessId,
        orderId,
        type: 'DELIVERY',
        label: 'Delivery',
        amountMinor: 3_000,
        beneficiary: 'MERCHANT',
        economicBearer: 'CUSTOMER',
        taxCode: 'STANDARD_RATE',
      }),
    );
    const processing = await withBusiness(db, businessId, (tx) =>
      chargesRepo.recordCharge(tx, {
        businessId,
        orderId,
        type: 'PAYMENT_PROCESSING',
        label: 'Payment charge',
        amountMinor: 1_500,
        beneficiary: 'PROVIDER',
        economicBearer: 'MERCHANT',
      }),
    );

    expect(
      await withBusiness(db, businessId, (tx) =>
        chargesRepo.resolveChargeActual(tx, {
          businessId,
          chargeId: processing.id,
          actualAmountMinor: 1_450,
        }),
      ),
    ).toBe('resolved');
    expect(
      await withBusiness(db, businessId, (tx) =>
        chargesRepo.resolveChargeActual(tx, { businessId, chargeId: processing.id }),
      ),
    ).toBe('already_actual');

    const charges = await withBusiness(db, businessId, (tx) =>
      chargesRepo.chargesForOrder(tx, businessId, orderId),
    );
    expect(charges).toHaveLength(2);
    const actual = charges.find((c) => c.type === 'PAYMENT_PROCESSING')!;
    expect(actual.actualOrEstimated).toBe('ACTUAL');
    expect(actual.amountMinor).toBe(1_450);
    /* The delivery line's tax treatment is STATED; the processing line
     * carries none, so it is not in the base — a fact, not an inference. */
    expect(charges.find((c) => c.type === 'DELIVERY')!.taxCode).toBe('STANDARD_RATE');
    expect(actual.taxCode).toBeNull();
  });

  it('a surcharge the merchant did not configure must not exist, at this door too', async () => {
    const { businessId, orderId } = await seedOrder();
    await expect(
      withBusiness(db, businessId, (tx) =>
        chargesRepo.recordCharge(tx, {
          businessId,
          orderId,
          type: 'SURCHARGE',
          label: 'Card surcharge',
          amountMinor: 500,
          beneficiary: 'MERCHANT',
          economicBearer: 'CUSTOMER',
        }),
      ),
    ).rejects.toThrow(SurchargeNotConfigured);
    await expect(
      withBusiness(db, businessId, (tx) =>
        chargesRepo.recordCharge(tx, {
          businessId,
          orderId,
          type: 'SURCHARGE',
          label: 'Card surcharge',
          amountMinor: 500,
          beneficiary: 'MERCHANT',
          economicBearer: 'CUSTOMER',
          surchargeConfigured: true,
        }),
      ),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('a line the customer read is never deleted, and nonsense is unrepresentable', async () => {
    const { businessId, orderId } = await seedOrder();
    await withBusiness(db, businessId, (tx) =>
      chargesRepo.recordCharge(tx, {
        businessId,
        orderId,
        type: 'SERVICE',
        label: 'Gift wrapping',
        amountMinor: 2_000,
        beneficiary: 'MERCHANT',
        economicBearer: 'CUSTOMER',
      }),
    );
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`DELETE FROM payment_charges WHERE business_id = ${businessId}::uuid`),
      ),
    ).rejects.toThrow();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO payment_charges
            (business_id, order_id, type, label, amount_minor, beneficiary, economic_bearer)
          VALUES (${businessId}::uuid, ${orderId}::uuid, 'VIBES', 'x', 1, 'MERCHANT', 'CUSTOMER')
        `),
      ),
    ).rejects.toThrow();
    /* An empty label is not a label a customer can read. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO payment_charges
            (business_id, order_id, type, label, amount_minor, beneficiary, economic_bearer)
          VALUES (${businessId}::uuid, ${orderId}::uuid, 'SERVICE', '', 1, 'MERCHANT', 'CUSTOMER')
        `),
      ),
    ).rejects.toThrow();
  });

  it("a charge cannot cite another tenant's order", async () => {
    const ada = await seedOrder();
    const bola = await seedOrder();
    await expect(
      withBusiness(db, ada.businessId, (tx) =>
        chargesRepo.recordCharge(tx, {
          businessId: ada.businessId,
          orderId: bola.orderId,
          type: 'SERVICE',
          label: 'Gift wrapping',
          amountMinor: 2_000,
          beneficiary: 'MERCHANT',
          economicBearer: 'CUSTOMER',
        }),
      ),
    ).rejects.toThrow();
  });
});
