/**
 * The one gate every ingress asks (canonical spec §4.1, §4.3).
 *
 * Two claims. That the effective set is the plan plus explicit grants, so a
 * support-issued entitlement survives a renewal that would otherwise take it
 * back. And that the gate refuses BEFORE anything is metered, which is spec
 * §4.3 rule 1 and the reason a refused request can consume nothing: nothing
 * was taken, so nothing has to be given back.
 *
 * The exhaustive cross-product suite is PR-018. This proves the mechanism.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { entitlementsRepo, identity, usageRepo } from './index.js';
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

async function seedOn(plan: string, phone: string): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Mama Chidi Stores',
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

const resolve = (businessId: string) =>
  withBusiness(db, businessId, (tx) => entitlementsRepo.resolve(tx, businessId));

const gate = (businessId: string, key: Parameters<typeof entitlementsRepo.requireEntitlement>[2]) =>
  withBusiness(db, businessId, (tx) => entitlementsRepo.requireEntitlement(tx, businessId, key));

describe('what each plan grants', () => {
  it.each([
    { plan: 'trial', expected: ['REKODA_CHAT', 'REKODA_INTEGRATE'] },
    { plan: 'chat', expected: ['REKODA_CHAT'] },
    { plan: 'integrate', expected: ['REKODA_INTEGRATE'] },
    { plan: 'complete', expected: ['REKODA_CHAT', 'REKODA_INTEGRATE'] },
    { plan: 'expired', expected: [] },
  ])('$plan holds $expected', async ({ plan, expected }, index) => {
    const businessId = await seedOn(plan, `+23480903000${10 + index}`);
    expect(await resolve(businessId)).toEqual(expected);
  });

  /**
   * The decision that separates Integrate from Complete (owner, 26 Aug 2026).
   * If Integrate held Chat, Complete would sell nothing but volume.
   */
  it('does not give the Integrate plan merchant-side Chat', async () => {
    const businessId = await seedOn('integrate', '+2348090300020');
    expect(await gate(businessId, 'REKODA_CHAT')).toEqual({
      missing: 'REKODA_CHAT',
      plan: 'integrate',
    });
    expect(await gate(businessId, 'REKODA_INTEGRATE')).toBeNull();
  });

  it('does not give the Chat plan customer-side commerce', async () => {
    const businessId = await seedOn('chat', '+2348090300021');
    expect(await gate(businessId, 'REKODA_INTEGRATE')).toEqual({
      missing: 'REKODA_INTEGRATE',
      plan: 'chat',
    });
    expect(await gate(businessId, 'REKODA_CHAT')).toBeNull();
  });

  it('gives Complete both halves, and neither is a third value', async () => {
    const businessId = await seedOn('complete', '+2348090300022');
    expect(await gate(businessId, 'REKODA_CHAT')).toBeNull();
    expect(await gate(businessId, 'REKODA_INTEGRATE')).toBeNull();
  });

  /** A lapsed business keeps its books readable and grows nothing (§4.5). */
  it('refuses everything on an expired plan', async () => {
    const businessId = await seedOn('expired', '+2348090300023');
    expect(await gate(businessId, 'REKODA_CHAT')).toMatchObject({ missing: 'REKODA_CHAT' });
    expect(await gate(businessId, 'REKODA_INTEGRATE')).toMatchObject({
      missing: 'REKODA_INTEGRATE',
    });
  });

  /** The API is sold separately and is in no plan (spec §27). */
  it('never derives REKODA_API from a plan', async () => {
    for (const [i, plan] of ['trial', 'chat', 'integrate', 'complete'].entries()) {
      const businessId = await seedOn(plan, `+23480903000${30 + i}`);
      expect(await gate(businessId, 'REKODA_API')).toMatchObject({ missing: 'REKODA_API' });
    }
  });
});

describe('an explicit grant on top of the plan', () => {
  it('adds a capability the plan does not carry', async () => {
    const businessId = await seedOn('chat', '+2348090300040');
    expect(await gate(businessId, 'REKODA_INTEGRATE')).not.toBeNull();

    await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.grant(tx, {
        businessId,
        entitlementKey: 'REKODA_INTEGRATE',
        source: 'MANUAL_GRANT',
        grantedBy: 'user:support',
      }),
    );
    expect(await gate(businessId, 'REKODA_INTEGRATE')).toBeNull();
    expect(await resolve(businessId)).toEqual(['REKODA_CHAT', 'REKODA_INTEGRATE']);
  });

  /**
   * A union, not an override. The plan says what was bought; a grant says
   * what somebody decided this business should also have, and a renewal
   * re-asserting the plan must not quietly withdraw the second.
   */
  it('is not taken away by what the plan implies', async () => {
    const businessId = await seedOn('integrate', '+2348090300041');
    await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.grant(tx, {
        businessId,
        entitlementKey: 'REKODA_CHAT',
        source: 'MANUAL_GRANT',
        grantedBy: 'user:support',
      }),
    );
    expect(await resolve(businessId)).toEqual(['REKODA_CHAT', 'REKODA_INTEGRATE']);
  });

  it('stops applying once revoked', async () => {
    const businessId = await seedOn('chat', '+2348090300042');
    await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.grant(tx, {
        businessId,
        entitlementKey: 'REKODA_INTEGRATE',
        source: 'MANUAL_GRANT',
        grantedBy: 'user:support',
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      entitlementsRepo.revoke(tx, businessId, 'REKODA_INTEGRATE'),
    );
    expect(await gate(businessId, 'REKODA_INTEGRATE')).not.toBeNull();
    expect(await resolve(businessId)).toEqual(['REKODA_CHAT']);
  });
});

describe('entitlement comes before the meter', () => {
  /**
   * Spec §4.3 rule 1 and rule 4, proven together. The refusal must happen
   * with the counter untouched: a gate that metered first would need a refund
   * on every unentitled path, and every refund path is somewhere the meter
   * can drift.
   */
  it('refuses without moving the counter', async () => {
    const businessId = await seedOn('chat', '+2348090300050');
    const period = '2026-08';

    const refusal = await gate(businessId, 'REKODA_INTEGRATE');
    expect(refusal).not.toBeNull();

    const rows = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM usage_counters WHERE business_id = ${businessId}::uuid`,
    );
    expect(Number([...rows][0]!.n)).toBe(0);

    /* And the entitled path still meters normally, so the gate has not simply
     * disabled the meter for everybody. */
    const granted = await withBusiness(db, businessId, (own) =>
      usageRepo.consumeUnit(own, businessId, period, 'documents', 100),
    );
    expect(granted).toBe(true);
  });
});
