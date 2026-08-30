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
import {
  composeShelfAnswer,
  customerConsentIntent,
  lagosDay,
  replies,
  shelfMatches,
  type ShelfItem,
} from '@rekoda/core';
import { normaliseParticipant, InvalidPhoneError } from '@rekoda/core/identity';
import { redactForLog } from '@rekoda/core/privacy';
import { participantIndexFor, PARTICIPANT_INDEX_KEY_VERSION } from '@rekoda/core/vault';
import { extractInboundEvents, metaWebhookBody, type InboundEvent } from '@rekoda/contracts';
import {
  catalogueRepo,
  conversationsRepo,
  customerConsentRepo,
  events,
  identity,
  ordersRepo,
  stockRepo,
  wabaRepo,
} from '@rekoda/db';
import type { Db, TenantDb } from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import type { CommandBus } from '../commands/command-bus.service.js';
import {
  placeCatalogueOrderWork,
  validateCatalogueOrderWork,
  type CatalogueOrderCmdInput,
} from '../commands/order-commands.js';
import type { PrivacyGateway } from '../privacy/gateway.service.js';
import { openPayload } from '../privacy/payload-vault.js';
import type { ReplySender } from '../replies/reply.service.js';
import type { CustomerTexts } from './payment-link.handler.js';
import { describeFailure, type JobContext, type JobHandler } from './runner.js';

export interface CustomerMessageDeps {
  config: ApiConfig;
  gateway: PrivacyGateway;
  /** The one bus every ingress converges on (spec §25). */
  commandBus: CommandBus;
  /** The A1 rollout flag for `PlaceOrder`. */
  commandPlaceOrder: boolean;
  /** The metered door into the customer's thread (PR-061; W4, PR-090). */
  customerTexts: CustomerTexts;
  /** The merchant's own thread, for the handoff notice (W4, PR-091). */
  replySender: ReplySender;
  /** For the owner's WhatsApp number, a question that lives above the tenant. */
  db: Db;
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
     * before it lands, anything else is stored as what it was. A cart is
     * stored as the FACT of a cart — its contents live on the order. */
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

    /* STOP, FROM THE PERSON IT IS ABOUT (PR-135).
     *
     * The same words the merchant path recognises, read on the customer's
     * thread and written to a different fact: this is "shop, stop messaging
     * me", never "Rekoda, stop messaging my books". The merchant's own
     * `users.opted_out_at` is not reachable from this handler at all, so a
     * customer cannot silence somebody else's bookkeeping, and a merchant
     * writing STOP to Rekoda cannot suppress their own shop's customers -
     * that message arrives on the MERCHANT handler and never gets here.
     *
     * It answers before the assistant and before the cart: a person asking
     * to be left alone gets that, not a price list.
     */
    if (inbound.messageType === 'text') {
      const intent = customerConsentIntent(inbound.text ?? '');
      if (intent) {
        const note = await recordConsentChange(tx, deps, businessId, participant, intent, {
          businessId,
          channelAccountId: phoneNumberId,
          customerHash: blindIndex,
          indexKeyVersion: PARTICIPANT_INDEX_KEY_VERSION,
        });
        await events.markProcessed(tx, eventId, note, businessId);
        return;
      }
    }

    /* A CART from the catalogue becomes an ORDER (spec §3.2; W3, PR-087)
     * — through the same PlaceOrder command every other door uses, and
     * never through the merchant-operations command set: a customer's
     * message is a conversation plus, at most, this one narrow act. */
    if (inbound.messageType === 'order' && inbound.order && inbound.order.items.length > 0) {
      const note = await ingestCatalogueOrder(tx, deps, businessId, participant, inbound);
      await events.markProcessed(tx, eventId, note, businessId);
      return;
    }

    /* THE AWAY ASSISTANT (spec Appendix D; W4, PR-090/091): a text the
     * shelf can answer gets an answer, when the merchant enabled it and
     * the day's ceiling for this customer has room. Deterministic on
     * purpose — no model in the customer channel — and it composes TEXT
     * only: the assistant holds no command surface at all, which is
     * Appendix D's "never HIGH_RISK" in its strongest form. Everything it
     * cannot answer HANDS OFF, and says it is doing so (PR-091). */
    if (inbound.messageType === 'text' && (inbound.text ?? '').trim().length > 0) {
      const note = await maybeAssistantAnswer(
        tx,
        deps,
        businessId,
        participant,
        blindIndex,
        inbound.text ?? '',
      );
      await events.markProcessed(tx, eventId, note, businessId);
      return;
    }

    /* A voice note, an image, an empty text: the assistant cannot answer
     * any of these, and "cannot answer" is exactly what the handoff is
     * for — every time, not just when the words looked like a question. */
    const settings = await wabaRepo.assistantSettingsFor(tx, businessId);
    const note = settings.enabled
      ? await handoffToHuman(tx, deps, businessId, participant, blindIndex)
      : null;
    await events.markProcessed(tx, eventId, note, businessId);
  };
}

/**
 * Honour a customer's STOP or START, and say so (PR-135).
 *
 * The ORDER of the two moves is the whole design, and it is deliberately
 * opposite in each direction, so that neither needs a way past the
 * suppression check `sendCustomerText` now performs:
 *
 *   STOP  - acknowledge FIRST, then record. At the moment of the send the
 *           person is still reachable, so the last message they get is the
 *           ordinary door, not an exception carved into it.
 *   START - record FIRST, then acknowledge. Recording is what MAKES them
 *           reachable; acknowledging before it would be refused.
 *
 * The record never depends on the send. A shop's WABA being revoked, out
 * of window, out of quota or simply broken must not turn "stop messaging
 * me" into nothing happening, so the send is attempted, its outcome is
 * noted, and the consent write happens regardless.
 *
 * Neither direction reaches the away assistant, and neither consumes an
 * assistant slot: a person who asked to be left alone is not a customer
 * enquiry, and the reply they get is a legal acknowledgement rather than
 * an automated answer to a question.
 */
async function recordConsentChange(
  tx: TenantDb,
  deps: CustomerMessageDeps,
  businessId: string,
  participant: string,
  intent: 'stop' | 'start',
  key: customerConsentRepo.CustomerConsentKey,
): Promise<string> {
  const log = new Logger('CustomerMessageJob');
  const reply = intent === 'stop' ? replies.customerOptedOut() : replies.customerOptedIn();

  const acknowledge = async (): Promise<void> => {
    try {
      const sent = await deps.customerTexts.sendCustomerText(
        businessId,
        { to: participant, text: reply.text },
        tx,
      );
      if (sent.outcome !== 'sent')
        log.log(`consent acknowledgement not delivered: ${sent.outcome}`);
    } catch (error: unknown) {
      /* Never rethrown: the consent write below is the obligation, and a
       * job that died here would retry the whole message. */
      log.warn(`consent acknowledgement failed: ${redactForLog(describeFailure(error))}`);
    }
  };

  if (intent === 'stop') {
    await acknowledge();
    await customerConsentRepo.setCustomerOptOut(tx, key, new Date());
    return 'customer opted out of shop messages';
  }

  await customerConsentRepo.setCustomerOptOut(tx, key, null);
  await acknowledge();
  return 'customer opted back in to shop messages';
}

/**
 * The handoff (spec §5.2; W4, PR-091): "it hands off, every time, and
 * says it is doing so." Two messages, one moment: the customer hears a
 * person will reply, on the merchant's own number; the merchant hears a
 * customer is waiting, in their own thread. Once per customer per day —
 * a promise repeated after every message reads as a machine stalling —
 * enforced by the same atomic claim the answer ceiling uses, under its
 * own key with a ceiling of one.
 */
async function handoffToHuman(
  tx: TenantDb,
  deps: CustomerMessageDeps,
  businessId: string,
  participant: string,
  customerHash: string,
): Promise<string | null> {
  const log = new Logger('CustomerMessageJob');

  const claimed = await wabaRepo.claimAssistantReply(tx, {
    businessId,
    customerHash: `handoff:${customerHash}`,
    day: lagosDay(new Date()),
    limit: 1,
  });
  if (!claimed) return 'handoff already said today';

  try {
    const sent = await deps.customerTexts.sendCustomerText(
      businessId,
      { to: participant, text: replies.assistantHandoff().text },
      tx,
    );
    if (sent.outcome !== 'sent') {
      log.log(`handoff not delivered: ${sent.outcome}`);
      return `handoff not delivered: ${sent.outcome}`;
    }
  } catch (error: unknown) {
    log.warn(`handoff send failed: ${redactForLog(describeFailure(error))}`);
    return 'handoff send failed';
  }

  /* The merchant's side. STOP is honoured — this is a message they did
   * not ask for by name — and a merchant who opted out still has the
   * customer's message waiting in their own WhatsApp, which is where the
   * notice was pointing anyway. */
  const to = await identity.ownerPhoneFor(deps.db, businessId);
  if (to && !(await identity.optedOutAt(deps.db, to))) {
    await deps.replySender.send(tx, { businessId, to, reply: replies.assistantHandoffNotice() });
  }
  return 'handed off to a human';
}

/**
 * The assistant's one move: price and availability off the merchant's own
 * rows, inside the window the customer's message just opened, against the
 * configured ceiling. The claim happens BEFORE the send because the limit
 * is the invariant: a slot occasionally spent on a send the door refused
 * is honest; a ceiling the assistant can slip past is not.
 */
async function maybeAssistantAnswer(
  tx: TenantDb,
  deps: CustomerMessageDeps,
  businessId: string,
  participant: string,
  customerHash: string,
  text: string,
): Promise<string | null> {
  const log = new Logger('CustomerMessageJob');

  const settings = await wabaRepo.assistantSettingsFor(tx, businessId);
  if (!settings.enabled) return null;

  const shelf = await catalogueRepo.sellableCatalogueFor(tx, businessId, {
    page: 1,
    pageSize: 500,
  });
  const matched = shelfMatches(text, shelf.rows).filter(
    (item): item is typeof item & { unitPriceK: number } => item.unitPriceK !== null,
  );
  if (matched.length === 0) {
    /* Not a question the shelf can answer: a human's, said out loud. */
    return handoffToHuman(tx, deps, businessId, participant, customerHash);
  }

  const held = await stockRepo.onHandByIds(
    tx,
    businessId,
    matched.map((item) => item.id),
  );
  const items: ShelfItem[] = matched.map((item) => {
    const counted = held.get(item.id);
    return {
      name: item.name,
      unitPriceK: item.unitPriceK,
      onHand: counted && counted.counted ? counted.onHand : null,
    };
  });
  const answer = composeShelfAnswer(items);
  if (!answer) return handoffToHuman(tx, deps, businessId, participant, customerHash);

  const claimed = await wabaRepo.claimAssistantReply(tx, {
    businessId,
    customerHash,
    day: lagosDay(new Date()),
    limit: settings.dailyReplyLimit,
  });
  if (!claimed) {
    /* Beyond the configured limits IS "the assistant cannot": the ceiling
     * was the merchant's own line, and past it a human takes over. */
    log.log('assistant ceiling reached: handing off');
    return handoffToHuman(tx, deps, businessId, participant, customerHash);
  }

  try {
    const sent = await deps.customerTexts.sendCustomerText(
      businessId,
      { to: participant, text: answer },
      tx,
    );
    if (sent.outcome !== 'sent') {
      log.log(`assistant answer not delivered: ${sent.outcome}`);
      return `assistant answer not delivered: ${sent.outcome}`;
    }
  } catch (error: unknown) {
    /* The conversation record stands either way: a failed automated reply
     * must never roll back the customer's own message. */
    log.warn(`assistant answer failed: ${redactForLog(describeFailure(error))}`);
    return 'assistant answer failed';
  }
  return 'assistant answered';
}

/**
 * The cart, priced off the merchant's own rows and placed once.
 *
 * The message named WHAT and HOW MANY; the parser already dropped every
 * figure the customer's device sent. Prices come from the products table
 * NOW — not from the catalog projection, and never from the message — so
 * a price the merchant changed since the last sync is the price charged.
 * An item the shelf does not sell refuses the WHOLE cart: a customer
 * shown a partial order they did not compose would pay for a guess.
 *
 * Idempotent twice over: the order's externalRef is Meta's message id
 * (`orders_external_ux` refuses a redelivered webhook structurally), and
 * the PlaceOrder claim carries the same identity through the bus.
 */
async function ingestCatalogueOrder(
  tx: TenantDb,
  deps: CustomerMessageDeps,
  businessId: string,
  participant: string,
  inbound: InboundEvent,
): Promise<string | null> {
  const log = new Logger('CustomerMessageJob');
  const externalRef = `meta:${inbound.externalId}`;

  const existing = await ordersRepo.orderByExternalRef(tx, businessId, externalRef);
  if (existing) return null; // Redelivered webhook: the order already stands.

  const wanted = inbound.order?.items ?? [];
  const products = await catalogueRepo.sellableByIds(
    tx,
    businessId,
    wanted.map((item) => item.retailerId),
  );
  const byId = new Map(products.map((p) => [p.id, p]));
  if (wanted.some((item) => !byId.has(item.retailerId))) {
    log.warn('customer.order: cart names an item the shelf does not sell; order refused');
    return 'order refused: unknown or unsellable item';
  }

  const lines = wanted.map((item) => {
    const product = byId.get(item.retailerId)!;
    return {
      productId: product.id,
      name: product.name,
      quantity: item.quantity,
      unitPriceK: product.unitPriceK,
      lineTotalK: item.quantity * product.unitPriceK,
    };
  });
  const totalK = lines.reduce((sum, line) => sum + line.lineTotalK, 0);

  /* The customer, anchored on their own phone — the same vault door every
   * identity passes through. Raw number in memory only. */
  const resolved = await deps.gateway.resolveStorefrontCustomer(businessId, '', participant);

  const input: CatalogueOrderCmdInput = {
    businessId,
    customerId: resolved?.customerId ?? null,
    lines,
    totalK,
    sourceId: inbound.externalId,
    externalRef,
  };
  let orderId: string;
  if (deps.commandPlaceOrder) {
    const run = await deps.commandBus.run(
      tx,
      {
        businessId,
        command: 'PlaceOrder',
        payload: input,
        actor: 'customer:waba',
        ingress: 'WABA',
        idempotencyKey: externalRef,
      },
      () => placeCatalogueOrderWork(tx, input),
    );
    /* A bus refusal here is a terminal fact about THIS cart, not a fault
     * to retry: a business whose Integrate entitlement lapsed mid-cart
     * takes no order, and the note says so. */
    if (run.outcome === 'not_entitled') return 'order refused: not entitled';
    if (run.outcome !== 'done') {
      throw new Error(`PlaceOrder refused unexpectedly: ${run.outcome}`);
    }
    orderId = run.result.orderId;
  } else {
    /* Same refusal as the storefront: this branch never checked entitlement
     * at all, so running it would take an order from a business whose plan
     * does not carry Integrate. */
    throw new Error(
      'REKODA_COMMAND_PLACE_ORDER is off. The legacy catalogue order path no longer places orders.',
    );
  }

  /* §5.2, in the same transaction as the placement: server-side
   * validation against real catalogue state and real stock, BEFORE any
   * figure is shown. VALIDATED gets its invoice and its §19.1 charge
   * records; a refusal leaves the order visibly CANCELLED with nothing
   * financial behind it — and the atomicity means a crash between the two
   * leaves no half-validated order anywhere. */
  const validated = await validateCatalogueOrderWork(tx, {
    businessId,
    orderId,
    actor: 'customer:waba',
  });
  if (validated.outcome === 'rejected') {
    log.warn(`customer.order: validation refused the cart (${validated.reason})`);
    return `order rejected: ${validated.reason}`;
  }
  return null;
}
