/**
 * What the merchant was SHOWN, stored beside a draft (G-49, OWN-16).
 *
 * The model's command says what the merchant asked for; this says what
 * Rekoda computed from SQL and put in front of them before their "yes". The
 * two are kept apart on purpose: `command_drafts.command` is the model's
 * tokenised output and passes the transient-field policy, while this is
 * system-owned, deterministic state (like `identity_link`), written once at
 * preview time and read back at confirmation.
 *
 * Two kinds, one per payment preview:
 *
 * - `payment_overpayment`: a deliberate overpayment on an existing invoice. At
 *   "yes" the invoice's locked balance must still equal `balanceShownK`, or
 *   the confirmation is stale and nothing is written: a balance that moved is
 *   never turned into customer credit the merchant did not see.
 * - `payment_invoice` (OD-57, OWN-101): every other payment preview. It binds
 *   the "yes" to the invoice the preview showed, so a newer invoice issued to
 *   the same customer before the "yes" never takes the payment, and the
 *   balance it showed must still be the locked balance at "yes". The invoice
 *   number is not stored: it is the invoice's own, read back by id.
 *
 * Ids and integer kobo only. No name, number, token or text.
 */
import { assertKobo, type Kobo } from './money.js';

export interface PaymentOverpaymentContext {
  readonly kind: 'payment_overpayment';
  readonly invoiceId: string;
  readonly balanceShownK: Kobo;
  readonly amountReceivedK: Kobo;
  readonly allocatedK: Kobo;
  readonly creditK: Kobo;
}

export interface PaymentInvoiceContext {
  readonly kind: 'payment_invoice';
  readonly invoiceId: string;
  /** The balance the preview showed ("Still owing after this" is computed from it). */
  readonly balanceShownK: Kobo;
  /** The amount the preview showed; at most `balanceShownK`, never zero. */
  readonly amountShownK: Kobo;
}

export type ConfirmationContext = PaymentOverpaymentContext | PaymentInvoiceContext;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isKobo(value: unknown): value is Kobo {
  if (typeof value !== 'number') return false;
  try {
    assertKobo(value);
  } catch {
    return false;
  }
  return value >= 0;
}

/**
 * The stored value, or null when it is absent or anything but exactly the
 * shape written. Null means "nothing Rekoda showed is on record", and a
 * payment confirmation then refuses and asks again (OD-57): it never resolves
 * an invoice afresh, which is how a "yes" used to land on a newer invoice.
 */
export function parseConfirmationContext(value: unknown): ConfirmationContext | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if (v['kind'] === 'payment_invoice') return parsePaymentInvoice(v, keys);
  if (keys !== 'allocatedK,amountReceivedK,balanceShownK,creditK,invoiceId,kind') return null;
  if (v['kind'] !== 'payment_overpayment') return null;
  if (typeof v['invoiceId'] !== 'string' || !UUID.test(v['invoiceId'])) return null;
  const { balanceShownK, amountReceivedK, allocatedK, creditK } = v;
  if (![balanceShownK, amountReceivedK, allocatedK, creditK].every(isKobo)) return null;
  /* Internally consistent, or it is not something Rekoda wrote. */
  if (
    (allocatedK as number) !== (balanceShownK as number) ||
    (creditK as number) <= 0 ||
    (allocatedK as number) + (creditK as number) !== (amountReceivedK as number)
  ) {
    return null;
  }
  return {
    kind: 'payment_overpayment',
    invoiceId: v['invoiceId'],
    balanceShownK: balanceShownK as Kobo,
    amountReceivedK: amountReceivedK as Kobo,
    allocatedK: allocatedK as Kobo,
    creditK: creditK as Kobo,
  };
}

function parsePaymentInvoice(
  v: Record<string, unknown>,
  keys: string,
): PaymentInvoiceContext | null {
  if (keys !== 'amountShownK,balanceShownK,invoiceId,kind') return null;
  if (typeof v['invoiceId'] !== 'string' || !UUID.test(v['invoiceId'])) return null;
  const { balanceShownK, amountShownK } = v;
  if (!isKobo(balanceShownK) || !isKobo(amountShownK)) return null;
  /* A part or exact payment on an invoice that owed something: anything else
   * is an overpayment (its own kind) or not something Rekoda wrote. */
  if (amountShownK <= 0 || amountShownK > balanceShownK) return null;
  return {
    kind: 'payment_invoice',
    invoiceId: v['invoiceId'],
    balanceShownK,
    amountShownK,
  };
}
