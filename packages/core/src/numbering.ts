/**
 * Sequential document numbering — per business, per document type, per year.
 * Nigerian practice expects gap-explained sequential numbers: INV-2026-000041.
 *
 * Pure function: the caller owns the counter row (incremented inside the
 * same DB transaction that issues the document).
 */

export type DocType =
  'invoice' | 'receipt' | 'credit_note' | 'order' | 'quote' | 'purchase_order' | 'journal' | 'bill';

const PREFIX: Record<DocType, string> = {
  invoice: 'INV',
  receipt: 'RCT',
  credit_note: 'CRN',
  /* An order is not a financial document: nothing is owed until the merchant
   * agrees to it. It is numbered anyway, and on the same counter, because a
   * merchant asking "what happened to the order Sandra sent on Tuesday" needs
   * something to say back that is not a description. */
  order: 'ORD',
  /* A quote is an offer, not an obligation: nothing posts until it converts.
   * Its own prefix and counter, because "send me quote QUO-2026-000003"
   * must never be answerable with an invoice number. */
  quote: 'QUO',
  /* The mirror of a quote, pointing the other way: what the merchant asks a
   * supplier for. Nothing posts until the goods land, and its own counter,
   * because "PO-2026-000002 never arrived" is a sentence said to a supplier
   * and it must never name a customer's document. */
  purchase_order: 'PO',
  /* Numbered because an accountant asks "which entry", and the answer has to
   * be something they can write down. On its own counter, so a business that
   * makes two corrections all year has JNL-2026-000001 and JNL-2026-000002
   * rather than two numbers from the middle of the invoice run. */
  journal: 'JNL',
  /* The mirror of an invoice, pointing the other way: what a SUPPLIER is
   * owed by the merchant (spec §8; F2, PR-077). Its own counter, because
   * "BILL-2026-000002 is due Friday" is about money going OUT and must
   * never name a customer's document. */
  bill: 'BILL',
};

export function formatDocumentNumber(docType: DocType, year: number, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`invalid sequence ${seq}`);
  if (!Number.isInteger(year) || year < 2020 || year > 2100)
    throw new Error(`invalid year ${year}`);
  return `${PREFIX[docType]}-${year}-${String(seq).padStart(6, '0')}`;
}

/** The Lagos business year for a timestamp (UTC+1, no DST). */
export function lagosYear(when: Date): number {
  return new Date(when.getTime() + 3_600_000).getUTCFullYear();
}
