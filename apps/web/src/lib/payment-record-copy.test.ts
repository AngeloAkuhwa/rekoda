import { describe, expect, it } from 'vitest';
import { billingPaymentState } from '@rekoda/contracts';
import {
  PAYMENT_RECORD_NOTICE,
  paymentRecordTimeline,
  paymentRecordTimes,
  paymentRecordView,
} from './payment-record-copy';

const base = {
  state: 'paid_applied' as const,
  reconciled: false,
  applied: true,
  noCharge: false,
  notAppliedReason: null,
  amountK: 990_000,
  paidAmountK: 990_000,
};

describe('payment record copy', () => {
  it('has words for every state the API can send', () => {
    for (const state of billingPaymentState.options) {
      const view = paymentRecordView({ ...base, state });
      expect(view.title.length).toBeGreaterThan(0);
      expect(view.summary.length).toBeGreaterThan(0);
    }
  });

  it('only a paid state claims the provider confirmed a payment', () => {
    const confirmed = billingPaymentState.options.filter(
      (state) => paymentRecordView({ ...base, state }).confirmed,
    );
    expect(confirmed.sort()).toEqual(
      ['paid_applied', 'paid_not_applied', 'part_refunded', 'refunded'].sort(),
    );
  });

  it('a started or replaced payment never reads as paid or active', () => {
    for (const state of ['awaiting_payment', 'replaced'] as const) {
      const { summary, title } = paymentRecordView({ ...base, state });
      expect(`${title} ${summary}`).toMatch(/no payment has been confirmed/i);
      expect(`${title} ${summary}`).not.toMatch(/confirmed this payment|applied to your account/i);
    }
  });

  it('money received after a newer choice says it is not applied and not a subscription', () => {
    const { summary } = paymentRecordView({
      ...base,
      state: 'paid_not_applied',
      applied: false,
      notAppliedReason: 'under_review',
    });
    expect(summary).toMatch(/not applied/i);
    expect(summary).toMatch(/does not make a subscription active/i);
  });

  it('a part refund of money that was never applied still says it was not applied', () => {
    const unapplied = paymentRecordView({
      ...base,
      state: 'part_refunded',
      applied: false,
      notAppliedReason: 'period_ended',
    });
    const applied = paymentRecordView({ ...base, state: 'part_refunded' });
    expect(unapplied.summary).toMatch(/was not applied because your billing period/i);
    expect(applied.summary).not.toMatch(/not applied/i);
    const refunded = paymentRecordView({
      ...base,
      state: 'refunded',
      applied: false,
      notAppliedReason: 'plan_changed',
    });
    expect(refunded.summary).toMatch(/was not applied because your plan changed/i);
  });

  it('names the true reason a payment was not applied and invents no newer choice', () => {
    const why = (reason: 'plan_changed' | 'period_ended' | 'paid_twice' | 'under_review') =>
      paymentRecordView({
        ...base,
        state: 'paid_not_applied',
        applied: false,
        notAppliedReason: reason,
      }).summary;
    expect(why('plan_changed')).toMatch(/plan changed after this payment was started/);
    expect(why('period_ended')).toMatch(/billing period had already ended/);
    expect(why('under_review')).toMatch(/being reviewed/);
    /* OD-51.7: a second payment for a top-up already paid for says exactly that, and never claims
     * the payment failed (Paystack confirmed it). */
    expect(why('paid_twice')).toMatch(/this top-up had already been paid for/);
    expect(why('paid_twice')).toMatch(/No extra units were added/);
    expect(why('paid_twice')).not.toMatch(/fail/i);
    expect(why('paid_twice')).toMatch(/^Paystack confirmed this payment/);
    expect(why('period_ended')).not.toMatch(/newer (plan )?choice|changed/i);
  });

  it('a reviewed payment never also says it is still being reviewed', () => {
    for (const reason of ['paid_twice', 'under_review'] as const) {
      const record = {
        ...base,
        state: 'paid_not_applied' as const,
        applied: false,
        notAppliedReason: reason,
      };
      expect(paymentRecordView(record).summary).toMatch(/review/);
      const reviewed = paymentRecordView({ ...record, reconciled: true }).summary;
      expect(reviewed).toMatch(/has since reviewed it/);
      expect(reviewed).not.toMatch(/is reviewing|being reviewed/);
      /* A part refund of it after the review: the same rule. */
      const refunded = paymentRecordView({
        ...record,
        state: 'part_refunded',
        reconciled: true,
      }).summary;
      expect(refunded).not.toMatch(/is reviewing|being reviewed/);
    }
    /* What was true before the review stays: nothing extra was added for the second payment. */
    expect(
      paymentRecordView({
        ...base,
        state: 'paid_not_applied',
        applied: false,
        notAppliedReason: 'paid_twice',
        reconciled: true,
      }).summary,
    ).toMatch(/already been paid for\. No extra units were added\./);
  });

  it('a no-charge upgrade claims no payment and no provider confirmation', () => {
    const view = paymentRecordView({ ...base, noCharge: true, amountK: 0, paidAmountK: null });
    expect(view.confirmed).toBe(false);
    expect(`${view.title} ${view.summary}`).toMatch(/no payment/i);
    expect(`${view.title} ${view.summary}`).not.toMatch(/paystack/i);
  });

  it('a refund of an overpayment does not claim everything received was returned', () => {
    const view = paymentRecordView({
      ...base,
      state: 'refunded',
      paidAmountK: 1_000_000,
    });
    expect(view.summary).not.toMatch(/all of (the|what)[^.]*received/i);
    expect(view.summary).toMatch(/more than was charged/);
    expect(paymentRecordView({ ...base, state: 'refunded' }).summary).toMatch(/charged amount/);
  });

  it('never calls itself a tax document, and says it is not one', () => {
    expect(PAYMENT_RECORD_NOTICE).toMatch(/not a VAT invoice, tax invoice or tax receipt/);
    for (const state of billingPaymentState.options) {
      const { title, summary } = paymentRecordView({ ...base, state, reconciled: true });
      expect(`${title} ${summary}`).not.toMatch(/vat|tax/i);
    }
  });
});

describe('payment record timeline (OD-40)', () => {
  const times = {
    kind: 'add_on' as const,
    state: 'paid_applied' as const,
    noCharge: false,
    providerPaidAt: '2026-11-01T09:00:00.000Z',
    paidAt: '2026-11-01T09:05:00.000Z',
    providerSettledAt: '2026-11-02T12:00:00.000Z',
    unitsCreditedAt: '2026-11-01T09:05:01.000Z',
    failedAt: null,
  };

  it('an add-on with four distinct times shows each, labelled, in order', () => {
    expect(paymentRecordTimes(times)).toEqual([
      { label: 'Paid at Paystack on', iso: times.providerPaidAt },
      { label: 'Payment recorded by Rekoda on', iso: times.paidAt },
      { label: 'Settled by Paystack on', iso: times.providerSettledAt },
      { label: 'Units added on', iso: times.unitsCreditedAt },
    ]);
  });

  it('shows nothing it does not have, and no units row for a plan', () => {
    expect(
      paymentRecordTimes({
        ...times,
        kind: 'renewal',
        providerPaidAt: null,
        providerSettledAt: null,
      }).map((r) => r.label),
    ).toEqual(['Payment recorded by Rekoda on']);
  });

  it('a no-charge upgrade shows when it was applied, never a Paystack time', () => {
    expect(
      paymentRecordTimes({ ...times, kind: 'upgrade', noCharge: true }).map((r) => r.label),
    ).toEqual(['Applied on']);
  });
});

describe('payment record timeline as shown (Lagos)', () => {
  it('shows each of four distinct times in Lagos time, to the minute', () => {
    expect(
      paymentRecordTimeline({
        kind: 'add_on',
        state: 'paid_applied',
        noCharge: false,
        providerPaidAt: '2026-11-01T09:00:00.000Z',
        paidAt: '2026-11-01T09:07:00.000Z',
        providerSettledAt: '2026-11-02T23:30:00.000Z',
        unitsCreditedAt: '2026-11-01T09:08:00.000Z',
        failedAt: null,
      }),
    ).toEqual([
      { label: 'Paid at Paystack on', shown: '1 Nov 2026, 10:00 (Lagos time)' },
      { label: 'Payment recorded by Rekoda on', shown: '1 Nov 2026, 10:07 (Lagos time)' },
      { label: 'Settled by Paystack on', shown: '3 Nov 2026, 00:30 (Lagos time)' },
      { label: 'Units added on', shown: '1 Nov 2026, 10:08 (Lagos time)' },
    ]);
  });
});
