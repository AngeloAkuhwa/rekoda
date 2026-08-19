/**
 * The Payment Hub's domain rules (docs/payments-v1.md).
 *
 * Pure, and in the barrel: nothing here touches node:crypto, a database or a
 * provider SDK. These are the decisions — is this provider event the money we
 * expected, how does a confirmed amount reconcile against an obligation, who
 * bears a fee — and decisions about money must be checkable without mocking
 * the thing that carries them.
 *
 * Provider-neutral by construction. Nothing in this file knows what a
 * subaccount code or a `charge.success` is; adapters translate providers into
 * these shapes, and everything above (invoices, receipts, ledger,
 * reconciliation) consumes only these.
 */

/* ── states (payments-v1 §5, §8, §17, §23, §27) ───────────────────────────── */

export const CONNECTION_STATUSES = [
  'not_configured',
  'pending_details',
  'pending_provider_creation',
  'pending_kyc',
  'pending_settlement_verification',
  'active',
  'suspended',
  'failed',
  'disconnected',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const INTENT_STATUSES = [
  'created',
  'awaiting_provider',
  'awaiting_customer',
  'processing',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
] as const;
export type PaymentIntentStatus = (typeof INTENT_STATUSES)[number];

/** Terminal intents accept no further transitions — a webhook arriving after
 * expiry must not resurrect one. */
export function isTerminalIntentStatus(status: PaymentIntentStatus): boolean {
  return (
    status === 'succeeded' || status === 'failed' || status === 'expired' || status === 'cancelled'
  );
}

export type ReconciliationState =
  | 'matched'
  | 'partial_match'
  | 'overpaid'
  | 'unmatched'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'duplicate'
  | 'reversed'
  | 'requires_review';

export type SettlementStatus =
  'not_applicable' | 'pending' | 'processing' | 'settled' | 'failed' | 'held';

export type FeePolicy = 'customer_bearing' | 'merchant_bearing' | 'platform_bearing';

/* ── the Rekoda reference (payments-v1 §9) ────────────────────────────────── */

/**
 * Crockford base32 — no I, L, O, U — same alphabet as customer tokens, and for
 * the same reason: these get read over the phone to a bank's support line.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type RandomBytes = (n: number) => Uint8Array;

/**
 * `RKD-PAY-20260819-A83F92` — the authoritative reference Rekoda mints BEFORE
 * anything reaches a provider.
 *
 * The date segment is not decoration: an unmatched transfer three weeks later
 * is investigated by a human, and "which day was this minted" narrows a search
 * before any system is opened. Uniqueness is the database's job (a unique
 * index), not this function's — six base32 characters is 2^30 per day, so a
 * collision is a retry, not a redesign.
 *
 * Randomness is injected because `@rekoda/core` has none by design; callers
 * pass `randomBytes` from node:crypto. Modulo bias is avoided the same way the
 * token generator avoids it: 256 % 32 === 0.
 */
export function paymentReference(at: Date, random: RandomBytes): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, '0');
  const d = String(at.getUTCDate()).padStart(2, '0');

  const bytes = random(6);
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += ALPHABET[bytes[i]! % 32];

  return `RKD-PAY-${y}${m}${d}-${suffix}`;
}

export const PAYMENT_REFERENCE_PATTERN = /^RKD-PAY-\d{8}-[0-9A-HJKMNP-TV-Z]{6}$/;

/* ── judging a provider's claim (payments-v1 §21) ─────────────────────────── */

export interface ExpectedPayment {
  reference: string;
  amountK: number;
  currency: string;
}

export interface ReportedPayment {
  reference: string;
  /** Integer subunits. Paystack already reports kobo — adapters must NOT
   * multiply by 100 again; a double conversion turns ₦1,500 into ₦150,000. */
  amountK: number;
  currency: string;
  /** Normalised by the adapter: did the provider call this successful? */
  succeeded: boolean;
}

export type PaymentJudgement =
  /** Money moved and it is OUR money. `reconciliation` says how it lands. */
  | {
      verdict: 'confirmed';
      amountK: number;
      reconciliation: 'matched' | 'partial_match' | 'overpaid';
    }
  /** Not accepted as this obligation's payment. Nothing downstream fires. */
  | {
      verdict: 'rejected';
      reason:
        'provider_not_success' | 'reference_mismatch' | 'currency_mismatch' | 'non_positive_amount';
    };

/**
 * The decision at the heart of the webhook pipeline.
 *
 * The asymmetry is deliberate and comes straight from the spec's own example.
 * A WRONG CURRENCY or a reference that is not ours is a rejection — that event
 * is not this obligation's money, whatever else it may be. A wrong AMOUNT is
 * not a rejection: a bank transfer of ₦80,000 against a ₦100,000 invoice is
 * real money that really moved (payments-v1 §22), so the payment confirms and
 * reconciliation says `partial_match` — the invoice stays partially paid and
 * the balance stays owed. Rejecting it would make the merchant's books deny a
 * transfer their bank statement shows.
 *
 * What this function refuses to do is the thing §21 forbids: let ₦90,000 mark
 * a ₦100,000 invoice PAID.
 */
export function judgeProviderPayment(
  expected: ExpectedPayment,
  reported: ReportedPayment,
): PaymentJudgement {
  if (!reported.succeeded) return { verdict: 'rejected', reason: 'provider_not_success' };
  if (reported.reference !== expected.reference) {
    return { verdict: 'rejected', reason: 'reference_mismatch' };
  }
  if (reported.currency.toUpperCase() !== expected.currency.toUpperCase()) {
    return { verdict: 'rejected', reason: 'currency_mismatch' };
  }
  if (!Number.isInteger(reported.amountK) || reported.amountK <= 0) {
    return { verdict: 'rejected', reason: 'non_positive_amount' };
  }

  const reconciliation =
    reported.amountK === expected.amountK
      ? 'matched'
      : reported.amountK < expected.amountK
        ? 'partial_match'
        : 'overpaid';
  return { verdict: 'confirmed', amountK: reported.amountK, reconciliation };
}

/* ── fees never distort revenue (payments-v1 §14–15, §43.5–6) ─────────────── */

export interface FeeSplitInput {
  /** The obligation — what the goods cost. The ONLY figure allowed into Sales Revenue. */
  invoiceAmountK: number;
  providerFeeK: number;
  /** Rekoda's own cut, when one exists. Zero in V1. */
  platformFeeK?: number;
  policy: FeePolicy;
}

export interface FeeSplit {
  /** Always exactly the invoice amount. The invariant this function exists for. */
  revenueK: number;
  /** What the customer is asked to hand over. */
  customerPaysK: number;
  /** What reaches the merchant's bank. */
  merchantSettlementK: number;
  /** What Rekoda absorbs (platform-bearing policy only). */
  platformAbsorbsK: number;
  providerFeeK: number;
  platformFeeK: number;
}

/**
 * ₦100,000 invoice + ₦300 processing charge = ₦100,300 paid, ₦100,000 revenue.
 *
 * Whoever bears the fee, `revenueK === invoiceAmountK`, unconditionally — a
 * processor fee is a cost of collection, not a bigger sale, and a bigger sale
 * is what every "just add it to the total" shortcut quietly books.
 */
export function splitFees(input: FeeSplitInput): FeeSplit {
  const platformFeeK = input.platformFeeK ?? 0;
  if (input.invoiceAmountK < 0 || input.providerFeeK < 0 || platformFeeK < 0) {
    throw new Error('splitFees: amounts must be non-negative integer kobo');
  }
  if (
    !Number.isInteger(input.invoiceAmountK) ||
    !Number.isInteger(input.providerFeeK) ||
    !Number.isInteger(platformFeeK)
  ) {
    throw new Error('splitFees: amounts must be non-negative integer kobo');
  }

  const base = {
    revenueK: input.invoiceAmountK,
    providerFeeK: input.providerFeeK,
    platformFeeK,
  };

  switch (input.policy) {
    case 'customer_bearing':
      // The customer covers collection costs; the merchant is made whole.
      return {
        ...base,
        customerPaysK: input.invoiceAmountK + input.providerFeeK + platformFeeK,
        merchantSettlementK: input.invoiceAmountK,
        platformAbsorbsK: 0,
      };
    case 'merchant_bearing':
      // The merchant absorbs collection costs out of the sale.
      return {
        ...base,
        customerPaysK: input.invoiceAmountK,
        merchantSettlementK: input.invoiceAmountK - input.providerFeeK - platformFeeK,
        platformAbsorbsK: 0,
      };
    case 'platform_bearing':
      // Rekoda eats the provider fee; the platform fee, if any, still stands.
      return {
        ...base,
        customerPaysK: input.invoiceAmountK,
        merchantSettlementK: input.invoiceAmountK - platformFeeK,
        platformAbsorbsK: input.providerFeeK,
      };
  }
}
