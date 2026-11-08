/**
 * #432 review: the public sale route checks a customer id and books the sale in one transaction.
 * The check must hold the customer row (FOR KEY SHARE) so a concurrent removal of that customer
 * (the orphan of a merge) cannot land between the check and the booking.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { customersRepo, identity, merchantApiRepo } from '../index.js';
import { migrate, requireUrls, truncateAll, type Urls } from '../testing.js';

let urls: Urls;
let appDb: Db;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 6 }));
});
afterAll(async () => {
  await closeApp?.();
});
beforeEach(async () => {
  await truncateAll(urls);
});

async function seed(): Promise<{ businessId: string; customerId: string }> {
  const user = await identity.upsertUserByPhone(appDb, '+2348050011001');
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const customer = await customersRepo.createCustomerWithIdentities(
    appDb,
    business.id,
    'CUST_RACE_1',
    [],
  );
  return { businessId: business.id, customerId: customer.id };
}

describe('sale customer ownership check holds the customer row', () => {
  it('a concurrent removal of the checked customer waits for the sale transaction', async () => {
    const { businessId, customerId } = await seed();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let checked!: () => void;
    const checkedDone = new Promise<void>((resolve) => (checked = resolve));

    const sale = withBusiness(appDb, businessId, async (tx) => {
      expect(await merchantApiRepo.customerBelongsToBusiness(tx, businessId, customerId)).toBe(
        true,
      );
      checked();
      await held; // the booking would happen here, still inside the same transaction
      return 'booked';
    });
    await checkedDone;

    // The removal (a merge's delete of the orphan) must not get through while the sale holds it.
    const removal = withBusiness(appDb, businessId, async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '400ms'`);
      return tx.execute(
        sql`DELETE FROM customers WHERE business_id = ${businessId}::uuid AND id = ${customerId}::uuid`,
      );
    });
    await expect(removal).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '55P03' }),
    });

    release();
    expect(await sale).toBe('booked');
    // Once the sale has committed, the removal is free to proceed.
    await withBusiness(appDb, businessId, (tx) =>
      tx.execute(sql`DELETE FROM customers WHERE id = ${customerId}::uuid`),
    );
  });
});
