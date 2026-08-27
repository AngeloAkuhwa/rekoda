/**
 * The dual write (F1; PR-031): from this deploy on, no ledger entry is born
 * without its chart account. The text key stays (readers cut over in
 * PR-033), the `account_id` arrives beside it, and the two must AGREE — the
 * linked account's code is the legacy key's code, for every line of every
 * posting path.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNTS, type AccountKey } from '@rekoda/core';
import {
  createDb,
  identity,
  issueRepo,
  journalRepo,
  settleRepo,
  sql,
  withBusiness,
  type Db,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

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

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481760${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** Every entry row with the code of the account its account_id points at. */
async function entryLinks(businessId: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ account: string; account_id: string | null; linked_code: string | null }>(sql`
      SELECT e.account, e.account_id, a.code AS linked_code
      FROM ledger_entries e
      LEFT JOIN accounts a ON a.id = e.account_id
      WHERE e.business_id = ${businessId}::uuid
    `),
  );
  return [...rows];
}

describe('every posting path writes both halves', () => {
  it('a journal, a sale and a reported payment all link their entries', async () => {
    const businessId = await seedBusiness();

    await withBusiness(db, businessId, async (tx) => {
      await journalRepo.recordJournal(tx, {
        businessId,
        memo: 'till to bank',
        amountK: 250_000,
        intoAccount: 'BANK',
        outOfAccount: 'CASH',
        actor: 'user:test',
      });
      const sale = await issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: null,
        items: [{ name: 'wig', quantity: 1, unitPriceK: 500_000 }],
        subtotalK: 500_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 500_000,
        paidK: 0,
        balanceDueK: 500_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-lx',
        saleSource: null,
        dueDate: null,
        actor: 'system',
      });
      await settleRepo.recordMerchantPayment(tx, {
        businessId,
        invoiceId: sale.invoiceId,
        amountK: 500_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'draft-pay-lx',
        actor: 'system',
      });
    });

    const links = await entryLinks(businessId);
    expect(links.length).toBeGreaterThanOrEqual(6);
    for (const link of links) {
      /* Born linked... */
      expect(link.account_id, link.account).not.toBeNull();
      /* ...and linked to the RIGHT row: the seeded account that kept the
       * legacy key's code. */
      expect(link.linked_code, link.account).toBe(ACCOUNTS[link.account as AccountKey].code);
    }
  });

  it('refuses to post when the seeded account is missing, loudly', async () => {
    const businessId = await seedBusiness();

    /* Break the invariant the way only an operator could: the app cannot
     * DELETE chart rows (0061 revoked it), so the owner stands in for the
     * catastrophe. */
    const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
    try {
      await owner`DELETE FROM accounts
                  WHERE business_id = ${businessId}::uuid AND code = '1020'`;
    } finally {
      await owner.end();
    }

    await expect(
      withBusiness(db, businessId, (tx) =>
        journalRepo.recordJournal(tx, {
          businessId,
          memo: 'till to bank',
          amountK: 100_000,
          intoAccount: 'BANK',
          outOfAccount: 'CASH',
          actor: 'user:test',
        }),
      ),
    ).rejects.toThrow(/the seed is missing/);
  });

  it('an entry citing another tenant account is unrepresentable', async () => {
    const ada = await seedBusiness();
    const bola = await seedBusiness();
    const bolaAccount = await withBusiness(db, bola, (tx) =>
      tx.execute<{ id: string }>(
        sql`SELECT id FROM accounts WHERE business_id = ${bola}::uuid AND code = '1000'`,
      ),
    );
    const foreignId = [...bolaAccount][0]!.id;

    /* A direct insert with a foreign account id violates the composite FK. */
    const txRow = await withBusiness(db, ada, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO ledger_transactions (business_id, memo, source_type, source_id)
        VALUES (${ada}::uuid, 'fk probe', 'manual', 'probe') RETURNING id
      `);
      return [...rows][0]!.id;
    });
    await expect(
      withBusiness(db, ada, (tx) =>
        tx.execute(sql`
          INSERT INTO ledger_entries (business_id, transaction_id, account, account_id, debit_k, credit_k)
          VALUES (${ada}::uuid, ${txRow}::uuid, 'CASH', ${foreignId}::uuid, 100, 0)
        `),
      ),
    ).rejects.toThrow();
  });
});
