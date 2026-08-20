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
});
export type PaymentConnectionResponse = z.infer<typeof paymentConnectionResponse>;

export const paymentsListResponse = z.object({
  payments: z.array(
    z.object({
      rekodaReference: z.string().nullable(),
      status: z.string().nullable(),
      verified: z.number(),
      method: z.string(),
      grossAmountK: z.number().nullable(),
      providerFeeK: z.number().nullable(),
      settlementAmountK: z.number().nullable(),
    }),
  ),
});
export type PaymentsListResponse = z.infer<typeof paymentsListResponse>;

export const paymentExceptionsResponse = z.object({
  exceptions: z.array(
    z.object({
      status: z.string(),
      reason: z.string().nullable(),
      amountK: z.number().nullable(),
      outstandingK: z.number().nullable(),
    }),
  ),
});
export type PaymentExceptionsResponse = z.infer<typeof paymentExceptionsResponse>;
