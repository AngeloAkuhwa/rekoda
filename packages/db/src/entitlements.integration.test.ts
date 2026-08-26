/**
 * Entitlements as data, against real PostgreSQL (canonical spec §4.1).
 *
 * This PR adds the tables and nothing else. The resolver and the command-layer
 * gate are PR-013; until then nothing reads these rows to make a decision, so
 * every assertion here is about the shape of the record rather than about a
 * refusal. The refusals get proven where they will actually live.
 *
 * Two claims are worth the database round trip. That a business can only ever
 * see its own grants, because an entitlement leak is a paid feature leak. And
 * that the catalogue is reference data the application may read and may never
 * write, because a service that can grant itself `REKODA_INTEGRATE` has no
 * product boundary at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createDb, withBusiness, type Db } from './client.js';
import { entitlementsRepo, identity } from './index.js';
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
});

async function seedBusiness(phone: string, name: string): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

describe('the entitlement catalogue', () => {
  it('carries exactly the three canonical entitlements', async () => {
    const all = await entitlementsRepo.catalogue(db);
    expect(all.map((e) => e.key).sort()).toEqual(['REKODA_API', 'REKODA_CHAT', 'REKODA_INTEGRATE']);
    /* Complete is the PAIR, not a fourth entitlement (spec §4.1). A
     * REKODA_COMPLETE row would make it possible to hold Complete without
     * holding either half, which is a state the product does not have. */
    expect(all.map((e) => e.key)).not.toContain('REKODA_COMPLETE');
  });

  it('is reference data the application may read and may never write', async () => {
    for (const [role, url] of [
      ['rekoda_app', urls.app],
      ['rekoda_worker', urls.worker],
    ] as const) {
      const client = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await expect(
          client`INSERT INTO entitlements (key, name, description)
                 VALUES ('REKODA_FREE_MONEY', 'x', 'x')`,
        ).rejects.toThrow(/permission denied/i);
        await expect(
          client`UPDATE entitlements SET name = 'x' WHERE key = 'REKODA_CHAT'`,
        ).rejects.toThrow(/permission denied/i);
        await expect(
          client`DELETE FROM entitlements WHERE key = 'REKODA_INTEGRATE'`,
        ).rejects.toThrow(/permission denied/i);
        const read = await client`SELECT key FROM entitlements ORDER BY key`;
        expect(read.length, `${role} lost SELECT on the catalogue`).toBe(3);
      } finally {
        await client.end();
      }
    }
  });
});

describe('what a business holds', () => {
  it('records a grant with its source and who made it', async () => {
    const businessId = await seedBusiness('+2348090200001', 'Mama Chidi Stores');
    await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.grant(tx, {
        businessId,
        entitlementKey: 'REKODA_CHAT',
        source: 'PLAN',
        grantedBy: 'system:subscription',
      }),
    );

    const held = await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.heldBy(tx, businessId),
    );
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      entitlementKey: 'REKODA_CHAT',
      source: 'PLAN',
      grantedBy: 'system:subscription',
    });
    expect(held[0]!.grantedAt).toBeInstanceOf(Date);
  });

  /** Re-granting is what a renewal does every month. It must not throw. */
  it('is idempotent: granting twice leaves one row', async () => {
    const businessId = await seedBusiness('+2348090200002', 'Mama Chidi Stores');
    const grant = () =>
      withBusiness(db, businessId, (tx) =>
        entitlementsRepo.grant(tx, {
          businessId,
          entitlementKey: 'REKODA_INTEGRATE',
          source: 'PLAN',
          grantedBy: 'system:subscription',
        }),
      );
    await grant();
    await grant();
    const held = await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.heldBy(tx, businessId),
    );
    expect(held).toHaveLength(1);
  });

  /**
   * Complete is two rows. If it were one, losing Integrate at a downgrade
   * would have to mean editing a value rather than removing a grant, and the
   * remaining Chat entitlement would have nowhere to live.
   */
  it('holds Complete as the pair', async () => {
    const businessId = await seedBusiness('+2348090200003', 'Mama Chidi Stores');
    for (const key of ['REKODA_CHAT', 'REKODA_INTEGRATE'] as const) {
      await withBusiness(db, businessId, (tx) =>
        entitlementsRepo.grant(tx, {
          businessId,
          entitlementKey: key,
          source: 'PLAN',
          grantedBy: 'system:subscription',
        }),
      );
    }
    const held = await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.heldBy(tx, businessId),
    );
    expect(held.map((e) => e.entitlementKey).sort()).toEqual(['REKODA_CHAT', 'REKODA_INTEGRATE']);
  });

  /**
   * A downgrade removes the grant and leaves everything the business already
   * recorded exactly where it was (spec §4.5). Nothing here deletes a record;
   * it withdraws permission to make new ones.
   */
  it('revokes one entitlement without touching the other', async () => {
    const businessId = await seedBusiness('+2348090200004', 'Mama Chidi Stores');
    for (const key of ['REKODA_CHAT', 'REKODA_INTEGRATE'] as const) {
      await withBusiness(db, businessId, (tx) =>
        entitlementsRepo.grant(tx, {
          businessId,
          entitlementKey: key,
          source: 'PLAN',
          grantedBy: 'system:subscription',
        }),
      );
    }
    await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.revoke(tx, businessId, 'REKODA_INTEGRATE'),
    );
    const held = await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.heldBy(tx, businessId),
    );
    expect(held.map((e) => e.entitlementKey)).toEqual(['REKODA_CHAT']);
  });

  it('refuses an entitlement that is not in the catalogue', async () => {
    const businessId = await seedBusiness('+2348090200005', 'Mama Chidi Stores');
    await expect(
      withBusiness(db, businessId, (tx) =>
        entitlementsRepo.grant(tx, {
          businessId,
          entitlementKey: 'REKODA_FREE_MONEY' as never,
          source: 'PLAN',
          grantedBy: 'system:subscription',
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a source that is not one of the three', async () => {
    const businessId = await seedBusiness('+2348090200006', 'Mama Chidi Stores');
    await expect(
      withBusiness(db, businessId, (tx) =>
        entitlementsRepo.grant(tx, {
          businessId,
          entitlementKey: 'REKODA_CHAT',
          source: 'BECAUSE_I_SAID_SO' as never,
          grantedBy: 'system:subscription',
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('tenant isolation', () => {
  /** A paid feature leaking across tenants is the whole point of the RLS. */
  it('never shows one business another business grants', async () => {
    const mine = await seedBusiness('+2348090200007', 'Mama Chidi Stores');
    const theirs = await seedBusiness('+2348090200008', 'Rival Shop');

    await withBusiness(db, theirs, (tx) =>
      entitlementsRepo.grant(tx, {
        businessId: theirs,
        entitlementKey: 'REKODA_INTEGRATE',
        source: 'PLAN',
        grantedBy: 'system:subscription',
      }),
    );

    const seen = await withBusiness(db, mine, (tx) => entitlementsRepo.heldBy(tx, mine));
    expect(seen).toEqual([]);

    /* And the pin holds against a deliberate attempt: asking for THEIR id
     * inside MY transaction returns nothing, because the policy answers, not
     * the WHERE clause. */
    const reached = await withBusiness(db, mine, (tx) => entitlementsRepo.heldBy(tx, theirs));
    expect(reached).toEqual([]);
  });

  it('refuses to write a grant for another business', async () => {
    const mine = await seedBusiness('+2348090200009', 'Mama Chidi Stores');
    const theirs = await seedBusiness('+2348090200010', 'Rival Shop');
    await expect(
      withBusiness(db, mine, (tx) =>
        entitlementsRepo.grant(tx, {
          businessId: theirs,
          entitlementKey: 'REKODA_INTEGRATE',
          source: 'MANUAL_GRANT',
          grantedBy: 'user:attacker',
        }),
      ),
    ).rejects.toThrow();
  });
});
