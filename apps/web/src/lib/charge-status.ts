import type { BillingChargeStatus } from '@rekoda/contracts';

/*
 * The status column was the one cell on the billing table printing the
 * database's own word: a merchant reconciling their bill read it beside four
 * columns of plain language.
 *
 * Keyed by the contract's own status list, so a status the writer can produce
 * and this table forgets is a compile error, not a raw word on a receipt
 * (G-69: the map once declared `succeeded`, which no charge ever carries, and
 * lacked `paid`, which every successful one does).
 */
const LABELS: Record<BillingChargeStatus, string> = {
  pending: 'Awaiting payment',
  paid: 'Paid',
  failed: 'Payment did not go through',
  refunded: 'Refunded',
};

/** A pending charge the account has replaced can no longer be paid, so it is not "awaiting payment". */
export function chargeStatusLabel(status: BillingChargeStatus, superseded = false): string {
  return status === 'pending' && superseded ? 'Replaced by a newer choice' : LABELS[status];
}
