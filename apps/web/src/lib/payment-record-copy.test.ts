import { describe, expect, it } from 'vitest';
import { billingPaymentState } from '@rekoda/contracts';
import { PAYMENT_RECORD_NOTICE, paymentRecordView } from './payment-record-copy';

describe('payment record copy', () => {
  it('has words for every state the API can send', () => {
    for (const state of billingPaymentState.options) {
      const view = paymentRecordView({ state, reconciled: false });
      expect(view.title.length).toBeGreaterThan(0);
      expect(view.summary.length).toBeGreaterThan(0);
    }
  });

  it('only a paid state claims the provider confirmed a payment', () => {
    const confirmed = billingPaymentState.options.filter(
      (state) => paymentRecordView({ state, reconciled: false }).confirmed,
    );
    expect(confirmed.sort()).toEqual(
      ['paid_applied', 'paid_not_applied', 'part_refunded', 'refunded'].sort(),
    );
  });

  it('a started or replaced payment never reads as paid or active', () => {
    for (const state of ['awaiting_payment', 'replaced'] as const) {
      const { summary, title } = paymentRecordView({ state, reconciled: false });
      expect(`${title} ${summary}`).toMatch(/no payment has been confirmed/i);
      expect(`${title} ${summary}`).not.toMatch(/confirmed this payment|applied to your account/i);
    }
  });

  it('money received after a newer choice says it is not applied and not a subscription', () => {
    const { summary } = paymentRecordView({ state: 'paid_not_applied', reconciled: false });
    expect(summary).toMatch(/not applied/i);
    expect(summary).toMatch(/does not make a subscription active/i);
  });

  it('never calls itself a tax document, and says it is not one', () => {
    expect(PAYMENT_RECORD_NOTICE).toMatch(/not a VAT invoice, tax invoice or tax receipt/);
    for (const state of billingPaymentState.options) {
      const { title, summary } = paymentRecordView({ state, reconciled: true });
      expect(`${title} ${summary}`).not.toMatch(/vat|tax/i);
    }
  });
});
