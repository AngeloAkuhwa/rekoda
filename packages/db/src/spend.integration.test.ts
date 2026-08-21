/**
 * Money going out (spend.ts), against real PostgreSQL.
 *
 * The claims that matter: an expense and its posting commit together and the
 * ledger balances from a database READ-BACK; a purchase partly on credit
 * carries exactly the unpaid remainder to ACCOUNTS_PAYABLE; and another
 * tenant sees none of it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, issueRepo, spendRepo } from './index.js';
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

async function seedBusiness(phone = '+2348120000001'): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const entriesOf = (businessId: string) =>
  withBusiness(db, businessId, (tx) => issueRepo.ledgerEntriesFor(tx, businessId));

describe('an expense', () => {
  it('writes the row and a balanced EXPENSES posting in one transaction', async () => {
    const businessId = await seedBusiness();

    const recorded = await withBusiness(db, businessId, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId,
        description: 'fuel for generator',
        category: 'utilities',
        amountK: 1_200_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'draft-x',
      }),
    );
    expect(recorded.owedK).toBe(0);

    const rows = await withBusiness(db, businessId, (tx) => spendRepo.expensesFor(tx, businessId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      description: 'fuel for generator',
      category: 'utilities',
      amountK: 1_200_000,
      method: 'cash',
    });

    const entries = await entriesOf(businessId);
    const debits = entries.reduce((sum, e) => sum + Number(e.debitK), 0);
    const credits = entries.reduce((sum, e) => sum + Number(e.creditK), 0);
    expect(debits).toBe(credits);
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'EXPENSES', debitK: 1_200_000 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'CASH', creditK: 1_200_000 }),
    );
  });
});

describe('a stock purchase', () => {
  it('on credit: INVENTORY in full, cash for what was paid, AP for the rest', async () => {
    const businessId = await seedBusiness();

    const recorded = await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'ankara fabric',
        amountK: 5_000_000,
        paidK: 2_000_000,
        sourceType: 'chat',
        sourceId: 'draft-y',
      }),
    );
    expect(recorded.owedK).toBe(3_000_000);

    const entries = await entriesOf(businessId);
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'INVENTORY', debitK: 5_000_000 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'CASH', creditK: 2_000_000 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'ACCOUNTS_PAYABLE', creditK: 3_000_000 }),
    );
  });

  it('paid in full: no ACCOUNTS_PAYABLE line at all', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'thread',
        amountK: 500_000,
        paidK: 500_000,
        sourceType: 'chat',
        sourceId: 'draft-z',
      }),
    );
    const entries = await entriesOf(businessId);
    expect(entries.some((e) => e.account === 'ACCOUNTS_PAYABLE')).toBe(false);
  });
});

describe('the spend register', () => {
  it('totals expenses and stock apart, and never adds them', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, async (tx) => {
      await spendRepo.recordExpense(tx, {
        businessId,
        description: 'diesel',
        category: 'utilities',
        amountK: 800_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'd1',
      });
      await spendRepo.recordExpense(tx, {
        businessId,
        description: 'shop rent',
        category: null,
        amountK: 2_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'd2',
      });
      await spendRepo.recordPurchase(tx, {
        businessId,
        description: 'ankara bales',
        amountK: 5_000_000,
        paidK: 2_000_000,
        sourceType: 'chat',
        sourceId: 'd3',
      });
    });

    const list = await withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50));

    expect(list.count).toBe(3);
    expect(list.expensesK).toBe(2_800_000);
    expect(list.purchasesK).toBe(5_000_000);
    /* The whole point of the split: one figure would read as 7,800,000 spent
     * when 5,000,000 of it is still on the shelf. */
    expect(list.expensesK + list.purchasesK).not.toBe(list.expensesK);
  });

  it('labels a stock purchase as one, and an uncategorised expense as an expense', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, async (tx) => {
      await spendRepo.recordExpense(tx, {
        businessId,
        description: 'transport',
        category: null,
        amountK: 150_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'd1',
      });
      await spendRepo.recordPurchase(tx, {
        businessId,
        description: 'lace',
        amountK: 900_000,
        paidK: 900_000,
        sourceType: 'chat',
        sourceId: 'd2',
      });
    });

    const list = await withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50));
    const byDescription = Object.fromEntries(list.rows.map((r) => [r.description, r.kind]));
    expect(byDescription).toEqual({ transport: 'expense', lace: 'purchase' });
  });

  it('reports what is still owed on a part-paid purchase, off the ledger', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'ankara bales',
        amountK: 5_000_000,
        paidK: 2_000_000,
        sourceType: 'chat',
        sourceId: 'd1',
      }),
    );
    const list = await withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50));
    expect(list.payableK).toBe(3_000_000);
  });

  it('owes nothing when every purchase was paid in full', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      spendRepo.recordPurchase(tx, {
        businessId,
        description: 'thread',
        amountK: 500_000,
        paidK: 500_000,
        sourceType: 'chat',
        sourceId: 'd1',
      }),
    );
    const list = await withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50));
    expect(list.payableK).toBe(0);
  });

  it('is newest first and bounded by the limit, with the all-time count intact', async () => {
    const businessId = await seedBusiness();
    for (const description of ['first', 'second', 'third']) {
      await withBusiness(db, businessId, (tx) =>
        spendRepo.recordExpense(tx, {
          businessId,
          description,
          category: null,
          amountK: 100_000,
          method: 'cash',
          sourceType: 'chat',
          sourceId: description,
        }),
      );
    }
    const list = await withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 2));
    expect(list.rows.map((r) => r.description)).toEqual(['third', 'second']);
    /* The count is the books, not the page. A merchant told "2 entries" when
     * they have three would think one had gone missing. */
    expect(list.count).toBe(3);
  });

  it('is empty and zeroed for a business that has spent nothing', async () => {
    const businessId = await seedBusiness();
    const list = await withBusiness(db, businessId, (tx) => spendRepo.spendFor(tx, businessId, 50));
    expect(list).toMatchObject({
      rows: [],
      count: 0,
      expensesK: 0,
      purchasesK: 0,
      payableK: 0,
    });
  });
});

describe('tenancy', () => {
  it('one tenant never reads the other`s spending', async () => {
    const ada = await seedBusiness('+2348120000001');
    const bola = await seedBusiness('+2348120000002');

    await withBusiness(db, ada, (tx) =>
      spendRepo.recordExpense(tx, {
        businessId: ada,
        description: 'fuel',
        category: null,
        amountK: 100_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'd1',
      }),
    );

    expect(await withBusiness(db, bola, (tx) => spendRepo.expensesFor(tx, bola))).toHaveLength(0);
    expect(await withBusiness(db, bola, (tx) => spendRepo.spendFor(tx, bola, 50))).toMatchObject({
      rows: [],
      count: 0,
      expensesK: 0,
      payableK: 0,
    });
    expect(await entriesOf(bola)).toHaveLength(0);
  });
});
