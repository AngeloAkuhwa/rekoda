/**
 * Billing sentences that must stay true (G-107). Kept out of the page so a test
 * can pin them: each one was once false for a state the page can be in.
 */

/** Under "This month" when no unit has an allowance to meter. */
export function emptyMeterCopy(
  statusState: 'active' | 'trial' | 'grace' | 'expired',
  isOwner: boolean,
): string {
  /* A stopped subscription sells zero of everything: it IS refused. Saying
   * "nothing you do will be refused" there is the false sentence this replaced.
   * The full data export lives on Settings, which only the owner sees. */
  if (statusState !== 'expired') return 'This plan includes nothing to meter right now.';
  return isOwner
    ? 'Your subscription has stopped, so new records and downloads are paused. Your books stay readable, and Settings has a full data export.'
    : 'Your subscription has stopped, so new records and downloads are paused. Your books stay readable, and the owner can download a full data export from Settings.';
}

/** The button that undoes a scheduled cancellation or downgrade. */
export function undoPendingLabel(pendingPlan: string, currentPlanName: string): string {
  return pendingPlan === 'expired' ? 'Keep my subscription' : `Stay on ${currentPlanName}`;
}

/**
 * The strip over the billing page while a renewal is overdue (G-16).
 *
 * Rekoda holds no card, so a renewal opens a charge and waits for the merchant
 * to pay it: nothing was attempted, and nothing failed. "A payment did not go
 * through" was untrue for every merchant in this state.
 */
export function graceStripCopy(endsOn: string, daysLeft: number): string {
  const when = daysLeft === 1 ? 'one day from now' : `${daysLeft} days from now`;
  return `Your plan's renewal is due and we have not received the payment yet. Everything keeps working until ${endsOn}, ${when}. Your records are safe. Message upgrade on WhatsApp and we will sort it out with you.`;
}

/**
 * Whether a charge shows a "refunded" note beside its amount. The row's status
 * stays Paid until the whole amount has been returned, so without the note it
 * reads as the full amount while the merchant's bank shows the net (G-111). A
 * fully refunded row already says Refunded. The amount itself is rendered by
 * `Money`, the only place money is formatted.
 */
export function partlyRefunded(
  refundedAmountK: number,
  status: 'pending' | 'paid' | 'failed' | 'refunded',
): boolean {
  return refundedAmountK > 0 && status !== 'refunded';
}
