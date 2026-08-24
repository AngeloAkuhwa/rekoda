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

export const paystackSubaccountResponse = z
  .object({
    status: z.boolean(),
    message: z.string().optional(),
    data: z
      .object({
        subaccount_code: z.string().min(1),
      })
      .loose()
      .optional(),
  })
  .loose();

export type PaystackSubaccountResponse = z.infer<typeof paystackSubaccountResponse>;

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

export const paystackSettlementListResponse = z
  .object({
    status: z.boolean(),
    message: z.string().optional(),
    data: z
      .array(
        z
          .object({
            id: z.union([z.number(), z.string()]),
            /** success | processing | pending | failed — stored verbatim for audit. */
            status: z.string(),
            /** When the batch reached (or is due to reach) the merchant's bank. */
            effective_date: z.string().nullish(),
            settlement_date: z.string().nullish(),
          })
          .loose(),
      )
      .optional(),
    /** Paystack's pager: page/pageCount let the caller follow every page. */
    meta: z
      .object({
        page: z.number().nullish(),
        pageCount: z.number().nullish(),
        perPage: z.union([z.number(), z.string()]).nullish(),
        total: z.number().nullish(),
      })
      .loose()
      .nullish(),
  })
  .loose();

export type PaystackSettlementListResponse = z.infer<typeof paystackSettlementListResponse>;

export const paystackSettlementTransactionsResponse = z
  .object({
    status: z.boolean(),
    message: z.string().optional(),
    data: z
      .array(
        z
          .object({
            reference: z.string().nullish(),
          })
          .loose(),
      )
      .optional(),
    /** Paystack's pager: page/pageCount let the caller follow every page. */
    meta: z
      .object({
        page: z.number().nullish(),
        pageCount: z.number().nullish(),
        perPage: z.union([z.number(), z.string()]).nullish(),
        total: z.number().nullish(),
      })
      .loose()
      .nullish(),
  })
  .loose();

export type PaystackSettlementTransactionsResponse = z.infer<
  typeof paystackSettlementTransactionsResponse
>;

/**
 * POST /charge with a `bank_transfer` object (ADR 0016, fix-plan 6 M5c):
 * Paystack answers with a temporary account for THIS transaction. Only the
 * fields the storefront shows a customer are read; everything else rides
 * `.loose()`. A response with no account number is treated as a refusal,
 * whatever the envelope's `status` claims.
 */
export const paystackChargeResponse = z
  .object({
    status: z.boolean(),
    message: z.string().optional(),
    data: z
      .object({
        reference: z.string().optional(),
        /** e.g. `pending_bank_transfer` — stored verbatim, never trusted. */
        status: z.string().optional(),
        bank_transfer: z
          .object({
            account_number: z.string().optional(),
            account_name: z.string().nullish(),
            account_expires_at: z.string().nullish(),
            bank: z.object({ name: z.string().optional() }).loose().nullish(),
          })
          .loose()
          .nullish(),
      })
      .loose()
      .optional(),
  })
  .loose();

export type PaystackChargeResponse = z.infer<typeof paystackChargeResponse>;
