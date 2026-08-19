/**
 * The provider-neutral payment port (docs/payments-v1.md §6–7).
 *
 * Everything above this interface — intents, webhook processing, booking,
 * receipts, reconciliation — speaks these shapes and ONLY these shapes.
 * Adding Monnify or Kuda later means writing one more adapter, never touching
 * a caller. The same construction as `ModelTransport` and `MessageSender`,
 * and the token lives here for the same circular-import lesson both taught.
 *
 * Two rules the port's shape enforces:
 *  - requests are built deterministically from domain records — a customer
 *    email comes from the vault or the call does not happen; there is no
 *    parameter a caller could fill with a fabricated address and no path for
 *    model output to reach a provider;
 *  - responses are NORMALISED before anyone judges them. `succeeded` is the
 *    adapter's translation of the provider's vocabulary; the provider's own
 *    status string rides along verbatim for audit only.
 */

export const PAYMENT_PROVIDER = Symbol('PaymentProvider');

export interface InitializeTransactionInput {
  /** RKD-PAY-… — minted before this call, always ours, never the provider's. */
  reference: string;
  /** Integer kobo. Adapters pass this through without arithmetic. */
  amountK: number;
  currency: string;
  /**
   * From the customer's encrypted email facet, decrypted at this boundary and
   * nowhere earlier. Null means Rekoda does not know one — and the answer to
   * that is `requires_customer_information`, never an invented address.
   */
  customerEmail: string | null;
  /** The merchant's provider-side settlement target, when one exists. */
  subaccountCode?: string | null;
}

export type InitializeTransactionResult =
  | { state: 'initialized'; checkoutUrl: string; accessCode: string }
  | { state: 'requires_customer_information'; missing: readonly string[] };

/** A provider's answer, normalised. The judgement consumes this — never a webhook body. */
export interface VerifiedTransaction {
  /** The adapter's translation of "did the provider call this successful". */
  succeeded: boolean;
  reference: string;
  /** Integer kobo, straight from the provider. */
  amountK: number;
  currency: string;
  /** The provider's native status, verbatim, for audit. */
  providerStatus: string;
  providerTransactionId: string;
  /** Integer kobo. Zero when the provider has not computed it yet. */
  providerFeeK: number;
  /** cash | transfer | card | unknown — normalised by the adapter. */
  method: string;
  paidAtIso: string | null;
}

export type VerifyTransactionResult =
  { found: true; transaction: VerifiedTransaction } | { found: false };

export interface PaymentProviderPort {
  readonly providerType: string;
  initializeTransaction(input: InitializeTransactionInput): Promise<InitializeTransactionResult>;
  /** Server-side verification — the ONLY source of authoritative amounts (§20). */
  verifyTransaction(reference: string): Promise<VerifyTransactionResult>;
}
