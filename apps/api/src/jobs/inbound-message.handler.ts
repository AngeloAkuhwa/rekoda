import { Logger } from '@nestjs/common';
import { routeMessage, type DeterministicIntent } from '@rekoda/core';
import { extractInboundEvents, metaWebhookBody } from '@rekoda/contracts';
import { conversationsRepo, events } from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import type { Interpreter } from '../ai/interpreter.service.js';
import type { PrivacyGateway } from '../privacy/gateway.service.js';
import { openPayload } from '../privacy/payload-vault.js';
import type { JobContext, JobHandler } from './runner.js';

export interface InboundMessageDeps {
  gateway: PrivacyGateway;
  interpreter: Interpreter;
  config: ApiConfig;
}

/**
 * What happens to a WhatsApp message after the webhook has answered 200.
 *
 * The order is the point:
 *
 *     open the sealed payload → route → tokenise ONLY if a model is needed
 *
 * Routing happens on the raw text, so a message the deterministic router
 * recognises — a greeting, a "yes", "who owes me" — is understood without the
 * gateway running at all. No vault write, no match-key lookup, no customer
 * created. The gateway is paid for by the messages that actually need it.
 *
 * Nothing raw is stored either way. A deterministic message is recorded as its
 * classification; everything else is recorded tokenised.
 */
export function inboundMessageHandler(deps: InboundMessageDeps): JobHandler {
  const log = new Logger('InboundMessageJob');

  return async ({ tx, payload, businessId }: JobContext): Promise<void> => {
    const eventId = typeof payload['eventId'] === 'string' ? payload['eventId'] : null;
    if (!eventId) {
      // Dies rather than retries: a payload with no event id will not grow one.
      throw new Error('inbound.message: payload is missing eventId');
    }

    const event = await events.eventForBusiness(tx, eventId, businessId);
    if (!event) {
      // Attributed to a different tenant, or truncated between enqueue and
      // run. Either way there is nothing here to do and nothing to retry.
      log.warn('inbound.message: no event for this tenant');
      return;
    }

    const body = metaWebhookBody.safeParse(openPayload(event.payload, deps.config.vaultKey));
    if (!body.success) {
      await events.markProcessed(tx, eventId, 'unreadable payload', businessId);
      return;
    }

    const [inbound] = extractInboundEvents(body.data);
    if (!inbound || inbound.kind !== 'message') {
      await events.markProcessed(tx, eventId, null, businessId);
      return;
    }

    const text = inbound.text ?? '';
    const route = routeMessage(text);

    /**
     * A deterministic message is stored as WHAT IT WAS, not what it said.
     *
     * The router only fires when the whole message is a phrase from a fixed
     * table, so the raw text would be safe to keep here — but keeping it would
     * establish a path where raw merchant text reaches a column, and the next
     * person to touch this file would reasonably follow it. The classification
     * is also what the reply layer actually reads.
     */
    const safeText =
      route.route === 'deterministic' ? null : (await deps.gateway.tokenise(businessId, text)).text;

    const message = await conversationsRepo.recordInbound(tx, {
      businessId,
      channel: 'meta',
      kind: 'text',
      body: route.route === 'deterministic' ? describeIntent(route.intent) : safeText,
      providerMessageId: inbound.externalId,
    });

    /**
     * Only messages the deterministic layer could not answer reach a model,
     * and only ones we have not already interpreted. `isNew` is what stops a
     * re-run — a reclaimed job, a redelivered webhook — from paying for the
     * same sentence twice.
     */
    if (safeText !== null && message.isNew) {
      const interpreted = await deps.interpreter.interpret(businessId, safeText);
      if (interpreted.outcome === 'command') {
        await conversationsRepo.recordDraft(tx, {
          businessId,
          conversationMessageId: message.id,
          intent: interpreted.command.intent,
          command: interpreted.command,
          model: deps.config.aiModelDefault,
        });
      } else {
        /**
         * Refused by a ceiling, unusable output, or a provider we could not
         * reach. All three end the same way for now: the message is on record
         * and no draft exists, so nothing half-understood can be confirmed.
         * Turning each into the right sentence for the merchant is the reply
         * layer's job — §5.3.3's "degrading gracefully with an honest
         * message", which needs somewhere to say it.
         */
        log.warn(`no draft for this message: ${interpreted.outcome}`);
      }
    }

    await events.markProcessed(tx, eventId, null, businessId);
    log.debug(`recorded an inbound message routed as ${route.route}`);
  };
}

/** The classification, in a form the reply layer can read back. */
function describeIntent(intent: DeterministicIntent): string {
  return intent.kind === 'number' ? `[number:${intent.value}]` : `[${intent.kind}]`;
}
