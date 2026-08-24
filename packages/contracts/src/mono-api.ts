/**
 * Mono REST responses (MASTER-PLAN B0, ADR 0012) — only the three calls the
 * bank-feed adapter makes, and only the fields Rekoda acts on.
 *
 * `.loose()` throughout, same reasoning as the Paystack schemas: an
 * aggregator adds fields routinely, and an adapter that breaks on a new
 * field turns a provider's release note into an outage.
 *
 * Amounts are ALREADY integer kobo. The adapter reads them straight through;
 * any ×100 anywhere is a hundred-fold error. Direction comes from `type`
 * (`credit` in, `debit` out), and the adapter turns that into the SIGNED
 * kobo convention the statement parser already produces, so the
 * reconciliation engine never learns which door a line came through.
 */
import { z } from 'zod';

/** POST /v2/accounts/auth — the one-time exchange code becomes an account id. */
export const monoAuthResponse = z
  .object({
    status: z.string().optional(),
    message: z.string().optional(),
    data: z
      .object({
        id: z.string().min(1),
      })
      .loose()
      .optional()
      .nullable(),
  })
  .loose();

export type MonoAuthResponse = z.infer<typeof monoAuthResponse>;

/** GET /v2/accounts/{id} — who the account belongs to, for the card label. */
export const monoAccountResponse = z
  .object({
    status: z.string().optional(),
    message: z.string().optional(),
    data: z
      .object({
        account: z
          .object({
            id: z.string().min(1),
            account_number: z.string().nullish(),
            institution: z
              .object({
                name: z.string().nullish(),
              })
              .loose()
              .nullish(),
          })
          .loose(),
      })
      .loose()
      .optional()
      .nullable(),
  })
  .loose();

export type MonoAccountResponse = z.infer<typeof monoAccountResponse>;

/** GET /v2/accounts/{id}/transactions — what actually moved. */
export const monoTransactionsResponse = z
  .object({
    status: z.string().optional(),
    message: z.string().optional(),
    data: z
      .array(
        z
          .object({
            id: z.string().nullish(),
            narration: z.string().nullish(),
            /** Integer kobo, always positive; `type` carries the direction. */
            amount: z.number(),
            type: z.string(),
            /** ISO timestamp or plain day; the adapter keeps only the day. */
            date: z.string(),
          })
          .loose(),
      )
      .optional()
      .nullable(),
  })
  .loose();

export type MonoTransactionsResponse = z.infer<typeof monoTransactionsResponse>;
