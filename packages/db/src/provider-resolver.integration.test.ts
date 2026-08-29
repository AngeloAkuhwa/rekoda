/**
 * ProviderCapability and the resolver over real rows (spec §17, §18; P3,
 * PR-068). The slice's own test: the resolver picks a provider from
 * capability and compliance, never from a hardcoded default — and the
 * capability table itself is reference data the runtime roles can read
 * and never write.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capabilityBlockers } from '@rekoda/core';
import { createDb, identity, paymentsHub, sql, withBusiness, type Db } from './index.js';
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

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481850${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function enableProduction(businessId: string, connectionId: string) {
  await withBusiness(db, businessId, (tx) =>
    tx.execute(sql`
      UPDATE payment_connections
      SET operational_status = 'ACTIVE', kyc_status = 'not_required',
          commercial_status = 'AGREED', compliance_status = 'PERMITTED'
      WHERE business_id = ${businessId}::uuid AND id = ${connectionId}::uuid
    `),
  );
}

describe("the platform capability table (§18, and PR-119's three axes)", () => {
  it('carries the seeded standing, every closed axis with its blocker BY NAME', async () => {
    const capabilities = await paymentsHub.platformCapabilities(db);
    const collect = new Map(
      capabilities.filter((c) => c.capability === 'COLLECT').map((c) => [c.providerType, c]),
    );
    expect(collect.get('paystack')).toMatchObject({
      technicalSupport: true,
      commercialApproval: true,
      complianceApproval: true,
      productionEnabled: true,
    });

    /* Mono and OPay are ONE axis away, and it is the same axis. Before
     * 0115 both read as a bare BLOCKED, which said nothing about how close
     * either was or what would move it. */
    expect(collect.get('mono')).toMatchObject({
      technicalSupport: true,
      commercialApproval: false,
      complianceApproval: true,
      productionEnabled: false,
    });
    expect(collect.get('mono')!.commercialNote).toContain('Mono production terms');
    expect(collect.get('opay')!.commercialNote).toContain('OPay production access');

    /* Kuda is the case the split exists for: TWO closed axes, and a
     * blended status could only ever have shown one of them. */
    expect(collect.get('kuda')).toMatchObject({
      technicalSupport: true,
      commercialApproval: false,
      complianceApproval: false,
      productionEnabled: false,
    });
    expect(collect.get('kuda')!.complianceNote).toContain('regulatory');
  });

  it('names every closed axis in the blockers, not just the first', async () => {
    const capabilities = await paymentsHub.platformCapabilities(db);
    const kuda = capabilities.find((c) => c.providerType === 'kuda' && c.capability === 'COLLECT')!;
    const blockers = capabilityBlockers(kuda);
    expect(blockers).toHaveLength(2);
    expect(blockers.join(' | ')).toMatch(/COMMERCIAL/);
    expect(blockers.join(' | ')).toMatch(/COMPLIANCE/);

    expect(capabilityBlockers(capabilities.find((c) => c.providerType === 'paystack')!)).toEqual(
      [],
    );
  });

  it('is read-only to the runtime: unblocking is a data decision, not an application write', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`UPDATE provider_capabilities SET commercial_approval = true WHERE provider_type = 'mono'`,
        ),
      ),
    ).rejects.toThrow();
  });

  it('a closed axis without its reason is unrepresentable', async () => {
    const rows = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM provider_capabilities
      WHERE (NOT technical_support   AND technical_note   IS NULL)
         OR (NOT commercial_approval AND commercial_note  IS NULL)
         OR (NOT compliance_approval AND compliance_note  IS NULL)
    `);
    expect([...rows][0]!.n).toBe(0);
  });

  it('will not let anyone write the derived flag, however they ask', async () => {
    /* Even as the OWNER, which is the point: production_enabled is
     * generated, so opening production means setting three separate axes
     * and there is no statement that shortcuts it. A working sandbox sets
     * one of them (owner ruling, 28 Aug 2026). */
    const owner = createDb(urls.owner, { max: 1 });
    try {
      await expect(
        owner.db.execute(
          sql`UPDATE provider_capabilities SET production_enabled = true WHERE provider_type = 'kuda'`,
        ),
      ).rejects.toThrow();
    } finally {
      await owner.close();
    }
  });
});

describe('the resolver over real rows (§17, §18)', () => {
  it('capability and compliance decide; seniority breaks a tie; nothing is defaulted', async () => {
    const businessId = await seedBusiness();
    /* Mono FIRST — if anything hardcoded a favourite or fell back to
     * insertion order alone, this arrangement would expose it. */
    const mono = await withBusiness(db, businessId, (tx) =>
      paymentsHub.upsertConnection(tx, { businessId, providerType: 'mono' }),
    );
    const paystack = await withBusiness(db, businessId, (tx) =>
      paymentsHub.upsertConnection(tx, { businessId, providerType: 'paystack' }),
    );
    await enableProduction(businessId, mono.id);
    await enableProduction(businessId, paystack.id);

    const outcome = await withBusiness(db, businessId, (tx) =>
      paymentsHub.resolveProviderConnection(tx, businessId, 'COLLECT'),
    );
    expect(outcome).toEqual({
      resolved: true,
      connectionId: paystack.id,
      providerType: 'paystack',
    });
  });

  it('a blocked platform capability refuses WITH the blocker, whatever the connection says', async () => {
    const businessId = await seedBusiness();
    const mono = await withBusiness(db, businessId, (tx) =>
      paymentsHub.upsertConnection(tx, { businessId, providerType: 'mono' }),
    );
    await enableProduction(businessId, mono.id);

    const outcome = await withBusiness(db, businessId, (tx) =>
      paymentsHub.resolveProviderConnection(tx, businessId, 'COLLECT'),
    );
    expect(outcome).toMatchObject({ resolved: false, reason: 'no_capable_provider' });
    if (outcome.resolved === false && outcome.reason === 'no_capable_provider') {
      expect(outcome.detail.join(' ')).toContain('Mono production terms');
    }
  });

  it("a capable provider still refuses while the merchant's own axes do not permit", async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      paymentsHub.upsertConnection(tx, { businessId, providerType: 'paystack' }),
    );

    const outcome = await withBusiness(db, businessId, (tx) =>
      paymentsHub.resolveProviderConnection(tx, businessId, 'COLLECT'),
    );
    expect(outcome).toEqual({
      resolved: false,
      reason: 'not_production_enabled',
      providerTypes: ['paystack'],
    });
  });

  it('no connection resolves to nothing — never to a default', async () => {
    const businessId = await seedBusiness();
    const outcome = await withBusiness(db, businessId, (tx) =>
      paymentsHub.resolveProviderConnection(tx, businessId, 'COLLECT'),
    );
    expect(outcome).toEqual({ resolved: false, reason: 'no_connection' });
  });
});
