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

/**
 * A voice note, as Meta describes it.
 *
 * Only the ID and the type travel: the audio itself is fetched separately and
 * never lands in the event store. `voice` is true for a recording made with
 * the microphone button, false for an audio FILE somebody attached, and the
 * two are worth telling apart because only the first is somebody talking to
 * their bookkeeper.
 */
const metaAudio = z.object({
  id: z.string().min(1),
  mime_type: z.string().optional(),
  voice: z.boolean().optional(),
});

/**
 * A photograph, as Meta describes it.
 *
 * The same shape as audio and for the same reason: only the id travels, and
 * the bytes are fetched at read time so there is nowhere for a merchant's
 * photograph to sit. The caption, when there is one, is ordinary merchant
 * text and takes the ordinary path.
 */
const metaImage = z.object({
  id: z.string().min(1),
  mime_type: z.string().optional(),
  caption: z.string().optional(),
});

/**
 * A cart submitted from the WABA catalogue (spec §3.2; W3, PR-087).
 *
 * Deliberately NOT parsed: `item_price` and `currency`. The §3.2 rule —
 * the customer's message never sets a price — is enforced at this border:
 * the figures Meta relays from the customer's device are dropped by the
 * schema itself, so no later layer can be tempted by a number it never
 * received. What survives is only WHAT and HOW MANY; every price comes
 * off the merchant's own rows.
 */
const metaOrder = z.object({
  catalog_id: z.string().optional(),
  product_items: z
    .array(
      z.object({
        product_retailer_id: z.string().min(1),
        quantity: z.number().int().positive(),
      }),
    )
    .optional(),
});

/**
 * A tapped control, in the two shapes WhatsApp sends it (remediation R11).
 *
 * A template quick reply arrives as `button`; a reply to an interactive
 * message arrives as `interactive`, wrapping either a `button_reply` or a
 * `list_reply`. Three shapes, one meaning: a person pressed a thing that
 * said something, and the thing it said is the message.
 *
 * This matters beyond convenience. A customer who taps a button labelled
 * "Stop messages" has asked to be left alone exactly as plainly as one who
 * types the word, and until these shapes were parsed the tap carried no
 * text at all and went unheard.
 */
const metaButton = z.object({
  payload: z.string().optional(),
  text: z.string().optional(),
});

const metaReply = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
});

const metaInteractive = z.object({
  type: z.string().optional(),
  button_reply: metaReply.optional(),
  list_reply: metaReply.optional(),
});

const metaMessage = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  timestamp: z.string().optional(),
  type: z.string(),
  text: metaText.optional(),
  audio: metaAudio.optional(),
  image: metaImage.optional(),
  order: metaOrder.optional(),
  button: metaButton.optional(),
  interactive: metaInteractive.optional(),
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
  /**
   * Meta's media id for a voice note, to be fetched and transcribed.
   *
   * An ID, never the audio. The bytes are pulled at transcription time and
   * held in memory for the length of one request: a merchant's voice is the
   * most identifying thing they can send us, and the promise is that it never
   * lands anywhere it could be recovered from.
   */
  readonly audioId: string | null;
  /**
   * Meta's media id for a photograph, to be read by our own OCR.
   *
   * An ID, never the image. ADR 0024 fixes what happens to the bytes: they
   * are fetched, extracted inside infrastructure we control, and dropped.
   */
  readonly imageId: string | null;
  /** A caption typed alongside a photograph. Ordinary merchant text. */
  readonly caption: string | null;
  /**
   * A catalogue cart, reduced to WHAT and HOW MANY (W3, PR-087). The
   * prices Meta relayed were dropped by the schema and do not exist here:
   * the customer's message never sets a price.
   */
  readonly order: {
    readonly catalogId: string | null;
    readonly items: ReadonlyArray<{ readonly retailerId: string; readonly quantity: number }>;
  } | null;
  /**
   * What a person's TAP said, when they answered by pressing rather than
   * typing (remediation R11).
   *
   * `id` is what the merchant configured (a payload or a reply id), `title`
   * is what the customer actually read on the control. Both travel because
   * neither is reliably the words: a template quick reply usually carries
   * its label in the payload, an interactive reply always carries it in the
   * title, and a reader looking for "STOP" has to be allowed to look in
   * whichever one holds it.
   */
  readonly tappedReply: {
    readonly id: string | null;
    readonly title: string | null;
  } | null;
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
/**
 * The one place the three tap shapes collapse into one (remediation R11).
 *
 * Written as a reader rather than three branches at the call site so that
 * every consumer of a tap sees the same two strings, and a fourth shape
 * from Meta is one edit here instead of a hunt.
 */
function tappedReplyOf(
  message: z.infer<typeof metaMessage>,
): { id: string | null; title: string | null } | null {
  const reply =
    message.interactive?.button_reply ??
    message.interactive?.list_reply ??
    (message.button ? { id: message.button.payload, title: message.button.text } : undefined);
  if (!reply) return null;
  const id = reply.id ?? null;
  const title = reply.title ?? null;
  return id === null && title === null ? null : { id, title };
}

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
          audioId: message.audio?.id ?? null,
          imageId: message.image?.id ?? null,
          caption: message.image?.caption ?? null,
          order: message.order
            ? {
                catalogId: message.order.catalog_id ?? null,
                items: (message.order.product_items ?? []).map((item) => ({
                  retailerId: item.product_retailer_id,
                  quantity: item.quantity,
                })),
              }
            : null,
          tappedReply: tappedReplyOf(message),
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
          audioId: null,
          imageId: null,
          caption: null,
          order: null,
          tappedReply: null,
          status: status.status,
        });
      }
    }
  }

  return events;
}
