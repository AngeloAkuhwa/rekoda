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
import { createHash } from 'node:crypto';

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

/* ── proving the mailbox is the merchant's (G-102 slice 2b, OWN-51) ─────────── */

/**
 * The rules for confirming a billing email. A confirmation link is a bearer
 * secret mailed to the address: whoever opens it proves they can read that
 * mailbox, so it expires, works once, and is useless once the address changes.
 */
export const BILLING_EMAIL_VERIFICATION = {
  /** How long a mailed link works. */
  ttlMs: 60 * 60 * 1000,
  /** At most this many links may be requested for one business in an hour. */
  maxPerHour: 5,
  /** The wait between one request and the next, so a double click mails once. */
  cooldownMs: 60 * 1000,
  /**
   * The same address, whichever businesses ask (SUB-02a; OWN-58 owner ruling, 2 Nov 2026): at most
   * five requests an hour per trimmed, lower-cased address across all businesses, and at least
   * sixty seconds between them. A request whose send outcome is unknown counts; only a definite
   * provider refusal gives it back.
   */
  perAddress: { maxPerHour: 5, cooldownMs: 60 * 1000 },
} as const;

/**
 * An address for display: enough for its owner to recognise it, not enough to
 * read it aloud. `ada@shop.example.ng` becomes `a**@shop.example.ng`.
 */
export function maskBillingEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  /* A one-character local part is hidden whole: showing its first character would
   * show all of it. */
  if (local.length === 1) return `*${email.slice(at)}`;
  return `${local[0]}${'*'.repeat(Math.min(local.length - 1, 8))}${email.slice(at)}`;
}

/**
 * The page a merchant opens from the mail. The token rides in the URL fragment,
 * which a browser never sends to a server, so it stays out of access logs and
 * referrer headers; the page reads it and posts it to the confirm endpoint.
 */
export function billingEmailConfirmationLink(webUrl: string, token: string): string {
  return `${webUrl.replace(/\/+$/, '')}/app/billing/confirm-email#token=${encodeURIComponent(token)}`;
}

/**
 * The key a suppressed address is stored under (N7): the SHA-256 of the trimmed,
 * lower-cased address. The address is not stored in clear text, but an unkeyed hash
 * stays linkable by anyone who can guess the address, so treat the table as personal data.
 */
export function emailSuppressionKey(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase(), 'utf8').digest('hex');
}
