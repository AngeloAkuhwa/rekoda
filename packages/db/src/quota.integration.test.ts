/**
 * The AI spend ceiling (MASTER-PLAN §5.3.3).
 *
 * "Race-proof" is the requirement, and a race has no in-memory imitation: the
 * read-then-decide version of this passes every single-threaded test and then
 * lets twenty simultaneous calls through a limit of ten. Every assertion below
 * that matters fires several reservations at once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, quotaRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

const GENEROUS = { perBusinessPerDay: 1_000, globalPerDay: 100_000 };

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  // Sixteen connections, because the point of half these tests is collision.
  ({ db, close } = createDb(urls.app, { max: 16 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(name: string, phone: string): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

describe('the per-business ceiling', () => {
  it('allows calls up to the limit and refuses the next one', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348070000001');
    const limits = { perBusinessPerDay: 3, globalPerDay: 1_000 };

    for (let i = 1; i <= 3; i++) {
      const r = await quotaRepo.reserveAiCall(db, businessId, limits);
      expect(r).toMatchObject({ ok: true, businessCalls: i });
    }

    expect(await quotaRepo.reserveAiCall(db, businessId, limits)).toEqual({
      ok: false,
      refusedBy: 'business',
    });
  });

  it('lets exactly TEN of twenty simultaneous calls through a limit of ten', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348070000001');
    const limits = { perBusinessPerDay: 10, globalPerDay: 1_000 };

    /**
     * The assertion the whole design exists for. Read-then-decide passes the
     * sequential test above and fails this one — twenty callers all read a
     * count below ten and all proceed, and the bill is for twenty.
     */
    const results = await Promise.all(
      Array.from({ length: 20 }, () => quotaRepo.reserveAiCall(db, businessId, limits)),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.filter((r) => !r.ok)).toHaveLength(10);

    const counted = await withBusiness(db, businessId, (tx) =>
      quotaRepo.callsToday(tx, businessId),
    );
    expect(counted).toBe(10);
  });

  it('does not spend one business`s allowance on another', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348070000001');
    const bola = await seedBusiness('Bola Electronics', '+2348070000002');
    const limits = { perBusinessPerDay: 2, globalPerDay: 1_000 };

    await quotaRepo.reserveAiCall(db, ada, limits);
    await quotaRepo.reserveAiCall(db, ada, limits);
    expect(await quotaRepo.reserveAiCall(db, ada, limits)).toMatchObject({ ok: false });

    // Bola's day has not started. A noisy neighbour must not mute a merchant.
    expect(await quotaRepo.reserveAiCall(db, bola, limits)).toMatchObject({ ok: true });
  });

  it('refuses a limit of zero rather than allowing the first call through', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348070000001');
    // The INSERT path has no conflicting row for the WHERE to test, so a
    // zero limit would otherwise let exactly one call per day escape.
    expect(
      await quotaRepo.reserveAiCall(db, businessId, { perBusinessPerDay: 0, globalPerDay: 10 }),
    ).toEqual({ ok: false, refusedBy: 'business' });
  });

  it('starts fresh on a new day', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348070000001');
    const limits = { perBusinessPerDay: 1, globalPerDay: 1_000 };
    /* The boundary is LAGOS midnight (23:00 UTC), because that is the
     * midnight the reply promises the merchant. 22:00 UTC is still Monday
     * evening in Lagos; 23:30 UTC is half past midnight on Tuesday. */
    const monday = new Date('2026-08-17T22:00:00Z');
    const tuesday = new Date('2026-08-17T23:30:00Z');

    expect(await quotaRepo.reserveAiCall(db, businessId, limits, monday)).toMatchObject({
      ok: true,
    });
    expect(await quotaRepo.reserveAiCall(db, businessId, limits, monday)).toMatchObject({
      ok: false,
    });
    expect(await quotaRepo.reserveAiCall(db, businessId, limits, tuesday)).toMatchObject({
      ok: true,
    });
  });
});

describe('the platform ceiling', () => {
  it('stops everyone once the platform budget is spent', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348070000001');
    const bola = await seedBusiness('Bola Electronics', '+2348070000002');
    const limits = { perBusinessPerDay: 100, globalPerDay: 2 };

    expect(await quotaRepo.reserveAiCall(db, ada, limits)).toMatchObject({ ok: true });
    expect(await quotaRepo.reserveAiCall(db, bola, limits)).toMatchObject({ ok: true });
    expect(await quotaRepo.reserveAiCall(db, ada, limits)).toEqual({
      ok: false,
      refusedBy: 'platform',
    });
  });

  it('does NOT charge a merchant for a call the platform refused', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348070000001');
    const limits = { perBusinessPerDay: 100, globalPerDay: 1 };

    await quotaRepo.reserveAiCall(db, businessId, limits);
    const before = await withBusiness(db, businessId, (tx) => quotaRepo.callsToday(tx, businessId));

    expect(await quotaRepo.reserveAiCall(db, businessId, limits)).toMatchObject({
      refusedBy: 'platform',
    });

    /**
     * The tenant's increment ran first and the platform's refused after it.
     * Both are in one transaction, so the rollback returns the slot — a
     * merchant must not lose an hour of their own daily allowance because the
     * platform was busy.
     */
    const after = await withBusiness(db, businessId, (tx) => quotaRepo.callsToday(tx, businessId));
    expect(after).toBe(before);
  });

  it('lets exactly FIVE of thirty simultaneous calls through a platform limit of five', async () => {
    const businesses = await Promise.all([
      seedBusiness('Ada Fashion', '+2348070000001'),
      seedBusiness('Bola Electronics', '+2348070000002'),
      seedBusiness('Chidi Provisions', '+2348070000003'),
    ]);
    const limits = { perBusinessPerDay: 100, globalPerDay: 5 };

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => quotaRepo.reserveAiCall(db, businesses[i % 3]!, limits)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
  });
});

describe('handing a reservation back', () => {
  it('returns the slot when the provider was never reached', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348070000001');
    const limits = { perBusinessPerDay: 1, globalPerDay: 10 };

    expect(await quotaRepo.reserveAiCall(db, businessId, limits)).toMatchObject({ ok: true });
    expect(await quotaRepo.reserveAiCall(db, businessId, limits)).toMatchObject({ ok: false });

    // A connection refused before any tokens were billed is not a call.
    await quotaRepo.releaseAiCall(db, businessId);
    expect(await quotaRepo.reserveAiCall(db, businessId, limits)).toMatchObject({ ok: true });
  });

  it('cannot be used to mint free calls by releasing twice', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348070000001');
    await quotaRepo.reserveAiCall(db, businessId, GENEROUS);

    await quotaRepo.releaseAiCall(db, businessId);
    await quotaRepo.releaseAiCall(db, businessId);
    await quotaRepo.releaseAiCall(db, businessId);

    const counted = await withBusiness(db, businessId, (tx) =>
      quotaRepo.callsToday(tx, businessId),
    );
    expect(counted).toBe(0);
  });
});

describe('usage telemetry', () => {
  it('records what a call cost, in both currencies', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348070000001');

    await withBusiness(db, businessId, (tx) =>
      quotaRepo.recordUsage(tx, {
        businessId,
        provider: 'anthropic',
        usageType: 'llm_call',
        quantity: 1,
        providerCostMicros: 4_200,
        nairaEquivalentK: 609,
        billingPeriod: '2026-08',
        meta: { model: 'claude-sonnet-latest', priced: true },
      }),
    );

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: number; micros: number }>(
        sql`SELECT count(*)::int AS n, sum(provider_cost_micros)::int AS micros FROM usage_events`,
      ),
    );
    expect([...rows][0]).toMatchObject({ n: 1, micros: 4_200 });
  });

  it('keeps one business`s costs invisible to another', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348070000001');
    const bola = await seedBusiness('Bola Electronics', '+2348070000002');

    await withBusiness(db, ada, (tx) =>
      quotaRepo.recordUsage(tx, {
        businessId: ada,
        provider: 'anthropic',
        usageType: 'llm_call',
        quantity: 1,
        providerCostMicros: 1,
        nairaEquivalentK: 1,
        billingPeriod: '2026-08',
      }),
    );

    const seen = await withBusiness(db, bola, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM usage_events`),
    );
    expect([...seen][0]).toMatchObject({ n: 0 });
  });
});
