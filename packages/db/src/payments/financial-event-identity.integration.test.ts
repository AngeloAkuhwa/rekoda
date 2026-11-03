/**
 * G-88: one financial event, one journal, enforced by PostgreSQL.
 *
 * The claims: a retried or replayed writer, two workers overlapping, and a
 * retry after a crash that committed the first attempt all leave exactly one
 * journal; a second event with a different identity is never refused; the
 * refusal is typed and takes the whole attempt back; and the unique indexes
 * hold for a writer that bypasses `writePosting`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from '../client.js';
import { identity, issueRepo, spendRepo } from '../index.js';
import { migrate, requireUrls, truncateAll, type Urls } from '../testing.js';

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

async function seedBusiness(phone: string): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Mama Chidi Stores',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const purchase = (businessId: string, sourceId: string, sourceType = 'chat') =>
  withBusiness(db, businessId, (tx) =>
    spendRepo.recordPurchase(tx, {
      businessId,
      description: 'Rice',
      amountK: 5_000_000,
      paidK: 5_000_000,
      method: 'cash',
      sourceType,
      sourceId,
    }),
  );

const expense = (businessId: string, sourceId: string, sourceType = 'chat') =>
  withBusiness(db, businessId, (tx) =>
    spendRepo.recordExpense(tx, {
      businessId,
      description: 'Fuel',
      category: 'transport',
      amountK: 1_000_000,
      method: 'cash',
      sourceType,
      sourceId,
    }),
  );

const journalCount = (businessId: string): Promise<number> =>
  withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM ledger_transactions WHERE business_id = ${businessId}::uuid`,
    );
    return Number([...rows][0]!.n);
  });

const expenseCount = (businessId: string): Promise<number> =>
  withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM expenses WHERE business_id = ${businessId}::uuid`,
    );
    return Number([...rows][0]!.n);
  });

describe('a purchase is one financial event per source', () => {
  it('refuses a replay of the same source with the typed error and posts nothing more', async () => {
    const businessId = await seedBusiness('+2348090000101');
    const first = await purchase(businessId, 'draft-1');

    const replay = await purchase(businessId, 'draft-1').catch((e: unknown) => e);
    expect(replay).toBeInstanceOf(issueRepo.FinancialEventAlreadyPostedError);
    expect((replay as issueRepo.FinancialEventAlreadyPostedError).existingTransactionId).toBe(
      first.ledgerTransactionId,
    );
    expect(await journalCount(businessId)).toBe(1);
    expect(await expenseCount(businessId)).toBe(1);
  });

  it('treats a purchase-order receipt as one event per order', async () => {
    const businessId = await seedBusiness('+2348090000107');
    const first = await purchase(businessId, 'po-1', 'purchase_order');
    const replay = await purchase(businessId, 'po-1', 'purchase_order').catch((e: unknown) => e);
    expect(replay).toBeInstanceOf(issueRepo.FinancialEventAlreadyPostedError);
    expect((replay as issueRepo.FinancialEventAlreadyPostedError).existingTransactionId).toBe(
      first.ledgerTransactionId,
    );
    expect(await journalCount(businessId)).toBe(1);
  });

  it('lets exactly one of eight overlapping workers post', async () => {
    const businessId = await seedBusiness('+2348090000102');
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => purchase(businessId, 'draft-race')),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(issueRepo.FinancialEventAlreadyPostedError);
      }
    }
    expect(await journalCount(businessId)).toBe(1);
    expect(await expenseCount(businessId)).toBe(1);
  });

  it('takes the whole attempt back, so a retry after a committed crash adds no bill, stock or entry', async () => {
    const businessId = await seedBusiness('+2348090000103');
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'Rice',
        amountK: 5_000_000,
        paidK: 0,
        method: null,
        sourceType: 'chat',
        sourceId: 'draft-crash',
      }),
    );
    const billsBefore = await withBusiness(db, businessId, async (tx) => {
      const rows = await tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM bills`);
      return Number([...rows][0]!.n);
    });
    await expect(
      withBusiness(db, businessId, (tx) =>
        spendRepo.recordPurchase(tx, {
          businessId,
          description: 'Rice',
          amountK: 5_000_000,
          paidK: 0,
          method: null,
          sourceType: 'chat',
          sourceId: 'draft-crash',
        }),
      ),
    ).rejects.toBeInstanceOf(issueRepo.FinancialEventAlreadyPostedError);
    const billsAfter = await withBusiness(db, businessId, async (tx) => {
      const rows = await tx.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM bills`);
      return Number([...rows][0]!.n);
    });
    expect(billsAfter).toBe(billsBefore);
    expect(await journalCount(businessId)).toBe(1);
    expect(await expenseCount(businessId)).toBe(1);
  });

  it('does not refuse distinct sources, the same source type in another business, or another source type with the same id', async () => {
    const a = await seedBusiness('+2348090000104');
    const b = await seedBusiness('+2348090000105');
    await purchase(a, 'draft-1');
    await purchase(a, 'draft-2');
    await purchase(b, 'draft-1');
    await purchase(a, 'draft-1', 'purchase_order');
    expect(await journalCount(a)).toBe(3);
    expect(await journalCount(b)).toBe(1);
  });

  it('lets the purchase be voided without colliding with its own key', async () => {
    const businessId = await seedBusiness('+2348090000106');
    const first = await purchase(businessId, 'draft-void');
    const entryId = first.expenseId;
    await withBusiness(db, businessId, (tx) =>
      spendRepo.voidExpense(tx, businessId, entryId, 'test void', 'user:1'),
    );
    expect(await journalCount(businessId)).toBe(2);
  });
});

describe('a chat expense is one financial event per draft; other sources are not', () => {
  it('refuses a replayed draft', async () => {
    const businessId = await seedBusiness('+2348090000111');
    await expense(businessId, 'draft-e1');
    await expect(expense(businessId, 'draft-e1')).rejects.toBeInstanceOf(
      issueRepo.FinancialEventAlreadyPostedError,
    );
    expect(await journalCount(businessId)).toBe(1);
  });

  it('keeps two identical entries from a non-draft source as two expenses', async () => {
    const businessId = await seedBusiness('+2348090000112');
    await expense(businessId, 'same', 'dashboard');
    await expense(businessId, 'same', 'dashboard');
    expect(await journalCount(businessId)).toBe(2);
  });
});

describe('the database refuses a writer that bypasses writePosting', () => {
  it('rejects a second ledger transaction with the same key', async () => {
    const businessId = await seedBusiness('+2348090000121');
    await purchase(businessId, 'draft-raw');
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO ledger_transactions (business_id, memo, source_type, source_id, posting_key)
          VALUES (${businessId}::uuid, 'raw', 'chat', 'draft-raw', 'purchase:chat:draft-raw')
        `),
      ),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    expect(await journalCount(businessId)).toBe(1);
  });
});

describe('finding duplicates that predate the ledger key', () => {
  it('reports a source that booked twice, without changing any row', async () => {
    const businessId = await seedBusiness('+2348090000131');
    await purchase(businessId, 'draft-ok');
    // Two legacy rows for one draft, written as history was: no ledger key.
    for (let i = 0; i < 2; i += 1) {
      await withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO expenses (business_id, description, category, amount_k, method, source_type, source_id)
          VALUES (${businessId}::uuid, 'Rice', 'stock', 5000000, 'cash', 'chat', 'draft-legacy')
        `),
      );
    }
    const before = await expenseCount(businessId);
    const found = await withBusiness(db, businessId, (tx) =>
      spendRepo.findDuplicateSpendEvents(tx, businessId),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      sourceType: 'chat',
      sourceId: 'draft-legacy',
      kind: 'purchase',
      standing: 2,
    });
    expect(found[0]!.expenseIds).toHaveLength(2);
    expect(await expenseCount(businessId)).toBe(before);
  });
});
