/**
 * Managing webhook endpoints, on the wire (canonical spec §26, §27).
 *
 * The dashboard's shapes, like `api-keys.ts` and for the same reason: this
 * is how a merchant registers a callback under their own session, not part
 * of the public API a key opens. What Rekoda SENDS to those callbacks is a
 * v1 public contract, in `public/v1/webhooks.ts`.
 *
 * The signing secret appears in exactly two responses — the one that creates
 * an endpoint and the one that rotates its secret — and nowhere else. It is
 * stored encrypted rather than hashed because signing needs it back, which
 * makes "never list it" the only remaining protection worth having.
 */
import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES } from './public/v1/webhooks.js';

const isoDate = z.string().datetime({ offset: true });

export const webhookEndpointView = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  description: z.string().nullable(),
  /** Empty means every event type. */
  eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)),
  status: z.enum(['active', 'disabled']),
  lastSuccessAt: isoDate.nullable(),
  /** Reset by any success. A climbing number is an endpoint gone quiet. */
  consecutiveFailures: z.number().int().nonnegative(),
  createdAt: isoDate,
});
export type WebhookEndpointView = z.infer<typeof webhookEndpointView>;

export const createWebhookEndpointRequest = z.object({
  /** HTTPS only. A plaintext callback carries a merchant's books in the open. */
  url: z
    .string()
    .url()
    .refine((value) => value.startsWith('https://'), 'the URL must be https'),
  description: z.string().trim().max(200).nullish(),
  eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).max(WEBHOOK_EVENT_TYPES.length).optional(),
});
export type CreateWebhookEndpointRequest = z.infer<typeof createWebhookEndpointRequest>;

/** The one response carrying the secret, plus the one from a rotation. */
export const webhookSecretResponse = z.object({
  endpoint: webhookEndpointView,
  /** Shown once. Rekoda stores it encrypted and never displays it again. */
  signingSecret: z.string(),
});
export type WebhookSecretResponse = z.infer<typeof webhookSecretResponse>;

export const webhookDeliveryView = z.object({
  id: z.string().uuid(),
  endpointId: z.string().uuid(),
  eventType: z.string(),
  status: z.enum(['pending', 'delivered', 'dead']),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  nextAttemptAt: isoDate,
  /** The HTTP status the endpoint last answered, or null if it never did. */
  lastStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  deliveredAt: isoDate.nullable(),
  createdAt: isoDate,
});
export type WebhookDeliveryView = z.infer<typeof webhookDeliveryView>;

export const webhookListResponse = z.object({
  endpoints: z.array(webhookEndpointView),
  deliveries: z.array(webhookDeliveryView),
});
export type WebhookListResponse = z.infer<typeof webhookListResponse>;
