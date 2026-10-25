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
      'You chose something else after this, so it should not be paid. No payment has been confirmed for it, and your plan has not changed because of it.',
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
      'Paystack confirmed this payment, but it was not applied to your plan. It does not make a subscription active. Contact support to have it applied or refunded.',
    confirmed: true,
  },
  part_refunded: {
    title: 'Partly refunded',
    summary:
      'Paystack confirmed this payment. Part of the charged amount has since been returned to you.',
    confirmed: true,
  },
  refunded: {
    title: 'Refunded',
    summary:
      'Paystack confirmed this payment. All of the charged amount has since been returned to you.',
    confirmed: true,
  },
};

/** Why a confirmed payment was not applied, in words that invent no event the merchant did not cause. */
const NOT_APPLIED_WHY: Record<NonNullable<BillingPaymentRecord['notAppliedReason']>, string> = {
  plan_changed: 'It was not applied because your plan changed after this payment was started.',
  period_ended: 'It was not applied because your billing period had already ended when it arrived.',
  under_review: 'It was not applied and is being reviewed.',
};

type ViewInput = Pick<
  BillingPaymentRecord,
  'state' | 'reconciled' | 'applied' | 'noCharge' | 'notAppliedReason' | 'amountK' | 'paidAmountK'
>;

export function paymentRecordView(record: ViewInput): PaymentRecordView {
  /* An upgrade that cost nothing took no payment: no provider confirmed anything. */
  if (record.noCharge && record.state === 'paid_applied') {
    return {
      title: 'No payment needed',
      summary:
        'This change cost nothing, so no payment was taken. It has been applied to your account.',
      confirmed: false,
    };
  }
  const view = VIEWS[record.state];
  let summary = view.summary;
  const why = record.notAppliedReason ? NOT_APPLIED_WHY[record.notAppliedReason] : null;
  if (record.state === 'paid_not_applied') {
    if (why) summary = summary.replace('but it was not applied to your plan.', `but ${lower(why)}`);
    if (record.reconciled)
      summary = `${summary} Our team has since reviewed it; ask support for the outcome.`;
  }
  /* A part refund of money that was never applied must still say it was never applied. */
  if (record.state === 'part_refunded' && !record.applied) {
    summary = `${summary} ${why ?? 'It was not applied to your plan.'}`;
  }
  /* Refunds return the charged amount; an overpayment leaves the difference with Paystack. */
  if (
    (record.state === 'refunded' || record.state === 'part_refunded') &&
    record.paidAmountK !== null &&
    record.paidAmountK > record.amountK
  ) {
    summary = `${summary} Paystack received more than was charged; contact support about the difference.`;
  }
  return summary === view.summary ? view : { ...view, summary };
}

const lower = (sentence: string): string => sentence.charAt(0).toLowerCase() + sentence.slice(1);

/** The sentence under every record: factual, and neither a tax invoice nor a tax receipt. */
export const PAYMENT_RECORD_NOTICE =
  'This is a record of a payment to Rekoda. It is not a VAT invoice, tax invoice or tax receipt.';
