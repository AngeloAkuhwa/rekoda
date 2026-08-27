/**
 * The four independent statuses (spec §17.1; PR-051): they fail
 * independently, so they are separate columns; production is DERIVED in
 * the database — all four must permit it — and no writer can hold a
 * stale copy of that answer, because no writer can write it at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, paymentsHub, sql, withBusiness, type Db } from './index.js';
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
async function seedConnection(): Promise<{ businessId: string; connectionId: string }> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481860${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const connection = await withBusiness(db, business.id, (tx) =>
    paymentsHub.upsertConnection(tx, { businessId: business.id, providerType: 'paystack' }),
  );
  return { businessId: business.id, connectionId: connection.id };
}

async function axes(businessId: string, connectionId: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{
      operational_status: string;
      kyc_status: string;
      commercial_status: string;
      compliance_status: string;
      production_enabled: boolean;
    }>(sql`
      SELECT operational_status, kyc_status, commercial_status, compliance_status, production_enabled
      FROM payment_connections WHERE id = ${connectionId}::uuid
    `),
  );
  return [...rows][0]!;
}

function setAxes(
  businessId: string,
  connectionId: string,
  values: Partial<
    Record<'operational_status' | 'kyc_status' | 'commercial_status' | 'compliance_status', string>
  >,
) {
  return withBusiness(db, businessId, async (tx) => {
    for (const [column, value] of Object.entries(values)) {
      await tx.execute(
        sql`UPDATE payment_connections SET ${sql.raw(column)} = ${value} WHERE id = ${connectionId}::uuid`,
      );
    }
  });
}

describe('four axes, one derived answer (§17.1)', () => {
  it('a new connection permits nothing and derives disabled', async () => {
    const { businessId, connectionId } = await seedConnection();
    const row = await axes(businessId, connectionId);
    expect(row).toMatchObject({
      operational_status: 'NOT_CONFIGURED',
      commercial_status: 'UNCONFIRMED',
      compliance_status: 'PERMITTED',
      production_enabled: false,
    });
  });

  it('production enables only when all four permit, and any one failing kills it', async () => {
    const { businessId, connectionId } = await seedConnection();
    await setAxes(businessId, connectionId, {
      operational_status: 'ACTIVE',
      kyc_status: 'verified',
      commercial_status: 'AGREED',
      compliance_status: 'PERMITTED',
    });
    expect((await axes(businessId, connectionId)).production_enabled).toBe(true);

    /* Operationally healthy, commercially suspended: the state the blended
     * column could not represent. */
    await setAxes(businessId, connectionId, { commercial_status: 'SUSPENDED' });
    const suspended = await axes(businessId, connectionId);
    expect(suspended.operational_status).toBe('ACTIVE');
    expect(suspended.production_enabled).toBe(false);

    await setAxes(businessId, connectionId, {
      commercial_status: 'AGREED',
      compliance_status: 'BLOCKED',
    });
    expect((await axes(businessId, connectionId)).production_enabled).toBe(false);
  });

  it('nobody writes the derived answer', async () => {
    const { businessId, connectionId } = await seedConnection();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`UPDATE payment_connections SET production_enabled = true WHERE id = ${connectionId}::uuid`,
        ),
      ),
    ).rejects.toThrow();
  });

  it('an unknown value on any axis is unrepresentable', async () => {
    const { businessId, connectionId } = await seedConnection();
    await expect(
      setAxes(businessId, connectionId, { commercial_status: 'VIBES' }),
    ).rejects.toThrow();
  });
});
