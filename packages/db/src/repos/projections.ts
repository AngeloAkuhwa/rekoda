/**
 * Document projections, provably rebuildable (spec Appendix E.3; PR-084).
 *
 * `invoices.paid_k`, `balance_due_k`, `credited_k` and the money half of
 * `status` — and `bills.paid_k` with its lifecycle — are DENORMALISED
 * PROJECTIONS of the subledgers: payment allocations, customer-credit
 * applications, credit notes, supplier payments. The canon's storage rule
 * is blunt about what that obliges: a projection "has a rebuild path that
 * a test exercises. A cache that cannot be rebuilt is not a cache, it is a
 * second source of truth wearing a disguise."
 *
 * This is that rebuild path. It recomputes every document's stored figures
 * from the subledgers alone and writes them back, reporting which
 * documents had drifted. In production nothing calls it: the writers
 * maintain the projection inside the same transactions as the facts, and
 * the exercised test is the proof they do. Its existence is what makes the
 * stored columns a cache rather than a second truth.
 *
 * What it deliberately preserves: `status = 'voided'` is LIFECYCLE, a real
 * transition somebody performed with no other record (E.3 says lifecycle
 * MAY persist) — a rebuild never un-voids a document. And a credit note
 * from before §14.1 (PR-081) reduced the invoice balance DIRECTLY, with no
 * customer-credit grant behind it; those notes are recognised by the
 * absence of their grant and honoured as the settlement they were, so a
 * rebuild does not resurrect a debt an old credit already forgave.
 */
import { sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';

export interface RebuiltDocuments {
  /** When the projection was computed — the timestamp the canon asks a
   * projection to carry, returned by the path that computes it. */
  computedAt: Date;
  invoicesChecked: number;
  /** Invoice numbers whose stored figures disagreed with the subledgers. */
  invoicesRepaired: string[];
  billsChecked: number;
  billsRepaired: string[];
}

export async function rebuildDocumentProjections(
  tx: TenantDb,
  businessId: string,
): Promise<RebuiltDocuments> {
  const computedAt = new Date();

  /* Invoices: settled = allocations (net of their exact-negation reversals,
   * §14.2) + credit applications (same shape) + legacy pre-§14.1 credit
   * notes. Derived first, compared, then only the drifted rows written. */
  const invoiceRows = await tx.execute<{ invoice_number: string }>(sql`
    WITH derived AS (
      SELECT i.id,
             i.invoice_number,
             i.total_k,
             i.status,
             COALESCE((SELECT SUM(pa.amount_k) FROM payment_allocations pa
                       WHERE pa.business_id = i.business_id AND pa.invoice_id = i.id), 0) AS paid,
             COALESCE((SELECT SUM(cca.amount_minor) FROM customer_credit_applications cca
                       WHERE cca.business_id = i.business_id AND cca.invoice_id = i.id), 0) AS applied,
             COALESCE((SELECT SUM(cn.amount_k) FROM credit_notes cn
                       WHERE cn.business_id = i.business_id AND cn.invoice_id = i.id), 0) AS credited,
             COALESCE((SELECT SUM(cn.amount_k) FROM credit_notes cn
                       WHERE cn.business_id = i.business_id AND cn.invoice_id = i.id
                         AND NOT EXISTS (SELECT 1 FROM customer_credits g
                                         WHERE g.business_id = cn.business_id
                                           AND g.source_type = 'credit_note'
                                           AND g.source_id = cn.credit_note_number)), 0) AS legacy_credited
      FROM invoices i
      WHERE i.business_id = ${businessId}::uuid
    ),
    target AS (
      SELECT id, invoice_number, paid, credited,
             CASE WHEN status = 'voided' THEN 0
                  ELSE GREATEST(total_k - paid - applied - legacy_credited, 0) END AS balance,
             CASE WHEN status = 'voided' THEN 'voided'
                  WHEN GREATEST(total_k - paid - applied - legacy_credited, 0) = 0 THEN 'paid'
                  WHEN paid + applied + legacy_credited > 0 THEN 'partially_paid'
                  ELSE 'issued' END AS status
      FROM derived
    )
    UPDATE invoices i
       SET paid_k = t.paid,
           balance_due_k = t.balance,
           credited_k = t.credited,
           status = t.status
      FROM target t
     WHERE i.id = t.id
       AND i.business_id = ${businessId}::uuid
       AND (i.paid_k <> t.paid OR i.balance_due_k <> t.balance
            OR i.credited_k <> t.credited OR i.status <> t.status)
    RETURNING i.invoice_number
  `);

  /* Bills: settled by the EXPENSE attribution — the same join the ageing
   * reads — because payments older than the bill_id column carry only it. */
  const billRows = await tx.execute<{ bill_number: string }>(sql`
    WITH derived AS (
      SELECT b.id, b.bill_number, b.total_k, b.status,
             COALESCE((SELECT SUM(sp.amount_k) FROM supplier_payments sp
                       WHERE sp.business_id = b.business_id
                         AND sp.expense_id = b.expense_id), 0) AS paid
      FROM bills b
      WHERE b.business_id = ${businessId}::uuid
    ),
    target AS (
      SELECT id, bill_number, LEAST(paid, total_k) AS paid,
             CASE WHEN status = 'voided' THEN 'voided'
                  WHEN LEAST(paid, total_k) >= total_k THEN 'paid'
                  WHEN paid > 0 THEN 'partially_paid'
                  ELSE 'open' END AS status
      FROM derived
    )
    UPDATE bills b
       SET paid_k = t.paid,
           status = t.status
      FROM target t
     WHERE b.id = t.id
       AND b.business_id = ${businessId}::uuid
       AND (b.paid_k <> t.paid OR b.status <> t.status)
    RETURNING b.bill_number
  `);

  const counts = await tx.execute<{ invoices: string; bills: string }>(sql`
    SELECT (SELECT COUNT(*) FROM invoices WHERE business_id = ${businessId}::uuid) AS invoices,
           (SELECT COUNT(*) FROM bills WHERE business_id = ${businessId}::uuid) AS bills
  `);
  const count = [...counts][0];

  return {
    computedAt,
    invoicesChecked: Number(count?.invoices ?? 0),
    invoicesRepaired: [...invoiceRows].map((r) => r.invoice_number).sort(),
    billsChecked: Number(count?.bills ?? 0),
    billsRepaired: [...billRows].map((r) => r.bill_number).sort(),
  };
}
