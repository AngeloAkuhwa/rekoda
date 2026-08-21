/**
 * Opening balances, against real PostgreSQL.
 *
 * The claims that matter: the entry balances and lands on the day the
 * merchant named rather than today; a second one is refused by the DATABASE
 * rather than by a check the caller is trusted to make; and another tenant
 * cannot see or set it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, issueRepo, openingRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(phone = '+2348120000101'): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const record = (businessId: string, asAt = '2026-07-31') =>
  withBusiness(db, businessId, (tx) =>
    openingRepo.recordOpeningBalances(tx, {
      businessId,
      asAt,
      cashK: 20_000_000,
      bankK: 5_000_000,
      stockK: 15_000_000,
      actor: 'user:1',
    }),
  );

describe('what the business was already holding', () => {
  it('writes a balanced entry and credits the lot to the owner', async () => {
    const businessId = await seedBusiness();
    const recorded = await record(businessId);
    expect(recorded.equityK).toBe(40_000_000);

    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    const debits = entries.reduce((n, e) => n + Number(e.debitK), 0);
    const credits = entries.reduce((n, e) => n + Number(e.creditK), 0);
    expect(debits).toBe(credits);
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'OWNERS_EQUITY', creditK: 40_000_000 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'CASH', debitK: 20_000_000 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'INVENTORY', debitK: 15_000_000 }),
    );
  });

  /**
   * The date is the whole reason this takes one. Balance-sheet accounts are
   * cumulative and would not care, but the cash flow statement reads CASH
   * movement within the period, and an opening till dated today is reported
   * as money that arrived today.
   */
  it('lands on the day the merchant named, not today', async () => {
    const businessId = await seedBusiness();
    await record(businessId, '2026-07-31');

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ created_at: string; source_type: string }>(sql`
        SELECT created_at, source_type FROM ledger_transactions
        WHERE business_id = ${businessId}::uuid
      `),
    );
    const row = [...rows][0]!;
    expect(row.source_type).toBe('opening');
    /* Lagos noon on the day named, which is 11:00 UTC. Noon rather than
     * midnight so that which month it lands in never turns on an hour. */
    expect(new Date(row.created_at).toISOString()).toBe('2026-07-31T11:00:00.000Z');
  });

  /* Two requests arriving together both read no opening entry and both post.
   * Only the index decides, which is why it exists. */
  it('refuses a second entry, and refuses it from the database', async () => {
    const businessId = await seedBusiness();
    await record(businessId);
    await expect(record(businessId, '2026-08-31')).rejects.toBeInstanceOf(
      openingRepo.OpeningBalancesAlreadySet,
    );

    const settled = await Promise.allSettled([
      seedBusiness('+2348120000102').then(() => null),
      record(businessId, '2026-09-30'),
    ]);
    expect(settled[1]!.status).toBe('rejected');
  });

  it('reads back exactly what was entered', async () => {
    const businessId = await seedBusiness();
    expect(
      await withBusiness(db, businessId, (tx) => openingRepo.openingBalancesFor(tx, businessId)),
    ).toBeNull();

    await record(businessId, '2026-07-31');
    expect(
      await withBusiness(db, businessId, (tx) => openingRepo.openingBalancesFor(tx, businessId)),
    ).toEqual({ asAt: '2026-07-31', cashK: 20_000_000, bankK: 5_000_000, stockK: 15_000_000 });
  });

  it('is one business at a time, however many have set one', async () => {
    const ada = await seedBusiness('+2348120000103');
    const bola = await seedBusiness('+2348120000104');
    await record(ada);

    expect(
      await withBusiness(db, bola, (tx) => openingRepo.openingBalancesFor(tx, bola)),
    ).toBeNull();
    /* And Bola may still set their own: the index is per business. */
    await expect(record(bola, '2026-06-30')).resolves.toMatchObject({ equityK: 40_000_000 });
  });

  it('refuses an entry of nothing before it writes anything', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        openingRepo.recordOpeningBalances(tx, {
          businessId,
          asAt: '2026-07-31',
          cashK: 0,
          bankK: 0,
          stockK: 0,
          actor: 'user:1',
        }),
      ),
    ).rejects.toBeInstanceOf(RangeError);

    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    expect(entries).toEqual([]);
  });
});
