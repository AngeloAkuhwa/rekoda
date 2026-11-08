/**
 * Object-level authorisation (IDOR) over the report-side writes that act on a record by number or
 * id: quotes, expense voids (harness: `ops-idor-harness.ts`). Two businesses; the target's own
 * rows must be unchanged and nothing may be written for the refused request.
 */
import { describe, expect, it } from 'vitest';
import { sql } from '@rekoda/db';
import { REASON, business, call, ownerDb } from './ops-idor-harness.js';
import { useHarness } from './ops-idor-harness.js';

// not issued: a quote number nobody holds, used only as a not-found probe
const NEVER_ISSUED_QUOTE = 'QUO-2099-999999';

useHarness();

const q = async (text: ReturnType<typeof sql>) => [...(await ownerDb.execute(text))];
const unknownUuid = '00000000-0000-4000-8000-000000000bad';

describe('quotes: the quote number is resolved inside the caller’s business', () => {
  it('B cannot convert or cancel A’s quote; every answer is not_found, as for an unknown number', async () => {
    const a = await business();
    const b = await business();
    const made = await call('POST', '/v1/reports/quotes', a.session, {
      items: [{ name: 'wig', quantity: 1, unitPriceK: 100_000 }],
      clientRef: crypto.randomUUID(),
    });
    expect(made.statusCode).toBe(200);
    const quoteNumber = (made.json() as { quoteNumber: string }).quoteNumber;
    const state = () =>
      q(sql`SELECT id, business_id, status FROM orders ORDER BY id`).then((rows) => ({
        rows,
        invoices: q(sql`SELECT id FROM invoices`),
      }));
    const before = {
      orders: (await state()).rows,
      invoices: await q(sql`SELECT id FROM invoices`),
    };

    for (const action of ['convert', 'cancel']) {
      const foreign = await call('POST', `/v1/reports/quotes/${action}`, b.session, {
        quoteNumber,
      });
      const missing = await call('POST', `/v1/reports/quotes/${action}`, b.session, {
        quoteNumber: NEVER_ISSUED_QUOTE,
      });
      expect(foreign.json(), action).toEqual({ outcome: 'not_found' });
      expect(missing.json(), action).toEqual({ outcome: 'not_found' });
    }
    expect({
      orders: (await state()).rows,
      invoices: await q(sql`SELECT id FROM invoices`),
    }).toEqual(before);
    // Control: the owner of the quote can cancel it.
    expect(
      (await call('POST', '/v1/reports/quotes/cancel', a.session, { quoteNumber })).json(),
    ).toEqual({ outcome: 'cancelled' });
  });
});

describe('expense void: the expense id is resolved inside the caller’s business', () => {
  it('B cannot void A’s expense; the answer matches an unknown id; A’s expense and ledger are untouched', async () => {
    const a = await business();
    const b = await business();
    const [expense] = await q(sql`
      INSERT INTO expenses (business_id, description, amount_k, source_type)
      VALUES (${a.id}::uuid, 'fabric', 250000, 'chat') RETURNING id`);
    const expenseId = (expense as { id: string }).id;
    const snapshot = async () => ({
      expenses: await q(sql`SELECT id, status FROM expenses ORDER BY id`),
      ledger: await q(sql`SELECT id FROM ledger_entries ORDER BY id`),
      audit: await q(sql`SELECT business_id, action FROM audit_events ORDER BY created_at, id`),
    });
    const before = await snapshot();

    const attempt = (id: string) =>
      call('POST', '/v1/reports/expenses/void', b.session, { expenseId: id, reason: REASON });
    // Void is HIGH_RISK: an optional confirmation step may come first; answer the same for both.
    const settle = async (id: string) => {
      const first = await attempt(id);
      const body = first.json() as { outcome: string; confirmationId?: string };
      if (body.outcome !== 'confirm') return first;
      return call('POST', '/v1/reports/expenses/void', b.session, {
        expenseId: id,
        reason: REASON,
        confirmationId: body.confirmationId,
      });
    };
    const foreign = await settle(expenseId);
    const missing = await settle(unknownUuid);
    expect(foreign.json()).toEqual({ outcome: 'not_found' });
    expect(missing.json()).toEqual({ outcome: 'not_found' });

    const after = await snapshot();
    expect({ ...after, audit: null }).toEqual({ ...before, audit: null });
    const added = after.audit.slice(before.audit.length) as Array<{ business_id: string }>;
    expect(added.every((row) => row.business_id === b.id)).toBe(true);
  });
});
