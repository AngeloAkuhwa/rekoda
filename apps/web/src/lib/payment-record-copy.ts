import type { BillingPaymentRecord } from '@rekoda/contracts';

/*
 * What the payment record page says for each state (billing Slice A). Keyed by the contract's own
 * state list, so a state the API can produce and this table forgets is a compile error, not a raw
 * word on a record a merchant keeps.
 *
 * Two lines are never blurred: "no payment has been confirmed" for anything not paid (starting a
 * payment is not paying), and "not applied to your plan" for money received after a newer choice
 * (a payment is not an active subscription). Nothing here names VAT or tax except to say the record
 * is neither: the tax treatment of Rekoda's own subscription is not decided (OWN-30).
 */
type State = BillingPaymentRecord['state'];

export interface PaymentRecordView {
  title: string;
  summary: string;
  /** True only for states where the provider's verified payment exists. */
  confirmed: boolean;
}

const VIEWS: Record<State, PaymentRecordView> = {
  awaiting_payment: {
    title: 'Not paid yet',
    summary: 'No payment has been confirmed for this charge, and your plan has not changed.',
    confirmed: false,
  },
  replaced: {
    title: 'Replaced by a newer choice',
    summary:
      'You chose something else after this, so it can no longer be paid. No payment has been confirmed for it, and your plan has not changed because of it.',
    confirmed: false,
  },
  failed: {
    title: 'Payment did not go through',
    summary:
      'Paystack did not complete this payment. Your plan has not changed because of it. You can start the payment again from your billing page.',
    confirmed: false,
  },
  paid_applied: {
    title: 'Paid',
    summary: 'Paystack confirmed this payment and it has been applied to your account.',
    confirmed: true,
  },
  paid_not_applied: {
    title: 'Payment received, not applied',
    summary:
      'Paystack confirmed this payment, but it was not applied to your plan because you had already made a newer plan choice. It does not make a subscription active. Contact support to have it applied or refunded.',
    confirmed: true,
  },
  part_refunded: {
    title: 'Partly refunded',
    summary: 'Paystack confirmed this payment. Part of it has since been returned to you.',
    confirmed: true,
  },
  refunded: {
    title: 'Refunded',
    summary: 'Paystack confirmed this payment. All of it has since been returned to you.',
    confirmed: true,
  },
};

export function paymentRecordView(
  record: Pick<BillingPaymentRecord, 'state' | 'reconciled'>,
): PaymentRecordView {
  const view = VIEWS[record.state];
  return record.state === 'paid_not_applied' && record.reconciled
    ? {
        ...view,
        summary: `${view.summary} Our team has since reviewed it; ask support for the outcome.`,
      }
    : view;
}

/** The sentence under every record: factual, and neither a tax invoice nor a tax receipt. */
export const PAYMENT_RECORD_NOTICE =
  'This is a record of a payment to Rekoda. It is not a VAT invoice, tax invoice or tax receipt.';
