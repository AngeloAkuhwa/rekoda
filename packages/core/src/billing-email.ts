/**
 * The email a merchant pays Rekoda from (G-102, OWN-39).
 *
 * Paystack will not start a checkout without one, and Rekoda holds none for a
 * merchant: they sign in by phone. So it is asked for once, inside the payment
 * flow, and checked here before it is kept. Pure, no IO: the same function runs
 * wherever the address is accepted.
 *
 * OWN-39 fixes three refusals. The address is the merchant's or their billing
 * contact's, never invented (the caller supplies it or there is none), and
 * never one of Rekoda's own, which would route a merchant's receipts to us.
 * The third, never the owner's personal email by substitution, is the caller's
 * rule: this module only ever sees what a person typed.
 */

/** Domains that are Rekoda's own. An address here is a support or billing mailbox of ours, not a merchant's. */
export const REKODA_EMAIL_DOMAINS: readonly string[] = ['rekoda.app', 'rekoda.ng', 'rekoda.com'];

export type BillingEmailCheck =
  { ok: true; email: string } | { ok: false; reason: 'invalid' | 'too_long' | 'reserved' };

/** RFC 5321 limits: 254 for the whole address, 64 for the part before the @. */
const MAX_ADDRESS = 254;
const MAX_LOCAL = 64;

const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Trim, lower-case and judge one typed address. A syntactic check only: whether
 * the mailbox exists is Paystack's to find out, and it mails the receipt there.
 */
export function checkBillingEmail(raw: string): BillingEmailCheck {
  const email = raw.trim().toLowerCase();
  if (email.length > MAX_ADDRESS) return { ok: false, reason: 'too_long' };

  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return { ok: false, reason: 'invalid' };
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > MAX_LOCAL || !LOCAL.test(local)) return { ok: false, reason: 'invalid' };

  const labels = domain.split('.');
  const tld = labels[labels.length - 1] ?? '';
  if (labels.length < 2 || !labels.every((label) => label.length <= 63 && LABEL.test(label))) {
    return { ok: false, reason: 'invalid' };
  }
  if (!/^[a-z]{2,}$/.test(tld)) return { ok: false, reason: 'invalid' };

  if (REKODA_EMAIL_DOMAINS.some((own) => domain === own || domain.endsWith(`.${own}`))) {
    return { ok: false, reason: 'reserved' };
  }
  return { ok: true, email };
}
