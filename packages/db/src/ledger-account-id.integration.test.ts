/**
 * The chart link, end state (F1; PR-031…034): `account_id` is NOT NULL with
 * a composite tenant FK, so an entry without its chart account — or citing
 * another tenant's — is unrepresentable. What the dual write once promised
 * and the backfill once proved, the database now simply enforces; what is
 * left to test is that every posting path links the RIGHT rows, and that
 * the failure modes stay loud.
 */
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNTS } from '@rekoda/core';
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

describe('every posting path links the right chart rows', () => {
  it('a journal, a sale and a reported payment land on the seeded accounts, by code', async () => {
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

    /* The whole history, grouped by the CODE of the linked chart row. The
     * per-code sums pin both halves at once: that entries link (a dangling
     * one cannot exist), and that they link where the posting builders
     * meant — the seeded account that kept the legacy key's code. */
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ code: string; debit_k: string; credit_k: string }>(sql`
        SELECT a.code, SUM(e.debit_k)::bigint AS debit_k, SUM(e.credit_k)::bigint AS credit_k
        FROM ledger_entries e
        JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid
        GROUP BY a.code
      `),
    );
    const byCode = Object.fromEntries(
      [...rows].map((r) => [r.code, { debitK: Number(r.debit_k), creditK: Number(r.credit_k) }]),
    );
    expect(byCode).toEqual({
      [ACCOUNTS.CASH.code]: { debitK: 500_000, creditK: 250_000 },
      [ACCOUNTS.BANK.code]: { debitK: 250_000, creditK: 0 },
      [ACCOUNTS.ACCOUNTS_RECEIVABLE.code]: { debitK: 500_000, creditK: 500_000 },
      [ACCOUNTS.SALES_REVENUE.code]: { debitK: 0, creditK: 500_000 },
    });
  });

  it('an entry without a chart account is unrepresentable', async () => {
    const businessId = await seedBusiness();
    const txRow = await withBusiness(db, businessId, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO ledger_transactions (business_id, memo, source_type, source_id)
        VALUES (${businessId}::uuid, 'null probe', 'manual', 'probe-null') RETURNING id
      `);
      return [...rows][0]!.id;
    });
    const code = await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO ledger_entries
          (business_id, transaction_id, debit_k, credit_k, transaction_amount_minor)
        VALUES (${businessId}::uuid, ${txRow}::uuid, 100, 0, 100)
      `),
    ).then(
      () => 'inserted',
      (error: unknown) => (error as { cause?: { code?: string } }).cause?.code ?? 'unknown',
    );
    /* 23502: the NOT NULL the end state promises. */
    expect(code).toBe('23502');
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
          INSERT INTO ledger_entries
            (business_id, transaction_id, account_id, debit_k, credit_k, transaction_amount_minor)
          VALUES (${ada}::uuid, ${txRow}::uuid, ${foreignId}::uuid, 100, 0, 100)
        `),
      ),
    ).rejects.toThrow();
  });
});
