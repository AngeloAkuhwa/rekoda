/**
 * Billing sentences that must stay true (G-107). Kept out of the page so a test
 * can pin them: each one was once false for a state the page can be in.
 */

/** Under "This month" when no unit has an allowance to meter. */
export function emptyMeterCopy(statusState: 'active' | 'trial' | 'grace' | 'expired'): string {
  /* A stopped subscription sells zero of everything: it IS refused. Saying
   * "nothing you do will be refused" there is the false sentence this replaced. */
  return statusState === 'expired'
    ? 'Your subscription has stopped, so new records and downloads are paused. Your books stay readable, and Settings has a full data export.'
    : 'This plan includes nothing to meter right now.';
}

/** The button that undoes a scheduled cancellation or downgrade. */
export function undoPendingLabel(pendingPlan: string, currentPlanName: string): string {
  return pendingPlan === 'expired' ? 'Keep my subscription' : `Stay on ${currentPlanName}`;
}
