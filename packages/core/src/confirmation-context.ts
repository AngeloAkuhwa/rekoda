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
 * One kind today: a deliberate overpayment on an existing invoice. At "yes"
 * the invoice's locked balance must still equal `balanceShownK`, or the
 * confirmation is stale and nothing is written: a balance that moved is never
 * turned into customer credit the merchant did not see.
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

export type ConfirmationContext = PaymentOverpaymentContext;

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
 * shape written. Null means "no confirmed overpayment", which is the safe
 * reading: the payment then gets today's conservative treatment.
 */
export function parseConfirmationContext(value: unknown): ConfirmationContext | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
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
