import type { BillingChargeView } from '@rekoda/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkoutInputProblem,
  checkoutRefusalCopy,
  confirmCopy,
  emailVerifyCopy,
  lastPaymentFailed,
  needsEmailInput,
  payHeading,
  pendingCharge,
  safeCheckoutUrl,
  tokenFromFragment,
  trialCopy,
  trialDaysLeft,
  trialMilestone,
} from './billing-pay-copy';
import { chargeStatusLabel } from './charge-status';

const charge = (reference: string, status: BillingChargeView['status']): BillingChargeView => ({
  reference,
  kind: 'first_purchase',
  plan: 'chat',
  packId: null,
  packLabel: null,
  amountK: 990_000,
  refundedAmountK: 0,
  status,
  periodStart: null,
  periodEnd: null,
  interval: 'monthly',
  superseded: false,
  applied: false,
  createdAt: '2026-10-20T10:00:00.000Z',
});

describe('trial wording (G-102 slice 2c)', () => {
  const now = new Date('2026-10-24T09:00:00Z');
  it('counts whole days left, never below zero', () => {
    expect(trialDaysLeft('2026-11-03T09:00:00Z', now)).toBe(10);
    expect(trialDaysLeft('2026-10-24T09:30:00Z', now)).toBe(1);
    expect(trialDaysLeft('2026-10-20T09:00:00Z', now)).toBe(0);
  });
  it('states the days plainly, with no urgency words', () => {
    for (const days of [14, 7, 3, 1, 0]) {
      expect(trialCopy('3 Nov 2026', days)).not.toMatch(
        /hurry|last chance|only|!|expires soon|act now/i,
      );
    }
    expect(trialCopy('3 Nov 2026', 10)).toBe(
      '10 days left in your free trial, which runs until 3 Nov 2026. No card needed.',
    );
    expect(trialCopy('3 Nov 2026', 1)).toMatch(/^1 day left/);
  });
  it('adds one gentle sentence only in the last days', () => {
    expect(trialCopy('3 Nov 2026', 4)).not.toMatch(/Choose a plan/);
    expect(trialCopy('3 Nov 2026', 3)).toMatch(/Choose a plan below any time/);
  });
  it('copes with a trial that has no end date', () => {
    expect(trialCopy(null, null)).toMatch(/No card needed/);
  });
});

describe('what is waiting and what failed', () => {
  it('offers the newest pending charge, or the one named', () => {
    const list = [charge('B', 'pending'), charge('A', 'pending')];
    expect(pendingCharge(list)?.reference).toBe('B');
    expect(pendingCharge(list, 'A')?.reference).toBe('A');
    expect(pendingCharge(list, 'ZZZ')?.reference).toBe('B');
    expect(pendingCharge([charge('C', 'paid')])).toBeNull();
  });
  it('labels a replaced pending charge as replaced, not awaiting payment', () => {
    expect(chargeStatusLabel('pending', true)).toBe('Replaced by a newer choice');
    expect(chargeStatusLabel('pending')).toBe('Awaiting payment');
    expect(chargeStatusLabel('paid', true)).toBe('Paid');
  });
  it('never offers a charge the server has replaced', () => {
    const replaced = { ...charge('OLD', 'pending'), superseded: true };
    expect(pendingCharge([replaced])).toBeNull();
    expect(pendingCharge([replaced, charge('LIVE', 'pending')])?.reference).toBe('LIVE');
    expect(pendingCharge([replaced, charge('LIVE', 'pending')], 'OLD')?.reference).toBe('LIVE');
  });
  it('never calls a pending charge failed', () => {
    expect(lastPaymentFailed([charge('B', 'pending')])).toBeNull();
    expect(chargeStatusLabel('pending')).toBe('Awaiting payment');
    expect(chargeStatusLabel('pending')).not.toMatch(/fail|did not/i);
  });
  it('reports a failed newest charge only', () => {
    expect(lastPaymentFailed([charge('F', 'failed'), charge('P', 'paid')])?.reference).toBe('F');
    expect(lastPaymentFailed([charge('P', 'paid'), charge('F', 'failed')])).toBeNull();
    expect(lastPaymentFailed([])).toBeNull();
  });
});

describe('the checkout link is only followed when it is safe', () => {
  it('accepts https and loopback http, and nothing else', () => {
    expect(safeCheckoutUrl('https://checkout.paystack.com/abc')).toBe(
      'https://checkout.paystack.com/abc',
    );
    expect(safeCheckoutUrl('http://127.0.0.1:9/x')).toBe('http://127.0.0.1:9/x');
    expect(safeCheckoutUrl('http://evil.example/x')).toBeNull();
    expect(safeCheckoutUrl('javascript:alert(1)')).toBeNull();
    expect(safeCheckoutUrl('not a url')).toBeNull();
  });
});

describe('checkout refusals say what happened to the money', () => {
  it('asks for the email inside the payment flow', () => {
    const r = checkoutRefusalCopy({ state: 'requires_billing_email' });
    expect(r.askEmail).toBe(true);
    expect(r.message).toMatch(/Nothing was charged/);
  });
  it('shows the email input again when Paystack rejects the address on file', () => {
    const r = checkoutRefusalCopy({
      state: 'unavailable',
      reason: 'provider_rejected_billing_email',
    });
    expect(r.askEmail).toBe(true);
    expect(r.message).toMatch(/Try another one/);
    expect(
      checkoutRefusalCopy({ state: 'unavailable', reason: 'superseded' }).askEmail,
    ).toBeUndefined();
  });
  it('explains the live-key mailbox rule honestly', () => {
    const r = checkoutRefusalCopy({
      state: 'requires_billing_email_verification',
      maskedEmail: 'a***@x.ng',
    });
    expect(r.message).toMatch(/Nothing was charged/);
    expect(r.message).toMatch(/a\*\*\*@x\.ng/);
    expect(r.message).toMatch(/confirmation link/);
  });
  it('does not tell a merchant who is mid-payment that nothing happened', () => {
    const waiting = checkoutRefusalCopy({ state: 'unavailable', reason: 'payment_in_progress' });
    expect(waiting.message).not.toMatch(/failed|Nothing was charged/);
    expect(waiting.message).toMatch(/wait/);
    expect(
      checkoutRefusalCopy({ state: 'unavailable', reason: 'payment_received' }).message,
    ).toMatch(/do not need to pay again/);
  });
  it('never says a payment failed for a refusal where none was attempted', () => {
    const reasons = [
      'unknown_charge',
      'not_pending',
      'superseded',
      'cycle_ended',
      'support_review',
      'nothing_to_pay',
      'payments_not_configured',
      'awaiting_platform_confirmation',
      'provider_rejected_billing_email',
      'payment_received',
      'payment_in_progress',
      'checkout_in_progress',
      'too_many_attempts',
    ] as const;
    for (const reason of reasons) {
      expect(checkoutRefusalCopy({ state: 'unavailable', reason }).message).not.toMatch(
        /payment failed|failed/i,
      );
    }
  });
});

describe('billing email and confirmation wording', () => {
  it('covers every send outcome', () => {
    expect(emailVerifyCopy({ state: 'sent', maskedEmail: 'a***@x.ng' }).ok).toBe(true);
    expect(
      emailVerifyCopy({ state: 'unavailable', reason: 'email_not_configured' }).message,
    ).toMatch(/cannot send confirmation emails yet/);
    expect(emailVerifyCopy({ state: 'unavailable', reason: 'address_unusable' }).message).toMatch(
      /cannot send email to that address/,
    );
    expect(emailVerifyCopy({ state: 'unavailable', reason: 'send_failed' }).message).toMatch(
      /Try again in a few minutes/,
    );
    expect(emailVerifyCopy({ state: 'rate_limited', retryAfterSeconds: 3600 }).message).toMatch(
      /60 minutes/,
    );
    expect(emailVerifyCopy({ state: 'rate_limited', retryAfterSeconds: 20 }).message).toMatch(
      /a minute/,
    );
  });
  it('says an uncertain send may or may not have arrived, and never that it failed or was sent', () => {
    const { ok, message } = emailVerifyCopy({
      state: 'delivery_uncertain',
      maskedEmail: 'a***@x.ng',
      retryAfterSeconds: 60,
    });
    expect(ok).toBe(false);
    expect(message).toMatch(/may or may not arrive/);
    expect(message).toMatch(/link we made still works/);
    expect(message).not.toMatch(/could not send|did not send|we sent/i);
  });
  it('has a distinct, calm sentence for each way a link can end', () => {
    const states = [
      'verified',
      'expired',
      'address_changed',
      'invalid',
      'not_owner',
      'error',
      'none',
    ] as const;
    const titles = new Set(states.map((s) => confirmCopy(s).title));
    expect(titles.size).toBe(states.length);
    expect(confirmCopy('invalid').body).toMatch(/used already|different Rekoda account/);
  });
});

describe('values that reach the checkout and confirmation forms', () => {
  it('reads a token from the fragment and treats an empty or short one as missing', () => {
    const token = 'x'.repeat(30); // gitleaks:allow (a fixture of no entropy, not a credential)
    expect(tokenFromFragment(`#token=${token}`)).toBe(token);
    expect(tokenFromFragment(`#${token}`)).toBe(token);
    expect(tokenFromFragment('#token=')).toBeNull();
    expect(tokenFromFragment('#token=short')).toBeNull();
    expect(tokenFromFragment('')).toBeNull();
  });
  it('turns an out-of-range reference or address into a sentence before the API is called', () => {
    expect(checkoutInputProblem('REF-1', 'a@b.ng')).toBeNull();
    expect(checkoutInputProblem('', '')).toMatch(/Nothing was charged/);
    expect(checkoutInputProblem('x'.repeat(65), '')).toMatch(/Nothing was charged/);
    expect(checkoutInputProblem('REF-1', 'a'.repeat(321))).toMatch(/too long/);
    expect(checkoutInputProblem('REF-1', 'a'.repeat(320))).toBeNull();
  });
});

describe('when the payment form asks for an email', () => {
  it('asks when none is on file, or when paying or link recovery asks for another', () => {
    expect(needsEmailInput(null)).toBe(true);
    expect(needsEmailInput('a***@x.ng', {}, {})).toBe(false);
    expect(needsEmailInput('a***@x.ng', { askEmail: true }, {})).toBe(true);
    expect(needsEmailInput('a***@x.ng', {}, { askEmail: true })).toBe(true);
  });
});

describe('the heading over a waiting charge', () => {
  it('names a plan or an add-on, never calls a pack a plan', () => {
    expect(payHeading('first_purchase')).toBe('Pay for your plan');
    expect(payHeading('renewal')).toBe('Pay for your plan');
    expect(payHeading('upgrade')).toBe('Pay for your plan');
    expect(payHeading('add_on')).toBe('Pay for your add-on');
    expect(payHeading('seat')).toBe('Pay for your add-on');
  });
});

describe('trialMilestone', () => {
  it('names a moment only at the milestones, never every day', () => {
    expect(trialMilestone(14)?.kind).toBe('start');
    expect(trialMilestone(13)?.kind).toBe('start');
    expect(trialMilestone(10)).toBeNull();
    expect(trialMilestone(7)?.kind).toBe('halfway');
    expect(trialMilestone(6)?.kind).toBe('halfway');
    expect(trialMilestone(5)).toBeNull();
    expect(trialMilestone(3)?.kind).toBe('ending');
    expect(trialMilestone(2)?.kind).toBe('ending');
    expect(trialMilestone(1)?.kind).toBe('last');
    expect(trialMilestone(0)?.kind).toBe('last');
  });

  it('always says records stay safe near the end, and never invents a charge', () => {
    for (const days of [3, 2, 1, 0]) {
      const m = trialMilestone(days);
      expect(m?.body).toMatch(/records (are|stay) safe/i);
      expect(m?.body).not.toMatch(/payment|failed|charged/i);
    }
  });

  it('never says tomorrow or today: days left rounds up, so the end may be hours away', () => {
    for (const days of [1, 0]) {
      expect(trialMilestone(days)?.heading).toBe('Your trial ends soon');
    }
  });
});
