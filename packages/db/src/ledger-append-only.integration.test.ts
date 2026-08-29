/**
 * The ledger is append-only because PostgreSQL says so, not because nothing
 * happens to write to it.
 *
 * Both tables are proven through `rekoda_app` and `rekoda_worker`, never
 * through the owner. A revocation asserted as the owner proves nothing: the
 * owner is exempt, so the assertion would pass on a database with no
 * revocation at all.
 *
 * `ledger_entries` has been protected since migrations 0001 and 0004.
 * `ledger_transactions` was not, and that is the hole this closes: a
 * transaction row carries the memo, the source type, the source id, the
 * reversal link and the timestamp its lines are read under, so a writer that
 * could not touch a line could still rewrite what the line was for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { identity, journalRepo } from './index.js';
import { createDb, withBusiness, type Db } from './client.js';
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

/** One real posting, so every attempt below has an actual row to aim at. */
async function seedPosting(): Promise<{ transactionId: string; entryId: string }> {
  const user = await identity.upsertUserByPhone(db, '+2348090100001');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Mama Chidi Stores',
    businessType: null,
    ownerUserId: user.id,
  });
  await withBusiness(db, business.id, (tx) =>
    journalRepo.recordJournal(tx, {
      businessId: business.id,
      memo: "Took the day's takings to the bank",
      amountK: 5_000_000,
      intoAccount: 'BANK',
      outOfAccount: 'CASH',
      actor: 'user:1',
    }),
  );

  const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    const [tx] = await owner`SELECT id FROM ledger_transactions LIMIT 1`;
    const [entry] = await owner`SELECT id FROM ledger_entries LIMIT 1`;
    return { transactionId: tx!['id'] as string, entryId: entry!['id'] as string };
  } finally {
    await owner.end();
  }
}

/**
 * Runs one statement as a non-owner role and returns the error, or null if
 * PostgreSQL allowed it. Null is the failure the tests are looking for.
 */
async function attempt(url: string, statement: string): Promise<Error | null> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(statement);
    return null;
  } catch (error) {
    return error as Error;
  } finally {
    await client.end();
  }
}

describe('the ledger cannot be rewritten by the application', () => {
  const roles = () => [
    { name: 'rekoda_app', url: urls.app },
    { name: 'rekoda_worker', url: urls.worker },
  ];

  it.each([
    {
      verb: 'UPDATE',
      statement: (id: string) =>
        `UPDATE ledger_transactions SET memo = 'edited' WHERE id = '${id}'`,
    },
    {
      verb: 'DELETE',
      statement: (id: string) => `DELETE FROM ledger_transactions WHERE id = '${id}'`,
    },
  ])('refuses $verb on ledger_transactions, for both roles', async ({ statement }) => {
    const { transactionId } = await seedPosting();
    for (const role of roles()) {
      const error = await attempt(role.url, statement(transactionId));
      expect(error, `${role.name} was allowed to rewrite the ledger`).not.toBeNull();
      expect(error!.message).toMatch(/permission denied/i);
    }
  });

  it.each([
    {
      verb: 'UPDATE',
      statement: (id: string) => `UPDATE ledger_entries SET debit_k = 1 WHERE id = '${id}'`,
    },
    { verb: 'DELETE', statement: (id: string) => `DELETE FROM ledger_entries WHERE id = '${id}'` },
  ])('refuses $verb on ledger_entries, for both roles', async ({ statement }) => {
    const { entryId } = await seedPosting();
    for (const role of roles()) {
      const error = await attempt(role.url, statement(entryId));
      expect(error, `${role.name} was allowed to rewrite a ledger line`).not.toBeNull();
      expect(error!.message).toMatch(/permission denied/i);
    }
  });

  /**
   * The revocation must not cost the ledger its only job. A posting that
   * could no longer be written would pass every test above and be useless.
   */
  it('still lets both roles INSERT and SELECT', async () => {
    const { transactionId } = await seedPosting();
    for (const role of roles()) {
      const read = await attempt(role.url, `SELECT count(*) FROM ledger_transactions`);
      expect(read, `${role.name} lost SELECT`).toBeNull();
    }
    expect(transactionId).toBeTruthy();

    const user = await identity.upsertUserByPhone(db, '+2348090100002');
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Second Shop',
      businessType: null,
      ownerUserId: user.id,
    });
    const recorded = await withBusiness(db, business.id, (tx) =>
      journalRepo.recordJournal(tx, {
        businessId: business.id,
        memo: 'Owner put money in',
        amountK: 100_000,
        intoAccount: 'CASH',
        outOfAccount: 'OWNERS_EQUITY',
        actor: 'user:1',
      }),
    );
    expect(recorded.journalNumber).toMatch(/^JNL-\d{4}-\d{6}$/);
  });
});
