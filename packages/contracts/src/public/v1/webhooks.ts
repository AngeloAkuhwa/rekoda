/**
 * What a Rekoda webhook looks like when it arrives (canonical spec §26, §27).
 *
 * This is the ONLY thing in the public contract that Rekoda sends rather
 * than answers, and that makes its stability the sharpest promise in v1: a
 * response shape breaks a client the next time they call, and a delivery
 * shape breaks one at three in the morning while nobody is looking.
 *
 * So the envelope is deliberately thin and the `data` inside it is exactly
 * the outbox fact — the same payload every other consumer of that event
 * sees. Adding a field to `data` for one event type is additive; changing
 * what an event MEANS is a new version, and the frozen shape test is what
 * makes the difference a decision rather than an accident.
 */
import { z } from 'zod';

/**
 * The facts a merchant may subscribe to.
 *
 * The list is the outbox's registered types (migration 0060 onward),
 * written out here rather than imported, so the wire contract stays a
 * literal any client can read without depending on the dispatcher.
 */
export const WEBHOOK_EVENT_TYPES = [
  'sale.recorded',
  'invoice.issued',
  'invoice.voided',
  'payment.recorded',
  'payment.confirmed',
  'expense.recorded',
  'purchase.recorded',
  'journal.posted',
  'period.closed',
  'period.reopened',
  'books.opened',
  'order.placed',
  'order.validated',
  'order.rejected',
  'financial_transactions.ingested',
  'reconciliation.confirmed',
  'inventory.adjusted',
  'data.erased',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const webhookEvent = z.object({
  /** This delivery. Stable across retries: the same fact, sent again. */
  id: z.string().uuid(),
  type: z.enum(WEBHOOK_EVENT_TYPES),
  /** The business this happened to. A partner serving many needs it. */
  businessId: z.string().uuid(),
  /** When the fact occurred, not when this attempt was made. */
  occurredAt: z.string().datetime({ offset: true }),
  /** Which attempt this is, from one. A receiver may log it; nothing more. */
  attempt: z.number().int().positive(),
  data: z.record(z.string(), z.unknown()),
});
export type WebhookEvent = z.infer<typeof webhookEvent>;
