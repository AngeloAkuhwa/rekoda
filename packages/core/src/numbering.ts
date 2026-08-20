/**
 * Sequential document numbering — per business, per document type, per year.
 * Nigerian practice expects gap-explained sequential numbers: INV-2026-000041.
 *
 * Pure function: the caller owns the counter row (incremented inside the
 * same DB transaction that issues the document).
 */

export type DocType = 'invoice' | 'receipt' | 'credit_note';

const PREFIX: Record<DocType, string> = {
  invoice: 'INV',
  receipt: 'RCT',
  credit_note: 'CRN',
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
