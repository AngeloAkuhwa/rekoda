/**
 * The margin report, against a real PostgreSQL.
 *
 * Two claims are being made and neither survives a mock. The first is
 * arithmetic over rows that only exist in a database. The second is a
 * privilege boundary: migration 0019 adds two SELECT policies for
 * `rekoda_worker` and must add nothing else, so the tests below run the same
 * queries as both roles and require different answers, and try the writes
 * those policies must not have authorised.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, marginRepo, quotaRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

const PERIOD = '2026-08';

async function seedBusiness(name: string, phone: string, plan?: string): Promise<string> {
  const user = await identity.upsertUserByPhone(appDb, phone);
  const business = await identity.createBusinessWithOwner(appDb, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  if (plan) {
    await withBusiness(appDb, business.id, (tx) =>
      tx.execute(sql`UPDATE businesses SET plan = ${plan} WHERE id = ${business.id}::uuid`),
    );
  }
  return business.id;
}

function spend(
  businessId: string,
  provider: quotaRepo.UsageRecord['provider'],
  nairaEquivalentK: number,
  options: { quantity?: number; period?: string; usageType?: string } = {},
): Promise<void> {
  return withBusiness(appDb, businessId, (tx) =>
    quotaRepo.recordUsage(tx, {
      businessId,
      provider,
      usageType: options.usageType ?? 'test',
      quantity: options.quantity ?? 1,
      providerCostMicros: 0,
      nairaEquivalentK,
      billingPeriod: options.period ?? PERIOD,
    }),
  );
}

describe('cost by business', () => {
  it('sums a period per tenant and keeps the tenants apart', async () => {
    const one = await seedBusiness('Mama Chidi', '+2348030000101', 'chat');
    const two = await seedBusiness('Ade Stores', '+2348030000102', 'complete');
    await spend(one, 'meta', 12_000);
    await spend(one, 'anthropic', 3_500);
    await spend(two, 'meta', 40_000);

    const rows = await marginRepo.costByBusiness(workerDb, PERIOD);
    const byId = new Map(rows.map((r) => [r.businessId, r]));
    expect(byId.get(one)?.costK).toBe(15_500);
    expect(byId.get(one)?.events).toBe(2);
    expect(byId.get(two)?.costK).toBe(40_000);
    expect(byId.get(two)?.plan).toBe('complete');
  });

  it('keeps a business that spent nothing, because silence is a signal', async () => {
    const quiet = await seedBusiness('Quiet Shop', '+2348030000103', 'chat');
    const rows = await marginRepo.costByBusiness(workerDb, PERIOD);
    const row = rows.find((r) => r.businessId === quiet);
    expect(row).toBeDefined();
    expect(row?.costK).toBe(0);
    expect(row?.events).toBe(0);
  });

  it('counts only the period asked for', async () => {
    const shop = await seedBusiness('Two Months', '+2348030000104', 'chat');
    await spend(shop, 'meta', 10_000, { period: '2026-07' });
    await spend(shop, 'meta', 25_000, { period: PERIOD });

    const august = await marginRepo.costByBusiness(workerDb, PERIOD);
    expect(august.find((r) => r.businessId === shop)?.costK).toBe(25_000);
    const july = await marginRepo.costByBusiness(workerDb, '2026-07');
    expect(july.find((r) => r.businessId === shop)?.costK).toBe(10_000);
  });

  it('puts the most expensive merchant first, which is who an operator wants', async () => {
    const small = await seedBusiness('Small', '+2348030000105', 'chat');
    const large = await seedBusiness('Large', '+2348030000106', 'chat');
    await spend(small, 'meta', 1_000);
    await spend(large, 'meta', 900_000);

    const rows = await marginRepo.costByBusiness(workerDb, PERIOD);
    expect(rows[0]?.businessId).toBe(large);
    expect(rows[1]?.businessId).toBe(small);
  });
});

describe('cost by provider', () => {
  it('splits the same period by who Rekoda is paying', async () => {
    const one = await seedBusiness('Split A', '+2348030000107', 'chat');
    const two = await seedBusiness('Split B', '+2348030000108', 'chat');
    await spend(one, 'meta', 30_000, { quantity: 40 });
    await spend(two, 'meta', 10_000, { quantity: 12 });
    await spend(one, 'anthropic', 4_000, { quantity: 9 });

    const rows = await marginRepo.costByProvider(workerDb, PERIOD);
    expect(rows[0]).toMatchObject({ provider: 'meta', costK: 40_000, quantity: 52, events: 2 });
    expect(rows[1]).toMatchObject({ provider: 'anthropic', costK: 4_000, quantity: 9 });
  });

  it('is empty for a period nothing happened in, not an error', async () => {
    expect(await marginRepo.costByProvider(workerDb, '2020-01')).toEqual([]);
  });
});

describe('the estate totals, counted rather than listed', () => {
  it('sums a period over every tenant, including ones off the page', async () => {
    const one = await seedBusiness('Big', '+2348030000120', 'chat');
    const two = await seedBusiness('Small', '+2348030000121', 'chat');
    await spend(one, 'meta', 300_000);
    await spend(two, 'meta', 900);

    const totals = await marginRepo.periodTotals(workerDb, PERIOD);
    expect(totals.costK).toBe(300_900);
    expect(totals.events).toBe(2);
    expect(totals.spending).toBe(2);

    const page = await marginRepo.costByBusiness(workerDb, PERIOD, 1);
    expect(page).toHaveLength(1);
    expect(page[0]?.businessId).toBe(one);
    expect(totals.costK).toBeGreaterThan(page[0]!.costK);
  });

  it('counts a business that spent nothing as not spending', async () => {
    await seedBusiness('Silent', '+2348030000122', 'chat');
    const totals = await marginRepo.periodTotals(workerDb, PERIOD);
    expect(totals.spending).toBe(0);
    expect(totals.costK).toBe(0);
  });

  it('is zero for a period nothing happened in', async () => {
    expect(await marginRepo.periodTotals(workerDb, '2020-01')).toEqual({
      costK: 0,
      events: 0,
      spending: 0,
    });
  });

  it('censuses who is on what over the whole estate', async () => {
    await seedBusiness('A', '+2348030000123', 'chat');
    await seedBusiness('B', '+2348030000124', 'chat');
    await seedBusiness('C', '+2348030000125', 'complete');
    await seedBusiness('D', '+2348030000126');

    const census = await marginRepo.planCensus(workerDb);
    const byPlan = new Map(census.map((c) => [c.plan, c.businesses]));
    expect(byPlan.get('chat')).toBe(2);
    expect(byPlan.get('complete')).toBe(1);
    expect(byPlan.get('trial')).toBe(1);
  });
});

describe('metered periods', () => {
  it('lists the months with usage, newest first', async () => {
    const shop = await seedBusiness('Historic', '+2348030000109', 'chat');
    await spend(shop, 'meta', 1_000, { period: '2026-06' });
    await spend(shop, 'meta', 1_000, { period: '2026-08' });
    await spend(shop, 'meta', 1_000, { period: '2026-07' });

    expect(await marginRepo.meteredPeriods(workerDb)).toEqual(['2026-08', '2026-07', '2026-06']);
  });
});

/**
 * The part that matters more than the arithmetic.
 *
 * 0019 hands `rekoda_worker` a cross-tenant read. These require that it went
 * exactly that far: the API role gains nothing, and the worker gains SELECT
 * and not UPDATE.
 */
describe('the privilege boundary 0019 draws', () => {
  it('leaves the application role seeing nothing across tenants', async () => {
    const shop = await seedBusiness('Hidden', '+2348030000110', 'chat');
    await spend(shop, 'meta', 50_000);

    expect(await marginRepo.costByBusiness(appDb, PERIOD)).toEqual([]);
    expect(await marginRepo.costByProvider(appDb, PERIOD)).toEqual([]);
  });

  it('still scopes the application role to its own tenant when pinned', async () => {
    const mine = await seedBusiness('Mine', '+2348030000111', 'chat');
    const theirs = await seedBusiness('Theirs', '+2348030000112', 'chat');
    await spend(mine, 'meta', 7_000);
    await spend(theirs, 'meta', 9_000);

    const totals = await withBusiness(appDb, mine, (tx) => quotaRepo.usageTotals(tx));
    expect(totals.nairaEquivalentK).toBe(7_000);
  });

  it('gives the worker no way to rewrite another tenant history', async () => {
    const shop = await seedBusiness('Untouchable', '+2348030000113', 'chat');
    await spend(shop, 'meta', 20_000);

    await workerDb.execute(sql`UPDATE usage_events SET naira_equivalent_k = 1`);
    const rows = await marginRepo.costByBusiness(workerDb, PERIOD);
    expect(rows.find((r) => r.businessId === shop)?.costK).toBe(20_000);
  });

  it('gives the worker no way to move another tenant onto a free plan', async () => {
    const shop = await seedBusiness('Still Paying', '+2348030000114', 'complete');

    await workerDb.execute(sql`UPDATE businesses SET plan = 'trial'`);
    const rows = await marginRepo.costByBusiness(workerDb, PERIOD);
    expect(rows.find((r) => r.businessId === shop)?.plan).toBe('complete');
  });
});

/**
 * The breakdown spec §24 exists for.
 *
 * Utility and marketing differ by roughly eightfold, and the specification
 * calls that difference the largest variable in plan margin. Grouped by
 * provider alone it is invisible: the Meta total moves and nothing says
 * whether the mix went one way or the other.
 */
describe('cost by usage type', () => {
  it('separates the message categories a provider total hides', async () => {
    const shop = await seedBusiness('Category Split', '+2348030000120', 'complete');
    await spend(shop, 'meta', 972, { usageType: 'UTILITY_TEMPLATE' });
    await spend(shop, 'meta', 972, { usageType: 'UTILITY_TEMPLATE' });
    await spend(shop, 'meta', 7_482, { usageType: 'MARKETING_TEMPLATE' });
    await spend(shop, 'meta', 0, { usageType: 'SERVICE_MESSAGE' });

    const rows = await marginRepo.costByUsageType(workerDb, PERIOD);
    const byType = new Map(rows.map((r) => [r.usageType, r]));

    expect(byType.get('UTILITY_TEMPLATE')?.costK).toBe(1_944);
    expect(byType.get('UTILITY_TEMPLATE')?.events).toBe(2);
    expect(byType.get('MARKETING_TEMPLATE')?.costK).toBe(7_482);
    expect(byType.get('SERVICE_MESSAGE')?.costK).toBe(0);
    expect(byType.get('SERVICE_MESSAGE')?.events).toBe(1);

    /* And the provider total still agrees with the parts, or one of the two
     * reports is lying and an operator has no way to tell which. */
    const meta = (await marginRepo.costByProvider(workerDb, PERIOD)).find(
      (r) => r.provider === 'meta',
    );
    const partsK = rows
      .filter((r) => r.provider === 'meta')
      .reduce((total, row) => total + row.costK, 0);
    expect(partsK).toBe(meta?.costK);
  });

  it("keeps one provider's categories apart from another's", async () => {
    const shop = await seedBusiness('Two Providers', '+2348030000121', 'complete');
    await spend(shop, 'meta', 972, { usageType: 'UTILITY_TEMPLATE' });
    await spend(shop, 'anthropic', 1_200, { usageType: 'llm_call' });

    const rows = await marginRepo.costByUsageType(workerDb, PERIOD);
    const utility = rows.find((r) => r.provider === 'meta' && r.usageType === 'UTILITY_TEMPLATE');
    const llm = rows.find((r) => r.provider === 'anthropic' && r.usageType === 'llm_call');
    expect(utility?.costK).toBe(972);
    expect(llm?.costK).toBe(1_200);
  });

  it('ranks the costliest first, which is the question an operator opens with', async () => {
    const shop = await seedBusiness('Ranked', '+2348030000122', 'complete');
    await spend(shop, 'meta', 100, { usageType: 'SERVICE_MESSAGE' });
    await spend(shop, 'meta', 9_000, { usageType: 'MARKETING_TEMPLATE' });
    await spend(shop, 'meta', 2_000, { usageType: 'AUTH_TEMPLATE' });

    const rows = (await marginRepo.costByUsageType(workerDb, PERIOD)).filter(
      (r) => r.provider === 'meta',
    );
    expect(rows.map((r) => r.usageType)).toEqual([
      'MARKETING_TEMPLATE',
      'AUTH_TEMPLATE',
      'SERVICE_MESSAGE',
    ]);
  });
});
