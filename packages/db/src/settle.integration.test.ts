/**
 * The booking engine (docs/payments-v1.md §16–25), against real PostgreSQL.
 *
 * These are the §37 money outcomes at the storage layer: exact payment,
 * partial, overpaid, money against a settled invoice, money with no
 * obligation — and the two invariants that make the rest safe to operate:
 * the ledger balances from a database READ-BACK (not from the objects that
 * were about to be written), and one Rekoda reference books exactly once.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { paymentReference } from '@rekoda/core';
import { createDb, withBusiness, type Db, type TenantDb } from './client.js';
import { identity, issueRepo, paymentsHub, reportsRepo, settleRepo } from './index.js';
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

async function seedBusiness(): Promise<string> {
  const user = await identity.upsertUserByPhone(db, '+2348120000001');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** An unpaid ₦150,000 invoice and a live intent covering its balance. */
async function seedObligation(businessId: string, expectedAmountK = 15_000_000) {
  return withBusiness(db, businessId, async (tx) => {
    const sale = await issueRepo.issueSale(tx, {
      businessId,
      customerId: null,
      customerToken: 'CUSTOMER_7K2',
      items: [{ name: 'wig', quantity: 3, unitPriceK: 5_000_000 }],
      subtotalK: 15_000_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 15_000_000,
      paidK: 0,
      balanceDueK: 15_000_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: 'draft-1',
      actor: 'system',
    });
    const intent = await paymentsHub.createIntent(tx, {
      businessId,
      reference: paymentReference(new Date(), (n) => randomBytes(n)),
      expectedAmountK,
      providerType: 'paystack',
      invoiceId: sale.invoiceId,
    });
    return { sale, intent };
  });
}

function book(
  tx: TenantDb,
  businessId: string,
  intent: paymentsHub.IntentRow,
  confirmedAmountK: number,
  overrides: Partial<settleRepo.BookVerifiedPaymentInput> = {},
) {
  return settleRepo.bookVerifiedPayment(tx, {
    businessId,
    intent: {
      id: intent.id,
      reference: intent.reference,
      invoiceId: intent.invoiceId,
      customerId: intent.customerId,
    },
    confirmedAmountK,
    currency: 'NGN',
    providerType: 'paystack',
    providerRef: `pst-${randomBytes(4).toString('hex')}`,
    providerStatus: 'success',
    providerFeeK: 0,
    feePolicy: 'merchant_bearing',
    method: 'transfer',
    actor: 'test',
    eventId: 'event-1',
    ...overrides,
  });
}

async function one<T extends Record<string, unknown>>(
  businessId: string,
  query: ReturnType<typeof sql>,
): Promise<T | undefined> {
  const rows = await withBusiness(db, businessId, (tx) => tx.execute(query));
  return [...rows][0] as T | undefined;
}

describe('booking outcomes (§21–25)', () => {
  it('books an exact payment: verified payment, paid invoice, receipt, balanced ledger, MATCHED', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);

    const booked = await withBusiness(db, businessId, (tx) =>
      book(tx, businessId, intent, 15_000_000, { providerFeeK: 225_000 }),
    );

    expect(booked.reconciliation).toBe('matched');
    expect(booked.allocatedK).toBe(15_000_000);
    expect(booked.receiptNumber).toMatch(/^RCT-/);
    expect(booked.invoiceStatus).toBe('paid');

    const payment = await one<{ verified: number; status: string; settlement_amount_k: number }>(
      businessId,
      sql`SELECT verified, status, settlement_amount_k::bigint AS settlement_amount_k FROM payments`,
    );
    // VERIFIED — the provider confirmed it server-side (ADR 0014).
    expect(payment?.verified).toBe(1);
    expect(payment?.status).toBe('confirmed');
    // ₦150,000 gross − ₦2,250 fee: the fee came out of settlement…
    expect(Number(payment?.settlement_amount_k)).toBe(14_775_000);

    // …and NEVER out of revenue. Read back from the database, not the input.
    const revenue = await one<{ credit: number }>(
      businessId,
      sql`SELECT coalesce(sum(credit_k), 0)::bigint AS credit FROM ledger_entries WHERE account = 'SALES_REVENUE'`,
    );
    expect(Number(revenue?.credit)).toBe(15_000_000);

    const balance = await one<{ d: number; c: number }>(
      businessId,
      sql`SELECT coalesce(sum(debit_k), 0)::bigint AS d, coalesce(sum(credit_k), 0)::bigint AS c FROM ledger_entries`,
    );
    expect(Number(balance?.d)).toBe(Number(balance?.c));

    const recon = await one<{ status: string }>(
      businessId,
      sql`SELECT status FROM reconciliations`,
    );
    expect(recon?.status).toBe('MATCHED');
  });

  it('NEVER lets ₦90,000 mark a ₦150,000 invoice paid — partial stays partial', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);

    const booked = await withBusiness(db, businessId, (tx) =>
      book(tx, businessId, intent, 9_000_000),
    );

    expect(booked.reconciliation).toBe('partial_match');
    expect(booked.invoiceStatus).toBe('partially_paid');

    const invoice = await one<{ status: string; balance_due_k: number }>(
      businessId,
      sql`SELECT status, balance_due_k::bigint AS balance_due_k FROM invoices`,
    );
    expect(invoice?.status).toBe('partially_paid');
    // The balance stays owed — the books do not forgive ₦60,000.
    expect(Number(invoice?.balance_due_k)).toBe(6_000_000);
  });

  it('books an overpayment conservatively: invoice settles, the excess is an EXCEPTION', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);

    const booked = await withBusiness(db, businessId, (tx) =>
      book(tx, businessId, intent, 20_000_000),
    );

    expect(booked.reconciliation).toBe('overpaid');
    expect(booked.allocatedK).toBe(15_000_000);
    expect(booked.invoiceStatus).toBe('paid');

    // The excess ₦50,000 appears ONLY here, negative, for a human to resolve.
    const recon = await one<{ status: string; outstanding_k: number }>(
      businessId,
      sql`SELECT status, outstanding_k::bigint AS outstanding_k FROM reconciliations`,
    );
    expect(recon?.status).toBe('EXCEPTION');
    expect(Number(recon?.outstanding_k)).toBe(-5_000_000);

    // And the ledger holds the allocated portion, not the gross.
    const bank = await one<{ d: number }>(
      businessId,
      sql`SELECT coalesce(sum(debit_k), 0)::bigint AS d FROM ledger_entries WHERE account = 'BANK_PAYSTACK'`,
    );
    expect(Number(bank?.d)).toBe(15_000_000);
  });

  it('flags money against an already-settled invoice as duplicate — nothing downstream fires', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);

    await withBusiness(db, businessId, (tx) => book(tx, businessId, intent, 15_000_000));
    // The first intent settles (as the processing job would record it) …
    await withBusiness(db, businessId, (tx) =>
      paymentsHub.advanceIntent(tx, intent.id, 'succeeded'),
    );
    // … and a second, distinct intent against the SAME invoice confirms later.
    const second = await withBusiness(db, businessId, async (tx) =>
      paymentsHub.createIntent(tx, {
        businessId,
        reference: paymentReference(new Date(), (n) => randomBytes(n)),
        expectedAmountK: 15_000_000,
        providerType: 'paystack',
        invoiceId: intent.invoiceId,
      }),
    );
    const booked = await withBusiness(db, businessId, (tx) =>
      book(tx, businessId, second, 15_000_000),
    );

    expect(booked.reconciliation).toBe('duplicate');
    expect(booked.receiptNumber).toBeNull();

    const receipts = await one<{ n: number }>(
      businessId,
      sql`SELECT count(*)::int AS n FROM receipts`,
    );
    expect(receipts?.n).toBe(1); // still exactly one

    const paidTwice = await one<{ paid_k: number }>(
      businessId,
      sql`SELECT paid_k::bigint AS paid_k FROM invoices`,
    );
    expect(Number(paidTwice?.paid_k)).toBe(15_000_000); // not 30,000,000
  });

  it('refuses to book one Rekoda reference twice — the backstop under the backstops', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);

    await withBusiness(db, businessId, (tx) => book(tx, businessId, intent, 15_000_000));
    await expect(
      withBusiness(db, businessId, (tx) => book(tx, businessId, intent, 15_000_000)),
    ).rejects.toBeInstanceOf(settleRepo.AlreadyBooked);
  });

  it('records money with no obligation as requires_review, allocating nothing', async () => {
    const businessId = await seedBusiness();
    const intent = await withBusiness(db, businessId, (tx) =>
      paymentsHub.createIntent(tx, {
        businessId,
        reference: paymentReference(new Date(), (n) => randomBytes(n)),
        expectedAmountK: 5_000_000,
        providerType: 'paystack',
      }),
    );

    const booked = await withBusiness(db, businessId, (tx) =>
      book(tx, businessId, intent, 5_000_000),
    );

    expect(booked.reconciliation).toBe('requires_review');
    expect(booked.receiptNumber).toBeNull();
    expect(booked.ledgerTransactionId).toBeNull();
    // The payment row exists — the money is real — but the books wait.
    const n = await one<{ n: number }>(businessId, sql`SELECT count(*)::int AS n FROM payments`);
    expect(n?.n).toBe(1);
  });
});

describe('the exception queue (§35): resolving', () => {
  /** Book an overpayment, returning the id of the EXCEPTION row it left behind. */
  async function seedException(businessId: string): Promise<string> {
    const { intent } = await seedObligation(businessId);
    await withBusiness(db, businessId, (tx) => book(tx, businessId, intent, 20_000_000));
    const recon = await one<{ id: string }>(
      businessId,
      sql`SELECT id FROM reconciliations WHERE status = 'EXCEPTION'`,
    );
    if (!recon) throw new Error('seed did not produce an exception');
    return recon.id;
  }

  it('resolves exactly once: first call wins, the second finds nothing left to resolve', async () => {
    const businessId = await seedBusiness();
    const exceptionId = await seedException(businessId);

    const first = await withBusiness(db, businessId, (tx) =>
      settleRepo.resolveException(tx, businessId, exceptionId, 'user:owner-1'),
    );
    expect(first).toBe(true);

    const row = await one<{ resolved_by: string | null; resolved_at: Date | null }>(
      businessId,
      sql`SELECT resolved_by, resolved_at FROM reconciliations WHERE id = ${exceptionId}::uuid`,
    );
    expect(row?.resolved_by).toBe('user:owner-1');
    expect(row?.resolved_at).not.toBeNull();

    // A double-tap (or a second reviewer) changes nothing and says so.
    const second = await withBusiness(db, businessId, (tx) =>
      settleRepo.resolveException(tx, businessId, exceptionId, 'user:owner-2'),
    );
    expect(second).toBe(false);
    const after = await one<{ resolved_by: string | null }>(
      businessId,
      sql`SELECT resolved_by FROM reconciliations WHERE id = ${exceptionId}::uuid`,
    );
    expect(after?.resolved_by).toBe('user:owner-1');
  });

  it('NEVER resolves across tenants: another business holding the id changes nothing', async () => {
    const businessId = await seedBusiness();
    const exceptionId = await seedException(businessId);

    const otherUser = await identity.upsertUserByPhone(db, '+2348120000002');
    const other = await identity.createBusinessWithOwner(db, {
      name: 'Bode Spares',
      businessType: null,
      ownerUserId: otherUser.id,
    });

    const resolved = await withBusiness(db, other.id, (tx) =>
      settleRepo.resolveException(tx, other.id, exceptionId, 'user:intruder'),
    );
    expect(resolved).toBe(false);

    const row = await one<{ resolved_at: Date | null }>(
      businessId,
      sql`SELECT resolved_at FROM reconciliations WHERE id = ${exceptionId}::uuid`,
    );
    expect(row?.resolved_at).toBeNull();
  });

  it('refuses a MATCHED reconciliation — only exceptions are reviewable', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    await withBusiness(db, businessId, (tx) => book(tx, businessId, intent, 15_000_000));
    const matched = await one<{ id: string }>(
      businessId,
      sql`SELECT id FROM reconciliations WHERE status = 'MATCHED'`,
    );

    const resolved = await withBusiness(db, businessId, (tx) =>
      settleRepo.resolveException(tx, businessId, matched!.id, 'user:owner-1'),
    );
    expect(resolved).toBe(false);
  });

  it('drops out of the overview count and gains a resolvedAt in the readback once reviewed', async () => {
    const businessId = await seedBusiness();
    const exceptionId = await seedException(businessId);

    const before = await withBusiness(db, businessId, (tx) =>
      reportsRepo.overviewFor(tx, businessId),
    );
    expect(before.exceptionsOpen).toBe(1);

    await withBusiness(db, businessId, (tx) =>
      settleRepo.resolveException(tx, businessId, exceptionId, 'user:owner-1'),
    );

    const after = await withBusiness(db, businessId, (tx) =>
      reportsRepo.overviewFor(tx, businessId),
    );
    expect(after.exceptionsOpen).toBe(0);

    // The readback keeps the row — reviewed, not erased.
    const readback = await withBusiness(db, businessId, (tx) => settleRepo.reconciliationsFor(tx));
    const row = readback.find((r) => r.id === exceptionId);
    expect(row?.status).toBe('EXCEPTION');
    expect(row?.resolvedAt).not.toBeNull();
  });
});

describe('settlement stamping (§26–28)', () => {
  it('moves pending → settled with the settlement date, exactly once', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    await withBusiness(db, businessId, (tx) => book(tx, businessId, intent, 15_000_000));

    const first = await withBusiness(db, businessId, (tx) =>
      settleRepo.markSettlements(
        tx,
        businessId,
        [intent.reference],
        'settled',
        '2026-08-19T04:00:00.000Z',
      ),
    );
    expect(first).toBe(1);

    const row = await one<{ settlement_status: string; settled_at: Date | null }>(
      businessId,
      sql`SELECT settlement_status, settled_at FROM payments`,
    );
    expect(row?.settlement_status).toBe('settled');
    expect(row?.settled_at).not.toBeNull();

    // Re-polling the same batch is a no-op, not a rewrite.
    const second = await withBusiness(db, businessId, (tx) =>
      settleRepo.markSettlements(
        tx,
        businessId,
        [intent.reference],
        'settled',
        '2026-08-20T04:00:00.000Z',
      ),
    );
    expect(second).toBe(0);
  });

  it('a failed batch marks failed and NEVER stamps a settled date', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    await withBusiness(db, businessId, (tx) => book(tx, businessId, intent, 15_000_000));

    const stamped = await withBusiness(db, businessId, (tx) =>
      settleRepo.markSettlements(tx, businessId, [intent.reference], 'failed', null),
    );
    expect(stamped).toBe(1);

    const row = await one<{ settlement_status: string; settled_at: Date | null }>(
      businessId,
      sql`SELECT settlement_status, settled_at FROM payments`,
    );
    expect(row?.settlement_status).toBe('failed');
    expect(row?.settled_at).toBeNull();
  });

  it('another tenant stamping the same reference changes nothing', async () => {
    const businessId = await seedBusiness();
    const { intent } = await seedObligation(businessId);
    await withBusiness(db, businessId, (tx) => book(tx, businessId, intent, 15_000_000));

    const otherUser = await identity.upsertUserByPhone(db, '+2348120000003');
    const other = await identity.createBusinessWithOwner(db, {
      name: 'Bode Spares',
      businessType: null,
      ownerUserId: otherUser.id,
    });
    const stamped = await withBusiness(db, other.id, (tx) =>
      settleRepo.markSettlements(tx, other.id, [intent.reference], 'settled', null),
    );
    expect(stamped).toBe(0);

    const row = await one<{ settlement_status: string }>(
      businessId,
      sql`SELECT settlement_status FROM payments`,
    );
    expect(row?.settlement_status).toBe('pending');
  });
});

/**
 * A payment the MERCHANT reported: cash at the counter, a transfer they saw
 * land (ADR 0014). Real money and a real receipt, distinguishable forever
 * from one a provider confirmed.
 */
describe('recording a merchant-reported payment', () => {
  /** Just the invoice. No intent: nobody asked a provider for this money. */
  async function seedUnpaidInvoice(businessId: string) {
    return withBusiness(db, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId: null,
        customerToken: 'CUSTOMER_7K2',
        items: [{ name: 'wig', quantity: 3, unitPriceK: 5_000_000 }],
        subtotalK: 15_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 15_000_000,
        paidK: 0,
        balanceDueK: 15_000_000,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'draft-1',
        actor: 'system',
      }),
    );
  }

  const record = (businessId: string, invoiceId: string, amountK: number) =>
    withBusiness(db, businessId, (tx) =>
      settleRepo.recordMerchantPayment(tx, {
        businessId,
        invoiceId,
        amountK,
        method: 'cash',
        sourceType: 'chat',
        sourceId: 'draft-pay',
        actor: 'system',
      }),
    );

  it('allocates a part payment and leaves the balance owing', async () => {
    const businessId = await seedBusiness();
    const sale = await seedUnpaidInvoice(businessId);

    const recorded = await record(businessId, sale.invoiceId, 6_000_000);

    expect(recorded.amountK).toBe(6_000_000);
    expect(recorded.balanceDueK).toBe(9_000_000);
    expect(recorded.invoiceStatus).toBe('partially_paid');
    expect(recorded.receiptNumber).toMatch(/^RCT-/);
  });

  it('settles the invoice when the payment covers the balance', async () => {
    const businessId = await seedBusiness();
    const sale = await seedUnpaidInvoice(businessId);

    const recorded = await record(businessId, sale.invoiceId, 15_000_000);

    expect(recorded.balanceDueK).toBe(0);
    expect(recorded.invoiceStatus).toBe('paid');
  });

  it('keeps the ledger balanced and takes the receivable down by the payment', async () => {
    const businessId = await seedBusiness();
    const sale = await seedUnpaidInvoice(businessId);

    await record(businessId, sale.invoiceId, 6_000_000);

    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    const debits = entries.reduce((n, e) => n + e.debitK, 0);
    const credits = entries.reduce((n, e) => n + e.creditK, 0);
    expect(debits).toBe(credits);

    const arCredit = entries
      .filter((e) => e.account === 'ACCOUNTS_RECEIVABLE')
      .reduce((n, e) => n + e.creditK, 0);
    expect(arCredit).toBe(6_000_000);
    const cashDebit = entries.filter((e) => e.account === 'CASH').reduce((n, e) => n + e.debitK, 0);
    expect(cashDebit).toBe(6_000_000);
  });

  it('books RECORDED, never verified: no provider vouched for this', async () => {
    const businessId = await seedBusiness();
    const sale = await seedUnpaidInvoice(businessId);

    await record(businessId, sale.invoiceId, 6_000_000);

    const payments = await withBusiness(db, businessId, (tx) => settleRepo.paymentsFor(tx));
    expect(payments).toHaveLength(1);
    expect(payments[0]?.verified).toBe(0);
    expect(payments[0]?.amountK).toBe(6_000_000);
  });

  it('two part payments accumulate rather than overwrite', async () => {
    const businessId = await seedBusiness();
    const sale = await seedUnpaidInvoice(businessId);

    await record(businessId, sale.invoiceId, 6_000_000);
    const second = await record(businessId, sale.invoiceId, 4_000_000);

    expect(second.balanceDueK).toBe(5_000_000);
    const entries = await withBusiness(db, businessId, (tx) =>
      issueRepo.ledgerEntriesFor(tx, businessId),
    );
    expect(entries.reduce((n, e) => n + e.debitK, 0)).toBe(
      entries.reduce((n, e) => n + e.creditK, 0),
    );
  });

  it('refuses an invoice that is already settled rather than crediting nothing', async () => {
    const businessId = await seedBusiness();
    const sale = await seedUnpaidInvoice(businessId);
    await record(businessId, sale.invoiceId, 15_000_000);

    await expect(record(businessId, sale.invoiceId, 2_000_000)).rejects.toBeInstanceOf(
      settleRepo.AlreadySettled,
    );
  });

  /**
   * The balance moved between the merchant's preview and this write. Nothing
   * is posted: applying what fits and dropping the rest would leave real
   * money with no story, and only the merchant knows where the excess goes.
   */
  it('refuses with the exact excess when the invoice owes less than reported', async () => {
    const businessId = await seedBusiness();
    const sale = await seedUnpaidInvoice(businessId);
    await record(businessId, sale.invoiceId, 10_000_000);

    await expect(record(businessId, sale.invoiceId, 8_000_000)).rejects.toMatchObject({
      invoiceNumber: sale.invoiceNumber,
      balanceDueK: 5_000_000,
      excessK: 3_000_000,
    });

    // And nothing moved: the refusal is a refusal, not a partial write.
    const payments = await withBusiness(db, businessId, (tx) => settleRepo.paymentsFor(tx));
    expect(payments).toHaveLength(1);
  });
});
