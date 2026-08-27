/**
 * A customer's message, recorded on the customer's own thread (spec §24,
 * Appendix F; PR-059).
 *
 * This handler ROUTES and RECORDS. It does not interpret, does not reply,
 * and does not touch the interpreter's code path at all: the inbound the
 * merchant sends Rekoda is a bookkeeping instruction, and the inbound a
 * customer sends the merchant is a conversation — running the second
 * through the first would let a stranger write into a merchant's books.
 * Understanding customer messages (carts, orders, W3) plugs in here later;
 * the thread they belong to is already the right one.
 *
 * The raw participant number exists in this file for exactly two calls:
 * normalisation and the blind index. It is never stored, never logged and
 * never placed in a payload — F.3's list is absolute.
 */
import { Logger } from '@nestjs/common';
import { normaliseParticipant, InvalidPhoneError } from '@rekoda/core/identity';
import { participantIndexFor, PARTICIPANT_INDEX_KEY_VERSION } from '@rekoda/core/vault';
import { extractInboundEvents, metaWebhookBody } from '@rekoda/contracts';
import { conversationsRepo, events, wabaRepo } from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import type { PrivacyGateway } from '../privacy/gateway.service.js';
import { openPayload } from '../privacy/payload-vault.js';
import type { JobContext, JobHandler } from './runner.js';

export interface CustomerMessageDeps {
  config: ApiConfig;
  gateway: PrivacyGateway;
}

export function customerMessageHandler(deps: CustomerMessageDeps): JobHandler {
  const log = new Logger('CustomerMessageJob');

  return async ({ tx, payload, businessId }: JobContext): Promise<void> => {
    const eventId = typeof payload['eventId'] === 'string' ? payload['eventId'] : null;
    const phoneNumberId =
      typeof payload['phoneNumberId'] === 'string' ? payload['phoneNumberId'] : null;
    const connectionId =
      typeof payload['connectionId'] === 'string' ? payload['connectionId'] : null;
    if (!eventId || !phoneNumberId || !connectionId) {
      // Dies rather than retries: a payload missing these will not grow them.
      throw new Error(
        'customer.message: payload is missing eventId, phoneNumberId or connectionId',
      );
    }

    const event = await events.eventForBusiness(tx, eventId, businessId);
    if (!event) {
      log.warn('customer.message: no event for this tenant');
      return;
    }

    const body = metaWebhookBody.safeParse(
      openPayload(event.payload, deps.config.vaultKey, 'meta', event.externalId),
    );
    if (!body.success) {
      await events.markProcessed(tx, eventId, 'unreadable payload', businessId);
      return;
    }

    /* One webhook body can carry several events; this job is for ONE. */
    const inbound = extractInboundEvents(body.data).find(
      (candidate) => candidate.kind === 'message' && candidate.externalId === event.externalId,
    );
    if (!inbound || inbound.kind !== 'message') {
      await events.markProcessed(tx, eventId, null, businessId);
      return;
    }

    /* The sender's number, normalised then immediately blinded. A number
     * that will not normalise cannot be indexed, and a guessed index is
     * indistinguishable from a real one forever after (F.8) — so refuse. */
    let participant: string;
    try {
      participant = normaliseParticipant(inbound.from);
    } catch (error) {
      if (error instanceof InvalidPhoneError) {
        await events.markProcessed(tx, eventId, 'participant did not normalise', businessId);
        return;
      }
      throw error;
    }

    const blindIndex = participantIndexFor(deps.config.matchKey, {
      businessId,
      channelAccountId: phoneNumberId,
      keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
      normalisedParticipant: participant,
    });
    const target: conversationsRepo.ThreadTarget = {
      kind: 'CUSTOMER',
      businessId,
      channel: 'meta',
      channelAccountId: phoneNumberId,
      participantBlindIndex: blindIndex,
      participantIndexKeyVersion: PARTICIPANT_INDEX_KEY_VERSION,
    };

    /* Same storage discipline as the merchant path: text is tokenised
     * before it lands, anything else is stored as what it was. */
    const stored =
      inbound.messageType === 'text'
        ? (await deps.gateway.tokenise(businessId, inbound.text ?? '')).text
        : `[${inbound.messageType} message]`;

    await conversationsRepo.recordInbound(
      tx,
      {
        businessId,
        channel: 'meta',
        kind: inbound.messageType === 'text' ? 'text' : 'media',
        body: stored,
        providerMessageId: inbound.externalId,
      },
      target,
    );

    /* THE CUSTOMER'S MESSAGE IS WHAT OPENS THE WINDOW (spec §24; PR-061):
     * 24 hours of free-form replies, per customer per connection, extended
     * by each new message and closed by its own clock. The window's key is
     * the SAME blind index the thread routes by — one identity vocabulary,
     * scoped per F.4, never a raw number. */
    await wabaRepo.touchServiceWindow(tx, {
      businessId,
      wabaConnectionId: connectionId,
      customerHash: blindIndex,
    });

    await events.markProcessed(tx, eventId, null, businessId);
  };
}
