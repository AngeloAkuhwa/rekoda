import { chargeReferenceOf } from '@rekoda/core';
import type { BillingOverviewResponse } from '@rekoda/contracts';

/**
 * What the merchant sees when Paystack sends them back to Rekoda after paying.
 *
 * The query string is never trusted for the outcome: it only says WHICH payment to look at. The
 * answer comes from the charge Rekoda holds, which only a verified payment can change, so a
 * hand-typed `?reference=` cannot show "paid".
 */
export type ReturnKind =
  'paid' | 'paid_not_applied' | 'confirming' | 'failed' | 'refunded' | 'replaced' | 'unknown';

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
      body: 'It is not among your most recent payments, so nothing has changed. Your billing page lists your latest payments to Rekoda.',
      poll: false,
    };
  }
  if (charge.status === 'paid') {
    /* Money arrived, but only an APPLIED charge changed the account. A payment that landed after a
     * newer decision (the merchant changed their mind, or the cycle moved) was received and
     * refused as stale (OD-30), so it must not read "active". */
    if (!charge.applied) {
      return {
        kind: 'paid_not_applied',
        title: 'Payment received, but not applied',
        body: `Your payment arrived after your plan choice had changed, so it has not switched anything on. Nothing is lost: message us on WhatsApp with reference ${charge.reference} and we will put it right.`,
        poll: false,
      };
    }
    if (charge.kind === 'add_on') {
      return {
        kind: 'paid',
        title: 'Payment received',
        body: `Your ${charge.packLabel ? `${charge.packLabel} pack` : 'extra units'} has been added to this month.`,
        poll: false,
      };
    }
    /* The date comes from the cycle the account actually holds, not from the date quoted when the
     * checkout was opened: a payment made days later starts its cycle when it settles. */
    const plan = charge.plan ? (PLAN_NAMES[charge.plan] ?? charge.plan) : null;
    if (plan && overview.plan === charge.plan && overview.status.state === 'active') {
      return {
        kind: 'paid',
        title: 'Payment received',
        body: `Your ${plan} plan is active until ${lagosDate(overview.status.renewsAt)}.`,
        poll: false,
      };
    }
    return {
      kind: 'paid',
      title: 'Payment received',
      body: 'Your payment has been applied. Your billing page shows what is active now.',
      poll: false,
    };
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
    body: 'We have not had Paystack’s confirmation yet. If you completed the payment, this usually takes under a minute and your plan switches on by itself. If you left without paying, nothing was charged. You can leave this page.',
    poll: true,
  };
}
