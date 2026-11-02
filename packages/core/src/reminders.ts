/**
 * Customer payment reminders (N1, OWN-43, OWN-62). Pure rules, no IO and no clock.
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
  | 'reminders_not_released'
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
  | 'ambiguous_contact'
  | 'email_not_configured'
  | 'send_failed'
  /* REM-02: another reminder to this invoice on this channel is still with the provider (status
   * `sending`), whatever idempotency key the new request carries. This is concurrency control, not
   * a waiting period: once that attempt has settled, a new request is judged on its own. */
  | 'reminder_in_flight';

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
  /** Another attempt on this invoice and channel is still `sending`. */
  reminderInFlight: boolean;
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
  if (p.reminderInFlight) return 'reminder_in_flight';
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

/**
 * The bank account a merchant has chosen and approved for customers to pay into (REM-04, OWN-64).
 * Rekoda never invents one: a reminder carries this only when the merchant entered it and approved
 * it, and otherwise falls back to the merchant's public phone.
 */
export interface PaymentInstruction {
  bankName: string;
  accountName: string;
  /** A ten-digit Nigerian account number (NUBAN). */
  accountNumber: string;
}

export type PaymentInstructionIssue = 'bank_name' | 'account_name' | 'account_number';

// eslint-disable-next-line no-control-regex
const CONTROL_OR_MARKUP = /[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/;

function cleanText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length < min || collapsed.length > max) return null;
  if (CONTROL_OR_MARKUP.test(collapsed)) return null;
  return collapsed;
}

/**
 * Validates merchant-entered bank details. Spaces and dashes in the account number are tolerated
 * (people type `0123 456 789`); anything else that is not ten digits is refused, never repaired.
 */
export function validatePaymentInstruction(input: {
  bankName: unknown;
  accountName: unknown;
  accountNumber: unknown;
}): { ok: true; value: PaymentInstruction } | { ok: false; issues: PaymentInstructionIssue[] } {
  const issues: PaymentInstructionIssue[] = [];
  const bankName = cleanText(input.bankName, 2, 60);
  if (bankName === null) issues.push('bank_name');
  const accountName = cleanText(input.accountName, 2, 80);
  if (accountName === null) issues.push('account_name');
  const digits =
    typeof input.accountNumber === 'string' ? input.accountNumber.replace(/[\s-]/g, '') : '';
  if (!/^[0-9]{10}$/.test(digits)) issues.push('account_number');
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: { bankName: bankName!, accountName: accountName!, accountNumber: digits },
  };
}

export interface ReminderFacts {
  businessName: string;
  publicPhone: string;
  /** Approved by the merchant; null means the reminder points to the public phone only. */
  paymentInstruction?: PaymentInstruction | null;
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

/** How to pay, in one sentence, for the free-text channels. Only merchant-approved details. */
function howToPay(facts: ReminderFacts, contact: string): string {
  const i = facts.paymentInstruction;
  if (!i) return `To pay or ask about it, ${contact}.`;
  const owing = formatKobo(facts.balanceDueK as Kobo);
  return (
    `To pay, transfer ${owing} to ${i.accountName}, ${i.bankName}, account number ` +
    `${i.accountNumber}, and quote invoice ${facts.invoiceNumber}. To ask about it, ${contact}.`
  );
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
      `${howToPay(facts, `contact ${facts.businessName} on ${facts.publicPhone}`)}\n\n` +
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
    `this message. ${howToPay(facts, `call ${facts.publicPhone}`)} ` +
    `Reply STOP to stop these reminders.`
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
