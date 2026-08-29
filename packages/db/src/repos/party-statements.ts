/**
 * Customer and supplier statements (D1, PR-096): one party's account with
 * the business, as dated entries with a running balance — the document an
 * accountant sends with "please reconcile and pay the balance".
 *
 * Derived from the DOCUMENT tables the kernel already keeps honest —
 * invoices, allocations, credit applications, bills, supplier payments —
 * never recomputed from prose. The tie each statement must hold is the
 * one the fixtures prove: a customer's closing balance equals the sum of
 * their open invoice balances, and a supplier's equals the sum of their
 * open bill balances. A statement that could disagree with the balances
 * page would be two answers to one question.
 *
 * Entries are SIGNED from the merchant's ledger perspective on the party:
 * a charge (invoice, bill) raises the balance, a settlement (payment,
 * credit applied) lowers it. Voided documents and their trailing rows are
 * excluded whole — a void reverses the story, and a statement that shows
 * both directions of a mistake reads as two mistakes.
 */
import { sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';

export interface PartyStatementEntry {
  /** Lagos date of the event, YYYY-MM-DD. */
  on: string;
  kind: 'invoice' | 'payment' | 'credit_applied' | 'bill' | 'supplier_payment';
  /** The document number where one exists; a payment shows its method. */
  reference: string;
  /** Signed: positive raises what the party owes, negative settles it. */
  amountK: number;
  /** Running balance after this entry. */
  balanceK: number;
}

export interface PartyStatement {
  /** Balance carried into the period (everything before `from`). */
  openingK: number;
  entries: PartyStatementEntry[];
  closingK: number;
}

type RawEvent = {
  on_day: string;
  at: string;
  kind: PartyStatementEntry['kind'];
  reference: string;
  amount_k: string;
};

function assemble(events: RawEvent[], from: string | null): PartyStatement {
  let openingK = 0;
  const entries: PartyStatementEntry[] = [];
  let balanceK = 0;
  for (const event of events) {
    const amountK = Number(event.amount_k);
    if (from && event.on_day < from) {
      openingK += amountK;
      balanceK += amountK;
      continue;
    }
    balanceK += amountK;
    entries.push({
      on: event.on_day,
      kind: event.kind,
      reference: event.reference,
      amountK,
      balanceK,
    });
  }
  return { openingK, entries, closingK: balanceK };
}

/**
 * One customer's account: invoices raised, payments allocated, credits
 * applied — ordered by the moment each happened, so the running balance
 * is the story in the order the customer lived it.
 */
export async function customerStatementFor(
  tx: TenantDb,
  businessId: string,
  customerId: string,
  window: { from?: string | null; to?: string | null } = {},
): Promise<PartyStatement> {
  const to = window.to ?? null;
  const rows = await tx.execute<RawEvent>(sql`
    WITH events AS (
      SELECT to_char(i.created_at + interval '1 hour', 'YYYY-MM-DD') AS on_day,
             i.created_at AS at, 'invoice'::text AS kind,
             i.invoice_number AS reference, i.total_k AS amount_k
      FROM invoices i
      WHERE i.business_id = ${businessId}::uuid AND i.customer_id = ${customerId}::uuid
        AND i.status <> 'voided'
      UNION ALL
      SELECT to_char(a.created_at + interval '1 hour', 'YYYY-MM-DD'),
             a.created_at, 'payment', p.method, -a.amount_k
      FROM payment_allocations a
      JOIN payments p ON p.id = a.payment_id
      JOIN invoices i ON i.id = a.invoice_id
      WHERE a.business_id = ${businessId}::uuid AND i.customer_id = ${customerId}::uuid
        AND i.status <> 'voided'
      UNION ALL
      SELECT to_char(ca.created_at + interval '1 hour', 'YYYY-MM-DD'),
             ca.created_at, 'credit_applied', ca.source_type, -ca.amount_minor
      FROM customer_credit_applications ca
      JOIN invoices i ON i.id = ca.invoice_id
      WHERE ca.business_id = ${businessId}::uuid AND i.customer_id = ${customerId}::uuid
        AND i.status <> 'voided'
    )
    SELECT * FROM events
    WHERE (${to}::date IS NULL OR on_day::date <= ${to}::date)
    ORDER BY at, kind
  `);
  return assemble([...rows], window.from ?? null);
}

/**
 * One supplier's account: bills raised against the business, payments made
 * to the supplier — linked by bill where the payment named one and by the
 * bill's own expense where it did not, so pre-bill history still lands on
 * the supplier it belongs to.
 */
export async function supplierStatementFor(
  tx: TenantDb,
  businessId: string,
  supplierId: string,
  window: { from?: string | null; to?: string | null } = {},
): Promise<PartyStatement> {
  const to = window.to ?? null;
  const rows = await tx.execute<RawEvent>(sql`
    WITH events AS (
      SELECT to_char(b.billed_on, 'YYYY-MM-DD') AS on_day,
             b.billed_on::timestamptz AS at, 'bill'::text AS kind,
             b.bill_number AS reference, b.total_k AS amount_k
      FROM bills b
      WHERE b.business_id = ${businessId}::uuid AND b.supplier_id = ${supplierId}::uuid
        AND b.status <> 'voided'
      UNION ALL
      SELECT to_char(sp.paid_on, 'YYYY-MM-DD'),
             sp.paid_on::timestamptz + interval '1 second', 'supplier_payment',
             sp.method, -sp.amount_k
      FROM supplier_payments sp
      JOIN bills b ON (b.id = sp.bill_id OR (sp.bill_id IS NULL AND b.expense_id = sp.expense_id))
      WHERE sp.business_id = ${businessId}::uuid AND b.supplier_id = ${supplierId}::uuid
        AND b.status <> 'voided'
    )
    SELECT * FROM events
    WHERE (${to}::date IS NULL OR on_day::date <= ${to}::date)
    ORDER BY at, kind
  `);
  return assemble([...rows], window.from ?? null);
}
