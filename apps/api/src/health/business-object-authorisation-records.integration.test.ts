/**
 * Object-level authorisation (IDOR) over the money-and-records endpoint families: the public
 * merchant API, party statements, payment lists and exceptions, invoice void and credit
 * (harness: `ops-idor-harness.ts`). Two businesses throughout; every refusal is checked against a
 * snapshot of the books and queues it could have touched.
 */
import { describe, expect, it } from 'vitest';
import {
  entitlementsRepo,
  issueRepo,
  partyStatementsRepo,
  settleRepo,
  sql,
  usageRepo,
  withBusiness,
} from '@rekoda/db';
import { usagePeriod } from '@rekoda/core';
import { grantCapacityAddOn, requireUrls, settlementDb } from '@rekoda/db/testing';
import {
  REASON,
  appDb,
  business,
  call,
  deadJobWithMerchantException,
  ownerDb,
  urls,
  useHarness,
} from './ops-idor-harness.js';

// not issued: an invoice number nobody holds, used only as a not-found probe
const NEVER_ISSUED_INVOICE = 'INV-2099-999999';

useHarness();

const unknownUuid = '00000000-0000-4000-8000-000000000bad';
const q = async (text: ReturnType<typeof sql>) => [...(await ownerDb.execute(text))];

/** What a request in this file could change, in one comparable value. */
async function books() {
  return {
    invoices: await q(
      sql`SELECT id, business_id, status, paid_k, balance_due_k FROM invoices ORDER BY id`,
    ),
    payments: await q(sql`SELECT id, business_id FROM payments ORDER BY id`),
    receipts: await q(sql`SELECT id FROM receipts ORDER BY id`),
    ledger: await q(sql`SELECT id FROM ledger_entries ORDER BY id`),
    credits: await q(sql`SELECT id FROM credit_notes ORDER BY id`),
    outbox: await q(sql`SELECT id FROM outbox_events ORDER BY id`),
    drafts: await q(sql`SELECT id FROM command_drafts ORDER BY id`),
    audit: await q(sql`SELECT business_id, action FROM audit_events ORDER BY created_at, id`),
  };
}

async function invoiceFor(businessId: string): Promise<string> {
  const sale = await withBusiness(appDb, businessId, (tx) =>
    issueRepo.issueSale(tx, {
      businessId,
      customerId: null,
      customerToken: 'CUSTOMER_7K2',
      items: [{ name: 'wig', quantity: 1, unitPriceK: 5_000_000 }],
      subtotalK: 5_000_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 5_000_000,
      paidK: 0,
      balanceDueK: 5_000_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: `idor-${Math.random()}`,
      actor: 'system',
    }),
  );
  return sale.invoiceNumber;
}

async function customerFor(businessId: string): Promise<string> {
  const rows = await q(
    sql`INSERT INTO customers (business_id, token) VALUES (${businessId}::uuid, ${'CUSTOMER_' + Math.random().toString(36).slice(2, 8)})
        RETURNING id`,
  );
  return (rows[0] as { id: string }).id;
}

/** A business with a live API key (mode live), the API entitlement and request capacity. */
async function apiShop() {
  const b = await business();
  await withBusiness(appDb, b.id, (tx) =>
    entitlementsRepo.grant(tx, {
      businessId: b.id,
      entitlementKey: 'REKODA_API',
      source: 'MANUAL_GRANT',
      grantedBy: 'operator:idor-suite',
    }),
  );
  await withBusiness(settlementDb(), b.id, (tx) =>
    usageRepo.creditBonus(tx, b.id, usagePeriod(new Date()), 'API_REQUEST_UNITS', 1_000),
  );
  await grantCapacityAddOn(urls, b.id, 'API_APPLICATIONS', 5);
  const app = (
    await call('POST', '/v1/api-keys/applications', b.session, { name: 'idor' })
  ).json() as {
    id: string;
  };
  const minted = (
    await call('POST', `/v1/api-keys/applications/${app.id}/keys`, b.session, { mode: 'live' })
  ).json() as { token: string };
  return { ...b, key: { authorization: `Bearer ${minted.token}` } };
}

describe('public merchant API: ids in a body or path are resolved inside the key’s business', () => {
  it('a sale naming another business’s customer is refused like an unknown one, and writes nothing', async () => {
    const a = await apiShop();
    const b = await apiShop();
    const theirCustomer = await customerFor(b.id);
    const sale = (customerId: string) =>
      call('POST', '/api/v1/sales', a.key, {
        items: [{ name: 'wig', quantity: 1, unitPriceK: 100_000 }],
        customerId,
      });
    const before = await books();

    const foreign = await sale(theirCustomer);
    const missing = await sale(unknownUuid);
    expect([foreign.statusCode, missing.statusCode]).toEqual([400, 400]);
    expect(foreign.body).toBe(missing.body);
    expect(await books()).toEqual(before);

    // Control: the same sale with the business's own customer is accepted.
    const own = await sale(await customerFor(a.id));
    expect(own.statusCode).toBe(200);
  });

  it('a payment against another business’s invoice number is refused like an unknown number', async () => {
    const a = await apiShop();
    const b = await apiShop();
    const theirs = await invoiceFor(b.id);
    const pay = (invoiceNumber: string) =>
      call('POST', '/api/v1/payments', a.key, { invoiceNumber, amountK: 100_000 });
    const before = await books();

    const foreign = await pay(theirs);
    const missing = await pay(NEVER_ISSUED_INVOICE);
    expect(foreign.json()).toEqual({ outcome: 'not_found' });
    expect(missing.json()).toEqual({ outcome: 'not_found' });
    expect(foreign.statusCode).toBe(missing.statusCode);
    expect(await books()).toEqual(before);
    // and the invoice is still readable by its own business only
    expect((await call('GET', `/api/v1/invoices/${theirs}`, a.key)).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/invoices/${theirs}`, b.key)).statusCode).toBe(200);
  });
});

describe('party statements: a foreign id reads as nothing, and the SQL itself is business-scoped', () => {
  /** A customer of `businessId` with one real invoice, and a supplier with one real bill. */
  async function partiesOf(businessId: string) {
    const customerId = await customerFor(businessId);
    const sale = await withBusiness(appDb, businessId, (tx) =>
      issueRepo.issueSale(tx, {
        businessId,
        customerId,
        customerToken: 'CUSTOMER_7K2',
        items: [{ name: 'wig', quantity: 1, unitPriceK: 5_000_000 }],
        subtotalK: 5_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 5_000_000,
        paidK: 0,
        balanceDueK: 5_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: `idor-${Math.random()}`,
        actor: 'system',
      }),
    );
    const [expense] = await q(sql`
      INSERT INTO expenses (business_id, description, amount_k, source_type)
      VALUES (${businessId}::uuid, 'fabric', 250000, 'chat') RETURNING id`);
    const [supplier] = await q(sql`
      INSERT INTO suppliers (business_id, name_cipher, match_key)
      VALUES (${businessId}::uuid, 'cipher', ${'mk-' + Math.random()}) RETURNING id`);
    const billNumber = `BILL-IDOR-${Math.floor(Math.random() * 1e6)}`;
    await q(sql`
      INSERT INTO bills (business_id, expense_id, supplier_id, bill_number, total_k, billed_on, source_type)
      VALUES (${businessId}::uuid, ${(expense as { id: string }).id}::uuid,
              ${(supplier as { id: string }).id}::uuid, ${billNumber}, 250000, current_date, 'chat')`);
    return {
      customerId,
      supplierId: (supplier as { id: string }).id,
      invoiceNumber: sale.invoiceNumber,
      billNumber,
    };
  }

  it.each([
    ['customers', 'customerId', 'invoiceNumber'],
    ['suppliers', 'supplierId', 'billNumber'],
  ] as const)('%s: JSON and CSV', async (kind, idKey, referenceKey) => {
    const a = await business();
    const b = await business();
    const theirs = await partiesOf(b.id);
    for (const suffix of ['statement', 'statement.csv']) {
      const url = (id: string) => `/v1/reports/${kind}/${id}/${suffix}`;
      const foreign = await call('GET', url(theirs[idKey]), a.session);
      const missing = await call('GET', url(unknownUuid), a.session);
      const malformed = await call('GET', url('not-a-uuid'), a.session);
      // The real foreign id is answered exactly as an id nobody holds, and shows nothing of B's.
      expect(foreign.statusCode, url('x')).toBe(missing.statusCode);
      expect(foreign.body.replace(/\d{4}-\d{2}-\d{2}/g, 'D'), url('x')).toBe(
        missing.body.replace(/\d{4}-\d{2}-\d{2}/g, 'D'),
      );
      expect(foreign.body, url('x')).not.toContain(theirs[referenceKey]);
      // Foreign, unknown and malformed are all the same 404 with the same body: the answer never
      // says which of the three it was, and none of them spends an export unit.
      expect(foreign.statusCode, url('x')).toBe(404);
      expect(malformed.statusCode, url('x')).toBe(404);
      expect(malformed.body, url('x')).toBe(missing.body);
      expect(foreign.body, url('x')).toBe(missing.body);
      // Control: the owner of the data does see its own entry.
      expect((await call('GET', url(theirs[idKey]), b.session)).body, url('x')).toContain(
        theirs[referenceKey],
      );
    }
  });

  it('a customer of the business with no activity yet still gets an (empty) statement, not a 404', async () => {
    const a = await business();
    const idle = await customerFor(a.id);
    for (const suffix of ['statement', 'statement.csv']) {
      expect(
        (await call('GET', `/v1/reports/customers/${idle}/${suffix}`, a.session)).statusCode,
        suffix,
      ).toBe(200);
    }
  });

  it('the statement queries are scoped to the business in SQL, on a connection that bypasses RLS', async () => {
    const a = await business();
    const b = await business();
    const theirs = await partiesOf(b.id);
    const run = (pinned: string, asBusiness: string) =>
      ownerDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.business_id', ${pinned}, true)`);
        // Control: this connection sees B's invoice whichever business it is pinned to.
        const [all] = await tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM invoices WHERE invoice_number = ${theirs.invoiceNumber}`,
        );
        expect(all?.n).toBeGreaterThanOrEqual(1);
        return {
          customer: await partyStatementsRepo.customerStatementFor(
            tx as never,
            asBusiness,
            theirs.customerId,
          ),
          supplier: await partyStatementsRepo.supplierStatementFor(
            tx as never,
            asBusiness,
            theirs.supplierId,
          ),
        };
      });
    const asA = await run(a.id, a.id);
    expect(JSON.stringify(asA)).not.toContain(theirs.invoiceNumber);
    expect(JSON.stringify(asA)).not.toContain(theirs.billNumber);
    // Control: the same readers return the entries for the business that owns them.
    const asB = await run(b.id, b.id);
    expect(JSON.stringify(asB.customer)).toContain(theirs.invoiceNumber);
    expect(JSON.stringify(asB.supplier)).toContain(theirs.billNumber);
  });
});

describe('payments lists: scoped to the pinned business in SQL as well as by RLS', () => {
  it('A never sees B’s payment exceptions, and cannot resolve one', async () => {
    const a = await business();
    const b = await business();
    const exceptionId = await deadJobWithMerchantException(b.id);
    const before = await books();
    const listed = (await call('GET', '/v1/payments/exceptions', a.session)).json() as {
      exceptions: Array<{ id: string }>;
    };
    expect(listed.exceptions.map((e) => e.id)).not.toContain(exceptionId);
    expect(
      (await call('POST', `/v1/payments/exceptions/${exceptionId}/resolve`, a.session)).statusCode,
    ).toBe(404);
    expect(
      (await call('GET', '/v1/payments/exceptions', b.session)).body,
      'B still sees its own',
    ).toContain(exceptionId);
    expect(await books()).toEqual(before);
  });

  it('the readers return only the pinned business even on a connection that bypasses RLS', async () => {
    const a = await business();
    const b = await business();
    const exceptionB = await deadJobWithMerchantException(b.id);
    await deadJobWithMerchantException(a.id);
    // One identifiable payment per business, so the payment list is proved as well as the exceptions.
    await q(sql`
      INSERT INTO payments (business_id, amount_k, source_type)
      VALUES (${a.id}::uuid, 1110000, 'chat'), (${b.id}::uuid, 2220000, 'chat')`);
    // The owner connection bypasses RLS: only the SQL predicate stands between A's pin and B's rows.
    const seen = await ownerDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.business_id', ${a.id}, true)`);
      // Control: this connection really does see across businesses while pinned to A, so the
      // readers below are limited by their own SQL and not by row-level security.
      const [all] = await tx.execute<{ n: number }>(
        sql`SELECT count(DISTINCT business_id)::int AS n FROM reconciliations`,
      );
      expect(all?.n).toBeGreaterThanOrEqual(2);
      const [paid] = await tx.execute<{ n: number }>(
        sql`SELECT count(DISTINCT business_id)::int AS n FROM payments`,
      );
      expect(paid?.n).toBe(2);
      const reconciliations = await settleRepo.reconciliationsFor(tx as never, {
        status: 'EXCEPTION',
        limit: 50,
      });
      const payments = await settleRepo.paymentsFor(tx as never);
      return { reconciliations, payments };
    });
    expect(seen.reconciliations.map((r) => r.id)).not.toContain(exceptionB);
    expect(seen.reconciliations.length).toBeGreaterThan(0);
    // The payment list: exactly A's one payment, B's excluded, and the count agrees with the rows.
    expect(seen.payments.rows.map((p) => Number(p.amountK))).toEqual([1110000]);
    expect(seen.payments.count).toBe(1);
    // With no business pinned the same reader returns nothing at all, rows and count: the SQL
    // predicate fails closed even on a connection that bypasses RLS.
    const unpinnedPayments = await ownerDb.transaction(async (tx) =>
      settleRepo.paymentsFor(tx as never),
    );
    expect(unpinnedPayments.rows).toEqual([]);
    expect(unpinnedPayments.count).toBe(0);
    const unpinned = await ownerDb.transaction(async (tx) =>
      settleRepo.reconciliationsFor(tx as never, { status: 'EXCEPTION', limit: 50 }),
    );
    expect(unpinned).toEqual([]);
  });
});

describe('invoice void and credit: the invoice number is resolved inside the caller’s business', () => {
  it('B’s owner cannot void or credit A’s invoice; every step answers as for an unknown number', async () => {
    const a = await business();
    const b = await business();
    const theirs = await invoiceFor(a.id);
    const before = await books();
    const unknown = NEVER_ISSUED_INVOICE;

    // Void is a two-step: the first call only opens a confirmation for the caller's OWN business.
    const voidIt = async (number: string) => {
      const opened = await call('POST', '/v1/reports/invoices/void', b.session, {
        invoiceNumber: number,
        reason: REASON,
      });
      const { confirmationId } = opened.json() as { confirmationId: string };
      return call('POST', '/v1/reports/invoices/void', b.session, {
        invoiceNumber: number,
        reason: REASON,
        confirmationId,
      });
    };
    const credit = (number: string) =>
      call('POST', '/v1/reports/invoices/credit', b.session, {
        invoiceNumber: number,
        amountK: 100_000,
        reason: REASON,
        clientRef: crypto.randomUUID(),
      });

    for (const act of [voidIt, credit]) {
      const foreign = await act(theirs);
      const missing = await act(unknown);
      expect(foreign.statusCode).toBe(200);
      expect(foreign.json()).toEqual({ outcome: 'not_found' });
      expect(missing.json()).toEqual({ outcome: 'not_found' });
    }
    // A's invoice, ledger, credits and payments are exactly as they were; only B's own
    // confirmation (a refused-operation record) may have been added, and never in A's business.
    const after = await books();
    expect({ ...after, audit: null }).toEqual({ ...before, audit: null });
    const added = (after.audit as Array<{ business_id: string }>).slice(
      (before.audit as unknown[]).length,
    );
    expect(added.every((row) => row.business_id === b.id)).toBe(true);
  });
});

describe('customer reminders: batch and invoice ids are resolved inside the caller’s business', () => {
  async function batchOf(businessId: string) {
    const invoiceNumber = await invoiceFor(businessId);
    const [invoice] = await q(
      sql`SELECT id FROM invoices WHERE business_id = ${businessId}::uuid AND invoice_number = ${invoiceNumber}`,
    );
    const [member] = await q(
      sql`SELECT user_id FROM memberships WHERE business_id = ${businessId}::uuid`,
    );
    const [batch] = await q(sql`
      INSERT INTO reminder_batches (business_id, channels, scheduled_for, idempotency_key, item_count, created_by)
      VALUES (${businessId}::uuid, 'auto', now() + interval '1 day', ${'idor-' + businessId.slice(0, 12)}, 1,
              ${(member as { user_id: string }).user_id}::uuid)
      RETURNING id`);
    const batchId = (batch as { id: string }).id;
    await q(sql`
      INSERT INTO reminder_batch_items (business_id, batch_id, invoice_id, position)
      VALUES (${businessId}::uuid, ${batchId}::uuid, ${(invoice as { id: string }).id}::uuid, 0)`);
    return { batchId, invoiceNumber };
  }
  const state = () =>
    q(sql`SELECT b.id, b.state, i.state AS item_state FROM reminder_batches b
          JOIN reminder_batch_items i ON i.batch_id = b.id ORDER BY b.id`);

  it('B cannot read or cancel A’s batch; the answer matches an unknown id; A’s batch is untouched', async () => {
    const a = await business();
    const b = await business();
    const mine = await batchOf(a.id);
    const before = { batches: await state(), audit: (await books()).audit };

    for (const [method, suffix] of [
      ['GET', ''],
      ['POST', '/cancel'],
    ] as const) {
      const foreign = await call(
        method,
        `/v1/reminders/batches/${mine.batchId}${suffix}`,
        b.session,
      );
      const missing = await call(
        method,
        `/v1/reminders/batches/${unknownUuid}${suffix}`,
        b.session,
      );
      const malformed = await call(method, `/v1/reminders/batches/not-a-uuid${suffix}`, b.session);
      expect([foreign.statusCode, missing.statusCode, malformed.statusCode], suffix).toEqual([
        404, 404, 404,
      ]);
      expect(foreign.body, suffix).toBe(missing.body);
    }
    expect(await state()).toEqual(before.batches);
    expect((await books()).audit).toEqual(before.audit);
    expect(
      JSON.stringify((await call('GET', '/v1/reminders/batches', b.session)).json()),
    ).not.toContain(mine.batchId);
    // Control: A reads its own batch.
    expect((await call('GET', `/v1/reminders/batches/${mine.batchId}`, a.session)).statusCode).toBe(
      200,
    );
  });

  it('B cannot send, stop or read the history of a reminder for A’s invoice number', async () => {
    const a = await business();
    const b = await business();
    const theirs = (await batchOf(a.id)).invoiceNumber;
    const before = {
      reminders: await q(sql`SELECT id FROM invoice_reminders`),
      books: await books(),
    };
    const probes = (number: string) => [
      call('GET', `/v1/reminders/history?invoiceNumber=${number}`, b.session),
      call('POST', '/v1/reminders/stop', b.session, { invoiceNumber: number }),
      call('POST', '/v1/reminders/send', b.session, {
        invoiceNumber: number,
        channels: 'auto',
        idempotencyKey: 'idor-send-key-0001',
      }),
    ];
    const foreign = await Promise.all(probes(theirs));
    const missing = await Promise.all(probes(NEVER_ISSUED_INVOICE));
    for (const [i, r] of foreign.entries()) {
      expect(r.statusCode, `probe ${i}`).toBe(missing[i]!.statusCode);
      expect(r.body.replace(theirs, 'N'), `probe ${i}`).toBe(
        missing[i]!.body.replace(NEVER_ISSUED_INVOICE, 'N'),
      );
    }
    expect({
      reminders: await q(sql`SELECT id FROM invoice_reminders`),
      books: await books(),
    }).toEqual(before);
  });
});
