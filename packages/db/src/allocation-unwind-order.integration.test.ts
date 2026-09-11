/**
 * Which allocation a partial refund unwinds first is decided by a
 * database-assigned ordinal, never by clock resolution or uuid order
 * (migration 0151; G-06).
 *
 * `standingAllocationsFor` lists a payment's standing allocations NEWEST
 * first and `unwindAllocations` reverses them in that order. It ordered by
 * `created_at DESC, id DESC`. `created_at` is `now()`, the transaction's
 * start, so every allocation one transaction writes ties on it, and the
 * tiebreaker behind the tie is a RANDOM uuid. Which invoice reopens on a
 * partial refund was therefore different on every run.
 *
 * The invariant, stated once: for one payment, if allocation B was inserted
 * after allocation A and both still stand, B is listed before A, regardless
 * of `created_at` equality and regardless of uuid lexical order.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  customersRepo,
  identity,
  issueRepo,
  settleRepo,
  sql,
  withBusiness,
  type Db,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let owner: Db;
let app: Db;
let closeOwner: () => Promise<void>;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  const asOwner = createDb(urls.owner, { max: 2 });
  owner = asOwner.db;
  closeOwner = asOwner.close;
  const asApp = createDb(urls.app, { max: 4 });
  app = asApp.db;
  closeApp = asApp.close;
});

afterAll(async () => {
  await closeApp();
  await closeOwner();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(app, `+23481870${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(app, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** One invoice for `totalK`, paid `paidK` at issue (a paid sale writes the payment and its allocation). */
async function seedInvoice(
  businessId: string,
  customer: { id: string; token: string },
  totalK: number,
  paidK: number,
) {
  seq += 1;
  return withBusiness(app, businessId, (tx) =>
    issueRepo.issueSale(tx, {
      businessId,
      customerId: customer.id,
      customerToken: customer.token,
      items: [{ name: 'wig', quantity: 1, unitPriceK: totalK }],
      subtotalK: totalK,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK,
      paidK,
      balanceDueK: totalK - paidK,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: `draft-ao-${seq}`,
      saleSource: null,
      dueDate: null,
      actor: 'system',
    }),
  );
}

/**
 * One payment of ₦100,000 re-matched (§14.2: full reversal, fresh
 * allocations) onto `count` invoices of ₦10,000 each, all inside ONE
 * transaction, so every fresh allocation shares `created_at`.
 * Returns the target invoice ids in insertion order.
 */
async function rematchedAcrossInvoices(businessId: string, count: number) {
  const customer = await customersRepo.createCustomerWithIdentities(
    app,
    businessId,
    `CUSTOMER_AO${seq}`,
    [],
  );
  const paid = await seedInvoice(businessId, customer, 100_000, 100_000);
  if (!paid.paymentId) throw new Error('fixture: an initially paid sale writes a payment');
  const paymentId = paid.paymentId;
  const targets: string[] = [];
  for (let i = 0; i < count; i += 1) {
    targets.push((await seedInvoice(businessId, customer, 10_000, 0)).invoiceId);
  }
  await withBusiness(app, businessId, async (tx) => {
    const [original] = await settleRepo.standingAllocationsFor(tx, businessId, paymentId);
    if (!original) throw new Error('fixture: the paid sale allocated its payment');
    const reversed = await settleRepo.reverseAllocation(tx, {
      businessId,
      allocationId: original.id,
      reason: 'rematch',
      sourceType: 'test',
      sourceId: 'rematch-1',
    });
    if (reversed.outcome !== 'reversed') throw new Error(`fixture: ${reversed.outcome}`);
    for (const invoiceId of targets) {
      await settleRepo.allocatePayment(tx, {
        businessId,
        paymentId,
        invoiceId,
        amountK: 10_000,
        reason: 'rematch',
        sourceType: 'test',
        sourceId: 'rematch-1',
      });
    }
  });
  return { paymentId, targets };
}

describe('the ordinal is the database’s, structurally', () => {
  it('insertion_seq is a bigint identity, GENERATED ALWAYS, not null', async () => {
    const rows = await owner.execute<{
      data_type: string;
      is_nullable: string;
      is_identity: string;
      identity_generation: string | null;
    }>(sql`
      SELECT data_type, is_nullable, is_identity, identity_generation
        FROM information_schema.columns
       WHERE table_name = 'payment_allocations' AND column_name = 'insertion_seq'
    `);
    expect([...rows]).toEqual([
      { data_type: 'bigint', is_nullable: 'NO', is_identity: 'YES', identity_generation: 'ALWAYS' },
    ]);
  });

  it('a caller who tries to choose the ordinal is refused by PostgreSQL itself', async () => {
    const businessId = await seedBusiness();
    const { paymentId, targets } = await rematchedAcrossInvoices(businessId, 1);
    await expect(
      withBusiness(app, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO payment_allocations (business_id, payment_id, invoice_id, amount_k, insertion_seq)
          VALUES (${businessId}::uuid, ${paymentId}::uuid, ${targets[0]}::uuid, 1, 999999)
        `),
      ),
    ).rejects.toThrow(/insertion_seq|identity|GENERATED ALWAYS/i);
  });
});

describe('standing allocations list newest first, whatever the clock and the uuids say', () => {
  /* Ten allocations in one transaction: the chance that ten random uuids
   * happen to sort in exact reverse-insertion order is 1 in 3,628,800, so
   * before 0151 this case failed on essentially every run. */
  it('ten allocations on one instant come back in reverse insertion order', async () => {
    const businessId = await seedBusiness();
    const { paymentId, targets } = await rematchedAcrossInvoices(businessId, 10);

    const standing = await withBusiness(app, businessId, (tx) =>
      settleRepo.standingAllocationsFor(tx, businessId, paymentId),
    );
    expect(standing).toHaveLength(10);
    // The tie the ordinal exists to break: one transaction, one `created_at`.
    expect(new Set(standing.map((a) => a.createdAt.getTime())).size).toBe(1);
    expect(standing.map((a) => a.invoiceId)).toEqual([...targets].reverse());
    for (let i = 1; i < standing.length; i += 1) {
      expect(standing[i - 1]!.insertionSeq).toBeGreaterThan(standing[i]!.insertionSeq);
    }
  });

  it('the newest allocation is listed first whichever way its uuid sorts', async () => {
    const businessId = await seedBusiness();
    const { paymentId, targets } = await rematchedAcrossInvoices(businessId, 2);
    const standing = await withBusiness(app, businessId, (tx) =>
      settleRepo.standingAllocationsFor(tx, businessId, paymentId),
    );
    const [newest, oldest] = standing;
    expect(newest!.invoiceId).toBe(targets[1]);
    expect(oldest!.invoiceId).toBe(targets[0]);
    expect(newest!.insertionSeq).toBeGreaterThan(oldest!.insertionSeq);
    expect(newest!.createdAt.getTime()).toBe(oldest!.createdAt.getTime());
  });

  it('a reversed allocation leaves the list and the order of the rest is unchanged', async () => {
    const businessId = await seedBusiness();
    const { paymentId, targets } = await rematchedAcrossInvoices(businessId, 3);
    await withBusiness(app, businessId, async (tx) => {
      const [newest] = await settleRepo.standingAllocationsFor(tx, businessId, paymentId);
      const reversed = await settleRepo.reverseAllocation(tx, {
        businessId,
        allocationId: newest!.id,
        reason: 'unwind',
        sourceType: 'refund',
        sourceId: 'rf-1',
      });
      expect(reversed.outcome).toBe('reversed');
    });
    const standing = await withBusiness(app, businessId, (tx) =>
      settleRepo.standingAllocationsFor(tx, businessId, paymentId),
    );
    expect(standing.map((a) => a.invoiceId)).toEqual([targets[1], targets[0]]);
  });
});
