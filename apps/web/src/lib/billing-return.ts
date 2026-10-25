import { chargeReferenceOf } from '@rekoda/core';
import type { BillingOverviewResponse } from '@rekoda/contracts';

/**
 * What the merchant sees when Paystack sends them back to Rekoda after paying.
 *
 * The query string is never trusted for the outcome: it only says WHICH payment to look at. The
 * answer comes from the charge Rekoda holds, which only a verified payment can change, so a
 * hand-typed `?reference=` cannot show "paid".
 */
export type ReturnKind = 'paid' | 'confirming' | 'failed' | 'refunded' | 'replaced' | 'unknown';

export interface ReturnView {
  kind: ReturnKind;
  title: string;
  body: string;
  /** Ask the server again shortly: the payment may not have been confirmed yet. */
  poll: boolean;
}

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/;

/** The payment reference Paystack appended (`reference`, or `trxref`), or null when it is not usable. */
export function referenceFromQuery(query: {
  reference?: string | string[];
  trxref?: string | string[];
}): string | null {
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const raw = (pick(query.reference) ?? pick(query.trxref) ?? '').trim();
  return REFERENCE.test(raw) ? raw : null;
}

const PLAN_NAMES: Record<string, string> = {
  chat: 'Chat',
  integrate: 'Integrate',
  complete: 'Complete',
};

function lagosDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function returnView(
  overview: BillingOverviewResponse,
  providerReference: string | null,
): ReturnView {
  const charge = providerReference
    ? overview.charges.find((c) => c.reference === chargeReferenceOf(providerReference))
    : undefined;
  if (!charge) {
    return {
      kind: 'unknown',
      title: 'We could not find that payment',
      body: 'It is not on your account, so nothing has changed. Your billing page lists every payment made to Rekoda.',
      poll: false,
    };
  }
  if (charge.status === 'paid') {
    const plan = charge.plan ? (PLAN_NAMES[charge.plan] ?? charge.plan) : null;
    const until = charge.periodEnd ? ` until ${lagosDate(charge.periodEnd)}` : '';
    const what =
      charge.kind === 'add_on'
        ? `Your ${charge.packLabel ? `${charge.packLabel} pack` : 'extra units'} has been added to this month.`
        : plan
          ? `Your ${plan} plan is active${until}.`
          : 'Your payment has been applied.';
    return { kind: 'paid', title: 'Payment received', body: what, poll: false };
  }
  if (charge.status === 'refunded') {
    return {
      kind: 'refunded',
      title: 'This payment was refunded',
      body: 'The money has been returned to you. Your billing page shows what is active now.',
      poll: false,
    };
  }
  if (charge.status === 'failed') {
    return {
      kind: 'failed',
      title: 'That payment did not go through',
      body: 'Paystack reported that it was not completed, so your plan has not changed. You can try again from your billing page.',
      poll: false,
    };
  }
  if (charge.superseded) {
    return {
      kind: 'replaced',
      title: 'That payment was replaced by a newer choice',
      body: 'You chose something else after starting it, so this one can no longer be paid. Your billing page shows the current choice.',
      poll: false,
    };
  }
  return {
    kind: 'confirming',
    title: 'Confirming your payment',
    body: 'Paystack is confirming it with us. This usually takes under a minute, and your plan switches on by itself as soon as it does. You can leave this page.',
    poll: true,
  };
}
