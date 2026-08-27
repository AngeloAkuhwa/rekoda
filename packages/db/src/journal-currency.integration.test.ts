/**
 * Journal currency columns (spec §16; PR-037), additive: every posting path
 * stamps what the money actually was, and for today's single-currency world
 * that is the functional amount in NGN with no snapshot — stated as data,
 * not assumed. The FX requirement itself (snapshot REQUIRED exactly when
 * currencies differ) is PR-038's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  const user = await identity.upsertUserByPhone(db, `+23481790${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

describe('every posting states its currency (§16)', () => {
  it('lines carry the transaction amount, NGN, and no snapshot; entries carry NGN functional', async () => {
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
        sourceId: 'draft-fx',
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
        sourceId: 'draft-pay-fx',
        actor: 'system',
      });
    });

    const lines = await withBusiness(db, businessId, (tx) =>
      tx.execute<{
        transaction_currency: string;
        transaction_amount_minor: string;
        debit_k: string;
        credit_k: string;
        exchange_rate_snapshot_id: string | null;
      }>(sql`
        SELECT e.transaction_currency, e.transaction_amount_minor::bigint AS transaction_amount_minor,
               e.debit_k::bigint AS debit_k, e.credit_k::bigint AS credit_k,
               e.exchange_rate_snapshot_id
        FROM ledger_entries e WHERE e.business_id = ${businessId}::uuid
      `),
    );
    expect([...lines].length).toBeGreaterThanOrEqual(6);
    for (const line of lines) {
      expect(line.transaction_currency).toBe('NGN');
      /* Same currency: the transaction amount IS the functional amount. */
      expect(Number(line.transaction_amount_minor)).toBe(
        Number(line.debit_k) + Number(line.credit_k),
      );
      expect(line.exchange_rate_snapshot_id).toBeNull();
    }

    const entries = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ functional_currency: string }>(
        sql`SELECT functional_currency FROM ledger_transactions
            WHERE business_id = ${businessId}::uuid`,
      ),
    );
    for (const entry of entries) expect(entry.functional_currency).toBe('NGN');
  });

  it('a negative transaction amount is unrepresentable', async () => {
    const businessId = await seedBusiness();
    const txId = await withBusiness(db, businessId, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO ledger_transactions (business_id, memo, source_type, source_id)
        VALUES (${businessId}::uuid, 'neg probe', 'manual', 'neg') RETURNING id
      `);
      return [...rows][0]!.id;
    });
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO ledger_entries
            (business_id, transaction_id, account_id, debit_k, credit_k, transaction_amount_minor)
          VALUES (${businessId}::uuid, ${txId}::uuid,
                  (SELECT id FROM accounts
                    WHERE business_id = ${businessId}::uuid AND code = '1000'),
                  100, 0, -100)
        `),
      ),
    ).rejects.toThrow();
  });
});
