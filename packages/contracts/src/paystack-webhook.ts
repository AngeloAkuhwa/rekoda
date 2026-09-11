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
        /** Paystack's numeric id for the event's OWN object: the transaction
         * on a charge event, the refund on a refund event, the dispute on a
         * dispute event. The idempotency anchor either way. */
        id: z.union([z.number(), z.string()]).optional(),
        reference: z.string().max(200).optional(),
        /** Integer kobo, straight from Paystack. Never multiply. */
        amount: z.number().optional(),
        currency: z.string().max(10).optional(),
        status: z.string().max(50).optional(),
        /**
         * Refund and dispute events are ABOUT a charge and name it here
         * rather than in `reference`, which on those envelopes is either
         * absent or the refund's own reference. Read at ingress so the
         * pump can route the event to the payment it concerns.
         */
        transaction_reference: z.string().max(200).optional(),
        transaction: z
          .object({
            id: z.union([z.number(), z.string()]).optional(),
            reference: z.string().max(200).optional(),
          })
          .loose()
          .optional(),
        /** Dispute events: the amount under dispute, kobo. */
        refund_amount: z.number().optional(),
        /** Dispute events: how Paystack says it ended, verbatim. */
        resolution: z.string().max(50).nullish(),
      })
      .loose(),
  })
  .loose();

export type PaystackWebhookBody = z.infer<typeof paystackWebhookBody>;

/**
 * Which pipeline an event belongs to. Decided from the event NAME, never
 * from the payload's contents, so a forged-but-signed body cannot pick a
 * branch by carrying the wrong fields.
 */
export type PaystackEventKind = 'charge' | 'refund' | 'dispute' | 'other';

export interface PaystackEventSummary {
  /** `<object id>:<event>` — one event type per object lands once. */
  fingerprint: string | null;
  eventType: string;
  kind: PaystackEventKind;
  /**
   * The Rekoda payment reference this event is ABOUT: the charge's own
   * reference on a charge event; the refunded or disputed charge's
   * reference on a refund or dispute event. Routing keys on this.
   */
  reference: string | null;
  /** The provider's id for the event's own object (refund, dispute, transaction). */
  objectId: string | null;
  /** Integer kobo as the envelope states it — a hint, never authoritative. */
  amountK: number | null;
  currency: string | null;
  providerStatus: string | null;
  /** Dispute events only: Paystack's resolution word, verbatim. */
  resolution: string | null;
}

export function paystackEventKind(eventType: string): PaystackEventKind {
  if (eventType.startsWith('refund.')) return 'refund';
  if (eventType.startsWith('charge.dispute.')) return 'dispute';
  if (eventType.startsWith('charge.')) return 'charge';
  return 'other';
}

/**
 * What ingress and routing need and nothing more.
 *
 * The fingerprint pairs the object id with the event TYPE for the same
 * reason Meta delivery receipts pair id with status: one transaction
 * legitimately produces `charge.success` and later `refund.processed`, and a
 * fingerprint on the id alone would discard the second as a duplicate of the
 * first. Null when Paystack sent no id — the caller falls back to hashing the
 * raw bytes, which still dedupes byte-identical retries.
 */
export function summarisePaystackEvent(body: PaystackWebhookBody): PaystackEventSummary {
  const id = body.data.id;
  const kind = paystackEventKind(body.event);
  const d = body.data;
  const reference =
    kind === 'refund'
      ? (d.transaction_reference ?? d.transaction?.reference ?? d.reference ?? null)
      : kind === 'dispute'
        ? (d.transaction?.reference ?? d.transaction_reference ?? d.reference ?? null)
        : (d.reference ?? null);
  const amount = kind === 'dispute' ? (d.refund_amount ?? d.amount) : d.amount;
  return {
    fingerprint: id === undefined || id === null ? null : `${id}:${body.event}`,
    eventType: body.event,
    kind,
    reference,
    objectId: id === undefined || id === null ? null : String(id),
    amountK: typeof amount === 'number' ? amount : null,
    currency: d.currency ?? null,
    providerStatus: d.status ?? null,
    resolution: kind === 'dispute' ? (d.resolution ?? null) : null,
  };
}
