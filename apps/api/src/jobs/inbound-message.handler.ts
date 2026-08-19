import { Logger } from '@nestjs/common';
import { events } from '@rekoda/db';
import type { JobContext, JobHandler } from './runner.js';

/**
 * What happens to a WhatsApp message after the webhook has answered 200.
 *
 * Today this closes the loop and no more: the event is marked handled so the
 * ingress backlog is a real backlog rather than a table that only ever grows.
 * The privacy gateway, the router and the transaction engine attach here in
 * the following slices, and they attach *inside* `ctx.tx` — a handle that is
 * already pinned to this message's tenant and is the only database access this
 * function has.
 *
 * It is deliberately not doing more than it can do correctly. A handler that
 * half-parsed a message would need unpicking before the router could be
 * written against it.
 */
export function inboundMessageHandler(): JobHandler {
  const log = new Logger('InboundMessageJob');

  return async ({ tx, payload, businessId }: JobContext): Promise<void> => {
    const eventId = typeof payload['eventId'] === 'string' ? payload['eventId'] : null;
    if (!eventId) {
      // Dies rather than retries: a payload with no event id will not grow one.
      throw new Error('inbound.message: payload is missing eventId');
    }

    await events.markProcessed(tx, eventId, null, businessId);
    log.debug('marked an inbound message handled');
  };
}
