/**
 * The E1 completion gate: no plan reaches another plan's capability.
 *
 * The individual gates are tested where they live. This suite exists because
 * a gate is only as good as its coverage, and coverage is the thing nobody
 * notices going missing: a capability is added, a door is written for it, and
 * the fact that a second door already existed is discovered by a merchant.
 *
 * So it asserts the MATRIX rather than the mechanism. Every plan against
 * every entitlement, in both directions, by name, so a future plan or a
 * future entitlement forces a decision here rather than inheriting one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { entitlementsRepo, identity } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';
import { ENTITLEMENT_KEYS, type EntitlementKey } from '@rekoda/core';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 6 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let phoneCounter = 0;

async function seedOn(plan: string): Promise<string> {
  phoneCounter += 1;
  const phone = `+23481700${String(phoneCounter).padStart(5, '0')}`;
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  /* Pinned: `businesses` carries RLS, so an unpinned UPDATE matches no row
   * and silently leaves every business on `trial`. */
  await withBusiness(db, business.id, (tx) =>
    tx.execute(sql`UPDATE businesses SET plan = ${plan} WHERE id = ${business.id}::uuid`),
  );
  return business.id;
}

const gate = (businessId: string, key: EntitlementKey) =>
  withBusiness(db, businessId, (tx) => entitlementsRepo.requireEntitlement(tx, businessId, key));

/** The matrix, written out. A plan gains an entitlement here or nowhere. */
const MATRIX: Array<{ plan: string; holds: EntitlementKey[] }> = [
  { plan: 'trial', holds: ['REKODA_CHAT', 'REKODA_INTEGRATE'] },
  { plan: 'chat', holds: ['REKODA_CHAT'] },
  { plan: 'integrate', holds: ['REKODA_INTEGRATE'] },
  { plan: 'complete', holds: ['REKODA_CHAT', 'REKODA_INTEGRATE'] },
  { plan: 'expired', holds: [] },
];

describe('every plan against every entitlement', () => {
  for (const { plan, holds } of MATRIX) {
    for (const key of ENTITLEMENT_KEYS) {
      const should = holds.includes(key);
      it(`${plan} ${should ? 'holds' : 'is refused'} ${key}`, async () => {
        const businessId = await seedOn(plan);
        const refusal = await gate(businessId, key);
        if (should) {
          expect(refusal).toBeNull();
        } else {
          expect(refusal).not.toBeNull();
          expect(refusal?.missing).toBe(key);
          expect(refusal?.plan).toBe(plan);
        }
      });
    }
  }
});

/**
 * The two headline refusals, stated as sentences rather than as a matrix
 * cell, because they are the product decision of 26 August 2026 and a
 * reader should find them by name.
 */
describe('the product boundary', () => {
  it('a Chat business cannot reach Integrate', async () => {
    const businessId = await seedOn('chat');
    expect(await gate(businessId, 'REKODA_INTEGRATE')).not.toBeNull();
  });

  it('an Integrate business cannot reach Chat', async () => {
    const businessId = await seedOn('integrate');
    expect(await gate(businessId, 'REKODA_CHAT')).not.toBeNull();
  });

  it('nobody reaches the API product yet', async () => {
    for (const { plan } of MATRIX) {
      const businessId = await seedOn(plan);
      expect(await gate(businessId, 'REKODA_API'), plan).not.toBeNull();
    }
  });
});

/**
 * A support-issued grant is a real entitlement, and every door must honour
 * it. This is the property that broke: the storefront's order endpoint asked
 * `requireEntitlement` while the publish endpoint next door compared plan
 * names, so a granted business could take orders through a shop it was not
 * allowed to publish.
 */
describe('a manual grant', () => {
  it('opens the capability for a plan that does not carry it', async () => {
    const businessId = await seedOn('chat');
    expect(await gate(businessId, 'REKODA_INTEGRATE')).not.toBeNull();

    await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.grant(tx, {
        businessId,
        entitlementKey: 'REKODA_INTEGRATE',
        source: 'MANUAL_GRANT',
        grantedBy: 'operator:support',
      }),
    );

    expect(await gate(businessId, 'REKODA_INTEGRATE')).toBeNull();
    /* And it grants exactly one thing. A support ticket about a shop link
     * must not quietly hand over the conversational interface as well. */
    expect(await gate(businessId, 'REKODA_API')).not.toBeNull();
  });

  /** Revoking puts it back, or a grant is a one-way door. */
  it('closes again when it is revoked', async () => {
    const businessId = await seedOn('chat');
    await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.grant(tx, {
        businessId,
        entitlementKey: 'REKODA_INTEGRATE',
        source: 'MANUAL_GRANT',
        grantedBy: 'operator:support',
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.revoke(tx, businessId, 'REKODA_INTEGRATE'),
    );
    expect(await gate(businessId, 'REKODA_INTEGRATE')).not.toBeNull();
  });
});

/**
 * One business's grant is not another's. Obvious, and exactly the kind of
 * obvious thing a resolver written with one `WHERE` too few gets wrong.
 */
describe('grants do not leak between tenants', () => {
  it('keeps a granted capability to the business it was granted to', async () => {
    const granted = await seedOn('chat');
    const other = await seedOn('chat');
    await withBusiness(db, granted, (tx) =>
      entitlementsRepo.grant(tx, {
        businessId: granted,
        entitlementKey: 'REKODA_INTEGRATE',
        source: 'MANUAL_GRANT',
        grantedBy: 'operator:support',
      }),
    );
    expect(await gate(granted, 'REKODA_INTEGRATE')).toBeNull();
    expect(await gate(other, 'REKODA_INTEGRATE')).not.toBeNull();
  });
});
