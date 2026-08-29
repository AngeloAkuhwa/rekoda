/**
 * The bill lifecycle over real rows (spec §8; F2, PR-077). The claims: a
 * credit purchase mints its DOCUMENT in the same transaction that raised
 * the payable; the lifecycle follows the money and cannot disagree with
 * it; a fully-paid purchase mints nothing; and a withdrawn purchase
 * takes its bill with it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, spendRepo } from './index.js';
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

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481880${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const buy = (businessId: string, amountK: number, paidK: number, description = 'ankara bales') =>
  withBusiness(db, businessId, (tx) =>
    spendRepo.recordPurchase(tx, {
      businessId,
      description,
      amountK,
      paidK,
      sourceType: 'chat',
      sourceId: `draft-${Math.abs(amountK - paidK)}`,
    }),
  );

const billList = (businessId: string) =>
  withBusiness(db, businessId, (tx) => spendRepo.billsFor(tx, businessId));

describe('minting the document (spec §8)', () => {
  it('a credit purchase mints its bill for exactly the credit portion', async () => {
    const businessId = await seedBusiness();
    const recorded = await buy(businessId, 10_000_000, 4_000_000);
    expect(recorded.owedK).toBe(6_000_000);
    expect(recorded.billNumber).toMatch(/^BILL-\d{4}-000001$/);

    const bill = (await billList(businessId))[0]!;
    expect(bill).toMatchObject({
      billNumber: recorded.billNumber,
      status: 'open',
      totalK: 6_000_000,
      paidK: 0,
      balanceDueK: 6_000_000,
      description: 'ankara bales',
    });
  });

  it('a fully paid purchase mints NO bill — no debt, no document', async () => {
    const businessId = await seedBusiness();
    const recorded = await buy(businessId, 5_000_000, 5_000_000);
    expect(recorded).toMatchObject({ owedK: 0, billNumber: null });
    expect(await billList(businessId)).toEqual([]);
  });
});

describe('the lifecycle follows the money', () => {
  it('part-payment and settlement move the status, and the payment names its bill', async () => {
    const businessId = await seedBusiness();
    const recorded = await buy(businessId, 10_000_000, 4_000_000);

    const part = await withBusiness(db, businessId, (tx) =>
      spendRepo.paySupplier(tx, {
        businessId,
        expenseId: recorded.expenseId,
        amountK: 2_000_000,
        method: 'transfer',
        actor: 'user:1',
      }),
    );
    expect(part.outcome).toBe('paid');
    let bill = (await billList(businessId))[0]!;
    expect(bill).toMatchObject({
      status: 'partially_paid',
      paidK: 2_000_000,
      balanceDueK: 4_000_000,
    });

    await withBusiness(db, businessId, (tx) =>
      spendRepo.paySupplier(tx, {
        businessId,
        expenseId: recorded.expenseId,
        amountK: 4_000_000,
        method: 'transfer',
        actor: 'user:1',
      }),
    );
    bill = (await billList(businessId))[0]!;
    expect(bill).toMatchObject({ status: 'paid', paidK: 6_000_000, balanceDueK: 0 });

    const payments = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ bill_id: string | null }>(
        sql`SELECT bill_id FROM supplier_payments WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...payments].map((r) => r.bill_id)).toEqual([bill.id, bill.id]);
  });

  it('withdrawing the purchase voids its bill with it', async () => {
    const businessId = await seedBusiness();
    const recorded = await buy(businessId, 10_000_000, 4_000_000);
    const voided = await withBusiness(db, businessId, (tx) =>
      spendRepo.voidExpense(tx, businessId, recorded.expenseId, 'wrong figures', 'user:1'),
    );
    expect(voided.outcome).toBe('voided');
    expect((await billList(businessId))[0]).toMatchObject({ status: 'voided' });
  });

  it('a status that disagrees with the money is unrepresentable', async () => {
    const businessId = await seedBusiness();
    await buy(businessId, 10_000_000, 4_000_000);
    /* "Paid" with money still standing. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`UPDATE bills SET status = 'paid' WHERE business_id = ${businessId}::uuid`),
      ),
    ).rejects.toThrow();
    /* Paid more than the bill is for. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`UPDATE bills SET paid_k = 7000000 WHERE business_id = ${businessId}::uuid`),
      ),
    ).rejects.toThrow();
  });
});
