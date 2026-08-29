/**
 * Opening balances, against real PostgreSQL.
 *
 * The claims that matter: the entry balances and lands on the day the
 * merchant named rather than today; a second one is refused by the DATABASE
 * rather than by a check the caller is trusted to make; and another tenant
 * cannot see or set it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { customersRepo, identity, issueRepo, openingRepo, settleRepo, stockRepo } from './index.js';
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

async function seedBusiness(phone = '+2348120000101'): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const record = (businessId: string, asAt = '2026-07-31') =>
  withBusiness(db, businessId, (tx) =>
    openingRepo.recordOpeningBalances(tx, {
      businessId,
      asAt,
      cashK: 20_000_000,
      bankK: 5_000_000,
      stockK: 15_000_000,
      actor: 'user:1',
    }),
  );

describe('what the business was already holding', () => {
  it('writes a balanced entry and credits the lot to the owner', async () => {
    const businessId = await seedBusiness();
    const recorded = await record(businessId);
    expect(recorded.equityK).toBe(40_000_000);

    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    const debits = entries.reduce((n, e) => n + Number(e.debitK), 0);
    const credits = entries.reduce((n, e) => n + Number(e.creditK), 0);
    expect(debits).toBe(credits);
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'OWNERS_EQUITY', creditK: 40_000_000 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'CASH', debitK: 20_000_000 }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'INVENTORY', debitK: 15_000_000 }),
    );
  });

  /**
   * The date is the whole reason this takes one. Balance-sheet accounts are
   * cumulative and would not care, but the cash flow statement reads CASH
   * movement within the period, and an opening till dated today is reported
   * as money that arrived today.
   */
  it('lands on the day the merchant named, not today', async () => {
    const businessId = await seedBusiness();
    await record(businessId, '2026-07-31');

    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ created_at: string; source_type: string }>(sql`
        SELECT created_at, source_type FROM ledger_transactions
        WHERE business_id = ${businessId}::uuid
      `),
    );
    const row = [...rows][0]!;
    expect(row.source_type).toBe('opening');
    /* Lagos noon on the day named, which is 11:00 UTC. Noon rather than
     * midnight so that which month it lands in never turns on an hour. */
    expect(new Date(row.created_at).toISOString()).toBe('2026-07-31T11:00:00.000Z');
  });

  /* Two requests arriving together both read no opening entry and both post.
   * Only the index decides, which is why it exists. */
  it('refuses a second entry, and refuses it from the database', async () => {
    const businessId = await seedBusiness();
    await record(businessId);
    await expect(record(businessId, '2026-08-31')).rejects.toBeInstanceOf(
      openingRepo.OpeningBalancesAlreadySet,
    );

    const settled = await Promise.allSettled([
      seedBusiness('+2348120000102').then(() => null),
      record(businessId, '2026-09-30'),
    ]);
    expect(settled[1]!.status).toBe('rejected');
  });

  it('reads back exactly what was entered', async () => {
    const businessId = await seedBusiness();
    expect(
      await withBusiness(db, businessId, (tx) => openingRepo.openingBalancesFor(tx, businessId)),
    ).toBeNull();

    await record(businessId, '2026-07-31');
    expect(
      await withBusiness(db, businessId, (tx) => openingRepo.openingBalancesFor(tx, businessId)),
    ).toEqual({
      asAt: '2026-07-31',
      cashK: 20_000_000,
      bankK: 5_000_000,
      stockK: 15_000_000,
      receivablesK: 0,
    });
  });

  it('is one business at a time, however many have set one', async () => {
    const ada = await seedBusiness('+2348120000103');
    const bola = await seedBusiness('+2348120000104');
    await record(ada);

    expect(
      await withBusiness(db, bola, (tx) => openingRepo.openingBalancesFor(tx, bola)),
    ).toBeNull();
    /* And Bola may still set their own: the index is per business. */
    await expect(record(bola, '2026-06-30')).resolves.toMatchObject({ equityK: 40_000_000 });
  });

  it('refuses an entry of nothing before it writes anything', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        openingRepo.recordOpeningBalances(tx, {
          businessId,
          asAt: '2026-07-31',
          cashK: 0,
          bankK: 0,
          stockK: 0,
          actor: 'user:1',
        }),
      ),
    ).rejects.toBeInstanceOf(RangeError);

    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    expect(entries).toEqual([]);
  });
});

describe('opening receivables become invoices (PR-083)', () => {
  async function seedCustomer(businessId: string, label: string) {
    return customersRepo.createCustomerWithIdentities(db, businessId, label, []);
  }

  const arTie = (businessId: string) =>
    withBusiness(db, businessId, async (tx) => {
      const rows = await tx.execute<{ ledger_ar: string; invoice_ar: string }>(sql`
        SELECT (SELECT COALESCE(SUM(e.debit_k - e.credit_k), 0)::bigint
                FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
                WHERE e.business_id = ${businessId}::uuid AND a.code = '1100') AS ledger_ar,
               (SELECT COALESCE(SUM(balance_due_k), 0)::bigint
                FROM invoices
                WHERE business_id = ${businessId}::uuid AND status <> 'voided') AS invoice_ar
      `);
      const row = [...rows][0]!;
      return { ledgerArK: Number(row.ledger_ar), invoiceArK: Number(row.invoice_ar) };
    });

  it('mints open invoices whose lines the ledger cites, and the AR tie holds', async () => {
    const businessId = await seedBusiness('+2348120000110');
    const ada = await seedCustomer(businessId, 'CUSTOMER_OP1');
    const bola = await seedCustomer(businessId, 'CUSTOMER_OP2');

    const recorded = await withBusiness(db, businessId, (tx) =>
      openingRepo.recordOpeningBalances(tx, {
        businessId,
        asAt: '2025-11-30',
        cashK: 1_000_000,
        bankK: 0,
        stockK: 0,
        receivables: [
          { customerId: ada.id, amountK: 3_000_000, dueDate: '2025-12-14' },
          { customerId: bola.id, amountK: 2_000_000 },
        ],
        actor: 'user:1',
      }),
    );
    expect(recorded.equityK).toBe(6_000_000);
    expect(recorded.invoices).toHaveLength(2);
    /* Numbered in the year the debt was TRUE: a 2025 debt carries a 2025
     * number, because the number is part of the document's identity. */
    for (const minted of recorded.invoices) {
      expect(minted.invoiceNumber).toMatch(/^INV-2025-/);
    }

    /* The documents are real and OPEN, carrying the posting's lineage. */
    const documents = await withBusiness(db, businessId, (tx) =>
      tx.execute<{
        status: string;
        balance_due_k: string;
        source_type: string;
        ledger_transaction_id: string;
      }>(sql`
        SELECT status, balance_due_k::bigint AS balance_due_k, source_type, ledger_transaction_id
        FROM invoices WHERE business_id = ${businessId}::uuid ORDER BY balance_due_k
      `),
    );
    expect(
      [...documents].map((d) => ({
        status: d.status,
        balanceDueK: Number(d.balance_due_k),
        sourceType: d.source_type,
        ledgerTransactionId: d.ledger_transaction_id,
      })),
    ).toEqual([
      {
        status: 'issued',
        balanceDueK: 2_000_000,
        sourceType: 'opening',
        ledgerTransactionId: recorded.ledgerTransactionId,
      },
      {
        status: 'issued',
        balanceDueK: 3_000_000,
        sourceType: 'opening',
        ledgerTransactionId: recorded.ledgerTransactionId,
      },
    ]);

    /* §12.3 on the rows: one AR line per invoice, each citing its document. */
    const arLines = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ debit_k: string; invoice_id: string | null }>(sql`
        SELECT e.debit_k::bigint AS debit_k, e.invoice_id
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid AND a.code = '1100'
        ORDER BY e.debit_k
      `),
    );
    expect(
      [...arLines].map((l) => ({ debitK: Number(l.debit_k), invoiceId: l.invoice_id })),
    ).toEqual([
      {
        debitK: 2_000_000,
        invoiceId: recorded.invoices.find((m) => m.amountK === 2_000_000)!.invoiceId,
      },
      {
        debitK: 3_000_000,
        invoiceId: recorded.invoices.find((m) => m.amountK === 3_000_000)!.invoiceId,
      },
    ]);

    /* THE TIE: the ledger's AR balance is the sum of open invoice balances
     * — the same equality the golden fixture certifies, holding from the
     * first day of the books. */
    expect(await arTie(businessId)).toEqual({ ledgerArK: 5_000_000, invoiceArK: 5_000_000 });

    /* And the invoice is alive: the same door every invoice is settled
     * through settles an opening one, and the tie holds after. */
    const adaInvoice = recorded.invoices.find((m) => m.amountK === 3_000_000)!;
    await withBusiness(db, businessId, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId,
        invoiceId: adaInvoice.invoiceId,
        amountK: 3_000_000,
        method: 'transfer',
        sourceType: 'dashboard',
        sourceId: 'settle-op-1',
        actor: 'user:1',
      }),
    );
    expect(await arTie(businessId)).toEqual({ ledgerArK: 2_000_000, invoiceArK: 2_000_000 });
  });

  it('refuses a customer of another business, and the whole act rolls back', async () => {
    const businessId = await seedBusiness('+2348120000111');
    const other = await seedBusiness('+2348120000112');
    const stranger = await seedCustomer(other, 'CUSTOMER_OP3');

    await expect(
      withBusiness(db, businessId, (tx) =>
        openingRepo.recordOpeningBalances(tx, {
          businessId,
          asAt: '2026-07-31',
          cashK: 1_000_000,
          bankK: 0,
          stockK: 0,
          receivables: [{ customerId: stranger.id, amountK: 3_000_000 }],
          actor: 'user:1',
        }),
      ),
    ).rejects.toBeInstanceOf(RangeError);

    const counts = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ invoices: string; entries: string }>(sql`
        SELECT (SELECT COUNT(*) FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
               (SELECT COUNT(*) FROM ledger_entries WHERE business_id = ${businessId}::uuid) AS entries
      `),
    );
    expect([...counts][0]).toEqual({ invoices: '0', entries: '0' });
  });

  it('a second opening rolls its minted invoices back with the refusal', async () => {
    const businessId = await seedBusiness('+2348120000113');
    const ada = await seedCustomer(businessId, 'CUSTOMER_OP4');
    await record(businessId);

    await expect(
      withBusiness(db, businessId, (tx) =>
        openingRepo.recordOpeningBalances(tx, {
          businessId,
          asAt: '2026-08-31',
          cashK: 0,
          bankK: 0,
          stockK: 0,
          receivables: [{ customerId: ada.id, amountK: 3_000_000 }],
          actor: 'user:1',
        }),
      ),
    ).rejects.toBeInstanceOf(openingRepo.OpeningBalancesAlreadySet);

    const counted = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string }>(
        sql`SELECT COUNT(*) AS n FROM invoices WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...counted][0]!.n).toBe('0');
  });
});

describe('opening stock lines open both books from one statement (PR-083)', () => {
  it('creates the products, moves the quantities, and posts their exact value', async () => {
    const businessId = await seedBusiness('+2348120000114');
    const recorded = await withBusiness(db, businessId, (tx) =>
      openingRepo.recordOpeningBalances(tx, {
        businessId,
        asAt: '2026-07-31',
        cashK: 0,
        bankK: 0,
        stockK: 0,
        stock: [
          { name: 'ankara', quantity: 10, unitCostK: 150_000 },
          { name: 'lace', quantity: 4, unitCostK: 250_000 },
        ],
        actor: 'user:1',
      }),
    );
    /* 10 × 1,500 + 4 × 2,500 = ₦25,000, derived, never stated twice. */
    expect(recorded.stockValueK).toBe(2_500_000);
    expect(recorded.equityK).toBe(2_500_000);

    const ankara = await withBusiness(db, businessId, (tx) =>
      stockRepo.productByName(tx, businessId, 'ankara'),
    );
    expect(ankara).toMatchObject({ onHand: 10, unitCostK: 150_000 });

    /* The movement remembers what it was: an opening, at its own cost. */
    const movements = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ reason: string; delta: number; unit_cost_k: string }>(sql`
        SELECT reason, delta, unit_cost_k::bigint AS unit_cost_k
        FROM inventory_movements WHERE business_id = ${businessId}::uuid ORDER BY delta
      `),
    );
    expect([...movements].map((m) => ({ ...m, unit_cost_k: Number(m.unit_cost_k) }))).toEqual([
      { reason: 'opening', delta: 4, unit_cost_k: 250_000 },
      { reason: 'opening', delta: 10, unit_cost_k: 150_000 },
    ]);

    /* The financial book carries the SAME figure the physical book holds. */
    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ account: 'INVENTORY', debitK: 2_500_000 }),
    );
  });

  it('refuses a value AND counted lines: two answers to one question', async () => {
    const businessId = await seedBusiness('+2348120000115');
    await expect(
      withBusiness(db, businessId, (tx) =>
        openingRepo.recordOpeningBalances(tx, {
          businessId,
          asAt: '2026-07-31',
          cashK: 0,
          bankK: 0,
          stockK: 1_000_000,
          stock: [{ name: 'ankara', quantity: 1, unitCostK: 100 }],
          actor: 'user:1',
        }),
      ),
    ).rejects.toThrow(/never both/);
  });
});
