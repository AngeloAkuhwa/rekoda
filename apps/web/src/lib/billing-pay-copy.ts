/**
 * The sentences on the billing page's payment, email and trial surfaces (G-102 slice 2c).
 *
 * Kept out of the components so a test can pin each one. The rules they hold:
 * a payment that was never attempted is never called failed; a trial is
 * described plainly, with no countdown pressure; nothing here computes a price
 * (every figure arrives from the API in kobo and is rendered by `Money`).
 */
import type {
  BillingChargeView,
  BillingCheckoutResponse,
  BillingEmailConfirmResponse,
  BillingEmailVerifyResponse,
} from '@rekoda/contracts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days left in a trial, never negative. Any time left rounds up to a day; 0 only once the end has passed. */
export function trialDaysLeft(endsAtIso: string, now: Date): number {
  const left = new Date(endsAtIso).getTime() - now.getTime();
  return left <= 0 ? 0 : Math.ceil(left / DAY_MS);
}

/**
 * The line under "Current plan" for a trial. Calm throughout: the days left are
 * a fact, the last few days get one gentle sentence, and nothing is bold, red
 * or counted down.
 */
export function trialCopy(endsOn: string | null, daysLeft: number | null): string {
  if (endsOn === null || daysLeft === null) return 'Your free trial is running. No card needed.';
  if (daysLeft === 0) {
    return `Your free trial ends today, ${endsOn}. Choose a plan below when you are ready to carry on. No card needed to look around.`;
  }
  const days = daysLeft === 1 ? '1 day' : `${daysLeft} days`;
  const base = `${days} left in your free trial, which runs until ${endsOn}. No card needed.`;
  return daysLeft <= 3 ? `${base} Choose a plan below any time to carry on without a break.` : base;
}

/** The newest charge still waiting for money and still payable, or null. Newest first, as the API lists them. */
export function pendingCharge(
  charges: readonly BillingChargeView[],
  preferred?: string,
): BillingChargeView | null {
  const waiting = charges.filter((charge) => charge.status === 'pending' && !charge.superseded);
  return waiting.find((charge) => charge.reference === preferred) ?? waiting[0] ?? null;
}

/**
 * The newest charge, when it is a payment that was tried and did not go
 * through and nothing is waiting. A pending charge never reads as failed.
 */
export function lastPaymentFailed(charges: readonly BillingChargeView[]): BillingChargeView | null {
  const newest = charges[0];
  return newest && newest.status === 'failed' ? newest : null;
}

/**
 * Only a web page is followed: https, or http on this machine itself (the test double a developer
 * runs; Paystack never answers with it). Anything else, such as a `javascript:` link, is refused.
 */
export function safeCheckoutUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.toString();
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  return url.protocol === 'http:' && loopback ? url.toString() : null;
}

/** What a checkout answer that is not a link says. Each begins with what happened to the money. */
export function checkoutRefusalCopy(answer: Exclude<BillingCheckoutResponse, { state: 'ready' }>): {
  message: string;
  askEmail?: boolean;
} {
  switch (answer.state) {
    case 'requires_billing_email':
      return {
        message:
          'Nothing was charged. Paystack needs an email address for your receipt: add it below.',
        askEmail: true,
      };
    case 'requires_billing_email_verification':
      return {
        message: `Nothing was charged. Before a real payment we need to know the mailbox ${answer.maskedEmail} is yours. Send yourself the confirmation link in "Billing email" below, open it, then come back and pay.`,
      };
    case 'invalid_billing_email':
      return { message: invalidEmailCopy(answer.reason), askEmail: true };
    case 'unavailable':
      return {
        message: unavailableCopy(answer.reason),
        /* "Try another one" needs somewhere to type it, even when an address is already on file. */
        ...(answer.reason === 'provider_rejected_billing_email' ? { askEmail: true } : {}),
      };
  }
}

export function invalidEmailCopy(reason: 'invalid' | 'too_long' | 'reserved'): string {
  switch (reason) {
    case 'too_long':
      return 'That email address is too long. Nothing was charged.';
    case 'reserved':
      return 'That address cannot receive mail from us. Use an address you read yourself. Nothing was charged.';
    case 'invalid':
      return 'That does not look like an email address. Check it and try again. Nothing was charged.';
  }
}

function unavailableCopy(
  reason: Extract<BillingCheckoutResponse, { state: 'unavailable' }>['reason'],
): string {
  switch (reason) {
    case 'payment_received':
      return 'Paystack says this payment already went through. Your receipt and plan will show here shortly. You do not need to pay again.';
    case 'payment_in_progress':
      return 'A payment on your last link is still going through at Paystack. Please wait a few minutes and refresh this page before asking for another link, so you are not charged twice.';
    case 'checkout_in_progress':
      return 'We are still setting up your payment link. Wait a moment and try again. Nothing was charged.';
    case 'too_many_attempts':
      return 'This payment has used all its attempts, so our team has to check it with you. Message us on WhatsApp with the reference. Nothing more will be charged.';
    case 'superseded':
      return 'This payment request was replaced by a newer one. Choose your plan again below. Nothing was charged.';
    case 'cycle_ended':
    case 'support_review':
      return 'This one needs a quick check by our team. Message upgrade on WhatsApp and we will sort it out with you. Nothing was charged.';
    case 'not_pending':
    case 'nothing_to_pay':
      return 'There is nothing left to pay on this one.';
    case 'unknown_charge':
      return 'We could not find that payment request. Nothing was charged.';
    case 'provider_rejected_billing_email':
      return 'Paystack did not accept that email address. Try another one. Nothing was charged.';
    case 'awaiting_platform_confirmation':
      return 'Card payments are not switched on yet. Nothing was charged. Message upgrade on WhatsApp and we will move you across by hand.';
    case 'payments_not_configured':
      return 'Payments are not available right now. Nothing was charged. Message upgrade on WhatsApp and we will help.';
  }
}

/** The answer to "send me the confirmation link". */
export function emailVerifyCopy(answer: BillingEmailVerifyResponse): {
  ok: boolean;
  message: string;
} {
  switch (answer.state) {
    case 'sent':
      return {
        ok: true,
        message: `We sent a confirmation link to ${answer.maskedEmail}. Open it while you are signed in to Rekoda. It works once and lasts one hour.`,
      };
    case 'already_verified':
      return { ok: true, message: `${answer.maskedEmail} is already confirmed.` };
    case 'requires_billing_email':
      return { ok: false, message: 'Enter your billing email first.' };
    case 'invalid_billing_email':
      return { ok: false, message: invalidEmailCopy(answer.reason) };
    case 'unavailable':
      return {
        ok: false,
        message:
          answer.reason === 'email_not_configured'
            ? 'We cannot send confirmation emails yet. Your address is fine; we will tell you when this is switched on.'
            : 'We could not send that email just now. Try again in a few minutes.',
      };
    case 'rate_limited': {
      const minutes = Math.max(1, Math.ceil(answer.retryAfterSeconds / 60));
      return {
        ok: false,
        message:
          answer.retryAfterSeconds < 60
            ? 'A link was only just sent. Check your inbox, or ask again in a minute.'
            : `You have asked for several links. Please try again in about ${minutes} minutes.`,
      };
    }
  }
}

/** The page the emailed link opens. `none` is a page opened without the link's fragment. */
export type ConfirmState = BillingEmailConfirmResponse['state'] | 'none' | 'not_owner' | 'error';

export function confirmCopy(state: ConfirmState): { title: string; body: string } {
  switch (state) {
    case 'verified':
      return {
        title: 'Billing email confirmed',
        body: 'Thank you. This address can now be used for your Rekoda payments.',
      };
    case 'expired':
      return {
        title: 'This link has expired',
        body: 'Links last one hour. Ask for a new one on the billing page and open it straight away.',
      };
    case 'address_changed':
      return {
        title: 'You changed your billing email since this link was sent',
        body: 'This link was for the earlier address. Use the newest link we sent, or ask for a new one on the billing page.',
      };
    case 'invalid':
      return {
        title: 'This link did not work',
        body: 'It may have been used already, or it was sent for a different Rekoda account. Check you are signed in to the right account, or ask for a new link on the billing page.',
      };
    case 'not_owner':
      return {
        title: 'Only the owner can confirm this',
        body: 'Billing is the owner’s to manage. Ask the owner to open the link from their own sign-in.',
      };
    case 'error':
      return {
        title: 'We could not check that just now',
        body: 'Nothing was changed. Try the button again in a moment.',
      };
    case 'none':
      return {
        title: 'Open the link from your email',
        body: 'This page needs the full link we emailed you, including everything after the #. Open it from the email again, or ask for a new one on the billing page.',
      };
  }
}

/**
 * The confirmation token in a URL fragment: `#token=...`, or a bare token. Anything shorter than a
 * real token (such as an empty `#token=`) is treated as missing, so no dead button is shown.
 */
export function tokenFromFragment(hash: string): string | null {
  const raw = hash.replace(/^#/, '');
  const candidate = raw.startsWith('token=') ? raw.slice('token='.length) : raw;
  return candidate.length >= 16 ? candidate : null;
}

/** The limits the API enforces, checked first so an out-of-range value gets a sentence, not an error page. */
export function checkoutInputProblem(reference: string, billingEmail: string): string | null {
  if (reference.length === 0 || reference.length > 64) {
    return 'We could not find that payment request. Nothing was charged.';
  }
  return billingEmailLengthProblem(billingEmail);
}

export function billingEmailLengthProblem(billingEmail: string): string | null {
  return billingEmail.length > 320 ? 'That email address is too long. Nothing was charged.' : null;
}
