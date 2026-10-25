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
  applied: false,
  createdAt: '2026-10-25T10:00:00.000Z',
  ...over,
});
const overview = (...charges: Charge[]) =>
  ({
    plan: 'chat',
    status: { state: 'active', renewsAt: '2026-11-27T10:00:00.000Z' },
    charges,
  }) as unknown as BillingOverviewResponse;

describe('returnView', () => {
  it('shows the paid-to date the account holds, not the date quoted when checkout opened', () => {
    // Opened on 25 Oct (quoted to 25 Nov) and paid on 27 Oct: the cycle runs to 27 Nov.
    const view = returnView(
      overview(charge({ status: 'paid', applied: true, periodEnd: '2026-11-25T10:00:00.000Z' })),
      'RKD-SUB-20261025-AB12CD',
    );
    expect(view).toMatchObject({ kind: 'paid', title: 'Payment received', poll: false });
    expect(view.body).toBe('Your Chat plan is active until 27 Nov 2026.');
  });

  it('does not say a plan is active when the payment was received but not applied', () => {
    const view = returnView(
      overview(charge({ status: 'paid', applied: false })),
      'RKD-SUB-20261025-AB12CD',
    );
    expect(view).toMatchObject({ kind: 'paid_not_applied', poll: false });
    expect(view.body).not.toMatch(/is active/);
    // It does not guess why (a changed choice, an ended cycle, a support review).
    expect(view.body).not.toMatch(/changed|choice|ended|whatsapp|put it right/i);
    expect(view.body).toContain('recorded as paid, but it has not been applied');
    expect(view.body).toContain('operator review');
    expect(view.body).toContain('RKD-SUB-20261025-AB12CD');
  });

  it('makes no date claim when the account is not in an active cycle or is on another plan', () => {
    const other = {
      plan: 'complete',
      status: { state: 'active', renewsAt: '2026-11-27T10:00:00.000Z' },
      charges: [charge({ status: 'paid', applied: true, plan: 'chat' })],
    } as unknown as BillingOverviewResponse;
    expect(returnView(other, 'RKD-SUB-20261025-AB12CD').body).not.toMatch(/until/);
    const grace = {
      plan: 'chat',
      status: { state: 'grace', endsAt: '2026-11-01T10:00:00.000Z', daysLeft: 3 },
      charges: [charge({ status: 'paid', applied: true })],
    } as unknown as BillingOverviewResponse;
    expect(returnView(grace, 'RKD-SUB-20261025-AB12CD').body).not.toMatch(/until/);
  });

  it('finds the charge through a replacement attempt reference (-R2)', () => {
    const view = returnView(
      overview(charge({ status: 'paid', applied: true })),
      'RKD-SUB-20261025-AB12CD-R2',
    );
    expect(view.kind).toBe('paid');
  });

  it('says a pack was added', () => {
    const view = returnView(
      overview(
        charge({
          kind: 'add_on',
          plan: null,
          packLabel: '100 messages',
          status: 'paid',
          applied: true,
        }),
      ),
      'RKD-SUB-20261025-AB12CD',
    );
    expect(view.body).toBe('Your 100 messages pack has been added to your account.');
    // No month is named, so reopening the page in a later month stays true.
    expect(view.body).not.toMatch(/this month/);
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

  it('keeps checking a replaced checkout, because its hosted page can still be paid late', () => {
    const view = returnView(
      overview(charge({ status: 'pending', superseded: true })),
      'RKD-SUB-20261025-AB12CD',
    );
    expect(view).toMatchObject({ kind: 'replaced', poll: true });
    expect(view.body).not.toMatch(/no longer be paid|cannot be paid/);
  });

  it('handles refunded and unknown payments without polling', () => {
    expect(
      returnView(overview(charge({ status: 'refunded' })), 'RKD-SUB-20261025-AB12CD').kind,
    ).toBe('refunded');
    for (const ref of [null, 'RKD-SUB-20261025-ZZZZZZ']) {
      const unknown = returnView(overview(charge({})), ref);
      expect(unknown).toMatchObject({ kind: 'unknown', poll: false });
      // It says only that the payment is not among the latest ones shown, never that it is not on the account.
      expect(unknown.body).toContain('not among your most recent payments');
      expect(unknown.body).not.toMatch(/not on your account|could not find/i);
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
