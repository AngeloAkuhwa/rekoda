import { describe, expect, it } from 'vitest';
import { paymentRecordState, type PaymentRecordFacts } from './payment-record.js';

const base: PaymentRecordFacts = {
  status: 'paid',
  replaced: false,
  unapplied: false,
  amountK: 990_000,
  refundedAmountK: 0,
};
const state = (over: Partial<PaymentRecordFacts>) => paymentRecordState({ ...base, ...over });

describe('paymentRecordState', () => {
  it('a started payment is awaiting payment, never paid', () => {
    expect(state({ status: 'pending' })).toBe('awaiting_payment');
  });
  it('a pending charge the account replaced can no longer be paid', () => {
    expect(state({ status: 'pending', replaced: true })).toBe('replaced');
  });
  it('a failed payment is failed', () => {
    expect(state({ status: 'failed' })).toBe('failed');
  });
  it('a verified payment that took effect is paid and applied', () => {
    expect(state({})).toBe('paid_applied');
  });
  it('money received but refused as stale is not an applied payment', () => {
    expect(state({ unapplied: true })).toBe('paid_not_applied');
  });
  it('a part-refunded payment says so and is not reported as fully refunded', () => {
    expect(state({ refundedAmountK: 100_000 })).toBe('part_refunded');
  });
  it('a fully refunded payment is refunded', () => {
    expect(state({ status: 'refunded', refundedAmountK: 990_000 })).toBe('refunded');
  });
  it('the replaced and unapplied flags mean nothing on a state they do not belong to', () => {
    expect(state({ status: 'failed', replaced: true, unapplied: true })).toBe('failed');
    expect(state({ replaced: true })).toBe('paid_applied');
  });
});
