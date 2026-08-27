/**
 * ProviderCapability and the resolver over real rows (spec §17, §18; P3,
 * PR-068). The slice's own test: the resolver picks a provider from
 * capability and compliance, never from a hardcoded default — and the
 * capability table itself is reference data the runtime roles can read
 * and never write.
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

describe('the platform capability table (§18)', () => {
  it('carries the seeded standing, every block with its blocker BY NAME', async () => {
    const capabilities = await paymentsHub.platformCapabilities(db);
    const collect = new Map(
      capabilities.filter((c) => c.capability === 'COLLECT').map((c) => [c.providerType, c]),
    );
    expect(collect.get('paystack')).toMatchObject({ status: 'AVAILABLE' });
    expect(collect.get('mono')!.status).toBe('BLOCKED');
    expect(collect.get('mono')!.reason).toContain('Mono production terms');
    expect(collect.get('opay')!.reason).toContain('OPay production access');
    expect(collect.get('kuda')!.reason).toContain('Kuda regulatory and commercial approval');
  });

  it('is read-only to the runtime: unblocking is a data decision, not an application write', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`UPDATE provider_capabilities SET status = 'AVAILABLE', reason = NULL WHERE provider_type = 'mono'`,
        ),
      ),
    ).rejects.toThrow();
  });

  it('a block without its reason is unrepresentable', async () => {
    const rows = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM provider_capabilities
      WHERE status = 'BLOCKED' AND reason IS NULL
    `);
    expect([...rows][0]!.n).toBe(0);
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
