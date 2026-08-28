/**
 * Add-on grants and holdings (PR-116, migration 0112).
 *
 * The owner ruling this proves: a CAPACITY unit is held rather than spent,
 * so it is sold as a recurring add-on and answered by counting, while a
 * CONSUMABLE_MONTHLY unit granted by an add-on arrives every month for as
 * long as the holding lasts. The version is pinned as sold, so a repricing
 * never changes what an existing holder was given.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { addOnsRepo, entitlementsRepo, identity } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 4 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  await resetTestAddOns();
});

/** The owner connection: the catalogue is never written by the application. */
async function asOwner(statement: string): Promise<void> {
  const owner = createDb(urls.owner, { max: 1 });
  try {
    await owner.db.execute(sql.raw(statement));
  } finally {
    await owner.close();
  }
}

async function resetTestAddOns(): Promise<void> {
  await asOwner(`
    DELETE FROM add_on_grants WHERE add_on_id LIKE 'test_%';
    DELETE FROM add_ons WHERE add_on_id LIKE 'test_%';
  `);
}

async function seedAddOn(
  addOnId: string,
  version: number,
  grants: Array<{ kind: string; unit?: string; quantity?: number; entitlement?: string }>,
): Promise<void> {
  await asOwner(`
    INSERT INTO add_ons (add_on_id, version, name, billing_interval, price_minor, currency, effective_from)
    VALUES ('${addOnId}', ${version}, '${addOnId} v${version}', 'monthly', 100000, 'NGN', '2026-01-01T00:00:00Z')
    ON CONFLICT (add_on_id, version) DO NOTHING;
  `);
  for (const grant of grants) {
    const unit = grant.unit ? `'${grant.unit}'` : 'NULL';
    const quantity = grant.quantity === undefined ? 'NULL' : String(grant.quantity);
    const entitlement = grant.entitlement ? `'${grant.entitlement}'` : 'NULL';
    await asOwner(`
      INSERT INTO add_on_grants (add_on_id, version, grant_kind, entitlement_key, unit, quantity)
      VALUES ('${addOnId}', ${version}, '${grant.kind}', ${entitlement}, ${unit}, ${quantity});
    `);
  }
}

/**
 * What the database said when it refused.
 *
 * Drizzle wraps the driver error, so `error.message` is its own "Failed
 * query" preamble and the constraint name lives one level down. Reading
 * `cause` is the difference between asserting on the database's answer and
 * asserting on the query text we just wrote, which would pass for any
 * failure at all.
 */
async function refusal(work: () => Promise<unknown>): Promise<string> {
  return work().then(
    () => 'the statement was accepted',
    (error: Error & { cause?: Error }) => error.cause?.message ?? error.message,
  );
}

async function seedBusiness(phone: string, name: string): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

describe('what a holding grants', () => {
  it('grants nothing to a business that holds nothing', async () => {
    const businessId = await seedBusiness('+2348197000001', 'Bare Co');
    await seedAddOn('test_apps', 1, [{ kind: 'CAPACITY', unit: 'API_APPLICATIONS', quantity: 2 }]);

    const granted = await withBusiness(db, businessId, (tx) =>
      addOnsRepo.grantedUnits(tx, businessId, 'CAPACITY', 'API_APPLICATIONS'),
    );
    expect(granted).toBe(0);
  });

  it('adds capacity while the holding is live, and takes it back when it ends', async () => {
    const businessId = await seedBusiness('+2348197000002', 'Holding Co');
    await seedAddOn('test_apps', 1, [{ kind: 'CAPACITY', unit: 'API_APPLICATIONS', quantity: 2 }]);

    await withBusiness(db, businessId, (tx) =>
      addOnsRepo.hold(tx, { businessId, addOnId: 'test_apps', version: 1 }),
    );
    expect(
      await withBusiness(db, businessId, (tx) =>
        addOnsRepo.grantedUnits(tx, businessId, 'CAPACITY', 'API_APPLICATIONS'),
      ),
    ).toBe(2);

    /* Ended in the future: the merchant keeps what they paid for until the
     * period closes, which is what a mid-month cancellation should do. */
    const nextMonth = new Date(Date.now() + 30 * 86_400_000);
    await withBusiness(db, businessId, (tx) =>
      addOnsRepo.endHolding(tx, businessId, 'test_apps', nextMonth),
    );
    expect(
      await withBusiness(db, businessId, (tx) =>
        addOnsRepo.grantedUnits(tx, businessId, 'CAPACITY', 'API_APPLICATIONS'),
      ),
    ).toBe(2);

    /* And after it closes, it is gone. */
    const later = new Date(nextMonth.getTime() + 86_400_000);
    expect(
      await withBusiness(db, businessId, (tx) =>
        addOnsRepo.grantedUnits(tx, businessId, 'CAPACITY', 'API_APPLICATIONS', later),
      ),
    ).toBe(0);
  });

  it('sums two holdings rather than taking the larger', async () => {
    const businessId = await seedBusiness('+2348197000003', 'Stacked Co');
    await seedAddOn('test_apps', 1, [{ kind: 'CAPACITY', unit: 'API_APPLICATIONS', quantity: 1 }]);
    await seedAddOn('test_apps_more', 1, [
      { kind: 'CAPACITY', unit: 'API_APPLICATIONS', quantity: 3 },
    ]);

    await withBusiness(db, businessId, async (tx) => {
      await addOnsRepo.hold(tx, { businessId, addOnId: 'test_apps', version: 1 });
      await addOnsRepo.hold(tx, { businessId, addOnId: 'test_apps_more', version: 1 });
    });

    expect(
      await withBusiness(db, businessId, (tx) =>
        addOnsRepo.grantedUnits(tx, businessId, 'CAPACITY', 'API_APPLICATIONS'),
      ),
    ).toBe(4);
  });

  it('keeps a holder on the version they were sold after a repricing', async () => {
    const businessId = await seedBusiness('+2348197000004', 'Grandfathered Co');
    await seedAddOn('test_requests', 1, [
      { kind: 'MONTHLY_UNITS', unit: 'API_REQUEST_UNITS', quantity: 25_000 },
    ]);
    await withBusiness(db, businessId, (tx) =>
      addOnsRepo.hold(tx, { businessId, addOnId: 'test_requests', version: 1 }),
    );

    /* Version 2 sells less for the same money. A repricing closes the old
     * version first, because the catalogue allows exactly one open version
     * per add-on, and then the holder is unaffected: their row still points
     * at version 1, which nobody edited. */
    await asOwner(`
      UPDATE add_ons SET effective_to = now()
      WHERE add_on_id = 'test_requests' AND version = 1
    `);
    await seedAddOn('test_requests', 2, [
      { kind: 'MONTHLY_UNITS', unit: 'API_REQUEST_UNITS', quantity: 5_000 },
    ]);
    expect(
      await withBusiness(db, businessId, (tx) => addOnsRepo.openVersionOf(tx, 'test_requests')),
    ).toBe(2);

    expect(
      await withBusiness(db, businessId, (tx) =>
        addOnsRepo.grantedUnits(tx, businessId, 'MONTHLY_UNITS', 'API_REQUEST_UNITS'),
      ),
    ).toBe(25_000);
  });
});

describe('entitlements a holding grants', () => {
  it('is held while the add-on is, and gone when it ends', async () => {
    const businessId = await seedBusiness('+2348197000010', 'Entitled Co');
    await seedAddOn('test_api', 1, [{ kind: 'ENTITLEMENT', entitlement: 'REKODA_API' }]);

    const before = await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.resolve(tx, businessId),
    );
    expect(before).not.toContain('REKODA_API');

    await withBusiness(db, businessId, (tx) =>
      addOnsRepo.hold(tx, { businessId, addOnId: 'test_api', version: 1 }),
    );
    const during = await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.resolve(tx, businessId),
    );
    expect(during).toContain('REKODA_API');

    /* Ending the holding ends the capability, with nothing to remember:
     * the entitlement was derived, never copied into a row somebody would
     * have had to delete. */
    const yesterday = new Date(Date.now() - 86_400_000);
    await asOwner(
      `UPDATE business_add_ons SET started_at = '${yesterday.toISOString()}' WHERE business_id = '${businessId}'`,
    );
    await withBusiness(db, businessId, (tx) =>
      addOnsRepo.endHolding(tx, businessId, 'test_api', new Date(Date.now() - 1_000)),
    );
    const after = await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.resolve(tx, businessId),
    );
    expect(after).not.toContain('REKODA_API');
  });

  it('refuses the gate for a business whose holding has lapsed', async () => {
    const businessId = await seedBusiness('+2348197000011', 'Lapsed Co');
    await seedAddOn('test_api', 1, [{ kind: 'ENTITLEMENT', entitlement: 'REKODA_API' }]);

    const refusal = await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_API'),
    );
    expect(refusal).toMatchObject({ missing: 'REKODA_API' });
  });
});

describe('the shape of a grant', () => {
  it('refuses a capacity grant of nothing and an entitlement grant of four', async () => {
    await seedAddOn('test_shape', 1, []);

    expect(
      await refusal(() =>
        asOwner(`
          INSERT INTO add_on_grants (add_on_id, version, grant_kind, unit)
          VALUES ('test_shape', 1, 'CAPACITY', 'API_APPLICATIONS')
        `),
      ),
    ).toMatch(/add_on_grants_shaped/);

    expect(
      await refusal(() =>
        asOwner(`
          INSERT INTO add_on_grants (add_on_id, version, grant_kind, entitlement_key, quantity)
          VALUES ('test_shape', 1, 'ENTITLEMENT', 'REKODA_API', 4)
        `),
      ),
    ).toMatch(/add_on_grants_shaped/);
  });

  it("keeps the catalogue out of the application's hands", async () => {
    const businessId = await seedBusiness('+2348197000020', 'Reader Co');
    const refused = await refusal(() =>
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO add_on_grants (add_on_id, version, grant_kind, unit, quantity)
          VALUES ('extra_seat', 1, 'CAPACITY', 'ACCOUNTANT_USERS', 99)
        `),
      ),
    );
    expect(refused).toMatch(/permission denied/i);
  });
});
