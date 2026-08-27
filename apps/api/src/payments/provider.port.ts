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

export interface CreateSubaccountInput {
  businessName: string;
  settlementBankCode: string;
  /**
   * Plaintext at THIS boundary only: it arrives from the owner's form, goes
   * to the provider over TLS, and is stored solely as a vault cipher plus
   * last4. No log, no reply and no response object ever carries it onward.
   */
  settlementAccountNumber: string;
}

export type CreateSubaccountResult =
  /** The provider accepted the account and minted a settlement target. */
  | { state: 'created'; subaccountCode: string }
  /**
   * The provider looked and said no — wrong account number, name mismatch,
   * unsupported bank. A product state for the merchant to fix, not an error
   * to retry: retrying the same wrong account yields the same no.
   */
  | { state: 'rejected'; reason: string };

/** One settlement batch, normalised (§26–28). */
/**
 * A signed adjustment inside a settlement, in §20's vocabulary. The
 * adapter translates whatever its provider itemises; where a provider
 * states only totals, the sweep derives the one component the totals
 * prove (gross − net) and says so in the note.
 */
export interface ProviderSettlementComponent {
  kind:
    | 'PROCESSING_FEE'
    | 'VAT_ON_FEE'
    | 'WITHHOLDING'
    | 'LEVY'
    | 'RESERVE_HELD'
    | 'RESERVE_RELEASED'
    | 'REBATE'
    | 'ADJUSTMENT'
    | 'CHARGEBACK';
  direction: 'DEDUCTION' | 'ADDITION';
  amountK: number;
  note?: string;
}

export interface ProviderSettlement {
  settlementId: string;
  /**
   * The adapter's translation into the settlement vocabulary the payments
   * table speaks. `held` is the conservative bucket for any provider status
   * the adapter does not recognise: neither settled nor failed is claimed
   * about money whose state is unknown.
   */
  status: 'pending' | 'processing' | 'settled' | 'failed' | 'held';
  /** The provider's native status, verbatim, for audit. */
  providerStatus: string;
  /** When the batch reached the merchant's bank; null until it has. */
  settledAtIso: string | null;
  /**
   * The provider's own totals in kobo (§20: actual data drives the
   * books). Null when the provider did not state them — then there is no
   * authoritative settlement to record, only statuses to stamp.
   */
  grossK: number | null;
  netK: number | null;
  currency?: string;
  /** Itemised adjustments, where the provider itemises. */
  components?: ProviderSettlementComponent[];
}

export interface PaymentProviderPort {
  readonly providerType: string;
  /** The merchant's settlement destination, provider-side (§3–5). */
  createSubaccount(input: CreateSubaccountInput): Promise<CreateSubaccountResult>;
  initializeTransaction(input: InitializeTransactionInput): Promise<InitializeTransactionResult>;
  /** Server-side verification — the ONLY source of authoritative amounts (§20). */
  verifyTransaction(reference: string): Promise<VerifyTransactionResult>;
  /**
   * Settlement batches since a date. Polled, not webhook-fed: settlement
   * webhooks are best-effort at Paystack, so the sweep asks directly.
   */
  listSettlements(fromIso: string): Promise<ProviderSettlement[]>;
  /** The transaction references a settlement batch carried. */
  listSettlementTransactions(settlementId: string): Promise<string[]>;
}
