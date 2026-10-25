import { describe, expect, it } from 'vitest';
import type { BillingOverviewResponse } from '@rekoda/contracts';
import { referenceFromQuery, returnView } from './billing-return';

type Charge = BillingOverviewResponse['charges'][number];
const charge = (over: Partial<Charge>): Charge => ({
  reference: 'RKD-SUB-20261025-AB12CD',
  kind: 'first_purchase',
  plan: 'chat',
  packId: null,
  packLabel: null,
  amountK: 990_000,
  refundedAmountK: 0,
  status: 'pending',
  periodStart: null,
  periodEnd: null,
  interval: 'monthly',
  superseded: false,
  createdAt: '2026-10-25T10:00:00.000Z',
  ...over,
});
const overview = (...charges: Charge[]) => ({ charges }) as unknown as BillingOverviewResponse;

describe('returnView', () => {
  it('shows a paid plan with its end date, and stops polling', () => {
    const view = returnView(
      overview(charge({ status: 'paid', periodEnd: '2026-11-25T10:00:00.000Z' })),
      'RKD-SUB-20261025-AB12CD',
    );
    expect(view).toMatchObject({ kind: 'paid', title: 'Payment received', poll: false });
    expect(view.body).toBe('Your Chat plan is active until 25 Nov 2026.');
  });

  it('finds the charge through a replacement attempt reference (-R2)', () => {
    const view = returnView(overview(charge({ status: 'paid' })), 'RKD-SUB-20261025-AB12CD-R2');
    expect(view.kind).toBe('paid');
  });

  it('says a pack was added', () => {
    const view = returnView(
      overview(charge({ kind: 'add_on', plan: null, packLabel: '100 messages', status: 'paid' })),
      'RKD-SUB-20261025-AB12CD',
    );
    expect(view.body).toBe('Your 100 messages pack has been added to this month.');
  });

  it('keeps asking while a payment is unconfirmed, and never claims it is paid', () => {
    const view = returnView(overview(charge({ status: 'pending' })), 'RKD-SUB-20261025-AB12CD');
    expect(view).toMatchObject({ kind: 'confirming', poll: true });
    expect(view.body).not.toMatch(/active|received/i);
  });

  it('does not say a payment failed unless Paystack reported it', () => {
    expect(
      returnView(overview(charge({ status: 'pending' })), 'RKD-SUB-20261025-AB12CD').title,
    ).not.toMatch(/did not go through/);
    const failed = returnView(overview(charge({ status: 'failed' })), 'RKD-SUB-20261025-AB12CD');
    expect(failed).toMatchObject({ kind: 'failed', poll: false });
    expect(failed.body).toContain('your plan has not changed');
  });

  it('handles refunded, replaced and unknown payments without polling', () => {
    expect(
      returnView(overview(charge({ status: 'refunded' })), 'RKD-SUB-20261025-AB12CD').kind,
    ).toBe('refunded');
    expect(
      returnView(
        overview(charge({ status: 'pending', superseded: true })),
        'RKD-SUB-20261025-AB12CD',
      ).kind,
    ).toBe('replaced');
    for (const ref of [null, 'RKD-SUB-20261025-ZZZZZZ']) {
      expect(returnView(overview(charge({})), ref)).toMatchObject({ kind: 'unknown', poll: false });
    }
  });

  it('ignores any outcome claimed in the address: only the held charge decides', () => {
    // The page gets only a reference; there is no "status" input to forge.
    expect(
      returnView(overview(charge({ status: 'pending' })), 'RKD-SUB-20261025-AB12CD').kind,
    ).toBe('confirming');
  });
});

describe('referenceFromQuery', () => {
  it('takes reference, then trxref, and rejects anything odd', () => {
    expect(referenceFromQuery({ reference: 'RKD-SUB-20261025-AB12CD' })).toBe(
      'RKD-SUB-20261025-AB12CD',
    );
    expect(referenceFromQuery({ trxref: 'RKD-SUB-20261025-AB12CD' })).toBe(
      'RKD-SUB-20261025-AB12CD',
    );
    expect(referenceFromQuery({ reference: ['RKD-SUB-20261025-AB12CD', 'x'] })).toBe(
      'RKD-SUB-20261025-AB12CD',
    );
    expect(referenceFromQuery({ reference: '<script>alert(1)</script>' })).toBeNull();
    expect(referenceFromQuery({ reference: '' })).toBeNull();
    expect(referenceFromQuery({})).toBeNull();
    expect(referenceFromQuery({ reference: 'x'.repeat(200) })).toBeNull();
  });
});
