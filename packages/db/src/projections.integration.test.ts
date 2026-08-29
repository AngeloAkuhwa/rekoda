/**
 * Document projections, provably rebuildable (Appendix E.3; PR-084).
 *
 * The canon's storage rule: a denormalised projection "has a rebuild path
 * that a test exercises. A cache that cannot be rebuilt is not a cache, it
 * is a second source of truth wearing a disguise." This is that test.
 *
 * The battery drives documents through every settlement door the system
 * has — a part-paid sale, a merchant payment, a credit note granted AND
 * applied, a void, a part-paid supplier bill, one paid off — then proves
 * two things: the writers left the stored projection agreeing with the
 * subledgers (rebuild repairs NOTHING on live data), and after the stored
 * columns are corrupted raw, the rebuild restores every figure exactly
 * from the subledgers alone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import {
  customersRepo,
  identity,
  issueRepo,
  projectionsRepo,
  settleRepo,
  spendRepo,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close: closeDb } = createDb(urls.app, { max: 4 }));
});

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481897${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

function saleOf(businessId: string, customerId: string | null, totalK: number, paidK: number) {
  seq += 1;
  return {
    businessId,
    customerId,
    customerToken: 'CUSTOMER_7K2',
    items: [],
    subtotalK: totalK,
    discountK: 0,
    deliveryFeeK: 0,
    vatK: 0,
    totalK,
    paidK,
    balanceDueK: totalK - paidK,
    method: 'transfer' as const,
    sourceType: 'chat',
    sourceId: `draft-p84-${seq}`,
    actor: 'system',
  };
}

interface DocumentSnapshot {
  number: string;
  status: string;
  paidK: number;
  balanceDueK: number;
  creditedK: number | null;
}

const snapshot = (businessId: string) =>
  withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{
      number: string;
      status: string;
      paid_k: string;
      balance_due_k: string;
      credited_k: string | null;
    }>(sql`
      SELECT invoice_number AS number, status, paid_k::bigint AS paid_k,
             balance_due_k::bigint AS balance_due_k, credited_k::bigint AS credited_k
      FROM invoices WHERE business_id = ${businessId}::uuid
      UNION ALL
      SELECT bill_number AS number, status, paid_k::bigint AS paid_k,
             balance_due_k::bigint AS balance_due_k, NULL AS credited_k
      FROM bills WHERE business_id = ${businessId}::uuid
      ORDER BY number
    `);
    return [...rows].map((r): DocumentSnapshot => ({
      number: r.number,
      status: r.status,
      paidK: Number(r.paid_k),
      balanceDueK: Number(r.balance_due_k),
      creditedK: r.credited_k === null ? null : Number(r.credited_k),
    }));
  });

/** Every settlement door the system has, exercised once. */
async function battery(businessId: string) {
  const customer = await customersRepo.createCustomerWithIdentities(
    db,
    businessId,
    'CUSTOMER_P84',
    [],
  );
  return withBusiness(db, businessId, async (tx) => {
    /* A part-paid credit sale, settled the rest of the way by hand. */
    const partPaid = await issueRepo.issueSale(
      tx,
      saleOf(businessId, customer.id, 10_000_000, 4_000_000),
    );
    await settleRepo.recordMerchantPayment(tx, {
      businessId,
      invoiceId: partPaid.invoiceId,
      amountK: 6_000_000,
      method: 'transfer',
      sourceType: 'dashboard',
      sourceId: 'p84-settle-1',
      actor: 'user:1',
    });

    /* A part-paid sale, credited (§14.1 grants against what was paid) and
     * the credit applied back onto its own remaining balance. */
    const credited = await issueRepo.issueSale(
      tx,
      saleOf(businessId, customer.id, 8_000_000, 5_000_000),
    );
    const note = await issueRepo.issueCreditNote(tx, {
      businessId,
      invoiceNumber: credited.invoiceNumber,
      amountK: 3_000_000,
      reason: 'damaged goods',
      actor: 'user:1',
    });
    if (note.outcome !== 'credited') throw new Error(`credit refused: ${note.outcome}`);
    await issueRepo.applyCreditToInvoice(tx, {
      businessId,
      customerCreditId: note.customerCreditId,
      invoiceNumber: credited.invoiceNumber,
      amountK: 3_000_000,
      actor: 'user:1',
    });

    /* A sale voided before any money moved. */
    const voided = await issueRepo.issueSale(tx, saleOf(businessId, customer.id, 5_000_000, 0));
    await issueRepo.voidInvoice(tx, businessId, voided.invoiceNumber, 'entered twice', 'user:1');

    /* The payable mirror: one bill part-paid, one paid off entirely. */
    const partBill = await spendRepo.recordPurchase(tx, {
      businessId,
      description: 'ankara bales',
      amountK: 6_000_000,
      paidK: 2_000_000,
      sourceType: 'chat',
      sourceId: 'p84-buy-1',
    });
    await spendRepo.paySupplier(tx, {
      businessId,
      expenseId: partBill.expenseId,
      amountK: 1_000_000,
      method: 'transfer',
      actor: 'user:1',
    });
    const settledBill = await spendRepo.recordPurchase(tx, {
      businessId,
      description: 'lace bales',
      amountK: 4_000_000,
      paidK: 0,
      sourceType: 'chat',
      sourceId: 'p84-buy-2',
    });
    await spendRepo.paySupplier(tx, {
      businessId,
      expenseId: settledBill.expenseId,
      amountK: 4_000_000,
      method: 'cash',
      actor: 'user:1',
    });

    return { partPaid, credited, voided };
  });
}

describe('the stored figures are projections of the subledgers', () => {
  it('live writers leave nothing to repair, and a corrupted cache rebuilds exactly', async () => {
    const businessId = await seedBusiness();
    await battery(businessId);

    const before = await snapshot(businessId);
    expect(before.length).toBe(5);

    /* THE FIRST CLAIM: the writers maintained the projection inside the
     * same transactions as the facts. Nothing drifts on live data. */
    const clean = await withBusiness(db, businessId, (tx) =>
      projectionsRepo.rebuildDocumentProjections(tx, businessId),
    );
    expect(clean.invoicesChecked).toBe(3);
    expect(clean.billsChecked).toBe(2);
    expect(clean.invoicesRepaired).toEqual([]);
    expect(clean.billsRepaired).toEqual([]);
    expect(await snapshot(businessId)).toEqual(before);

    /* THE SECOND CLAIM: corrupt every stored figure raw, and the rebuild
     * restores each one from the subledgers alone — the cache is a cache,
     * not a second truth. The one thing deliberately NOT corrupted is a
     * void: lifecycle is E.3's persisted dimension precisely because there
     * is no other record of it, so a lifecycle erased raw is a fact lost,
     * not a cache to rebuild. The voided document's money figures are
     * corrupted like the rest. */
    await withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        UPDATE invoices
           SET paid_k = 1, balance_due_k = 99, credited_k = 7,
               status = CASE WHEN status = 'voided' THEN 'voided' ELSE 'issued' END
        WHERE business_id = ${businessId}::uuid
      `),
    );
    /* Bills can only be corrupted COHERENTLY: `bills_status_coherent`
     * (0098) makes "open with money paid" unrepresentable, so the worst
     * lie a bill can tell is a coherent one — nothing paid at all. */
    await withBusiness(db, businessId, (tx) =>
      tx.execute(
        sql`UPDATE bills SET paid_k = 0, status = 'open' WHERE business_id = ${businessId}::uuid`,
      ),
    );

    const repaired = await withBusiness(db, businessId, (tx) =>
      projectionsRepo.rebuildDocumentProjections(tx, businessId),
    );
    expect(repaired.invoicesRepaired).toHaveLength(3);
    expect(repaired.billsRepaired).toHaveLength(2);
    expect(repaired.computedAt).toBeInstanceOf(Date);
    expect(await snapshot(businessId)).toEqual(before);
  });

  /**
   * A credit note from before §14.1 reduced the balance DIRECTLY, with no
   * customer-credit grant behind it. The rebuild recognises the era by the
   * absence of the grant and honours the settlement it was: history is not
   * a drift to be repaired.
   */
  it('honours a pre-§14.1 credit note instead of resurrecting the debt it forgave', async () => {
    const businessId = await seedBusiness();
    const customer = await customersRepo.createCustomerWithIdentities(
      db,
      businessId,
      'CUSTOMER_P84L',
      [],
    );
    const issued = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, saleOf(businessId, customer.id, 9_000_000, 0)),
    );

    /* The old flow, verbatim as data: a note row, the balance reduced, the
     * credited figure carried — and NO grant. */
    await withBusiness(db, businessId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO credit_notes (business_id, invoice_id, credit_note_number, amount_k, reason, actor)
        VALUES (${businessId}::uuid, ${issued.invoiceId}::uuid, 'CN-2025-000001', ${2_000_000}, 'legacy', 'user:1')
      `);
      await tx.execute(sql`
        UPDATE invoices
           SET balance_due_k = ${7_000_000}, credited_k = ${2_000_000}, status = 'partially_paid'
         WHERE id = ${issued.invoiceId}::uuid AND business_id = ${businessId}::uuid
      `);
    });

    const before = await snapshot(businessId);
    const rebuilt = await withBusiness(db, businessId, (tx) =>
      projectionsRepo.rebuildDocumentProjections(tx, businessId),
    );
    expect(rebuilt.invoicesRepaired).toEqual([]);
    expect(await snapshot(businessId)).toEqual(before);
  });
});
