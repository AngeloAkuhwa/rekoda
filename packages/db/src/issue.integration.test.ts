/**
 * The transaction engine (MASTER-PLAN §5.3.5) and CG3.
 *
 * This is the file that has to hold if anything does. Everything it asserts is
 * a property of a real transaction against a real PostgreSQL: that a numbered
 * document, its items, its payment and its ledger entries appear together or
 * not at all, that two confirmations arriving together produce ONE document,
 * and that the books balance after every operation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { trialBalance, type Posting } from '@rekoda/core';
import { canonicalise, documentHash } from '@rekoda/core/documents';
import { createDb, withBusiness, type Db, type TenantDb } from './client.js';
import { conversationsRepo, identity, issueRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 12 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(name = 'Ada Fashion', phone = '+2348100000001'): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** "Ada bought 3 wigs for 150k, paid 100k" — the plan's own example. */
function theSale(businessId: string): issueRepo.IssueSaleInput {
  return {
    businessId,
    customerId: null,
    customerToken: 'CUSTOMER_7K2',
    items: [{ name: 'wig', quantity: 3, unitPriceK: 5_000_000 }],
    subtotalK: 15_000_000,
    discountK: 0,
    deliveryFeeK: 0,
    vatK: 0,
    totalK: 15_000_000,
    paidK: 10_000_000,
    balanceDueK: 5_000_000,
    method: 'transfer',
    sourceType: 'chat',
    sourceId: 'draft-1',
    actor: 'system',
  };
}

function countOf(businessId: string, table: string) {
  return withBusiness(db, businessId, (tx) =>
    tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`),
  ).then((rows) => [...rows][0]?.n ?? 0);
}

describe('issuing a sale', () => {
  it('produces a numbered, balanced, audited record in one transaction', async () => {
    const businessId = await seedBusiness();
    const issued = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, theSale(businessId)),
    );

    expect(issued.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(issued.docHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.paymentId).not.toBeNull();

    expect(await countOf(businessId, 'invoices')).toBe(1);
    expect(await countOf(businessId, 'invoice_items')).toBe(1);
    expect(await countOf(businessId, 'payments')).toBe(1);
    expect(await countOf(businessId, 'payment_allocations')).toBe(1);
    expect(await countOf(businessId, 'ledger_transactions')).toBe(1);
    expect(await countOf(businessId, 'audit_events')).toBe(1);
  });

  it('keeps where-it-happened apart from how-it-arrived (rekoda-chat-v1 §27)', async () => {
    const businessId = await seedBusiness();
    // An Instagram sale, told to Rekoda Chat: captured via chat, earned on
    // Instagram. Neither fact may overwrite the other.
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, { ...theSale(businessId), saleSource: 'instagram' }),
    );

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ source_type: string; sale_source: string | null }>(
        sql`SELECT source_type, sale_source FROM invoices`,
      ),
    );
    const invoice = [...rows][0];
    expect(invoice?.source_type).toBe('chat');
    expect(invoice?.sale_source).toBe('instagram');

    // And a sale with no stated channel is simply a sale.
    await withBusiness(db, businessId, (tx) => issueRepo.issueSale(tx, theSale(businessId)));
    const untagged = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ sale_source: string | null }>(
        sql`SELECT sale_source FROM invoices ORDER BY invoice_number DESC LIMIT 1`,
      ),
    );
    expect([...untagged][0]?.sale_source).toBeNull();
  });

  it('balances the books', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) => issueRepo.issueSale(tx, theSale(businessId)));

    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    const posting: Posting = {
      memo: 'reconstructed',
      lines: entries.map((e) => ({
        account: e.account as never,
        debitK: e.debitK,
        creditK: e.creditK,
      })),
    };

    // Read back out of the database, not asserted on the object we passed in.
    // The claim is that what was STORED balances.
    const { balanced } = trialBalance([posting]);
    expect(balanced).toBe(true);
  });

  it('records the payment as RECORDED, never verified', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) => issueRepo.issueSale(tx, theSale(businessId)));

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ verified: number }>(sql`SELECT verified FROM payments`),
    );
    /**
     * The merchant said money arrived. Nobody confirmed it with a provider.
     * Marking this verified would be the anti-fake-alert defence (ADR 0014)
     * defeating itself on day one.
     */
    expect([...rows][0]?.verified).toBe(0);
  });

  it('marks a fully paid sale paid, and a part-paid one partially_paid', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) => issueRepo.issueSale(tx, theSale(businessId)));
    await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        ...theSale(businessId),
        paidK: 15_000_000,
        balanceDueK: 0,
        sourceId: 'draft-2',
      }),
    );

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ status: string }>(sql`SELECT status FROM invoices ORDER BY invoice_number`),
    );
    expect([...rows].map((r) => r.status)).toEqual(['partially_paid', 'paid']);
  });

  it('writes a snapshot with a token and no name', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) => issueRepo.issueSale(tx, theSale(businessId)));

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ snapshot_json: Record<string, unknown> }>(
        sql`SELECT snapshot_json FROM invoices`,
      ),
    );
    const snapshot = [...rows][0]!.snapshot_json;
    // Anyone debugging a document can read this column without reading a
    // merchant's customer list.
    expect(snapshot['customerToken']).toBe('CUSTOMER_7K2');
    expect(JSON.stringify(snapshot)).not.toMatch(/Adaeze|08\d{9}/);
  });
});

describe('numbering', () => {
  it('never issues the same number twice under EIGHT concurrent sales', async () => {
    const businessId = await seedBusiness();

    /**
     * Read-then-write here produces two invoices numbered INV-2026-000041 —
     * a duplicate in the one field required to be unique, and a constraint
     * violation that rolls back a sale the merchant already watched succeed.
     */
    const issued = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        withBusiness(db, businessId, (tx) =>
          issueRepo.issueSale(tx, { ...theSale(businessId), sourceId: `draft-${i}` }),
        ),
      ),
    );

    const numbers = issued.map((r) => r.invoiceNumber);
    expect(new Set(numbers).size).toBe(8);
    expect(numbers.every((n) => /^INV-\d{4}-\d{6}$/.test(n))).toBe(true);
  });

  it('numbers each business independently', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348100000001');
    const bola = await seedBusiness('Bola Electronics', '+2348100000002');

    const first = await withBusiness(db, ada, (tx) => issueRepo.issueSale(tx, theSale(ada)));
    const second = await withBusiness(db, bola, (tx) => issueRepo.issueSale(tx, theSale(bola)));

    // A merchant's invoice numbers are their own sequence, not a slice of a
    // global one — INV-2026-000001 is a first sale, and it should look like one.
    expect(first.invoiceNumber.endsWith('000001')).toBe(true);
    expect(second.invoiceNumber.endsWith('000001')).toBe(true);
  });

  it('records a voided document so the gap it leaves is explained', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) =>
      issueRepo.recordVoidedDocument(tx, businessId, 'INV-2026-000041', 'issued in error'),
    );

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ action: string; reason: string }>(sql`SELECT action, reason FROM audit_events`),
    );
    // An unexplained gap is what an auditor reads as a deleted invoice.
    expect([...rows][0]).toMatchObject({ action: 'voided', reason: 'issued in error' });
  });
});

describe('all of it, or none of it', () => {
  it('writes NOTHING when the ledger would not balance', async () => {
    const businessId = await seedBusiness();

    /**
     * VAT above the total drives the SALES_REVENUE credit negative, which
     * `assertBalanced` refuses — and it refuses AFTER the invoice, the items
     * and the payment have already been inserted. The transaction is what
     * takes them back out.
     *
     * The failure must come from the posting layer, not from `paidK` above
     * `totalK` — `issueSale` clamps the paid figure before posting, so that
     * input never throws and would leave the rollback unexercised.
     */
    await expect(
      withBusiness(db, businessId, (tx) =>
        issueRepo.issueSale(tx, { ...theSale(businessId), vatK: 20_000_000 }),
      ),
    ).rejects.toThrow();

    expect(await countOf(businessId, 'invoices')).toBe(0);
    expect(await countOf(businessId, 'invoice_items')).toBe(0);
    expect(await countOf(businessId, 'payments')).toBe(0);
    expect(await countOf(businessId, 'ledger_entries')).toBe(0);
    expect(await countOf(businessId, 'audit_events')).toBe(0);
  });

  it('leaves NO gap — the counter rolls back with everything else', async () => {
    const businessId = await seedBusiness();

    await withBusiness(db, businessId, (tx) => issueRepo.issueSale(tx, theSale(businessId)));
    await expect(
      withBusiness(db, businessId, (tx) =>
        issueRepo.issueSale(tx, { ...theSale(businessId), vatK: 20_000_000 }),
      ),
    ).rejects.toThrow();
    const third = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, { ...theSale(businessId), sourceId: 'draft-3' }),
    );

    /**
     * A stronger property than the plan assumed, and it falls out of the
     * design rather than being arranged: the counter bump happens INSIDE the
     * same transaction, so a failure un-bumps it. Numbering stays dense, and
     * the "explain the gap" audit event the plan asks for is not needed on
     * this path at all.
     *
     * A design that reserved the number in a separate transaction would burn
     * 000002 here; same-transaction numbering must not.
     */
    expect(third.invoiceNumber.endsWith('000002')).toBe(true);
  });
});

describe('CG3 — two rapid "yes" produce exactly one document', () => {
  async function seedDraft(businessId: string): Promise<string> {
    const message = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.recordInbound(tx, {
        businessId,
        channel: 'meta',
        kind: 'text',
        body: 'CUSTOMER_7K2 bought 3 wigs',
        providerMessageId: `wamid.${Math.abs(businessId.length)}${Date.now()}`,
      }),
    );
    const draft = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.recordDraft(tx, {
        businessId,
        conversationMessageId: message.id,
        intent: 'RecordSale',
        command: { intent: 'RecordSale' },
        model: 'test',
      }),
    );
    return draft.id;
  }

  it('lets exactly ONE of eight simultaneous confirmations claim the draft', async () => {
    const businessId = await seedBusiness();
    const draftId = await seedDraft(businessId);

    /**
     * On WhatsApp a double-tap is not an edge case, it is Tuesday. Two jobs on
     * two connections both read state='pending', both decide to issue, and the
     * merchant's customer receives two invoices for one sale.
     */
    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        withBusiness(db, businessId, (tx) => conversationsRepo.claimDraft(tx, draftId)),
      ),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('issues one document when eight confirmations race', async () => {
    const businessId = await seedBusiness();
    const draftId = await seedDraft(businessId);

    await Promise.all(
      Array.from({ length: 8 }, () =>
        withBusiness(db, businessId, async (tx: TenantDb) => {
          const won = await conversationsRepo.claimDraft(tx, draftId);
          if (!won) return;
          await issueRepo.issueSale(tx, { ...theSale(businessId), sourceId: draftId });
        }),
      ),
    );

    // The whole point, end to end.
    expect(await countOf(businessId, 'invoices')).toBe(1);
  });

  it('does not claim a draft that was already superseded', async () => {
    const businessId = await seedBusiness();
    const draftId = await seedDraft(businessId);

    await withBusiness(db, businessId, (tx) =>
      conversationsRepo.supersedePendingDrafts(tx, businessId),
    );

    // CG5 replaced it. A "yes" arriving late must not resurrect the version
    // the merchant already corrected.
    const claimed = await withBusiness(db, businessId, (tx) =>
      conversationsRepo.claimDraft(tx, draftId),
    );
    expect(claimed).toBe(false);
  });

  it('finds the pending draft, and stops finding it once superseded', async () => {
    const businessId = await seedBusiness();
    await seedDraft(businessId);

    expect(
      await withBusiness(db, businessId, (tx) => conversationsRepo.pendingDraft(tx, businessId)),
    ).not.toBeNull();

    await withBusiness(db, businessId, (tx) =>
      conversationsRepo.supersedePendingDrafts(tx, businessId),
    );
    expect(
      await withBusiness(db, businessId, (tx) => conversationsRepo.pendingDraft(tx, businessId)),
    ).toBeNull();
  });
});

describe('the document hash', () => {
  it('does not change when a field is written in a different order', () => {
    /**
     * `JSON.stringify` emits keys in insertion order, so the same document
     * built by two code paths hashes differently. A hash that changes when
     * nothing changed is worse than no hash — the first time it happens,
     * somebody concludes the record was tampered with.
     */
    const a = { totalK: 15_000_000, documentNumber: 'INV-2026-000001', paidK: 10_000_000 };
    const b = { paidK: 10_000_000, documentNumber: 'INV-2026-000001', totalK: 15_000_000 };
    expect(documentHash(a)).toBe(documentHash(b));
    expect(canonicalise(a)).toBe(canonicalise(b));
  });

  it('DOES change when a figure changes', () => {
    const a = { documentNumber: 'INV-2026-000001', totalK: 15_000_000 };
    const b = { documentNumber: 'INV-2026-000001', totalK: 15_000_001 };
    expect(documentHash(a)).not.toBe(documentHash(b));
  });

  it('sorts nested objects and preserves array order', () => {
    // Array order is meaningful — the items on an invoice are a list, not a set.
    expect(canonicalise({ x: [{ b: 1, a: 2 }, { a: 3 }] })).toBe('{"x":[{"a":2,"b":1},{"a":3}]}');
  });
});

describe('tenancy', () => {
  it('does not show one business another`s invoices or ledger', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348100000001');
    const bola = await seedBusiness('Bola Electronics', '+2348100000002');
    await withBusiness(db, ada, (tx) => issueRepo.issueSale(tx, theSale(ada)));

    expect(await countOf(ada, 'invoices')).toBe(1);
    expect(await countOf(bola, 'invoices')).toBe(0);
    expect(await countOf(bola, 'ledger_entries')).toBe(0);
  });
});

/**
 * Voiding an invoice that should never have gone out.
 *
 * The claim an accounting tool has to make here is narrow and total: the
 * books after a void say the sale happened AND was cancelled, and net to the
 * same place they were before it. Not "the invoice is gone" - that is the one
 * thing a void must never look like.
 */
describe('voiding an invoice', () => {
  /** The same sale, with nothing paid: the only kind that can be voided. */
  const unpaidSale = (businessId: string): issueRepo.IssueSaleInput => ({
    ...theSale(businessId),
    paidK: 0,
    balanceDueK: 15_000_000,
  });

  const netByAccount = async (businessId: string): Promise<Map<string, number>> => {
    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    const net = new Map<string, number>();
    for (const e of entries) {
      net.set(e.account, (net.get(e.account) ?? 0) + Number(e.debitK) - Number(e.creditK));
    }
    return net;
  };

  it('leaves the books exactly where they were, without deleting anything', async () => {
    const businessId = await seedBusiness();
    const sale = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, unpaidSale(businessId)),
    );

    const before = await netByAccount(businessId);
    expect(before.get('ACCOUNTS_RECEIVABLE')).toBe(15_000_000);

    const outcome = await withBusiness(db, businessId, (tx) =>
      issueRepo.voidInvoice(tx, businessId, sale.invoiceNumber, 'wrong customer', 'user:ada'),
    );
    expect(outcome).toMatchObject({ outcome: 'voided', reversedK: 15_000_000 });

    // Every account nets to zero: the reversal cancels the sale exactly.
    for (const [, amount] of await netByAccount(businessId)) expect(amount).toBe(0);

    /* And BOTH postings are still there. A void that removed the original
     * would be indistinguishable from a sale that never happened, which is
     * the story an auditor must never be told by accident. */
    expect(await countOf(businessId, 'ledger_transactions')).toBe(2);
    expect(await countOf(businessId, 'invoices')).toBe(1);
  });

  it('marks the invoice rather than removing it, and clears what is owed', async () => {
    const businessId = await seedBusiness();
    const sale = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, unpaidSale(businessId)),
    );
    await withBusiness(db, businessId, (tx) =>
      issueRepo.voidInvoice(tx, businessId, sale.invoiceNumber, 'duplicate', 'user:ada'),
    );

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ status: string; balance_due_k: string }>(
        sql`SELECT status, balance_due_k FROM invoices WHERE id = ${sale.invoiceId}::uuid`,
      ),
    );
    const invoice = [...rows][0];
    expect(invoice?.status).toBe('voided');
    // Nobody owes anything on a withdrawn invoice, so it leaves the ageing.
    expect(Number(invoice?.balance_due_k)).toBe(0);
  });

  it('writes the REASON, because a dense sequence needs its gap explained', async () => {
    const businessId = await seedBusiness();
    const sale = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, unpaidSale(businessId)),
    );
    await withBusiness(db, businessId, (tx) =>
      issueRepo.voidInvoice(tx, businessId, sale.invoiceNumber, 'wrong customer', 'user:ada'),
    );

    const audit = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ actor: string; reason: string; new_value: { documentNumber: string } }>(
        sql`SELECT actor, reason, new_value FROM audit_events
            WHERE business_id = ${businessId}::uuid AND action = 'voided'`,
      ),
    );
    const row = [...audit][0];
    expect(row?.reason).toBe('wrong customer');
    expect(row?.actor).toBe('user:ada');
    expect(row?.new_value.documentNumber).toBe(sale.invoiceNumber);
  });

  it('REFUSES an invoice money has arrived against', async () => {
    const businessId = await seedBusiness();
    // theSale is ₦150,000 with ₦100,000 already paid at the counter.
    const sale = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, theSale(businessId)),
    );

    const outcome = await withBusiness(db, businessId, (tx) =>
      issueRepo.voidInvoice(tx, businessId, sale.invoiceNumber, 'changed my mind', 'user:ada'),
    );
    /* Reversing the revenue while the cash stays in the account leaves books
     * that describe nothing. The instrument for this is a refund and a credit,
     * and it is a different one. */
    expect(outcome).toEqual({ outcome: 'has_payments', paidK: 10_000_000 });
    expect(await countOf(businessId, 'ledger_transactions')).toBe(1);
  });

  it('voids once, however many times it is asked', async () => {
    const businessId = await seedBusiness();
    const sale = await withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, unpaidSale(businessId)),
    );
    const voidIt = () =>
      withBusiness(db, businessId, (tx) =>
        issueRepo.voidInvoice(tx, businessId, sale.invoiceNumber, 'duplicate', 'user:ada'),
      );

    expect((await voidIt()).outcome).toBe('voided');
    expect((await voidIt()).outcome).toBe('already_void');
    // One reversal, not two: the books cannot cancel one sale twice.
    expect(await countOf(businessId, 'ledger_transactions')).toBe(2);
  });

  it('says so plainly when there is no such invoice', async () => {
    const businessId = await seedBusiness();
    expect(
      await withBusiness(db, businessId, (tx) =>
        issueRepo.voidInvoice(tx, businessId, 'INV-2026-999999', 'typo', 'user:ada'),
      ),
    ).toEqual({ outcome: 'not_found' });
  });

  it('cannot reach another tenant invoice', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348100000301');
    const bola = await seedBusiness('Bola Electronics', '+2348100000302');
    const sale = await withBusiness(db, ada, (tx) => issueRepo.issueSale(tx, unpaidSale(ada)));

    // Bola's pin, Ada's invoice number. Row-level security answers first.
    expect(
      await withBusiness(db, bola, (tx) =>
        issueRepo.voidInvoice(tx, bola, sale.invoiceNumber, 'not mine', 'user:bola'),
      ),
    ).toEqual({ outcome: 'not_found' });
    expect(await countOf(ada, 'ledger_transactions')).toBe(1);
  });
});
