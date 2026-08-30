/**
 * The web tier's view of the Payment Hub (docs/payments-v1.md §3–5, §35).
 *
 * Same contract discipline as identity: every response is zod-parsed at the
 * boundary, so a renamed field surfaces as a thrown error at the edge rather
 * than `undefined` three components deep. Nothing here carries a full account
 * number — the dashboard renders `GTBank •••• 4821` from last4, and the full
 * number exists only as a cipher the API never returns.
 */
import { z } from 'zod';

/** NUBAN: ten digits, no more, no less. Deterministic, not a model's guess. */
export const submitConnectionRequest = z.object({
  bankCode: z.string().regex(/^\d{3,6}$/, 'bank code must be 3 to 6 digits'),
  accountNumber: z.string().regex(/^\d{10}$/, 'NUBAN account numbers are 10 digits'),
  accountName: z.string().min(2).max(120),
});
export type SubmitConnectionRequest = z.infer<typeof submitConnectionRequest>;

export const paymentConnectionResponse = z.object({
  /** §5 state machine, plus 'not_configured' when no row exists yet. */
  status: z.string(),
  kycStatus: z.string().nullable(),
  providerType: z.string().nullable(),
  bankCode: z.string().nullable(),
  accountLast4: z.string().nullable(),
  accountName: z.string().nullable(),
  /** platform_subaccount | merchant_key (ADR 0019). Null before any row. */
  keyMode: z.string().nullable(),
  /** "key ending 4821" for the card; the key itself never leaves the vault. */
  merchantKeyTail: z.string().nullable(),
  /**
   * Lifetime collections through the shop, kobo (ADR 0019, fix-plan 6 M5d).
   * Populated only in merchant_key mode, because that is the figure the
   * Paystack Starter cap measures; null everywhere else.
   */
  collectedToDateK: z.number().int().nonnegative().nullable(),
});
export type PaymentConnectionResponse = z.infer<typeof paymentConnectionResponse>;

/**
 * Connecting the merchant's OWN Paystack account (ADR 0019, fix-plan 6 M5a).
 *
 * The key is verified against Paystack before anything is stored: a key the
 * provider refuses is never vaulted. This model needs no platform
 * confirmation, because Rekoda is never in the money's path — the storefront
 * charges against the merchant's own integration and settles to their own
 * bank.
 */
export const submitMerchantKeyRequest = z.object({
  /**
   * The merchant's own Paystack secret key. Paystack judges whether it
   * WORKS; Rekoda judges which world it works in, because a test key works
   * perfectly and its money is not real (remediation R4).
   */
  secretKey: z.string().trim().min(10).max(200),
});

export const submitMerchantKeyResponse = z.discriminatedUnion('state', [
  z.object({ state: z.literal('connected'), merchantKeyTail: z.string() }),
  /** Paystack refused the key: mistyped, revoked, or the wrong mode. */
  z.object({ state: z.literal('rejected') }),
  /**
   * Paystack accepted the key and Rekoda will not: a test key on a
   * production deployment. Sandbox charges answer `success`, so booking one
   * would tell a merchant a customer had paid when nobody had.
   */
  z.object({ state: z.literal('rejected_test_key') }),
  /** The deployment cannot hold the key safely (no CONNECTION_KEY). */
  z.object({ state: z.literal('unavailable'), reason: z.literal('connection_key_missing') }),
]);
export type SubmitMerchantKeyRequest = z.infer<typeof submitMerchantKeyRequest>;
export type SubmitMerchantKeyResponse = z.infer<typeof submitMerchantKeyResponse>;

export const paymentsListResponse = z.object({
  /**
   * Every verified payment, which is not `payments.length`.
   *
   * The list is a page, newest first. Saying nothing about the rest left a
   * merchant unable to tell a short list from a complete one.
   */
  paymentsTotal: z.number().int().nonnegative(),
  payments: z.array(
    z.object({
      rekodaReference: z.string().nullable(),
      status: z.string().nullable(),
      verified: z.number(),
      method: z.string(),
      amountK: z.number(),
      grossAmountK: z.number().nullable(),
      providerFeeK: z.number().nullable(),
      settlementAmountK: z.number().nullable(),
      /** not_applicable · pending · processing · settled · failed · held */
      settlementStatus: z.string(),
      settledAt: z.string().nullable(),
    }),
  ),
});
export type PaymentsListResponse = z.infer<typeof paymentsListResponse>;

export const paymentExceptionsResponse = z.object({
  exceptions: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      reason: z.string().nullable(),
      amountK: z.number().nullable(),
      outstandingK: z.number().nullable(),
      createdAt: z.string(),
      resolvedAt: z.string().nullable(),
    }),
  ),
});
export type PaymentExceptionsResponse = z.infer<typeof paymentExceptionsResponse>;
