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

/** How a price is read: per month or per year (OWN-40). */
export type Interval = 'monthly' | 'annual';

/** "a month" / "a year", for a price line. */
export function perInterval(interval: Interval): string {
  return interval === 'annual' ? 'a year' : 'a month';
}

/**
 * The line under "Billing frequency" while a switch waits for the renewal.
 * Nothing is charged or refunded by the switch itself: the merchant keeps the
 * month or the year they already paid for.
 */
export function pendingIntervalCopy(pending: Interval, cancelling = false): string {
  if (cancelling) {
    return `Your plan is set to end at the close of this period, so the switch to ${pending === 'annual' ? 'yearly' : 'monthly'} billing cannot take effect while the cancellation stands. Nothing is charged or refunded. You can clear the waiting switch below.`;
  }
  return pending === 'annual'
    ? 'Switching to yearly billing at your next renewal. You keep your current monthly plan until then, and nothing is charged now.'
    : 'Switching to monthly billing at your next renewal. You keep the year you paid for until then, and nothing is refunded or charged now.';
}

/** The button that undoes a scheduled interval switch. */
export function undoIntervalLabel(current: Interval): string {
  return current === 'annual' ? 'Stay on yearly billing' : 'Stay on monthly billing';
}

/**
 * The offer to switch, with the saving stated plainly and no countdown.
 * Yearly is ten months' price for twelve months of service.
 */
export function switchIntervalOffer(current: Interval): string {
  return current === 'monthly'
    ? 'Pay once a year and get two months free: twelve months of service for the price of ten. It starts at your next renewal.'
    : 'Go back to paying month by month. It starts at your next renewal, after the year you paid for.';
}

/** What a first purchase buys, in words, for the confirmation step. */
export function firstPurchaseTerm(interval: Interval): string {
  return interval === 'annual' ? 'twelve months of service' : 'one month of service';
}

/** The suffix on a billing-history row: only yearly plan charges need saying. */
export function chargeIntervalSuffix(kind: string, interval: Interval): string {
  return interval === 'annual' && (kind === 'first_purchase' || kind === 'renewal')
    ? ' · Yearly'
    : '';
}

/** The price view a first purchase browses: a year only when a year can be chosen. */
export function browsingInterval(
  requested: string | undefined,
  annualOffered: boolean,
): 'monthly' | 'annual' {
  return annualOffered && requested === 'annual' ? 'annual' : 'monthly';
}

/**
 * Whether the billing frequency card has an action to offer outside a waiting switch: a
 * yearly subscriber can always go back to monthly, but a monthly one is offered a year
 * only when yearly billing is on.
 */
export function canOfferSwitch(interval: 'monthly' | 'annual', annualOffered: boolean): boolean {
  return interval === 'annual' || annualOffered;
}

/** The price the API sells a plan at for this business, or undefined for a plan it does not list. */
export function soldPrice<K>(
  overview: { planPrices: { plan: string; monthlyK: K; annualK: K }[] },
  plan: string,
): { monthlyK: K; annualK: K } | undefined {
  return overview.planPrices.find((row) => row.plan === plan);
}

/**
 * The yearly price quoted in the "switch to yearly" offer. The switch applies at the
 * next renewal, so a scheduled plan change is priced, not the plan being left.
 */
export function nextRenewalAnnualK(overview: {
  annualPriceK: number;
  pendingPlan: string | null;
  planPrices: { plan: string; monthlyK: number; annualK: number }[];
}): number {
  const next = overview.pendingPlan ? soldPrice(overview, overview.pendingPlan) : undefined;
  return next ? next.annualK : overview.annualPriceK;
}

/**
 * Whether the Billing frequency card has anything to say. With yearly billing off, a
 * monthly subscriber has no action and no waiting switch, so the card would only
 * advertise a feature that is not on sale. A cancellation leaves no renewal to switch
 * for, so only a waiting switch (to undo) keeps the card. In grace the renewal is
 * already overdue and the late-renewal behaviour of a switch is not yet decided
 * (slice 3), so a new switch is not offered there either.
 */
export function showFrequencyCard(o: {
  state?: string;
  interval: 'monthly' | 'annual';
  annualOffered: boolean;
  pendingPlan: string | null;
  pendingInterval: 'monthly' | 'annual' | null;
}): boolean {
  if (o.pendingInterval) return true;
  if (o.state === 'grace') return false;
  return o.pendingPlan !== 'expired' && canOfferSwitch(o.interval, o.annualOffered);
}
