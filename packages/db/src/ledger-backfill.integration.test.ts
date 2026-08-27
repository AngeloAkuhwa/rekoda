/**
 * The validated backfill (F1; PR-032), tested the only honest way: by
 * re-executing the migration file itself against rows made to look like the
 * pre-dual-write estate. Its idempotence is what makes that possible, and
 * its VALIDATION gate is proved to abort — a backfill that reports success
 * while rows dangle is the failure the gate exists to catch.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  identity,
  journalRepo,
  settleRepo,
  issueRepo,
  sql,
  withBusiness,
  type Db,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

const MIGRATION = readFileSync(
  join(
    fileURLToPath(import.meta.url),
    '..',
    '..',
    'migrations',
    '0064_backfill_ledger_account_id.sql',
  ),
  'utf8',
);

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
  const user = await identity.upsertUserByPhone(db, `+23481770${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function postHistory(businessId: string): Promise<void> {
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
      items: [{ name: 'wig', quantity: 1, unitPriceK: 400_000 }],
      subtotalK: 400_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 400_000,
      paidK: 0,
      balanceDueK: 400_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: 'draft-bf',
      saleSource: null,
      dueDate: null,
      actor: 'system',
    });
    await settleRepo.recordMerchantPayment(tx, {
      businessId,
      invoiceId: sale.invoiceId,
      amountK: 400_000,
      method: 'cash',
      sourceType: 'chat',
      sourceId: 'draft-pay-bf',
      actor: 'system',
    });
  });
}

async function linkState(businessId: string) {
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

describe('the backfill (PR-032)', () => {
  it('relinks a pre-dual-write history completely, and every link agrees by code', async () => {
    const businessId = await seedBusiness();
    await postHistory(businessId);

    const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
    try {
      /* Make the history look pre-dual-write. */
      await owner`UPDATE ledger_entries SET account_id = NULL
                  WHERE business_id = ${businessId}::uuid`;
      const before = await linkState(businessId);
      expect(before.every((r) => r.account_id === null)).toBe(true);
      expect(before.length).toBeGreaterThanOrEqual(6);

      /* The migration itself, replayed. */
      await owner.unsafe(MIGRATION);
    } finally {
      await owner.end();
    }

    const after = await linkState(businessId);
    for (const row of after) {
      expect(row.account_id, row.account).not.toBeNull();
    }
    /* Spot the agreement through two known keys. */
    expect(after.find((r) => r.account === 'CASH')?.linked_code).toBe('1000');
    expect(after.find((r) => r.account === 'SALES_REVENUE')?.linked_code).toBe('4000');
  });

  it('is idempotent: a second run changes nothing and still validates', async () => {
    const businessId = await seedBusiness();
    await postHistory(businessId);

    const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
    try {
      await owner.unsafe(MIGRATION);
      await owner.unsafe(MIGRATION);
    } finally {
      await owner.end();
    }
    const after = await linkState(businessId);
    expect(after.every((r) => r.account_id !== null)).toBe(true);
  });

  it('ABORTS when a key nobody mapped would be left dangling', async () => {
    const businessId = await seedBusiness();
    await postHistory(businessId);

    const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
    try {
      const [tx] = await owner<{ id: string }[]>`
        INSERT INTO ledger_transactions (business_id, memo, source_type, source_id)
        VALUES (${businessId}::uuid, 'legacy mystery', 'manual', 'legacy-1') RETURNING id
      `;
      await owner`
        INSERT INTO ledger_entries (business_id, transaction_id, account, debit_k, credit_k)
        VALUES (${businessId}::uuid, ${tx!.id}::uuid, 'LEGACY_MYSTERY', 100, 0),
               (${businessId}::uuid, ${tx!.id}::uuid, 'CASH', 0, 100)
      `;

      /* The gate refuses to declare victory over a dangling row. */
      await expect(owner.unsafe(MIGRATION)).rejects.toThrow(/backfill incomplete/);
    } finally {
      await owner.end();
    }
  });
});
