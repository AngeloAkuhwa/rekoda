import { Logger } from '@nestjs/common';
import { replies, routeMessage, type DeterministicIntent, type Reply } from '@rekoda/core';
import { extractInboundEvents, metaWebhookBody } from '@rekoda/contracts';
import type { StructuredBusinessCommand } from '@rekoda/contracts';
import { conversationsRepo, events, type TenantDb } from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import type { Interpreter } from '../ai/interpreter.service.js';
import type { PrivacyGateway } from '../privacy/gateway.service.js';
import type { ReplySender } from '../replies/reply.service.js';
import { openPayload } from '../privacy/payload-vault.js';
import type { JobContext, JobHandler } from './runner.js';

export interface InboundMessageDeps {
  gateway: PrivacyGateway;
  interpreter: Interpreter;
  replySender: ReplySender;
  config: ApiConfig;
}

/**
 * What happens to a WhatsApp message after the webhook has answered 200.
 *
 *     open the sealed payload → route → tokenise only if a model is needed
 *       → record → answer
 *
 * Routing happens on the raw text, so a message the deterministic router
 * recognises is understood AND answered without the gateway running at all —
 * no vault write, no match-key lookup, no model call, no naira spent. Both the
 * gateway and the model are paid for only by the messages that need them.
 *
 * Nothing raw is stored on either path, and nothing rehydrated is stored on
 * any path: a reply goes into the conversation tokenised and becomes a real
 * name only inside `ReplySender.send`, for the length of one HTTP request.
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
    const tokenised =
      route.route === 'deterministic' ? null : await deps.gateway.tokenise(businessId, text);

    /**
     * A deterministic message is stored as WHAT IT WAS, not what it said.
     *
     * The router only fires when the whole message is a phrase from a fixed
     * table, so the raw text would be safe to keep — but keeping it would
     * establish a path where raw merchant text reaches a column, and the next
     * person to touch this file would reasonably follow it.
     */
    const message = await conversationsRepo.recordInbound(tx, {
      businessId,
      channel: 'meta',
      kind: 'text',
      body: route.route === 'deterministic' ? describeIntent(route.intent) : tokenised!.text,
      providerMessageId: inbound.externalId,
    });

    /**
     * `isNew` is what stops a re-run — a reclaimed job, a redelivered webhook
     * — from paying for the same sentence twice AND answering it twice. A
     * merchant receiving one reply per retry is how a bug becomes a nuisance.
     */
    if (!message.isNew) {
      await events.markProcessed(tx, eventId, null, businessId);
      return;
    }

    const answer =
      route.route === 'deterministic'
        ? deterministicReply(route.intent)
        : await interpretedReply(deps, tx, businessId, tokenised!.text, message.id);

    if (answer) {
      await deps.replySender.send(tx, {
        businessId,
        to: inbound.from,
        reply: answer,
        // Only the model path can produce a reply that names a customer.
        ...(tokenised ? { tokens: tokenised.tokens } : {}),
      });
    }

    await events.markProcessed(tx, eventId, null, businessId);
    log.debug(`answered an inbound message routed as ${route.route}`);
  };
}

/**
 * Answers that need no model — and honest placeholders where the capability is
 * not built.
 *
 * `records` and `debtors` are deliberately NOT answered with a summary. There
 * is no ledger to read yet, and a bookkeeping assistant that invents a debtor
 * list has destroyed the only thing it sells.
 */
function deterministicReply(intent: DeterministicIntent): Reply | null {
  switch (intent.kind) {
    case 'greeting':
      return replies.greeting();
    case 'help':
      return replies.help();
    case 'stop':
      return replies.optedOut();
    case 'start':
      return replies.optedIn();
    case 'cancel':
      return replies.cancelled();
    case 'delete_my_data':
      return replies.confirmErasure();
    case 'number':
      return replies.strayNumber();
    case 'debtors':
      return replies.notYet('Your debtor list');
    case 'records':
      return replies.notYet('Sending your records');
    case 'resend':
      return replies.notYet('Resending a document');
    case 'affirm':
    case 'deny':
      /**
       * Silence, and the only silence in this function.
       *
       * "Yes" and "no" answer a question, and until the confirmation gates
       * land there is no question outstanding. Replying "I did not understand"
       * to a merchant who said yes is worse than saying nothing — it invites
       * them to say it again.
       */
      return null;
  }
}

/** The model path: a draft when it worked, an honest sentence when it did not. */
async function interpretedReply(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  safeText: string,
  conversationMessageId: string,
): Promise<Reply> {
  const interpreted = await deps.interpreter.interpret(businessId, safeText);

  /**
   * Three failures, three different sentences. Collapsing them into one
   * "something went wrong" would waste the single message a merchant standing
   * in a shop will actually read: "you have hit today's limit" and "I am busy,
   * send it again" call for completely different things from them.
   */
  if (interpreted.outcome === 'refused') {
    return interpreted.refusedBy === 'business'
      ? replies.quotaReachedForBusiness()
      : replies.busyRightNow();
  }
  if (interpreted.outcome === 'unavailable') return replies.busyRightNow();
  if (interpreted.outcome === 'unusable') return replies.couldNotRead();

  await conversationsRepo.recordDraft(tx, {
    businessId,
    conversationMessageId,
    intent: interpreted.command.intent,
    command: interpreted.command,
    model: deps.config.aiModelDefault,
  });

  return acknowledge(interpreted.command);
}

/**
 * What we say about a command we understood but have not acted on.
 *
 * Saying "Recorded!" here would be the exact failure the gates exist to
 * prevent: claiming something happened before it has. The preview belongs to
 * CG2 and the document to the transaction engine.
 */
function acknowledge(command: StructuredBusinessCommand): Reply {
  if (command.intent === 'Unclear') return replies.clarification(command.clarification);
  return replies.notYet('Confirming and issuing documents');
}

/** The classification, in a form the reply layer can read back. */
function describeIntent(intent: DeterministicIntent): string {
  return intent.kind === 'number' ? `[number:${intent.value}]` : `[${intent.kind}]`;
}
