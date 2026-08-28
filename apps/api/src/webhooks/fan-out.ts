/**
 * Turning one outbox fact into the deliveries it owes (PR-112, spec §26).
 *
 * Migration 0060 built the outbox and registered every handler as an empty
 * body, with a note that PR-112 would replace them with fan-out to whatever
 * the merchant subscribed. This is that function, and it is ONE function
 * shared by every event type rather than a handler per type: what differs
 * between `sale.recorded` and `period.closed` is the payload the command
 * already wrote, not how it reaches a subscriber.
 *
 * Fan-out writes rows; it never sends. The send is a separate sweep with its
 * own retries, because an HTTP call inside the outbox dispatcher would let a
 * merchant's slow endpoint dam the queue behind every other merchant's
 * facts.
 */
import { Logger } from '@nestjs/common';
import { wantsEvent } from '@rekoda/core/webhooks';
import { outboxRepo, webhooksRepo, withBusiness, type Db } from '@rekoda/db';

const log = new Logger('WebhookFanOut');

export type OutboxFanOut = (event: outboxRepo.ClaimedEvent) => Promise<void>;

/**
 * Build the fan-out the dispatcher calls for every registered type.
 *
 * The worker connection, pinned per business: `withBusiness` is used even
 * though the worker's own policy would let it through unpinned, because the
 * pin is what makes an accidental cross-tenant write impossible rather than
 * merely unlikely, and because the insert then reads exactly as the
 * merchant's own would.
 */
export function webhookFanOut(worker: Db): OutboxFanOut {
  return async (event) => {
    await withBusiness(worker, event.businessId, async (tx) => {
      const endpoints = await webhooksRepo.activeEndpointsFor(tx, event.businessId);
      if (endpoints.length === 0) return;

      for (const endpoint of endpoints) {
        if (!wantsEvent(endpoint.eventTypes, event.type)) continue;
        /* The payload is FROZEN here, from the fact as it was committed. A
         * retry three hours later must deliver what happened, not what the
         * books say by then. */
        const queued = await webhooksRepo.queueDelivery(tx, {
          businessId: event.businessId,
          endpointId: endpoint.id,
          outboxEventId: event.id,
          eventType: event.type,
          payload: event.payload,
        });
        /* Already queued means a previous pass got there first, which is the
         * dispatcher being at-least-once and the unique index doing its job.
         * Worth a debug line and nothing more. */
        if (!queued) log.debug(`delivery for ${event.type} already queued on ${endpoint.id}`);
      }
    });
  };
}
