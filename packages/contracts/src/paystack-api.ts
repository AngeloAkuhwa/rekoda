/**
 * Paystack REST responses (docs/payments-v1.md §6, §20) — only the two calls
 * the adapter makes, and only the fields Rekoda acts on.
 *
 * `.loose()` throughout, same reasoning as the webhook envelope: Paystack adds
 * fields routinely, and an adapter that breaks on a new field is an adapter
 * that turns a provider's release note into an outage.
 *
 * Amounts are ALREADY integer kobo in both directions. The adapter passes
 * Rekoda's kobo straight through on initialise and reads Paystack's kobo
 * straight back on verify — any ×100 anywhere is a hundred-fold error.
 */
import { z } from 'zod';

export const paystackInitializeResponse = z
  .object({
    status: z.boolean(),
    message: z.string().optional(),
    data: z
      .object({
        authorization_url: z.string().min(1),
        access_code: z.string().min(1),
        reference: z.string().min(1),
      })
      .loose()
      .optional(),
  })
  .loose();

export type PaystackInitializeResponse = z.infer<typeof paystackInitializeResponse>;

export const paystackVerifyResponse = z
  .object({
    status: z.boolean(),
    message: z.string().optional(),
    data: z
      .object({
        id: z.union([z.number(), z.string()]),
        /** Paystack's own word for the transaction. Stored verbatim, never trusted. */
        status: z.string(),
        reference: z.string(),
        /** Integer kobo. Never multiply. */
        amount: z.number(),
        currency: z.string(),
        /** Integer kobo. Null while Paystack is still computing it. */
        fees: z.number().nullish(),
        channel: z.string().nullish(),
        paid_at: z.string().nullish(),
        gateway_response: z.string().nullish(),
      })
      .loose()
      .optional(),
  })
  .loose();

export type PaystackVerifyResponse = z.infer<typeof paystackVerifyResponse>;
