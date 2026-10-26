/**
 * Customer payment reminders (N1, OWN-43, OWN-57). Pure rules, no IO and no clock.
 *
 * A reminder is Rekoda writing on a merchant's behalf to the merchant's own customer about a debt.
 * Three things follow and are fixed here: it names the merchant honestly and never presents Rekoda
 * as the creditor; it quotes only a balance the caller has just read from the invoice; and every
 * reason it may not go is a named code, so a refusal is never silent and never a guess.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { daysOverdue, isOverdue } from './due-dates.js';
import { formatKobo, type Kobo } from './money.js';

/** The wording of the merchant's attestation. A new wording is a new version and asks again. */
export const REMINDER_POLICY_VERSION = '2026-10-25.1';

/** Why a reminder was not sent. Stored on the history row and shown to the merchant. */
export type ReminderBlockReason =
  | 'invoice_not_found'
  | 'nothing_owing'
  | 'reminders_stopped'
  | 'no_customer'
  | 'no_contact'
  | 'no_public_contact'
  | 'attestation_required'
  | 'customer_opted_out'
  | 'address_suppressed'
  | 'not_entitled'
  | 'window_closed_no_template'
  | 'template_not_configured'
  | 'template_not_approved'
  | 'no_whatsapp_connection'
  | 'allowance_exhausted'
  | 'invalid_recipient'
  | 'email_not_configured'
  | 'send_failed';

export interface ReminderPreflight {
  invoiceFound: boolean;
  /** Stored invoice status. Only an issued or partly paid invoice can be chased. */
  invoiceStatus: string;
  balanceDueK: number;
  remindersStopped: boolean;
  hasCustomer: boolean;
  hasContact: boolean;
  publicContactApproved: boolean;
  /** Email only: the merchant has attested for this customer under the current policy version. */
  attested: boolean;
  needsAttestation: boolean;
  optedOut: boolean;
}

/** The first reason, in the order a merchant can act on them, or null when the reminder may go. */
export function reminderBlock(p: ReminderPreflight): ReminderBlockReason | null {
  if (!p.invoiceFound) return 'invoice_not_found';
  if (!['issued', 'partially_paid'].includes(p.invoiceStatus) || p.balanceDueK <= 0) {
    return 'nothing_owing';
  }
  if (p.remindersStopped) return 'reminders_stopped';
  if (!p.hasCustomer) return 'no_customer';
  if (!p.hasContact) return 'no_contact';
  if (!p.publicContactApproved) return 'no_public_contact';
  if (p.optedOut) return 'customer_opted_out';
  if (p.needsAttestation && !p.attested) return 'attestation_required';
  return null;
}

/** A display name that cannot break out of an address header or carry a control character. */
export function senderDisplayName(businessName: string): string {
  const cleaned = businessName
    // eslint-disable-next-line no-control-regex
    .replace(/[<>"\\,;@\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `${cleaned || 'Your supplier'} via Rekoda`;
}

export interface ReminderFacts {
  businessName: string;
  publicPhone: string;
  invoiceNumber: string;
  balanceDueK: number;
  dueDate: Date | null;
  now: Date;
}

function dueSentence(facts: ReminderFacts): string {
  /* Never demand money before the agreed date: a future deadline is reported as the date, and a
   * debt with no agreed date as outstanding. */
  if (facts.dueDate === null) return 'is outstanding';
  if (!isOverdue(facts.dueDate, facts.balanceDueK, facts.now)) {
    const date = facts.dueDate.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Africa/Lagos',
    });
    return `is due on ${date}`;
  }
  const late = daysOverdue(facts.dueDate, facts.balanceDueK, facts.now);
  if (late <= 0) return 'is now due';
  return late === 1 ? 'is one day overdue' : `is ${late} days overdue`;
}

export interface EmailReminder {
  fromName: string;
  subject: string;
  text: string;
}

/**
 * The email. Sent from Rekoda's verified domain under `Business via Rekoda`, with the merchant's
 * public phone and an opt-out link. It does not imitate the merchant's own address and does not
 * say Rekoda is owed anything.
 */
export function composeEmailReminder(facts: ReminderFacts, optOutUrl: string): EmailReminder {
  const owing = formatKobo(facts.balanceDueK as Kobo);
  return {
    fromName: senderDisplayName(facts.businessName),
    subject: `Payment reminder from ${facts.businessName.slice(0, 60)}: invoice ${facts.invoiceNumber}`,
    text:
      `Hello,\n\n` +
      `This is a reminder from ${facts.businessName} about invoice ${facts.invoiceNumber}. ` +
      `The balance of ${owing} ${dueSentence(facts)}.\n\n` +
      `If you have already paid, please ignore this message and accept our thanks. ` +
      `To pay or ask about it, contact ${facts.businessName} on ${facts.publicPhone}.\n\n` +
      `This message was sent by Rekoda on behalf of ${facts.businessName}. Rekoda is not the ` +
      `creditor and does not hold your money.\n\n` +
      `Do not want these reminders from ${facts.businessName}? Stop them here: ${optOutUrl}\n`,
  };
}

/** The WhatsApp text, for inside the customer-service window. */
export function composeWhatsAppReminder(facts: ReminderFacts): string {
  const owing = formatKobo(facts.balanceDueK as Kobo);
  return (
    `Hello, a reminder from ${facts.businessName} about invoice ${facts.invoiceNumber}: ` +
    `the balance of ${owing} ${dueSentence(facts)}. If you have already paid, please ignore ` +
    `this message. To pay or ask about it, call ${facts.publicPhone}. Reply STOP to stop ` +
    `these reminders.`
  );
}

/** Body parameters for the approved utility template, in the order the template declares them. */
export function reminderTemplateParameters(facts: ReminderFacts): string[] {
  return [
    facts.businessName,
    facts.invoiceNumber,
    formatKobo(facts.balanceDueK as Kobo),
    facts.publicPhone,
  ];
}

/* ── the opt-out link ────────────────────────────────────────────────────── */

const MAC_LENGTH = 22;

function mac(secret: string, businessId: string, addressHash: string): string {
  return createHmac('sha256', secret)
    .update(`reminder-optout:${businessId}:${addressHash}`, 'utf8')
    .digest('base64url')
    .slice(0, MAC_LENGTH);
}

/**
 * A stateless opt-out token: the business, the address hash and a MAC under a server secret. It
 * names no address and cannot be forged or reused for another business or another address.
 */
export function signReminderOptOut(
  secret: string,
  businessId: string,
  addressHash: string,
): string {
  return `${businessId}.${addressHash}.${mac(secret, businessId, addressHash)}`;
}

export function verifyReminderOptOut(
  secret: string,
  token: string,
): { businessId: string; addressHash: string } | null {
  if (!secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [businessId, addressHash, provided] = parts as [string, string, string];
  if (!/^[0-9a-f-]{36}$/.test(businessId) || !/^[0-9a-f]{64}$/.test(addressHash)) return null;
  const expected = Buffer.from(mac(secret, businessId, addressHash));
  const given = Buffer.from(provided);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { businessId, addressHash };
}
