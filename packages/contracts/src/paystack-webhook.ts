/**
 * The Paystack webhook envelope (docs/payments-v1.md §18–19).
 *
 * Deliberately minimal. The signature is the admission check; this schema's
 * only job at ingress is to yield a FINGERPRINT for idempotency and the fields
 * the processing job will verify server-side anyway. Being strict here would
 * mean dropping signed events whenever Paystack adds a field — and a signed
 * event we cannot read today is still evidence worth holding.
 *
 * One fact adapters must never forget: Paystack's `amount` is ALREADY integer
 * kobo. Multiplying by 100 "to convert to kobo" turns ₦1,500 into ₦150,000 —
 * a hundred-fold error that flatters every merchant's books.
 */
import { z } from 'zod';

export const paystackWebhookBody = z
  .object({
    event: z.string().min(1).max(100),
    data: z
      .object({
        /** Paystack's numeric transaction id. The idempotency anchor. */
        id: z.union([z.number(), z.string()]).optional(),
        reference: z.string().max(200).optional(),
        /** Integer kobo, straight from Paystack. Never multiply. */
        amount: z.number().optional(),
        currency: z.string().max(10).optional(),
        status: z.string().max(50).optional(),
      })
      .loose(),
  })
  .loose();

export type PaystackWebhookBody = z.infer<typeof paystackWebhookBody>;

export interface PaystackEventSummary {
  /** `<transaction id>:<event>` — one event type per transaction lands once. */
  fingerprint: string | null;
  eventType: string;
  reference: string | null;
}

/**
 * What ingress needs and nothing more.
 *
 * The fingerprint pairs the transaction id with the event TYPE for the same
 * reason Meta delivery receipts pair id with status: one transaction
 * legitimately produces `charge.success` and later `refund.processed`, and a
 * fingerprint on the id alone would discard the second as a duplicate of the
 * first. Null when Paystack sent no id — the caller falls back to hashing the
 * raw bytes, which still dedupes byte-identical retries.
 */
export function summarisePaystackEvent(body: PaystackWebhookBody): PaystackEventSummary {
  const id = body.data.id;
  return {
    fingerprint: id === undefined || id === null ? null : `${id}:${body.event}`,
    eventType: body.event,
    reference: body.data.reference ?? null,
  };
}
