/**
 * The shape of what Meta sends (MASTER-PLAN §5.3.1).
 *
 * This is untrusted input from the public internet, so it is PARSED, never
 * cast. Everything optional is genuinely optional: Meta adds fields, ships
 * event types we do not handle, and will send a payload with no messages in it
 * at all. A parser that throws on an unfamiliar shape turns a Meta product
 * update into an outage, so unknown entries are skipped rather than fatal.
 */
import { z } from 'zod';

const metaText = z.object({ body: z.string() });

const metaMessage = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  timestamp: z.string().optional(),
  type: z.string(),
  text: metaText.optional(),
});

const metaStatus = z.object({
  id: z.string().min(1),
  status: z.string(),
  recipient_id: z.string().optional(),
  timestamp: z.string().optional(),
});

const metaValue = z.object({
  messaging_product: z.string().optional(),
  metadata: z
    .object({
      display_phone_number: z.string().optional(),
      phone_number_id: z.string().optional(),
    })
    .optional(),
  messages: z.array(metaMessage).optional(),
  statuses: z.array(metaStatus).optional(),
});

export const metaWebhookBody = z.object({
  object: z.string().optional(),
  entry: z
    .array(
      z.object({
        id: z.string().optional(),
        changes: z.array(z.object({ field: z.string().optional(), value: metaValue })).optional(),
      }),
    )
    .optional(),
});
export type MetaWebhookBody = z.infer<typeof metaWebhookBody>;

/**
 * One thing that happened, flattened out of Meta's four levels of nesting.
 *
 * `externalId` is what makes a retry a no-op: Meta's `wamid` for a message,
 * and the message id plus the status for a delivery receipt — a single message
 * legitimately produces `sent`, `delivered` and `read`, so the id alone would
 * collapse three distinct events into one.
 */
export interface InboundEvent {
  readonly kind: 'message' | 'status';
  readonly externalId: string;
  /** E.164-ish sender, as Meta gives it — normalisation belongs to core. */
  readonly from: string;
  readonly phoneNumberId: string | null;
  readonly messageType: string;
  /** Present only for text messages. Never logged. */
  readonly text: string | null;
  readonly status: string | null;
}

/**
 * Flatten a payload into the events worth acting on.
 *
 * Returns an empty array rather than throwing for anything unrecognised. Meta
 * retries on a non-2xx, so a payload we cannot read must still be acknowledged
 * — refusing it earns an escalating retry storm and, eventually, a disabled
 * webhook.
 */
export function extractInboundEvents(body: MetaWebhookBody): InboundEvent[] {
  const events: InboundEvent[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      const phoneNumberId = value.metadata?.phone_number_id ?? null;

      for (const message of value.messages ?? []) {
        events.push({
          kind: 'message',
          externalId: message.id,
          from: message.from,
          phoneNumberId,
          messageType: message.type,
          text: message.text?.body ?? null,
          status: null,
        });
      }

      for (const status of value.statuses ?? []) {
        events.push({
          kind: 'status',
          // One message produces sent, delivered and read. Keyed on the id
          // alone, the second and third would be discarded as duplicates.
          externalId: `${status.id}:${status.status}`,
          from: status.recipient_id ?? '',
          phoneNumberId,
          messageType: 'status',
          text: null,
          status: status.status,
        });
      }
    }
  }

  return events;
}
