/**
 * Payment provenance vocabulary (canonical spec §6.2).
 *
 * Two independent dimensions, never multiplied together: how the truth was
 * established, and what instrument the money moved on. The earlier model ran
 * out of room the moment POS appeared, because the source enum was carrying
 * the instrument.
 */

export const CONFIRMATION_SOURCES = [
  'PROVIDER_VERIFIED',
  'BANK_FEED_MATCH',
  'MERCHANT_ATTESTED',
  'MANUAL_RECONCILIATION',
  /** An initial historical state, NEVER a verification source (§6.2). */
  'LEGACY_PROVENANCE_UNKNOWN',
] as const;
export type ConfirmationSource = (typeof CONFIRMATION_SOURCES)[number];

/** The four a PaymentVerification may carry; the fifth is CHECK-refused. */
export type VerificationSource = Exclude<ConfirmationSource, 'LEGACY_PROVENANCE_UNKNOWN'>;

export const PAYMENT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'POS',
  'CARD',
  'USSD',
  'WALLET',
  'OTHER',
  'UNKNOWN',
] as const;
/* Named CanonicalPaymentMethod because ledger.ts already exports a narrow
 * PaymentMethod ('cash' | 'transfer') that decides which ACCOUNT money posts
 * to. That type is posting mechanics; this one is spec §6.2 vocabulary, and
 * renaming the ledger's out from under its callers would be a refactor this
 * PR does not need. */
export type CanonicalPaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * The estate's lower-case `method` column, said in the canonical vocabulary.
 *
 * `unknown` maps to `UNKNOWN`, not to `OTHER`, because §6.2 keeps the two
 * apart on purpose: OTHER is something we can name but have not enumerated,
 * UNKNOWN is that we do not know, and an adapter that answered `unknown` was
 * saying exactly the second thing. Anything unrecognised maps to OTHER,
 * because at that point we CAN name it — it is sitting in the column — we
 * have merely not enumerated it.
 */
export function normalisePaymentMethod(method: string | null | undefined): CanonicalPaymentMethod {
  switch ((method ?? '').trim().toLowerCase()) {
    case 'cash':
      return 'CASH';
    case 'transfer':
    case 'bank_transfer':
      return 'BANK_TRANSFER';
    case 'pos':
      return 'POS';
    case 'card':
      return 'CARD';
    case 'ussd':
      return 'USSD';
    case 'wallet':
      return 'WALLET';
    case 'unknown':
    case '':
      return 'UNKNOWN';
    default:
      return 'OTHER';
  }
}
