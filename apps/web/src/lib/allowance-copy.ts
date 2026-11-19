/**
 * What a merchant is told when converting a quote finds the document allowance used up.
 *
 * A paid plan's allowance is a month's; a trial's is one budget for its 14 days (G-109), so a
 * trial is never told "this month". A missing window (an older API) reads as a month.
 */
export function quoteConvertExhausted(
  allowance: number,
  window: 'month' | 'trial' | undefined,
): string {
  if (window === 'trial') {
    return `You have used all ${allowance} invoices and receipts included in your free trial. Choose a plan on the billing page and convert again.`;
  }
  return `You have used all ${allowance} invoices and receipts in your plan this month. Upgrade on the billing page and convert again.`;
}
