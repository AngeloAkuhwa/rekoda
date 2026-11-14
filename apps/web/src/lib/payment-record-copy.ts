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

/**
 * Why a confirmed payment was not applied, in words that invent no event the merchant did not cause.
 * A reason that mentions a review has a second wording for after the review, so a reviewed record
 * never also says the review is still going on.
 */
const NOT_APPLIED_WHY: Record<
  NonNullable<BillingPaymentRecord['notAppliedReason']>,
  string | { pending: string; reviewed: string }
> = {
  plan_changed: 'It was not applied because your plan changed after this payment was started.',
  period_ended: 'It was not applied because your billing period had already ended when it arrived.',
  paid_twice: {
    pending:
      'It was not applied because this top-up had already been paid for. No extra units were added, and our team is reviewing this second payment.',
    reviewed:
      'It was not applied because this top-up had already been paid for. No extra units were added.',
  },
  under_review: {
    pending: 'It was not applied and is being reviewed.',
    reviewed: 'It was not applied.',
  },
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
  const reason = record.notAppliedReason ? NOT_APPLIED_WHY[record.notAppliedReason] : null;
  const why =
    reason === null || typeof reason === 'string'
      ? reason
      : record.reconciled
        ? reason.reviewed
        : reason.pending;
  if (record.state === 'paid_not_applied') {
    if (why) summary = summary.replace('but it was not applied to your plan.', `but ${lower(why)}`);
    if (record.reconciled)
      summary = `${summary} Our team has since reviewed it; ask support for the outcome.`;
  }
  /* A part refund of money that was never applied must still say it was never applied. */
  if ((record.state === 'part_refunded' || record.state === 'refunded') && !record.applied) {
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

type TimesInput = Pick<
  BillingPaymentRecord,
  | 'kind'
  | 'state'
  | 'noCharge'
  | 'providerPaidAt'
  | 'paidAt'
  | 'providerSettledAt'
  | 'unitsCreditedAt'
  | 'failedAt'
>;

/**
 * The record's timeline (OD-40), in order: each row only when its time exists, and each a
 * distinct fact, never one time standing in for another. Lagos formatting stays with the page.
 */
export function paymentRecordTimes(record: TimesInput): Array<{ label: string; iso: string }> {
  const rows: Array<{ label: string; iso: string }> = [];
  if (record.providerPaidAt && !record.noCharge) {
    rows.push({ label: 'Paid at Paystack on', iso: record.providerPaidAt });
  }
  if (record.paidAt) {
    rows.push({
      label: record.noCharge ? 'Applied on' : 'Payment recorded by Rekoda on',
      iso: record.paidAt,
    });
  }
  if (record.providerSettledAt && !record.noCharge) {
    rows.push({ label: 'Settled by Paystack on', iso: record.providerSettledAt });
  }
  if (record.kind === 'add_on' && record.unitsCreditedAt) {
    rows.push({ label: 'Units added on', iso: record.unitsCreditedAt });
  }
  if (record.failedAt && record.state === 'failed') {
    rows.push({ label: 'Reported failed on', iso: record.failedAt });
  }
  return rows;
}

/** Lagos, so a merchant reads the date and time they would write on a form. */
export function lagosDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The timeline as the page shows it: each label with its Lagos date and time. */
export function paymentRecordTimeline(record: TimesInput): Array<{ label: string; shown: string }> {
  return paymentRecordTimes(record).map((row) => ({
    label: row.label,
    shown: `${lagosDateTime(row.iso)} (Lagos time)`,
  }));
}
