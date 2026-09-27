/**
 * "Paid by" for a register row. A stock purchase bought wholly on credit
 * says so, rather than borrowing the column's old 'cash' default (G-61).
 * It names how the purchase was made, never whether the debt has since been
 * settled: a supplier payment clears it later without touching this row.
 */
export function paidBy(method: string): string {
  if (method === 'transfer') return 'Transfer';
  if (method === 'credit') return 'On credit';
  return 'Cash';
}
