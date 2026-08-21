/**
 * Orders somebody else placed (orders.ts), against real PostgreSQL.
 *
 * The claims that matter: order numbers are dense per business per year and
 * do not collide across tenants; the status move happens exactly once however
 * many callers race for it; and one merchant's orders are invisible to
 * another.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, ordersRepo, stockRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(phone = '+2348120000061'): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function seedProduct(businessId: string, name = 'Ankara bale'): Promise<string> {
  const product = await withBusiness(db, businessId, (tx) =>
    stockRepo.findOrCreateProduct(tx, businessId, name),
  );
  return product.id;
}

function place(businessId: string, productId: string, quantity = 2, placedAt?: Date) {
  return withBusiness(db, businessId, (tx) =>
    ordersRepo.placeOrder(tx, {
      businessId,
      customerId: null,
      lines: [
        {
          productId,
          name: 'Ankara bale',
          quantity,
          unitPriceK: 850_000,
          lineTotalK: 850_000 * quantity,
        },
      ],
      totalK: 850_000 * quantity,
      sourceType: 'chat',
      sourceId: `draft-${quantity}`,
      ...(placedAt ? { placedAt } : {}),
    }),
  );
}

describe('placing an order', () => {
  it('numbers it densely, per business per year', async () => {
    const businessId = await seedBusiness();
    const productId = await seedProduct(businessId);
    const at = new Date('2026-06-01T10:00:00Z');

    expect((await place(businessId, productId, 1, at)).orderNumber).toBe('ORD-2026-000001');
    expect((await place(businessId, productId, 2, at)).orderNumber).toBe('ORD-2026-000002');
    expect((await place(businessId, productId, 3, at)).orderNumber).toBe('ORD-2026-000003');
  });

  /* The counter is per business. Two shops both start at one, and neither can
   * infer the other's volume from a number on a document. */
  it('starts every shop at one', async () => {
    const mine = await seedBusiness('+2348120000061');
    const theirs = await seedBusiness('+2348120000062');
    const at = new Date('2026-06-01T10:00:00Z');

    await place(mine, await seedProduct(mine), 1, at);
    await place(mine, await seedProduct(mine, 'Head tie'), 1, at);
    expect((await place(theirs, await seedProduct(theirs), 1, at)).orderNumber).toBe(
      'ORD-2026-000001',
    );
  });

  it('starts again at one in a new year', async () => {
    const businessId = await seedBusiness();
    const productId = await seedProduct(businessId);
    await place(businessId, productId, 1, new Date('2026-12-31T20:00:00Z'));
    expect(
      (await place(businessId, productId, 1, new Date('2027-01-01T09:00:00Z'))).orderNumber,
    ).toBe('ORD-2027-000001');
  });

  /* 23:30 UTC on 31 December is already the new year in Lagos, and a document
   * numbered for the wrong year is a gap an auditor cannot explain. */
  it('reads the turn of the year in Lagos, not UTC', async () => {
    const businessId = await seedBusiness();
    const productId = await seedProduct(businessId);
    expect(
      (await place(businessId, productId, 1, new Date('2026-12-31T23:30:00Z'))).orderNumber,
    ).toBe('ORD-2027-000001');
  });

  it('reads back with its lines and its total', async () => {
    const businessId = await seedBusiness();
    const productId = await seedProduct(businessId);
    const placed = await place(businessId, productId, 2);

    const order = await withBusiness(db, businessId, (tx) =>
      ordersRepo.orderByNumber(tx, businessId, placed.orderNumber),
    );
    expect(order).toMatchObject({ status: 'placed', totalK: 1_700_000 });
    expect(order!.lines).toEqual([
      { name: 'Ankara bale', quantity: 2, unitPriceK: 850_000, lineTotalK: 1_700_000 },
    ]);
  });

  it('lists what the shop has taken, newest first, with a line count', async () => {
    const businessId = await seedBusiness();
    const productId = await seedProduct(businessId);
    await place(businessId, productId, 1, new Date('2026-06-01T10:00:00Z'));
    await place(businessId, productId, 2, new Date('2026-06-02T10:00:00Z'));

    const list = await withBusiness(db, businessId, (tx) => ordersRepo.ordersFor(tx, businessId));
    expect(list.map((o) => o.orderNumber)).toEqual(['ORD-2026-000002', 'ORD-2026-000001']);
    expect(list[0]).toMatchObject({ itemCount: 1, totalK: 1_700_000, status: 'placed' });
  });
});

describe('moving an order on', () => {
  it('happens exactly once, however many callers race for it', async () => {
    const businessId = await seedBusiness();
    const placed = await place(businessId, await seedProduct(businessId));

    const mark = () =>
      withBusiness(db, businessId, (tx) =>
        ordersRepo.markOrder(tx, businessId, placed.id, 'placed', 'confirmed'),
      );
    const results = await Promise.all([mark(), mark(), mark(), mark()]);

    expect(results.filter((r) => r === 'marked')).toHaveLength(1);
    expect(results.filter((r) => r === 'already')).toHaveLength(3);
  });

  it('refuses a move from a state the order is no longer in', async () => {
    const businessId = await seedBusiness();
    const placed = await place(businessId, await seedProduct(businessId));
    await withBusiness(db, businessId, (tx) =>
      ordersRepo.markOrder(tx, businessId, placed.id, 'placed', 'confirmed'),
    );
    expect(
      await withBusiness(db, businessId, (tx) =>
        ordersRepo.markOrder(tx, businessId, placed.id, 'placed', 'cancelled'),
      ),
    ).toBe('already');
  });

  it('reports not_found for an order that belongs to somebody else', async () => {
    const mine = await seedBusiness('+2348120000061');
    const theirs = await seedBusiness('+2348120000062');
    const placed = await place(theirs, await seedProduct(theirs));

    expect(
      await withBusiness(db, mine, (tx) =>
        ordersRepo.markOrder(tx, mine, placed.id, 'placed', 'confirmed'),
      ),
    ).toBe('not_found');
  });
});

describe('tenant isolation', () => {
  it('hides one merchant’s orders from another', async () => {
    const mine = await seedBusiness('+2348120000061');
    const theirs = await seedBusiness('+2348120000062');
    const placed = await place(theirs, await seedProduct(theirs));

    expect(await withBusiness(db, mine, (tx) => ordersRepo.ordersFor(tx, mine))).toEqual([]);
    expect(
      await withBusiness(db, mine, (tx) => ordersRepo.orderByNumber(tx, mine, placed.orderNumber)),
    ).toBeNull();
  });
});
