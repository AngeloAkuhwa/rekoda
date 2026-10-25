/**
 * What a payment to Rekoda IS, as a merchant should read it (billing Slice A).
 *
 * One pure answer from the facts on a charge, so the page, the print view and the tests say the
 * same thing. Three rules the states below keep apart on purpose:
 *   - starting a payment is not paying: `awaiting_payment` holds no money and grants nothing;
 *   - money received is not entitlement applied: `paid_not_applied` is a verified payment whose
 *     plan change was refused as stale (OD-30), and it never reads as an active subscription;
 *   - a charge the account replaced is not "awaiting payment": `replaced` can no longer be paid.
 * `paid` is only ever written after the provider's payment was verified server side, so the paid
 * states are the "confirmed by the provider" states.
 */
export type PaymentRecordState =
  | 'awaiting_payment'
  | 'replaced'
  | 'failed'
  | 'paid_applied'
  | 'paid_not_applied'
  | 'part_refunded'
  | 'refunded';

export interface PaymentRecordFacts {
  status: 'pending' | 'paid' | 'failed' | 'refunded';
  /** A pending charge the account has since replaced (stamped, retired or decided over). */
  replaced: boolean;
  /** A paid charge whose plan change was refused as stale (OD-30). */
  unapplied: boolean;
  amountK: number;
  refundedAmountK: number;
}

export function paymentRecordState(facts: PaymentRecordFacts): PaymentRecordState {
  switch (facts.status) {
    case 'pending':
      return facts.replaced ? 'replaced' : 'awaiting_payment';
    case 'failed':
      return 'failed';
    case 'refunded':
      return 'refunded';
    case 'paid':
      if (facts.refundedAmountK > 0) return 'part_refunded';
      return facts.unapplied ? 'paid_not_applied' : 'paid_applied';
  }
}
