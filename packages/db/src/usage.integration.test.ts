/**
 * The usage meter (docs/metering-v1.md), against real PostgreSQL.
 *
 * The claim that matters is the race: N concurrent consumers against an
 * allowance of K get exactly K grants, decided by the database. Everything
 * else — zero allowances refusing the first unit, bonus raising the ceiling
 * the way a billing top-up will, refunds flooring at zero — exists so the
 * commercial rules in the doc are enforced shapes, not intentions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, usageRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 10 }));
});

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(): Promise<string> {
  const user = await identity.upsertUserByPhone(db, '+2348140000001');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const PERIOD = '2026-08';

const consume = (businessId: string, allowance: number, n = 1) =>
  withBusiness(db, businessId, (tx) =>
    usageRepo.consumeUnit(tx, businessId, PERIOD, 'messages', allowance, n),
  );

describe('the atomic gate', () => {
  it('grants exactly K of N concurrent consumes against an allowance of K', async () => {
    const businessId = await seedBusiness();

    // Eight messages arrive together against the last five units. A
    // read-then-write meter grants all eight; this one cannot.
    const results = await Promise.all(Array.from({ length: 8 }, () => consume(businessId, 5)));

    expect(results.filter(Boolean)).toHaveLength(5);
    const [row] = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    expect(row?.used).toBe(5);
  });

  it('refuses the FIRST unit of a zero allowance — voice on Integrate is not "one free"', async () => {
    const businessId = await seedBusiness();
    expect(await consume(businessId, 0)).toBe(false);
    const rows = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    expect(rows).toHaveLength(0); // refused consumes leave no residue
  });

  it('lets a billing top-up raise the ceiling through bonus, and only through bonus', async () => {
    const businessId = await seedBusiness();
    expect(await consume(businessId, 2)).toBe(true);
    expect(await consume(businessId, 2)).toBe(true);
    expect(await consume(businessId, 2)).toBe(false); // exhausted at plan allowance

    // What the M4 billing event will do after a VERIFIED top-up payment.
    await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        UPDATE usage_counters SET bonus = 3
        WHERE business_id = ${businessId}::uuid AND period = ${PERIOD} AND unit = 'messages'
      `),
    );

    expect(await consume(businessId, 2)).toBe(true); // doorway reopened
    expect(await consume(businessId, 2)).toBe(true);
    expect(await consume(businessId, 2)).toBe(true);
    expect(await consume(businessId, 2)).toBe(false); // and closes again at plan+bonus
  });

  it('refunds floor at zero and give back exactly what was taken', async () => {
    const businessId = await seedBusiness();
    await consume(businessId, 5);
    await consume(businessId, 5);

    await withBusiness(db, businessId, (tx) =>
      usageRepo.refundUnit(tx, businessId, PERIOD, 'messages'),
    );
    const [row] = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    expect(row?.used).toBe(1);

    // Refunding more than was ever taken cannot mint credit.
    await withBusiness(db, businessId, (tx) =>
      usageRepo.refundUnit(tx, businessId, PERIOD, 'messages', 99),
    );
    const [floored] = await withBusiness(db, businessId, (tx) =>
      usageRepo.usageFor(tx, businessId, PERIOD),
    );
    expect(floored?.used).toBe(0);
  });

  it('keeps months separate — a new period is a fresh meter', async () => {
    const businessId = await seedBusiness();
    expect(await consume(businessId, 1)).toBe(true);
    expect(await consume(businessId, 1)).toBe(false);

    const nextMonth = await withBusiness(db, businessId, (tx) =>
      usageRepo.consumeUnit(tx, businessId, '2026-09', 'messages', 1),
    );
    expect(nextMonth).toBe(true);
  });
});
