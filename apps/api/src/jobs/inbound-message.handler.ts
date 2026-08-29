import { Logger } from '@nestjs/common';
import {
  gateExpense,
  gatePayment,
  daysOverdue,
  resolveDueDate,
  resolvePeriod,
  gatePurchase,
  gateSale,
  gateStockChange,
  purchaseArrival,
  isSaleSource,
  looksLikeCorrection,
  orderPreview,
  orderQuestion,
  postCostOfSale,
  priceOrder,
  replies,
  routeMessage,
  usagePeriod,
  billingPeriod,
  costOfCall,
  costOfTranscription,
  type AiModelRole,
  type DeterministicIntent,
  type Reply,
} from '@rekoda/core';
import { normalisePhone, InvalidPhoneError } from '@rekoda/core/identity';
import { extractInboundEvents, metaWebhookBody } from '@rekoda/contracts';
import type { StructuredBusinessCommand } from '@rekoda/contracts';
import {
  billingRepo,
  catalogueRepo,
  conversationsRepo,
  withBusiness,
  customersRepo,
  entitlementsRepo,
  events,
  identity,
  issueRepo,
  jobsRepo,
  ordersRepo,
  reportsRepo,
  settleRepo,
  spendRepo,
  riskRepo,
  stockRepo,
  usageRepo,
  quotaRepo,
  type Db,
  type TenantDb,
} from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import { meterAllowance } from '../billing/plan-terms.js';
import { LINK_MINUTES, mintDashboardLink } from '../auth/dashboard-link.js';
import type { Interpreter } from '../ai/interpreter.service.js';
import type { IdentityLinkProposal, PrivacyGateway } from '../privacy/gateway.service.js';
import type { ReplySender } from '../replies/reply.service.js';
import type { PaymentIntentsService } from '../payments/payment-intents.service.js';
import { openPayload } from '../privacy/payload-vault.js';
import { redactForLog } from '@rekoda/core/privacy';
import { describeFailure, JobDeferred, type JobContext, type JobHandler } from './runner.js';
import { TranscriptionUnavailable, type SpeechToText, type Transcript } from '../ai/stt.js';
import type { AudioMetadataProbe } from '../ai/audio-duration.js';
import { TextExtractionUnavailable, type TextExtraction } from '../ai/ocr.js';
import type { CommandBus } from '../commands/command-bus.service.js';
import { recordSaleWork, type RecordSaleInput } from '../commands/sale-commands.js';
import {
  recordPaymentEvidenceWork,
  recordPaymentWork,
  type RecordPaymentInput,
  type RecordPaymentResult,
} from '../commands/payment-commands.js';
import {
  recordExpenseWork,
  recordPurchaseWork,
  type RecordExpenseCmdInput,
  type RecordPurchaseCmdInput,
} from '../commands/spend-commands.js';
import { placeOrderWork, type PlaceOrderCmdInput } from '../commands/order-commands.js';
import { adjustInventoryWork, type AdjustInventoryInput } from '../commands/stock-commands.js';
import { eraseDataWork } from '../commands/privacy-commands.js';
import type { MessageSender } from '../channels/sender.js';
import type { CustomerThreadRouter } from '../channels/customer-route.service.js';
import type { CustomerTexts } from './payment-link.handler.js';

/** The MERCHANT thread identity, stated at the ingress (Appendix F.2).
 * This ingress hears the merchant talking to Rekoda; customer threads
 * arrive with their own stated identity when Integrate routing lands. */
const merchantThread = (businessId: string) =>
  ({ kind: 'MERCHANT', businessId, channel: 'meta' }) as const;

const paymentLog = new Logger('InboundMessageJob');

export interface InboundMessageDeps {
  gateway: PrivacyGateway;
  interpreter: Interpreter;
  replySender: ReplySender;
  config: ApiConfig;
  paymentIntents: PaymentIntentsService;
  /** Fetches media a merchant sent, and delivers the OTP template. */
  sender: MessageSender;
  /** The AfriSpeech sidecar (ADR 0008), or something that refuses honestly. */
  stt: SpeechToText;
  /**
   * How long a voice note runs, read from the bytes before any provider is
   * called. A port, because an ffprobe sidecar answers the same question and
   * a deployment that would rather run one should not have to touch this
   * file.
   */
  audioProbe: AudioMetadataProbe;
  /**
   * The self-hosted OCR sidecar (ADR 0024), or something that refuses
   * honestly. Never a vision model: see `ocr.ts` for why there is no such
   * option and must not be one.
   */
  ocr: TextExtraction;
  /** The app pool, for the rows that live ABOVE tenancy: users' consent state. */
  db: Db;
  /** The one bus every ingress converges on (spec §25). */
  commandBus: CommandBus;
  /** THE cross-product routing decision (X1, PR-092). */
  customerRoute: CustomerThreadRouter;
  /** The metered door into a customer's thread (PR-061), for X1 delivery. */
  customerTexts: CustomerTexts;
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

  return async ({ tx, jobId, payload, businessId, attempt }: JobContext): Promise<void> => {
    /**
     * Metered units are taken in their own committed transactions, which is
     * the one thing this job's rollback cannot undo. So a retry must not take
     * them again: attempt 1 already did, and five attempts of one message
     * would otherwise burn five units of a merchant's allowance for a failure
     * that was ours. Under-counting by one on the rare first-attempt-crashed
     * case is the right side to err on.
     */
    const retrying = attempt > 1;
    const eventId = typeof payload['eventId'] === 'string' ? payload['eventId'] : null;
    if (!eventId) {
      // Dies rather than retries: a payload with no event id will not grow one.
      throw new Error('inbound.message: payload is missing eventId');
    }

    /**
     * One inbound message per business at a time.
     *
     * The worker runs several concurrency lanes, and this handler reads then
     * writes the pending draft (supersede, record, confirm) assuming it is
     * the only runner for the business. Without this, a burst — "sold 3 wigs"
     * then "make it 4" — could have two lanes racing that state and produce
     * two drafts or no reply. A per-business advisory lock, held to commit,
     * serializes the conversation while leaving OTHER businesses' lanes free.
     */
    await jobsRepo.serializeBusiness(tx, businessId, 'inbound');

    /**
     * The lock serializes, it does not order. A lane that claimed the LATER
     * of two messages can still win the lock while the earlier one's lane is
     * between claim and lock — and "yes" processed before the draft it
     * confirms silently drops a record. So, under the lock: if an older
     * inbound job for this business is still live, this one is jumping the
     * queue. Step back and let it go first; the runner re-queues without
     * charging an attempt.
     */
    if (await jobsRepo.hasEarlierLiveJob(tx, jobId)) throw new JobDeferred();

    const event = await events.eventForBusiness(tx, eventId, businessId);
    if (!event) {
      // Attributed to a different tenant, or truncated between enqueue and
      // run. Either way there is nothing here to do and nothing to retry.
      log.warn('inbound.message: no event for this tenant');
      return;
    }

    const body = metaWebhookBody.safeParse(
      openPayload(event.payload, deps.config.vaultKey, 'meta', event.externalId),
    );
    if (!body.success) {
      await events.markProcessed(tx, eventId, 'unreadable payload', businessId);
      return;
    }

    /* One webhook body can carry several events - several messages, possibly
     * to different businesses - and this job is for ONE, named by its wamid.
     * Taking events[0] processed a DIFFERENT tenant's message under this
     * tenant when a batched body's first event was not ours: the wrong
     * customer tokenised into this business, the wrong reply sent, and our
     * own message dropped when the global provider-id unique made its job a
     * no-op. Selected by externalId, exactly as the customer handler does. */
    const inbound = extractInboundEvents(body.data).find(
      (candidate) => candidate.kind === 'message' && candidate.externalId === event.externalId,
    );
    if (!inbound || inbound.kind !== 'message') {
      await events.markProcessed(tx, eventId, null, businessId);
      return;
    }

    /**
     * A voice note becomes a sentence; everything else that is not text says
     * so honestly.
     *
     * The transcript then takes EXACTLY the path a typed message takes:
     * tokenised before any model sees it, routed, gated, confirmed. Voice is
     * an input method, not a second product, and a parallel path is where the
     * two would drift until one of them lost a conversation gate.
     */
    let spoken: { transcript: Transcript; messageId: string } | null = null;
    let read: { text: string; messageId: string } | null = null;
    if (isVoiceNote(inbound)) {
      spoken = await transcribeVoiceNote(deps, tx, businessId, inbound, log);
      if (!spoken) {
        /* Already answered inside, and already marked new-or-not. Nothing to
         * interpret and nothing to charge for. */
        await events.markProcessed(tx, eventId, null, businessId);
        return;
      }
    } else if (isReceiptPhoto(inbound)) {
      read = await readReceiptPhoto(deps, tx, businessId, inbound, log);
      if (!read) {
        await events.markProcessed(tx, eventId, null, businessId);
        return;
      }
    } else if (inbound.messageType !== 'text') {
      const recorded = await conversationsRepo.recordInbound(
        tx,
        {
          businessId,
          channel: 'meta',
          kind: 'media',
          body: `[${inbound.messageType} message]`,
          providerMessageId: inbound.externalId,
        },
        merchantThread(businessId),
      );
      if (recorded.isNew) {
        await deps.replySender.send(tx, {
          businessId,
          to: inbound.from,
          reply: replies.onlyText(),
        });
      }
      await events.markProcessed(tx, eventId, null, businessId);
      return;
    }

    const text = spoken?.transcript.text ?? read?.text ?? inbound.text ?? '';
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
    /**
     * ONE row per inbound message, whichever way it arrived.
     *
     * A voice note was already claimed by `transcribeVoiceNote`, and a
     * photograph by `readReceiptPhoto` — that claim is what stops a
     * redelivered webhook doing the work and metering twice — so recording
     * again here would hit `messages_provider_ux`, come back `isNew: false`,
     * and silently return without answering the merchant. The body is filled
     * in now that there is something to store.
     */
    const claimed = spoken?.messageId ?? read?.messageId ?? null;
    const message = claimed
      ? {
          id: claimed,
          isNew: await conversationsRepo.setInboundBody(
            tx,
            businessId,
            claimed,
            route.route === 'deterministic' ? describeIntent(route.intent) : tokenised!.text,
          ),
        }
      : await conversationsRepo.recordInbound(
          tx,
          {
            businessId,
            channel: 'meta',
            kind: 'text',
            body: route.route === 'deterministic' ? describeIntent(route.intent) : tokenised!.text,
            providerMessageId: inbound.externalId,
          },
          merchantThread(businessId),
        );

    /**
     * `isNew` is what stops a re-run — a reclaimed job, a redelivered webhook
     * — from paying for the same sentence twice AND answering it twice. A
     * merchant receiving one reply per retry is how a bug becomes a nuisance.
     */
    if (!message.isNew) {
      await events.markProcessed(tx, eventId, null, businessId);
      return;
    }

    /* Mutable copy: a mention resolved during interpretation adds its token
     * here so the SAME table serves the outbound rehydration below. */
    const liveTokens = tokenised ? new Map(tokenised.tokens) : null;

    const answer =
      route.route === 'deterministic'
        ? await deterministicReply(deps, tx, businessId, route.intent, {
            eventId,
            messageId: message.id,
            from: inbound.from,
            retrying,
          })
        : await interpretedReply(
            deps,
            tx,
            businessId,
            text,
            tokenised!.text,
            message.id,
            retrying,
            tokenised!.link,
            inbound.from,
            liveTokens!,
          );

    if (answer) {
      await deps.replySender.send(tx, {
        businessId,
        to: inbound.from,
        reply: answer,
        // Only the model path can produce a reply that names a customer.
        ...(liveTokens ? { tokens: liveTokens } : {}),
      });
    }

    await events.markProcessed(tx, eventId, null, businessId);
    log.debug(`answered an inbound message routed as ${route.route}`);
  };
}

/** A recording somebody made with the microphone button, not an attached file. */
function isVoiceNote(inbound: { messageType: string; audioId: string | null }): boolean {
  return (inbound.messageType === 'audio' || inbound.messageType === 'voice') && !!inbound.audioId;
}

/** A photograph, which for a bookkeeper means a receipt or an invoice. */
function isReceiptPhoto(inbound: { messageType: string; imageId: string | null }): boolean {
  return inbound.messageType === 'image' && !!inbound.imageId;
}

/**
 * A photograph, turned into text by the configured reader, or an honest answer.
 *
 * Returns null when there is nothing to interpret, having already replied:
 * somebody who photographed a receipt is holding their phone waiting.
 *
 * THE IMAGE IS NEVER STORED. ADR 0024 fixed the pipeline - photo, text
 * extraction, PII tokenisation, then a reasoning model - and ADR 0027 chose
 * which engine performs the extraction step at launch: the vision model as
 * a transcription-only processor, named on /ai-privacy, with the OCR
 * sidecar one env var away. Either way the REASONING model only ever sees
 * tokenised text, because the gateway tokenises text and cannot tokenise an
 * image.
 *
 * There is no branch below that retries the image somewhere else when the
 * configured engine fails. That is the whole design, and it is why the
 * failure path answers with a sentence rather than a second attempt at an
 * engine the privacy page never named.
 */
async function readReceiptPhoto(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  inbound: { externalId: string; from: string; imageId: string | null; caption: string | null },
  log: Logger,
): Promise<{ text: string; messageId: string } | null> {
  const recorded = await conversationsRepo.recordInbound(
    tx,
    {
      businessId,
      channel: 'meta',
      kind: 'media',
      body: '[receipt photo]',
      providerMessageId: inbound.externalId,
    },
    merchantThread(businessId),
  );
  /* A redelivered webhook must not read, meter and answer twice. */
  if (!recorded.isNew) return null;

  const plan = await usageRepo.planFor(tx, businessId);
  if (plan === 'expired') {
    await deps.replySender.send(tx, { businessId, to: inbound.from, reply: replies.trialEnded() });
    return null;
  }

  /* ENTITLEMENT BEFORE ANY PROVIDER IS TOUCHED (spec §4.3, rules 1 and 2).
   * Reading a receipt is a Chat capability. An Integrate-only merchant who
   * photographs one is refused here, which is before the media fetch and a
   * long way before the OCR engine: the refusal costs Rekoda nothing and
   * costs the merchant nothing, so there is no unit to give back. */
  if (await entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_CHAT')) {
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: replies.chatNotInPlan(),
    });
    return null;
  }

  let image;
  try {
    image = await deps.sender.fetchMedia(inbound.imageId!);
  } catch {
    log.warn('could not fetch a photograph from the provider');
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: replies.photoUnavailable(),
    });
    return null;
  }

  /**
   * Metered BEFORE the engine reads the page (spec §4.3, rule 3).
   *
   * This used to charge afterwards, on the reasoning that a page nobody
   * could read is a page nobody should pay for. That reasoning is right
   * about the refund and wrong about the order: it let an exhausted merchant
   * spend Rekoda's OCR budget on every photograph they sent, because the
   * refusal only arrived after the engine had already run. The unit is taken
   * first and given back on every path that reads nothing, which is the same
   * outcome for the merchant and a different one for the bill.
   *
   * Its own short transaction, like every other unit here, so the counter is
   * not held across a network call.
   */
  const period = usagePeriod(new Date());
  const allowance = await meterAllowance(deps.config, tx, businessId, plan, 'DOCUMENTS_UNDERSTOOD');
  const granted = await withBusiness(deps.db, businessId, (own) =>
    usageRepo.consumeUnit(own, businessId, period, 'DOCUMENTS_UNDERSTOOD', allowance),
  );
  if (!granted) {
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: replies.allowanceExhausted(allowance, 'DOCUMENTS_UNDERSTOOD'),
    });
    return null;
  }

  let extracted;
  try {
    extracted = await deps.ocr.extract(image.bytes, image.mimeType);
  } catch (error) {
    /* Our failure, not the merchant's, so the unit goes back. The image is
     * dropped here and goes nowhere else: no vision model, no retry against a
     * hosted engine, no exception "just this once". */
    log.warn('the OCR engine could not be reached');
    /* A hosted read that TIMED OUT may still be on the invoice — the page
     * may have been processed after we stopped waiting. Zero with
     * `priced: false` is the row reconciliation ties to; the merchant's
     * unit still goes back, because Rekoda's timeout is Rekoda's cost. */
    if (error instanceof TextExtractionUnavailable && error.maybeBilled) {
      await withBusiness(deps.db, businessId, (own) =>
        quotaRepo.recordUsage(own, {
          businessId,
          provider: 'anthropic',
          usageType: 'ocr_vision',
          quantity: 1,
          providerCostMicros: 0,
          nairaEquivalentK: 0,
          billingPeriod: billingPeriod(new Date()),
          meta: {
            role: 'vision' satisfies AiModelRole,
            priced: false,
            reason: 'timed out after the request went out; possibly billed',
            messageId: recorded.id,
          },
        }),
      );
    }
    await withBusiness(deps.db, businessId, (own) =>
      usageRepo.refundUnit(own, businessId, period, 'DOCUMENTS_UNDERSTOOD'),
    );
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: replies.photoUnavailable(),
    });
    return null;
  }

  /* WHAT THE READ COST, recorded whatever becomes of the text (item 7 of
   * the AI hardening plan; same contract as the interpreter's rows). Only
   * hosted engines report usage — the sidecar's per-call provider cost is
   * genuinely zero and writes no row. `ocr_vision` matches the OCR cost
   * class however the read was performed. */
  if (extracted.usage) {
    const cost = costOfCall(
      extracted.usage.model,
      extracted.usage.tokens,
      deps.config.planningFxNairaPerUsd,
    );
    if (!cost.priced) {
      log.error(`no price for vision model "${extracted.usage.model}" — recorded at zero`);
    }
    await withBusiness(deps.db, businessId, (own) =>
      quotaRepo.recordUsage(own, {
        businessId,
        provider: extracted.usage!.provider,
        usageType: 'ocr_vision',
        quantity: 1,
        providerCostMicros: cost.usdMicros,
        nairaEquivalentK: cost.nairaKobo,
        billingPeriod: billingPeriod(new Date()),
        meta: {
          role: 'vision' satisfies AiModelRole,
          model: extracted.usage!.model,
          purpose: 'document_extraction',
          priced: cost.priced,
          messageId: recorded.id,
          ...extracted.usage!.tokens,
        },
      }),
    );
  }

  /* The caption is what the merchant TYPED, and it says what the photograph
   * is for. Kept in front of the extracted text so "this is my fuel receipt"
   * reaches the interpreter as the instruction it is. */
  const caption = inbound.caption?.trim();
  const text = caption ? `${caption}\n${extracted.text}` : extracted.text;
  return { text, messageId: recorded.id };
}

/**
 * A voice note, turned into a sentence, or an honest answer about why not.
 *
 * Returns null when there is nothing to interpret — and in that case has
 * already replied, because every path out of here owes the merchant a
 * sentence. Somebody who recorded a voice note is holding their phone
 * waiting.
 *
 * THE AUDIO IS NEVER STORED. It is fetched, passed to the configured
 * transcriber, and left to the garbage collector. A merchant's voice is the
 * most identifying thing they can send us; ADR 0027 names the launch
 * transcriber (a hosted processor, on /ai-privacy in those words) and keeps
 * the sidecar one env var away, and the transcript walks the same gateway
 * every typed sentence walks before any reasoning model sees it.
 */
async function transcribeVoiceNote(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  inbound: { externalId: string; from: string; audioId: string | null },
  log: Logger,
): Promise<{ transcript: Transcript; messageId: string } | null> {
  const recorded = await conversationsRepo.recordInbound(
    tx,
    {
      businessId,
      channel: 'meta',
      kind: 'voice',
      body: '[voice note]',
      providerMessageId: inbound.externalId,
    },
    merchantThread(businessId),
  );
  /* A redelivered webhook must not transcribe, meter and answer twice. The
   * body is replaced with the transcript below only on the first pass. */
  if (!recorded.isNew) return null;

  const plan = await usageRepo.planFor(tx, businessId);
  if (plan === 'expired') {
    await deps.replySender.send(tx, { businessId, to: inbound.from, reply: replies.trialEnded() });
    return null;
  }

  /* ENTITLEMENT BEFORE ANY PROVIDER IS TOUCHED (spec §4.3, rules 1 and 2).
   * Speaking to Rekoda is a Chat capability, and an Integrate-only merchant
   * refused here never reaches the transcriber. Nothing was reserved, so
   * there is nothing to give back. */
  if (await entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_CHAT')) {
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: replies.chatNotInPlan(),
    });
    return null;
  }

  let audio;
  try {
    audio = await deps.sender.fetchMedia(inbound.audioId!);
  } catch {
    log.warn('could not fetch a voice note from the provider');
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: replies.voiceUnavailable(),
    });
    return null;
  }

  /**
   * MEASURED before anything is spent (spec §4.3 rules 2 and 3, journey C3).
   *
   * The webhook does not carry a duration and the media endpoint does not
   * either, which was once read as "only the transcriber knows" and turned
   * the merchant's length limit into a reservation window. That was wrong:
   * the bytes are already here, and a container that stores audio stores how
   * much of it there is. Reading it locally costs nothing and makes the limit
   * a limit again.
   *
   * The order below is the whole point. Measure, refuse if it is too long,
   * take exactly the seconds it runs, and only then call a provider. A note
   * that is refused reaches no transcriber at all, which is what stops a
   * merchant with no allowance left from spending Rekoda's transcription
   * budget one voice note at a time.
   */
  const seconds = await deps.audioProbe.duration(audio.bytes, audio.mimeType);
  if (seconds === null) {
    /* Unreadable is not zero. A caller that treats the two alike transcribes
     * for free, and the recovery for the two is not the same: this one asks
     * the merchant to send it again, and nothing has been metered or spent. */
    log.warn('a voice note arrived in a container we could not measure');
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: replies.voiceUnreadable(),
    });
    return null;
  }

  const maxSeconds = deps.config.voiceNoteMaxDurationSeconds;
  if (seconds > maxSeconds) {
    /* The commercial limit, enforced where it protects money rather than
     * where it merely reports it. Nothing is metered: the merchant did not
     * use anything, they were told to send it differently. */
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: replies.voiceTooLong(maxSeconds),
    });
    return null;
  }

  /**
   * Exactly the seconds the note runs, taken atomically before the
   * transcriber is called. Its own short transaction, like the message unit,
   * because the counter must not be held across a network call.
   */
  const period = usagePeriod(new Date());
  const allowance = await meterAllowance(deps.config, tx, businessId, plan, 'VOICE_MINUTES');
  const granted = await withBusiness(deps.db, businessId, (own) =>
    usageRepo.consumeUnit(own, businessId, period, 'VOICE_MINUTES', allowance, seconds),
  );
  if (!granted) {
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: replies.allowanceExhausted(allowance, 'VOICE_MINUTES'),
    });
    return null;
  }

  let transcript: Transcript;
  try {
    transcript = await deps.stt.transcribe(audio.bytes, audio.mimeType);
  } catch (error) {
    /* An outage, not the merchant's fault, so the seconds go back. The reason
     * is logged without the audio and without their words. */
    await withBusiness(deps.db, businessId, (own) =>
      usageRepo.refundUnit(own, businessId, period, 'VOICE_MINUTES', seconds),
    );
    /* A hosted transcription that TIMED OUT may still be on the invoice.
     * Zero with `priced: false` is the row reconciliation ties to. The
     * merchant's seconds went back above: Rekoda's timeout, Rekoda's cost. */
    if (error instanceof TranscriptionUnavailable && error.maybeBilled) {
      await withBusiness(deps.db, businessId, (own) =>
        quotaRepo.recordUsage(own, {
          businessId,
          provider: 'openai',
          usageType: 'transcription',
          quantity: seconds,
          providerCostMicros: 0,
          nairaEquivalentK: 0,
          billingPeriod: billingPeriod(new Date()),
          meta: {
            role: 'transcriber' satisfies AiModelRole,
            priced: false,
            reason: 'timed out after the audio went out; possibly billed',
            localSeconds: seconds,
            messageId: recorded.id,
          },
        }),
      );
    }
    log.warn('the transcriber could not be reached');
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: replies.voiceUnavailable(),
    });
    return null;
  }

  /* WHAT THE TRANSCRIPTION COST (item 7). Only the hosted transcriber
   * reports usage; the sidecar writes no row because its per-call provider
   * cost is zero. BOTH durations go on the row: the local probe's (what the
   * allowance reserved on) and the provider's (what the bill runs on) —
   * recorded for audit without storing a byte of audio. */
  if (transcript.usage) {
    const cost = costOfTranscription(
      transcript.usage.model,
      transcript.seconds,
      deps.config.planningFxNairaPerUsd,
    );
    if (!cost.priced) {
      log.error(
        `no per-minute price for transcriber "${transcript.usage.model}" — recorded at zero`,
      );
    }
    await withBusiness(deps.db, businessId, (own) =>
      quotaRepo.recordUsage(own, {
        businessId,
        provider: transcript.usage!.provider,
        usageType: 'transcription',
        quantity: transcript.seconds,
        providerCostMicros: cost.usdMicros,
        nairaEquivalentK: cost.nairaKobo,
        billingPeriod: billingPeriod(new Date()),
        meta: {
          role: 'transcriber' satisfies AiModelRole,
          model: transcript.usage!.model,
          purpose: 'voice_transcription',
          priced: cost.priced,
          localSeconds: seconds,
          providerSeconds: transcript.seconds,
          messageId: recorded.id,
        },
      }),
    );
  }

  return { transcript, messageId: recorded.id };
}

/** What a deterministic answer may need beyond the tenant: the ask itself. */
interface CommandContext {
  eventId: string;
  messageId: string;
  /** The sender's wa id — the phone whose consent state STOP/START moves. */
  from: string;
  /** True on attempt 2 and later. See the note where it is set. */
  retrying: boolean;
}

/**
 * Answers that need no model. `who owes me` and `payment details` are free
 * commands answered from rows; what is not built yet still says so honestly.
 */
async function deterministicReply(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  intent: DeterministicIntent,
  ctx: CommandContext,
): Promise<Reply | null> {
  /* The yes is the moment a draft becomes a document, so it carries the same
   * role rule as making the draft: view-only members confirm nothing, not
   * even a draft the owner parked. */
  if (intent.kind === 'affirm') {
    if (!(await mayTransact(tx, businessId, ctx.from))) return replies.viewOnlyRole();
    return confirmPendingDraft(deps, tx, businessId, ctx.retrying);
  }
  if (intent.kind === 'deny' || intent.kind === 'cancel') {
    // A refusal after a preview discards the draft rather than leaving it to
    // be confirmed by an accidental "yes" ten minutes later.
    const dropped = await conversationsRepo.supersedePendingDrafts(tx, businessId);
    return dropped > 0
      ? replies.cancelled()
      : intent.kind === 'cancel'
        ? replies.cancelled()
        : null;
  }

  switch (intent.kind) {
    case 'greeting':
      return replies.greeting();
    case 'help':
      return replies.help();
    case 'stop':
      // The fact first, the sentence second: every proactive send checks this.
      await recordConsent(deps.db, ctx.from, new Date());
      return replies.optedOut();
    case 'start':
      await recordConsent(deps.db, ctx.from, null);
      return replies.optedIn();
    case 'delete_my_data': {
      /* Owner only. This deletes every customer's contact details for the
       * whole business in one irreversible statement, which is not a thing an
       * accountant or a delegate should be able to do from a phone. */
      if (!(await isOwner(tx, businessId, ctx.from))) return replies.erasureNotYours();

      /* Two-message erasure (CG-style): the first ask parks an EraseData
       * draft, the second ask claims it and deletes. Anything else in
       * between claims the draft through the ordinary yes/no paths and
       * keeps the data. */
      const pending = await conversationsRepo.pendingDraft(tx, businessId);
      const pendingCommand = pending?.command as { intent?: string } | undefined;
      if (pending && pendingCommand?.intent === 'EraseData') {
        if (!(await conversationsRepo.claimDraft(tx, pending.id))) {
          return replies.alreadyConfirmed();
        }
        /* The A1 rollout seam (spec §25, Appendix D). The exact phrase was
         * typed twice — the router IS the phrase check — and the pending
         * confirmation opened at the first ask records what the merchant was
         * told. If it lapsed (or the flag flipped between asks), one is
         * opened now recording the same consequence, claimed in the same
         * transaction: the two-message phrase mechanism already did the
         * waiting. */
        if (deps.config.commandEraseData) {
          const subject = `draft:${pending.id}`;
          const open = (await riskRepo.openConfirmationsFor(tx, businessId)).find(
            (c) => c.command === 'EraseData' && c.subject === subject,
          );
          const confirmation =
            open ??
            (await deps.commandBus.riskPolicy.ask(tx, {
              businessId,
              command: 'EraseData',
              subject,
              actor: 'system',
              ingress: 'CHAT',
              consequence:
                'Every customer contact detail for this business will be permanently deleted.',
              reason: 'merchant asked by exact phrase, twice',
            }));
          const run = await deps.commandBus.run(
            tx,
            {
              businessId,
              command: 'EraseData',
              payload: { sourceType: 'chat' },
              subject,
              confirmationId: confirmation.id,
              actor: 'system',
              ingress: 'CHAT',
            },
            () => eraseDataWork(tx, { businessId, sourceType: 'chat' }),
          );
          if (run.outcome !== 'done') return replies.erasureKept();
          return replies.erasureDone(run.result.erased);
        }
        const erased = await eraseDataWork(tx, { businessId, sourceType: 'chat' });
        return replies.erasureDone(erased.erased);
      }
      const discarded = await conversationsRepo.supersedePendingDrafts(tx, businessId);
      const parked = await conversationsRepo.recordDraft(tx, {
        businessId,
        conversationMessageId: ctx.messageId,
        intent: 'EraseData',
        command: { intent: 'EraseData' },
        model: null,
      });
      /* Appendix D: the confirmation is opened when the merchant is SHOWN
       * the consequence, so the record says what they agreed to. */
      if (deps.config.commandEraseData && parked.isNew) {
        await deps.commandBus.riskPolicy.ask(tx, {
          businessId,
          command: 'EraseData',
          subject: `draft:${parked.id}`,
          actor: 'system',
          ingress: 'CHAT',
          consequence:
            'Every customer contact detail for this business will be permanently deleted.',
          reason: 'merchant asked by exact phrase',
        });
      }
      return replies.confirmErasure(discarded);
    }
    case 'number':
      return replies.strayNumber();
    case 'debtors': {
      // Answered from the same SQL the dashboard uses. Invoice numbers, not
      // customer names: this text crosses WhatsApp in the clear.
      const debtors = await reportsRepo.debtorsFor(tx, businessId, 8);
      /* Oldest promise first, with how late each one is: a debtors list is a
       * work queue, and a merchant standing in a shop needs to know who to
       * call before they need the total. */
      const now = new Date();
      return replies.debtorList(
        debtors.rows.map((r) => ({
          invoiceNumber: r.invoiceNumber,
          balanceDueK: r.balanceDueK,
          daysOverdue: daysOverdue(r.dueDate, r.balanceDueK, now),
        })),
        debtors.totalK,
        debtors.count,
      );
    }
    case 'payment_details':
      /* Sends a message to a customer in the business's name, which is a
       * write in every way that matters. Same rule for reminders and
       * resends below. */
      if (!(await mayTransact(tx, businessId, ctx.from))) return replies.viewOnlyRole();
      return paymentDetailsReply(deps, tx, businessId);
    case 'remind':
      if (!(await mayTransact(tx, businessId, ctx.from))) return replies.viewOnlyRole();
      return remindReply(deps, tx, businessId, ctx, intent.invoiceNumber);
    case 'dashboard': {
      /* The link belongs to the PERSON who asked, not to the business. A
       * stranger messaging the number resolves to no membership and gets the
       * stranger path elsewhere; a delegate gets a delegate's session. A link
       * can never carry more access than the sender already had. */
      const member = await identity.memberByPhone(tx, businessId, normalisePhone(ctx.from));
      if (!member) return replies.dashboardUnavailable();

      const url = await mintDashboardLink({
        db: deps.db,
        webUrl: deps.config.webUrl,
        userId: member.userId,
        businessId,
      });
      return url ? replies.dashboardLink(url, LINK_MINUTES) : replies.dashboardUnavailable();
    }
    case 'records': {
      // The same SQL the dashboard overview runs — totals only, no customer.
      const overview = await reportsRepo.overviewFor(tx, businessId);
      return replies.recordsSummary(overview);
    }
    case 'stock': {
      /* Free and deterministic, because a merchant checks stock several times
       * a day and paying for a model call to answer "what is left" would be
       * charging them for a SELECT. Lowest count first: the row that needs
       * them is the one about to run out. */
      const register = await stockRepo.stockList(tx, businessId, 20);
      return replies.stockList(
        register.rows.map((p) => ({ name: p.name, onHand: p.onHand })),
        register.count,
        register.outOfStock,
      );
    }
    case 'resend':
      if (!(await mayTransact(tx, businessId, ctx.from))) return replies.viewOnlyRole();
      return resendReply(tx, businessId, ctx.eventId);
    case 'upgrade': {
      // Free, and always answered: this is the one message from a merchant
      // who wants to pay us, and it must never hit a wall or a dead link.
      const plan = await usageRepo.planFor(tx, businessId);
      await billingRepo.recordUpgradeRequest(tx, businessId, plan);
      return replies.upgradeRequested();
    }
    default:
      return null;
  }
}

/**
 * STOP/START, written where sends can see it. A phone that fails to
 * normalise or belongs to no user is a quiet no-op — there is no consent
 * row to keep for a person the system has never verified.
 */
/**
 * Is this wa id the business's owner?
 *
 * False for an unparseable number rather than throwing: upstream attribution
 * already accepted this sender, and the safe answer to "may they erase
 * everything" when we cannot tell is no.
 */
async function isOwner(tx: TenantDb, businessId: string, from: string): Promise<boolean> {
  try {
    return (await identity.roleOfPhone(tx, businessId, normalisePhone(from))) === 'owner';
  } catch {
    return false;
  }
}

/**
 * May this sender CHANGE the books?
 *
 * Owners and delegates can: recording trade from a phone is what a delegate
 * is for. An accountant's access is view only everywhere (spec §35), and the
 * chat surface has no guard layer, so the check lives here. False when the
 * number cannot be read or holds no membership, for the same reason isOwner
 * answers no: the safe reading of "may they write when we cannot tell" is no.
 */
async function mayTransact(tx: TenantDb, businessId: string, from: string): Promise<boolean> {
  try {
    const role = await identity.roleOfPhone(tx, businessId, normalisePhone(from));
    return role === 'owner' || role === 'delegate';
  } catch {
    return false;
  }
}

/**
 * A reminder the merchant forwards, sent as TWO messages.
 *
 * The first is Rekoda talking to the merchant; the second is the reminder
 * itself, written to be read by their customer and containing nothing else.
 * Splitting them is what makes "forward the next message as it is" a thing
 * they can actually do: a single message would carry our instructions into
 * their customer's chat.
 *
 * One invoice, named explicitly, and never a list. The merchant forwards this
 * into a private conversation, and a list would take other customers' numbers
 * and balances with it.
 */
async function remindReply(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  ctx: CommandContext,
  invoiceNumber: string,
): Promise<Reply> {
  const invoice = await issueRepo.invoiceByNumber(tx, businessId, invoiceNumber);
  if (!invoice || invoice.balanceDueK <= 0) {
    return replies.reminderNothingToChase(invoiceNumber);
  }

  const business = await identity.businessById(deps.db, businessId);
  const reminder = replies.overdueReminder({
    invoiceNumber: invoice.invoiceNumber,
    balanceDueK: invoice.balanceDueK,
    daysOverdue: daysOverdue(invoice.dueDate, invoice.balanceDueK, new Date()),
    businessName: business?.name ?? 'us',
  });

  /* The forwardable one goes first as its own message, then the handler's
   * return value becomes the instruction above it. Order matters on a phone:
   * the merchant reads the instruction last and acts on the message under
   * their thumb. */
  await deps.replySender.send(tx, { businessId, to: ctx.from, reply: reminder });
  return replies.reminderReady(invoice.invoiceNumber);
}

async function recordConsent(db: Db, from: string, at: Date | null): Promise<void> {
  try {
    await identity.setOptOut(db, normalisePhone(from), at);
  } catch (error) {
    /* Only the unparseable-number case is survivable: there is no consent
     * row to keep for a person the system never verified. A DATABASE failure
     * must throw, because the reply about to go out says "you will hear
     * nothing more from us", and proactive sends keep consulting the row
     * this write just failed to make. */
    if (!(error instanceof InvalidPhoneError)) throw error;
  }
}

/**
 * "resend": the newest stored document goes back through the same delivery
 * job that sent it the first time — same bytes, same caption rules, same
 * retries. The singleton key carries the event id, so a redelivered webhook
 * cannot queue the same resend twice while a fresh ask always can.
 */
async function resendReply(tx: TenantDb, businessId: string, eventId: string): Promise<Reply> {
  const newest = await issueRepo.latestDocumentFor(tx, businessId);
  if (!newest) return replies.nothingToResend();

  await jobsRepo.enqueue(tx, {
    businessId,
    kind: 'document.deliver',
    // requestedByMerchant: an explicit ask overrides a standing STOP for
    // exactly this one delivery — they messaged us for this document.
    payload: { documentId: newest.id, requestedByMerchant: true },
    singletonKey: `redeliver:${newest.id}:${eventId}`,
  });
  return replies.resending(newest.refNumber ?? 'your latest document');
}

/**
 * "Send payment details" (payments-v1 §160): the newest open invoice becomes
 * a payable link. Every non-link outcome is an honest sentence, never a dead
 * URL — a merchant forwards this to a customer, so it must not lie.
 *
 * The intents service runs its own transactions and talks to the provider;
 * the same shape process-payment-event already uses inside a job.
 */
async function paymentDetailsReply(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
): Promise<Reply> {
  const invoice = await issueRepo.latestOpenInvoice(tx, businessId);
  if (!invoice) return replies.paymentLinkNothingOwed();

  /* A provider outage must degrade to an honest sentence, not kill the job:
   * a thrown error here would roll back the recorded message and retry the
   * same failure until the job dies, with the merchant hearing nothing. */
  let outcome;
  try {
    outcome = await deps.paymentIntents.createForInvoice(businessId, invoice.id);
  } catch (error) {
    paymentLog.warn(
      `payment details failed at the provider: ${redactForLog(describeFailure(error))}`,
    );
    return replies.paymentLinkUnavailable();
  }

  switch (outcome.state) {
    case 'ready': {
      /* THE COMPLETE JOURNEY (spec §5.3; X1, PR-093): the ask came from
       * Chat, the delivery goes through Integrate — into the customer's
       * own thread on the merchant's WABA, through the same routing
       * decision and the same metered door every cross-product delivery
       * uses. ONE intent was minted above; when the customer pays it,
       * the pipeline books ONE payment, ONE allocation, ONE receipt.
       * Every unreachable rung falls back to today's Chat shape: the
       * merchant gets the forwardable link in their own hands, which is
       * exactly what §3.1 says a Chat-only business gets by design. */
      if (invoice.customerId) {
        const route = await deps.customerRoute.routeFor(tx, businessId, invoice.customerId);
        if (route.state === 'reachable') {
          try {
            const sent = await deps.customerTexts.sendCustomerText(
              businessId,
              {
                to: route.phone,
                text: replies.paymentDetailsForCustomer(
                  invoice.invoiceNumber,
                  outcome.amountK,
                  outcome.checkoutUrl,
                ).text,
              },
              tx,
            );
            if (sent.outcome === 'sent') {
              return replies.paymentDetailsDelivered(invoice.invoiceNumber, outcome.amountK);
            }
            paymentLog.log(`cross-product delivery not made: ${sent.outcome}`);
          } catch (error) {
            paymentLog.warn(
              `cross-product delivery failed: ${redactForLog(describeFailure(error))}`,
            );
          }
        } else {
          paymentLog.log(`cross-product delivery not routed: ${route.state}`);
        }
      }
      return replies.paymentLinkReady(invoice.invoiceNumber, outcome.amountK, outcome.checkoutUrl);
    }
    case 'connection_not_active':
      return replies.paymentLinkNeedsConnection();
    case 'requires_customer_information':
      /* Only the pre-mint no-email case is the merchant's records; a post-mint
       * provider rejection must not be blamed on them. */
      return outcome.reason === 'no_email_on_file'
        ? replies.paymentLinkNeedsEmail(invoice.invoiceNumber)
        : replies.paymentLinkUnavailable();
    case 'nothing_to_pay':
      /* The invoice settled between our read and the mint. Scoped to that
       * invoice: an older one may still be open. */
      return replies.paymentLinkSettled(invoice.invoiceNumber);
  }
}

/**
 * CG3 — a "yes" claims the pending draft, and only one "yes" can.
 *
 * `claimDraft` is a conditional UPDATE whose WHERE clause carries the
 * precondition, so two rapid confirmations become one winner and one loser.
 * The loser is told the truth — the document IS being issued — rather than
 * apologised to for a success.
 */
/**
 * A customer token resolved to the row it stands for, or null.
 *
 * Null is ordinary rather than exceptional: a merchant can name somebody the
 * privacy gateway has never tokenised, and a sale to a walk-in names nobody
 * at all. What it must never do is invent a customer, which is why it only
 * ever looks one up.
 */
async function customerIdFor(
  tx: TenantDb,
  businessId: string,
  token: string | null,
): Promise<string | null> {
  if (!token) return null;
  return customersRepo.customerIdForToken(tx, businessId, token);
}

/**
 * The stored proposal, read back defensively.
 *
 * A jsonb column can hold anything a past version wrote, and this one decides
 * which customer record disappears. Anything not shaped exactly right links
 * nothing.
 */
function identityLinkOf(value: unknown): { survivorId: string; orphanId: string } | null {
  if (!value || typeof value !== 'object') return null;
  const link = value as { survivorId?: unknown; orphanId?: unknown };
  return typeof link.survivorId === 'string' && typeof link.orphanId === 'string'
    ? { survivorId: link.survivorId, orphanId: link.orphanId }
    : null;
}

async function confirmPendingDraft(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  retrying: boolean,
): Promise<Reply | null> {
  const draft = await conversationsRepo.pendingDraft(tx, businessId);
  if (!draft) return replies.nothingToConfirm();

  const command = draft.command as { intent?: string } & Record<string, unknown>;

  /**
   * An invoice and a receipt are both metered documents (metering-v1.md §1),
   * and the copy says so: "invoices and receipts". A reported payment issues
   * a receipt, so it costs a unit exactly like a sale does; leaving that free
   * let a merchant on an exhausted plan take receipts without limit.
   *
   * Checked BEFORE the draft is claimed and before anything is booked: the
   * soft-limit rule is that nobody is cut off mid-transaction, and this is
   * the last moment that is still between transactions. Refusing here leaves
   * the draft pending, so the same "yes" works the moment they upgrade.
   */
  const issuesDocument =
    command.intent === 'RecordSale' ||
    command.intent === 'RecordPayment' ||
    /* A confirmed order raises a real invoice, so it costs a document unit
     * exactly like a sale does. Leaving it free would be a second door into
     * the same metered thing. */
    command.intent === 'RecordOrder';
  const period = usagePeriod(new Date());
  let documentTaken = false;
  let orderTaken = false;
  if (issuesDocument && !retrying) {
    const plan = await usageRepo.planFor(tx, businessId);
    /* A trial that lapsed between the preview and the yes is its own
     * sentence. The allowance path would refuse correctly and say "you have
     * used all 0 invoices this month", which is true of the number and
     * useless about the reason. */
    if (plan === 'expired') return replies.trialEnded();
    const allowance = await meterAllowance(
      deps.config,
      tx,
      businessId,
      plan,
      'DOCUMENT_GENERATION',
    );
    const granted = await withBusiness(deps.db, businessId, (own) =>
      usageRepo.consumeUnit(own, businessId, period, 'DOCUMENT_GENERATION', allowance),
    );
    if (!granted) return replies.allowanceExhausted(allowance, 'DOCUMENT_GENERATION');
    documentTaken = true;

    /* An order costs its own unit ON TOP of the document, because automatic
     * order capture is the thing Integrate sells: the allowance table said
     * so from the start, but nothing ever consumed it, so a Chat plan's
     * zero was a differentiator that existed only on the pricing page and
     * the ₦5,000 orders pack sold capacity nothing metered. Refused HERE,
     * before the draft is claimed, so the same "yes" works the moment they
     * upgrade — and a zero allowance gets the sentence about the plan, not
     * "you have used all 0 orders". */
    if (command.intent === 'RecordOrder') {
      /* The entitlement decides, not the allowance. Before PR-013 this read
       * `orderAllowance === 0` and inferred the product boundary from a
       * quantity, which only works for capabilities that happen to be
       * counted. Asked BEFORE the consume so a refusal takes nothing. */
      if (await entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_INTEGRATE')) {
        await refundDocument(deps, businessId, period);
        return replies.ordersNotInPlan();
      }
      const orderAllowance = await meterAllowance(
        deps.config,
        tx,
        businessId,
        plan,
        'CATALOGUE_ORDERS',
      );
      const orderGranted = await withBusiness(deps.db, businessId, (own) =>
        usageRepo.consumeUnit(own, businessId, period, 'CATALOGUE_ORDERS', orderAllowance),
      );
      if (!orderGranted) {
        await refundDocument(deps, businessId, period);
        return replies.allowanceExhausted(orderAllowance, 'CATALOGUE_ORDERS');
      }
      orderTaken = true;
    }
  }

  if (!(await conversationsRepo.claimDraft(tx, draft.id))) {
    /* The other "yes" won. It is issuing the invoice and it took its own
     * unit, so this one goes back: two rapid confirmations must cost one
     * document, which is how many the merchant ends up with. */
    if (documentTaken) await refundDocument(deps, businessId, period);
    if (orderTaken) await refundOrder(deps, businessId, period);
    return replies.alreadyConfirmed();
  }
  /**
   * The link the merchant was asked about in the preview, applied by the same
   * `yes`. Before the sale, so the invoice below names the record that
   * survives rather than one about to be absorbed.
   *
   * `linkCustomers` refuses a record with any history of its own, so a `yes`
   * can only ever undo a split made moments earlier. A refusal is silent: the
   * merchant asked for a sale and got one, and "I could not tidy your
   * customer list" is not worth a message in the middle of that.
   */
  const proposal = identityLinkOf(draft.identityLink);
  if (proposal) {
    await customersRepo.linkCustomers(tx, businessId, proposal.survivorId, proposal.orphanId);
  }

  if (command.intent === 'RecordExpense')
    return confirmExpense(deps, tx, businessId, draft.id, command);
  if (command.intent === 'RecordPurchase')
    return confirmPurchase(deps, tx, businessId, draft.id, command);
  if (command.intent === 'EraseData') {
    // Erasure confirms ONLY with the exact phrase. A "yes" is "anything
    // else" in the confirmation copy's terms, and anything else keeps the data.
    return replies.erasureKept();
  }
  if (command.intent === 'RecordPayment') {
    /* Refunds its own unit on every path that answers without issuing a
     * receipt: an invoice settled from under the merchant, or a payment we
     * could not place, must not cost them a document they never got. */
    return confirmPayment(deps, tx, businessId, draft, command, () =>
      documentTaken ? refundDocument(deps, businessId, period) : Promise.resolve(),
    );
  }
  if (command.intent === 'AdjustInventory') {
    /* No document, so the unit this confirmation reserved goes back. A stock
     * count produces nothing to send and must not cost the merchant one of
     * the documents they are allowed to generate. */
    if (documentTaken) await refundDocument(deps, businessId, period);
    return confirmStockChange(deps, tx, businessId, draft.id, command as never);
  }
  if (command.intent === 'RecordOrder') {
    return confirmOrder(deps, tx, businessId, draft.id, command as never, async () => {
      /* Every no-order path gives BOTH units back: no invoice came out, so
       * neither the document nor the order capture was delivered. */
      if (documentTaken) await refundDocument(deps, businessId, period);
      if (orderTaken) await refundOrder(deps, businessId, period);
    });
  }
  if (command.intent !== 'RecordSale') {
    // Anything else is not actionable yet. The draft is claimed either way,
    // so an unconfirmable one cannot sit pending forever inviting another yes.
    return replies.notYet('Recording that kind of entry');
  }

  const gate = gateSale(command as never);
  if (gate.gate !== 'CG2') {
    // Should be unreachable: a CG1 draft is never previewed, so nothing ever
    // invited a yes for it. Handled rather than asserted, and the unit goes
    // back with it, because no invoice comes out of this branch.
    if (documentTaken) await refundDocument(deps, businessId, period);
    return replies.arithmeticQuestion(gate.question);
  }

  const money = gate.money;
  const items = (
    command['items'] as Array<{ name: string; quantity: number; unitPrice: number }>
  ).map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unitPriceK: Math.round(item.unitPrice * 100),
  }));
  const input: RecordSaleInput = {
    businessId,
    /* The person, not just their pseudonym. The gateway resolved a customer
     * row before the model ever saw this message and the sale used to throw
     * it away, which left every chat-issued invoice unable to answer "whose
     * is this" - and a payment link needs an email off that customer's vault
     * to exist at all. */
    customerId: await customerIdFor(tx, businessId, customerTokenOf(command)),
    customerToken: customerTokenOf(command),
    items,
    subtotalK: money.subtotalK,
    discountK: money.discountK,
    deliveryFeeK: money.deliveryFeeK,
    vatK: money.vatK,
    totalK: money.totalK,
    paidK: money.amountPaidK,
    balanceDueK: money.balanceDueK,
    method: command['paymentMethod'] === 'cash' ? 'cash' : 'transfer',
    /* Captured-via vs where-it-happened (rekoda-chat-v1 §27): sourceType says
     * this arrived through a Chat conversation; saleSource carries the channel
     * ONLY when the merchant named one, validated against the domain list. */
    sourceType: 'chat',
    sourceId: draft.id,
    saleSource: isSaleSource(command['saleSource']) ? command['saleSource'] : null,
    /* The merchant told us when they expect the money and until now we threw
     * it away. The model reported the PHRASE; core decides which day it is,
     * because that day is when somebody gets chased. */
    dueDate: resolveDueDate(
      typeof command['dueDescription'] === 'string' ? command['dueDescription'] : null,
      new Date(),
    ),
    actor: 'system',
  };

  /* The A1 rollout seam (spec §25). Same work function either way — the flag
   * decides whether the command bus's gates run around it. Off is exactly
   * the path this handler always took, which is what makes the flag a
   * rollback and not a second implementation. */
  if (deps.config.commandRecordSale) {
    const run = await deps.commandBus.run(
      tx,
      {
        businessId,
        command: 'RecordSale',
        payload: input,
        actor: 'system',
        ingress: 'CHAT',
        /* The claimed draft: one draft, one yes, one sale. The claim above
         * already guarantees single execution; this key is the second net,
         * and it makes the replay answer the same reply. */
        idempotencyKey: `draft:${draft.id}`,
      },
      () => recordSaleWork(tx, input),
    );
    if (run.outcome !== 'done') {
      /* Unreachable by construction — RecordSale is STANDARD and ungated —
       * so reaching it is a bug. The unit goes back and the merchant hears
       * "not yet" rather than silence. */
      if (documentTaken) await refundDocument(deps, businessId, period);
      return replies.notYet('Recording that sale');
    }
    if (run.replayed && documentTaken) {
      /* The first run already paid for this invoice. */
      await refundDocument(deps, businessId, period);
    }
    return replies.issued(run.result.invoiceNumber, run.result.totalK, run.result.balanceDueK);
  }

  const issued = await recordSaleWork(tx, input);
  return replies.issued(issued.invoiceNumber, money.totalK, money.balanceDueK);
}

/**
 * A confirmed order: the order, the invoice it becomes, and the stock it
 * commits, in one transaction.
 *
 * The catalogue is re-read here rather than carried on the draft, for the
 * same reason `confirmStockChange` re-reads the count: the merchant may have
 * changed a price between the preview and the yes, and quoting from a stale
 * figure would issue an invoice for a number they have since decided against.
 * If that re-read changes anything the order cannot be quoted on, this
 * refuses and says so rather than issuing at yesterday's price.
 *
 * The stock moves, exactly as it does for a sale the merchant dictates. An
 * order they have agreed to IS a sale on credit: the goods are committed, the
 * customer owes for them, and the shelf figure has to say so or the next
 * customer is quoted for bales that are already spoken for.
 */
async function confirmOrder(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  draftId: string,
  command: StructuredBusinessCommand & { intent: 'RecordOrder' },
  refund: () => Promise<void>,
): Promise<Reply> {
  /* By the names the order asks for, not the first three hundred products by
   * name: a shop with more than that had everything past the cap priced as
   * something it does not stock. */
  const catalogue = await catalogueRepo.catalogueByNames(
    tx,
    businessId,
    command.items.map((i) => i.name),
  );
  const order = priceOrder(command.items, catalogue);

  const question = orderQuestion(order);
  if (question) {
    /* No invoice comes out of this branch, so the document unit goes back. */
    await refund();
    return replies.arithmeticQuestion(question);
  }

  const input: PlaceOrderCmdInput = {
    businessId,
    customerId: await customerIdFor(tx, businessId, customerTokenOf(command as never)),
    customerToken: customerTokenOf(command as never),
    lines: order.lines.map((line) => ({
      productId: line.productId,
      name: line.name,
      quantity: line.quantity,
      unitPriceK: line.unitPriceK,
      lineTotalK: line.lineTotalK,
    })),
    totalK: order.totalK,
    sourceType: 'chat',
    sourceId: draftId,
    /* Where the sale happened is not knowable from a forwarded message: the
     * customer wrote it somewhere, and guessing which app would be Rekoda
     * inventing a channel the merchant never named. */
    saleSource: null,
    /* The invoice cites the confirmed draft, as it always has. */
    invoiceSourceId: draftId,
    actor: 'system',
  };

  /* The A1 rollout seam (spec §25). The bus enforces REKODA_INTEGRATE too —
   * the ingress already refused before taking units, and a second door
   * refusing is the matrix holding, not a duplicate. */
  let placed: Awaited<ReturnType<typeof placeOrderWork>>;
  if (deps.config.commandRecordOrder) {
    const run = await deps.commandBus.run(
      tx,
      {
        businessId,
        command: 'RecordOrder',
        payload: input,
        actor: 'system',
        ingress: 'CHAT',
        idempotencyKey: `draft:${draftId}`,
      },
      () => placeOrderWork(tx, input),
    );
    if (run.outcome === 'not_entitled') {
      await refund();
      return replies.ordersNotInPlan();
    }
    if (run.outcome !== 'done') {
      await refund();
      return replies.notYet('Recording that order');
    }
    placed = run.result;
  } else {
    placed = await placeOrderWork(tx, input);
  }

  return replies.orderRaised(placed.orderNumber, placed.invoiceNumber, order.totalK);
}

/**
 * A confirmed stock count.
 *
 * The product is created on first mention, so a shop's catalogue builds
 * itself out of what they actually trade rather than out of a setup screen
 * nobody fills in. The count is re-read here rather than carried on the
 * draft: a sale may have landed between the preview and the yes, and a
 * movement applied against a stale figure would report a total the shelf
 * disagrees with.
 */
async function confirmStockChange(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  draftId: string,
  command: StructuredBusinessCommand & { intent: 'AdjustInventory' },
): Promise<Reply> {
  const product = await stockRepo.findOrCreateProduct(tx, businessId, command.productMention);
  const gate = gateStockChange(command, product.onHand);
  /* The count moved under the merchant between preview and confirmation. The
   * gate says why in the merchant's own terms; nothing is written. */
  if (gate.gate === 'CG1') return replies.arithmeticQuestion(gate.question);

  const destructive = gate.quantityDelta < 0;
  const input: AdjustInventoryInput = {
    businessId,
    productId: product.id,
    delta: gate.quantityDelta,
    sourceType: 'chat',
    sourceId: draftId,
  };

  /* The A1 rollout seam (spec §25, Appendix D). Adding stock is STANDARD;
   * writing it OFF is D.2's destructive adjustment and must claim the
   * confirmation the preview opened. A lapsed one gets a fresh preview, not
   * a shrug: five minutes is the window a decision about disappearing stock
   * stays warm. */
  if (deps.config.commandAdjustInventory) {
    let confirmationId: string | null = null;
    if (destructive) {
      const open = (await riskRepo.openConfirmationsFor(tx, businessId)).find(
        (c) => c.command === 'AdjustInventory' && c.subject === `draft:${draftId}`,
      );
      if (!open) return replies.confirmationLapsed('that stock change');
      confirmationId = open.id;
    }
    const run = await deps.commandBus.run(
      tx,
      {
        businessId,
        command: 'AdjustInventory',
        payload: input,
        subject: `draft:${draftId}`,
        ...(destructive ? { context: { destructive: true } } : {}),
        confirmationId,
        actor: 'system',
        ingress: 'CHAT',
        idempotencyKey: `draft:${draftId}`,
      },
      () => adjustInventoryWork(tx, input),
    );
    if (
      run.outcome === 'confirm_first' ||
      run.outcome === 'confirmation_expired' ||
      run.outcome === 'confirmation_already_used' ||
      run.outcome === 'confirmation_invalid'
    ) {
      return replies.confirmationLapsed('that stock change');
    }
    if (run.outcome !== 'done') return replies.notYet('Updating that stock count');
  } else {
    await adjustInventoryWork(tx, input);
  }
  return replies.stockSaved(product.name, gate.quantityDelta, gate.onHandAfter);
}

/**
 * A confirmed expense: the row and its balanced posting, one transaction, and
 * a reply that says "in your books" rather than pretending a document exists.
 * No render job follows — there is no paper to make.
 */
async function confirmExpense(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  draftId: string,
  command: Record<string, unknown>,
): Promise<Reply> {
  const gate = gateExpense(command as never);
  if (gate.gate !== 'CG2') return replies.arithmeticQuestion(gate.question);

  const description = String(command['description'] ?? '');
  const input: RecordExpenseCmdInput = {
    businessId,
    description,
    category: typeof command['category'] === 'string' ? command['category'] : null,
    amountK: gate.amountK,
    method: command['paymentMethod'] === 'transfer' ? 'transfer' : 'cash',
    sourceType: 'chat',
    sourceId: draftId,
  };

  /* The A1 rollout seam (spec §25): same work either way; the flag decides
   * whether the bus's gates wrap the call. */
  if (deps.config.commandRecordExpense) {
    const run = await deps.commandBus.run(
      tx,
      {
        businessId,
        command: 'RecordExpense',
        payload: input,
        actor: 'system',
        ingress: 'CHAT',
        idempotencyKey: `draft:${draftId}`,
      },
      () => recordExpenseWork(tx, input),
    );
    if (run.outcome !== 'done') return replies.notYet('Recording that expense');
  } else {
    await recordExpenseWork(tx, input);
  }
  return replies.expenseSaved(gate.amountK, description);
}

/**
 * A confirmed stock purchase. The supplier MENTION never reaches this
 * boundary — the draft resolved it into a vault row and kept only the id
 * (migration 0050; see spend.ts). What survives is what the books need:
 * the stock, the cost, what is still owed, and WHO it is owed to as a
 * reference the vault can open, never as a name.
 */
async function confirmPurchase(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  draftId: string,
  command: Record<string, unknown>,
): Promise<Reply> {
  const gate = gatePurchase(command as never);
  if (gate.gate !== 'CG2') return replies.arithmeticQuestion(gate.question);

  const supplierId = typeof command['supplierId'] === 'string' ? command['supplierId'] : null;

  /**
   * A purchase is a delivery too, when the merchant counted one. Carried on
   * the command input so the goods land in the SAME transaction as the
   * money. Only when they named a countable thing AND a number: inferring a
   * quantity from an amount would put a stock count in their books that
   * nobody took. The arrival's cost is the gate's amount — the merchant
   * named a thing, a number of it and an amount; that is a unit cost, and
   * it is the only one they have given us.
   */
  const arriving = purchaseArrival(command as never);
  const input: RecordPurchaseCmdInput = {
    businessId,
    description: String(command['description'] ?? ''),
    amountK: gate.amountK,
    paidK: gate.paidK,
    sourceType: 'chat',
    sourceId: draftId,
    supplierId,
    arrivals: arriving
      ? [{ product: arriving.productMention, quantity: arriving.quantity, costK: gate.amountK }]
      : [],
  };

  /* The A1 rollout seam (spec §25). */
  let recorded: Awaited<ReturnType<typeof recordPurchaseWork>>;
  if (deps.config.commandRecordPurchase) {
    const run = await deps.commandBus.run(
      tx,
      {
        businessId,
        command: 'RecordPurchase',
        payload: input,
        actor: 'system',
        ingress: 'CHAT',
        idempotencyKey: `draft:${draftId}`,
      },
      () => recordPurchaseWork(tx, input),
    );
    if (run.outcome !== 'done') return replies.notYet('Recording that purchase');
    recorded = run.result;
  } else {
    recorded = await recordPurchaseWork(tx, input);
  }

  const landed = recorded.arrived[0];
  return landed
    ? replies.purchaseSaved(gate.amountK, recorded.owedK, landed)
    : replies.purchaseSaved(gate.amountK, recorded.owedK);
}

/**
 * What the books say, in answer to a spoken question.
 *
 * The model decided WHICH question was asked and over what period. It
 * computed nothing: the window comes from `resolvePeriod` and every figure
 * from SQL, which is the same rule that keeps it out of the arithmetic on
 * every other path.
 *
 * No customer is ever named in what comes back. These answers cross WhatsApp
 * in the clear, so a balance is reported by invoice number exactly as the
 * debtors list is.
 */
async function answerQuery(
  tx: TenantDb,
  businessId: string,
  command: Extract<StructuredBusinessCommand, { intent: 'Query' }>,
): Promise<Reply> {
  /* `custom` periods carry only the merchant's words, which nothing here can
   * turn into boundaries yet. This month is the honest default and the reply
   * names the window, so a merchant who meant something else can see that. */
  const period = resolvePeriod(
    command.period === 'today' || command.period === 'week' ? command.period : 'month',
    new Date(),
  );

  switch (command.topic) {
    case 'debtors': {
      const debtors = await reportsRepo.debtorsFor(tx, businessId, 8);
      const now = new Date();
      return replies.debtorList(
        debtors.rows.map((r) => ({
          invoiceNumber: r.invoiceNumber,
          balanceDueK: r.balanceDueK,
          daysOverdue: daysOverdue(r.dueDate, r.balanceDueK, now),
        })),
        debtors.totalK,
        debtors.count,
      );
    }

    case 'customer_balance': {
      const token = customerTokenOf(command as never);
      /* No token means the model heard a name it could not resolve to
       * anybody we know. Asking is better than answering about the wrong
       * person, or about everybody. */
      if (!token) return replies.paymentNoOpenInvoice();
      const owed = await issueRepo.openInvoicesForCustomer(tx, businessId, token);
      return replies.customerBalanceAnswer(
        owed.map((r) => ({ invoiceNumber: r.invoiceNumber, balanceDueK: r.balanceDueK })),
        owed.reduce((n, r) => n + r.balanceDueK, 0),
      );
    }

    case 'sales_summary': {
      const summary = await reportsRepo.summaryFor(tx, businessId, period.from, period.to);
      return replies.salesAnswer({ label: period.label, ...summary });
    }

    case 'expenses_summary': {
      const summary = await reportsRepo.summaryFor(tx, businessId, period.from, period.to);
      return replies.expensesAnswer({ label: period.label, ...summary });
    }

    case 'supplier_balances': {
      const overview = await reportsRepo.overviewFor(tx, businessId);
      return replies.suppliersAnswer(overview.youOweK);
    }

    case 'unreconciled': {
      const overview = await reportsRepo.overviewFor(tx, businessId);
      return replies.unreconciledAnswer(overview.exceptionsOpen);
    }

    case 'report_request':
      return replies.reportRequestAnswer();
  }
}

/**
 * A confirmed payment the merchant reported.
 *
 * The invoice is resolved AGAIN here rather than carried on the draft: a
 * provider payment or another reported one may have landed since the
 * preview, and applying a stale balance is how an invoice goes negative. The
 * gate runs again on the fresh figure for the same reason.
 */
async function confirmPayment(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  draft: { id: string; messageKind: string | null },
  command: Record<string, unknown>,
  refundDocumentUnit: () => Promise<void>,
): Promise<Reply> {
  const target = await issueRepo.openInvoiceForPayment(tx, businessId, {
    invoiceNumber: (command['documentRef'] as string | null) ?? null,
    customerToken: customerTokenOf(command),
  });
  if (target.outcome === 'none') {
    await refundDocumentUnit();
    return replies.paymentNoOpenInvoice();
  }
  if (target.outcome === 'ambiguous') {
    await refundDocumentUnit();
    return replies.paymentWhichInvoice(target.openCount);
  }
  const invoice = target.invoice;

  const gate = gatePayment(command as never, invoice.invoiceNumber, invoice.balanceDueK);
  if (gate.gate !== 'CG2') {
    await refundDocumentUnit();
    return replies.arithmeticQuestion(gate.question);
  }

  /* How the merchant's assertion reached us (spec E.7) — from the DRAFTING
   * message's kind, never guessed. Context for a human, not a trust grade:
   * the payment stays MERCHANT_ATTESTED whichever way it was said. */
  const basis =
    draft.messageKind === 'voice'
      ? 'SPOKEN'
      : draft.messageKind === 'media'
        ? 'SAW_AN_IMAGE'
        : draft.messageKind === 'text'
          ? 'TYPED'
          : null;

  /* A screenshot came with the claim: the evidence row records that an image
   * was SHOWN (§6.1 — it proves nothing), born RESOLVED because the
   * attestation it accompanies resolves it in this same transaction. */
  let paymentEvidenceId: string | null = null;
  if (basis === 'SAW_AN_IMAGE') {
    const evidenceInput = {
      businessId,
      source: 'chat_image',
      claimedAmountK: gate.amountK,
      resolution: { state: 'RESOLVED', at: new Date() } as const,
    };
    if (deps.config.commandRecordPayment) {
      const run = await deps.commandBus.run(
        tx,
        {
          businessId,
          command: 'RecordPaymentEvidence',
          payload: evidenceInput,
          actor: 'system',
          ingress: 'CHAT',
          idempotencyKey: `evidence:${draft.id}`,
        },
        () => recordPaymentEvidenceWork(tx, evidenceInput),
      );
      paymentEvidenceId = run.outcome === 'done' ? run.result.evidenceId : null;
    } else {
      paymentEvidenceId = (await recordPaymentEvidenceWork(tx, evidenceInput)).evidenceId;
    }
  }

  const input: RecordPaymentInput = {
    businessId,
    invoice: { id: invoice.id },
    amountK: gate.amountK,
    method: command['paymentMethod'] === 'cash' ? 'cash' : 'transfer',
    sourceType: 'chat',
    sourceId: draft.id,
    actor: 'system',
    evidenceBasis: basis,
    paymentEvidenceId,
  };

  /* The A1 rollout seam (spec §25): the work books the payment, enqueues the
   * receipt's paper and announces it; the flag decides whether the bus's
   * gates wrap the call. Refusals come back as OUTCOMES, which is what lets
   * the idempotency snapshot complete beside them — a retried refusal
   * replays as the same refusal instead of a claim stuck "running". */
  let recorded: RecordPaymentResult;
  if (deps.config.commandRecordPayment) {
    const run = await deps.commandBus.run(
      tx,
      {
        businessId,
        command: 'RecordPayment',
        payload: input,
        actor: 'system',
        ingress: 'CHAT',
        idempotencyKey: `draft:${draft.id}`,
      },
      () => recordPaymentWork(tx, input),
    );
    if (run.outcome !== 'done') {
      /* Unreachable by construction — RecordPayment is STANDARD and ungated. */
      await refundDocumentUnit();
      return replies.notYet('Recording that payment');
    }
    if (run.replayed && run.result.outcome === 'recorded') {
      /* The first run already paid for this receipt. */
      await refundDocumentUnit();
    }
    recorded = run.result;
  } else {
    recorded = await recordPaymentWork(tx, input);
  }

  if (recorded.outcome === 'already_settled') {
    await refundDocumentUnit();
    return replies.paymentAlreadySettled(invoice.invoiceNumber);
  }
  if (recorded.outcome === 'balance_moved') {
    await refundDocumentUnit();
    return replies.paymentBalanceMoved(
      recorded.invoiceNumber,
      recorded.balanceDueK,
      recorded.excessK,
    );
  }
  if (recorded.outcome !== 'recorded') {
    /* `not_found` cannot happen on the id path; honest fallback, unit back. */
    await refundDocumentUnit();
    return replies.paymentNoOpenInvoice();
  }

  /* Every figure here comes from the WRITE, never from the gate. The gate
   * read the balance without a lock, so its amount is what we hoped to post;
   * `recorded.amountK` is what the ledger actually took. */
  return replies.paymentRecorded(
    recorded.receiptNumber,
    recorded.amountK,
    recorded.invoiceNumber,
    recorded.balanceDueK,
  );
}

function customerTokenOf(command: Record<string, unknown>): string | null {
  const customer = command['customer'] as { kind?: string; token?: string } | undefined;
  return customer?.kind === 'token' ? (customer.token ?? null) : null;
}

/** The model path: a draft when it worked, an honest sentence when it did not. */
async function interpretedReply(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  rawText: string,
  safeText: string,
  conversationMessageId: string,
  retrying: boolean,
  /** Two records this message may have made of one person. Usually null. */
  link: IdentityLinkProposal | null,
  /** The sender's wa id, for the role check on write commands. */
  from: string,
  /**
   * The gateway's token table for THIS message, shared with the reply send.
   * A mention resolved below adds its token here, which is what lets the
   * preview say the customer's name over the wire while every stored copy
   * holds the token.
   */
  tokens: Map<string, string>,
): Promise<Reply> {
  /**
   * The MONTHLY meter (docs/metering-v1.md), checked before the model is
   * paid for. Router-served turns never reach this function, so free
   * commands stay free at zero units. The consume is atomic: two racing
   * messages cannot both take the last unit. Refusal is the doorway reply,
   * and the unit was not spent — a refused message costs the merchant
   * nothing.
   */
  const plan = await usageRepo.planFor(tx, businessId);
  /* A lapsed trial is its own sentence, not "you used all 0 messages". The
   * plan carries the fact (allowances are all zero), so the gate below still
   * refuses; what changes is what the merchant is told. */
  if (plan === 'expired') return replies.trialEnded();

  /* ENTITLEMENT BEFORE METER, and before the model is paid for (spec §4.3,
   * rules 1 to 3). An Integrate-only merchant holds the customer-facing half
   * and not this one, and refusing here means no unit is taken and no
   * provider is called — so there is nothing to refund and no path where the
   * meter can drift. */
  if (await entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_CHAT')) {
    return replies.chatNotInPlan();
  }

  const monthlyMessages = await meterAllowance(deps.config, tx, businessId, plan, 'AI_ACTIONS');
  const period = usagePeriod(new Date());

  /**
   * The consume runs in its OWN short transaction, not this job's.
   *
   * This one spans the model call, which can take twenty seconds, and the
   * counter row is locked for the whole of an enclosing transaction. Every
   * other message from the same business would queue behind it — one slow
   * model call throttling a whole shop. The compensating refund below is
   * what makes a separate transaction safe: the meter is corrected by a
   * second statement rather than by a rollback.
   */
  /* Skipped on a retry: attempt 1's consume committed in its own transaction
   * and survived this job's rollback, so taking another would charge the
   * merchant again for one message. */
  const granted = retrying || (await consumeMessage(deps, businessId, period, monthlyMessages));
  if (!granted) return replies.allowanceExhausted(monthlyMessages);

  const interpreted = await deps.interpreter.interpret(businessId, safeText);

  /**
   * The meter only moves when the product worked. If the model never ran
   * (daily ceiling, provider down) or its answer was unusable, the unit goes
   * back — a merchant must never watch their allowance shrink on Rekoda's
   * failures.
   */
  if (interpreted.outcome !== 'command' && !retrying) {
    await refundMessage(deps, businessId, period);
  }

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

  /**
   * The role rule, applied where the intent is first known.
   *
   * A question is a read and answers for every member; anything else changes
   * the books, and a view-only member does not get a draft to say yes to.
   * Checked after the model because only the model knows which of the two
   * this message was; the message unit it spent is the ordinary price of
   * finding out.
   */
  if (
    interpreted.command.intent !== 'Query' &&
    interpreted.command.intent !== 'Unclear' &&
    !(await mayTransact(tx, businessId, from))
  ) {
    return replies.viewOnlyRole();
  }

  /**
   * A mention becomes a vault identity before ANYTHING stores the command.
   *
   * The model saw the name once, because nothing knew it yet. From here the
   * name lives encrypted as a customer facet, the command carries the token,
   * and so do the draft and the preview the merchant reads back. The next
   * message that types this name is caught by the gateway's known-name pass
   * and the model never sees it again. This is the promise on /ai-privacy,
   * made mechanical.
   */
  let command = interpreted.command;
  if ('customer' in command && command.customer && command.customer.kind === 'mention') {
    const mention = command.customer.mention;
    const named = await deps.gateway.resolveMention(businessId, mention);
    tokens.set(named.token, mention);
    command = {
      ...command,
      customer: { kind: 'token', token: named.token },
    } as StructuredBusinessCommand;

    /* The inbound row was stored BEFORE the model named this customer, so it
     * still carries the name. Scrubbed now, in the same transaction: the
     * conversation history must not hold a customer's real name, and "we
     * only learned it was a name a moment ago" is not an exemption. */
    const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
    const scrubbed = safeText.replace(pattern, named.token);
    if (scrubbed !== safeText) {
      await conversationsRepo.setInboundBody(tx, businessId, conversationMessageId, scrubbed);
    }
  }

  /**
   * CG5 — a correction REPLACES the pending draft rather than sitting beside
   * it. Superseded, not deleted: what the merchant first said is part of the
   * record, and it is the only way to answer "why does this say 3 when I said
   * 4". Getting the direction wrong makes a merchant fixing a quantity lose
   * the sale they were fixing.
   */
  const existing = await conversationsRepo.pendingDraft(tx, businessId);
  const correcting = looksLikeCorrection(rawText, existing !== null);
  if (correcting) await conversationsRepo.supersedePendingDrafts(tx, businessId);

  /**
   * The answer is built BEFORE the draft is stored, because what the draft
   * carries depends on what the merchant was actually asked.
   *
   * A link proposal is only saved when the question about it reached them. A
   * CG1 arithmetic question comes first and leaves no room for a second
   * question, and storing the proposal anyway would mean a later `yes` joining
   * two customer records nobody was ever asked about.
   */
  const answered = await acknowledge(tx, businessId, command, correcting, link);

  /* Supplier names are never persisted (ADR 0005): the preview above
   * already said "From: ...". What the stored draft keeps instead is the
   * VAULT ROW the mention resolved to (migration 0050) — an opaque id the
   * confirm can stamp on the purchase, never the name itself. */
  let stored: Record<string, unknown> = command;
  if (command.intent === 'RecordPurchase') {
    const mention = (command as { supplierMention?: unknown }).supplierMention;
    const supplier =
      typeof mention === 'string' && mention.trim().length > 0
        ? await deps.gateway.resolveSupplierMention(businessId, mention)
        : null;
    stored = { ...command, supplierMention: null, supplierId: supplier?.supplierId ?? null };
  }

  const draft = await conversationsRepo.recordDraft(tx, {
    businessId,
    conversationMessageId,
    intent: command.intent,
    command: stored,
    model: deps.config.aiModelDefault,
    identityLink: answered.linkAsked ? link : null,
  });

  /* Appendix D: a preview that shows stock DISAPPEARING opens the
   * confirmation the yes will claim, recording the exact consequence the
   * merchant read. Additions stay STANDARD and open nothing. */
  if (deps.config.commandAdjustInventory && command.intent === 'AdjustInventory' && draft.isNew) {
    const product = await stockRepo.productByName(tx, businessId, command.productMention);
    const gate = gateStockChange(command, product?.onHand ?? 0);
    if (gate.gate === 'CG2' && gate.quantityDelta < 0) {
      await deps.commandBus.riskPolicy.ask(tx, {
        businessId,
        command: 'AdjustInventory',
        subject: `draft:${draft.id}`,
        actor: 'system',
        ingress: 'CHAT',
        consequence: gate.preview,
        reason: 'stock written off by merchant count',
        context: { destructive: true },
      });
    }
  }

  return answered.reply;
}

/**
 * What we say about a command we understood but have not acted on.
 *
 * Saying "Recorded!" here would be the exact failure the gates exist to
 * prevent: claiming something happened before it has. The preview belongs to
 * CG2 and the document to the transaction engine.
 */
async function acknowledge(
  tx: TenantDb,
  businessId: string,
  command: StructuredBusinessCommand,
  correcting: boolean,
  link: IdentityLinkProposal | null = null,
): Promise<{ reply: Reply; linkAsked: boolean }> {
  /**
   * The link question rides a PREVIEW and nothing else. A clarification, an
   * answered query and a CG1 arithmetic question are all the wrong moment:
   * none of them ends in the `yes` that would confirm it.
   */
  const withLink = (preview: Reply): { reply: Reply; linkAsked: boolean } => {
    if (!link) return { reply: preview, linkAsked: false };
    return {
      reply: replies.preview(
        `${preview.text}\n\n${replies.linkQuestion(link.survivorToken, link.orphanToken)}`,
      ),
      linkAsked: true,
    };
  };
  const plain = (reply: Reply) => ({ reply, linkAsked: false });

  if (command.intent === 'Unclear') return plain(replies.clarification(command.clarification));

  /**
   * A question is a READ, so it answers now.
   *
   * No draft, no preview, no yes. The conversation gates exist because a
   * write a merchant did not intend is expensive to undo; a wrong answer to
   * a question costs one message and they ask again. Routing questions
   * through CG2 would make the product ask "shall I tell you?".
   *
   * `Query` has been in the command contract since M0 with nothing handling
   * it, so the model could emit one and the merchant got "Recording that kind
   * of entry is not built yet" — the wrong sentence for a question, about a
   * thing they were not recording.
   */
  if (command.intent === 'Query') return plain(await answerQuery(tx, businessId, command));

  /**
   * A reported payment is gated against a REAL balance, read here.
   *
   * "Half" and "the rest" mean nothing without the invoice, and the contract
   * is explicit that resolving them is core's job over a figure from SQL —
   * never the model's arithmetic about what a customer owes.
   */
  if (command.intent === 'RecordPayment') {
    const target = await issueRepo.openInvoiceForPayment(tx, businessId, {
      invoiceNumber: command.documentRef,
      customerToken: customerTokenOf(command as never),
    });
    if (target.outcome === 'none') return plain(replies.paymentNoOpenInvoice());
    if (target.outcome === 'ambiguous') {
      return plain(replies.paymentWhichInvoice(target.openCount));
    }
    const invoice = target.invoice;

    const paymentGate = gatePayment(command, invoice.invoiceNumber, invoice.balanceDueK);
    if (paymentGate.gate === 'CG1') {
      return plain(replies.arithmeticQuestion(paymentGate.question));
    }
    return withLink(
      replies.preview(
        correcting
          ? `${replies.correctionTaken().text}\n\n${paymentGate.preview}`
          : paymentGate.preview,
      ),
    );
  }

  /**
   * An order somebody else placed, forwarded here by the merchant.
   *
   * The prices come from the merchant's catalogue, read now. That is the
   * whole difference between this and a sale: a sale reports what the
   * merchant charged, and this proposes what they WOULD charge, so there is
   * no testimony to check the arithmetic against and no figure the model is
   * allowed to name. An unpriced product becomes a question rather than a
   * guess, because inventing a price would put a number in front of a
   * customer that the merchant never agreed to.
   */
  if (command.intent === 'RecordOrder') {
    const catalogue = await catalogueRepo.catalogueByNames(
      tx,
      businessId,
      command.items.map((i) => i.name),
    );
    const order = priceOrder(command.items, catalogue);

    const question = orderQuestion(order);
    if (question) return plain(replies.arithmeticQuestion(question));

    /* A link proposal belongs here for the same reason it does on a sale:
     * the `yes` is about a customer, and this is the message that asks. */
    return withLink(
      replies.preview(
        correcting
          ? `${replies.correctionTaken().text}\n\n${orderPreview(order, command.note)}`
          : orderPreview(order, command.note),
      ),
    );
  }

  if (command.intent === 'AdjustInventory') {
    /**
     * The count comes from SQL, never from the model.
     *
     * "I have 5 left" and "add 20" are both a delta against a real figure,
     * and a model that guessed at the figure would be a model deciding what a
     * merchant owns. Reading it here also means the preview can say what the
     * count was and what it becomes, which is the whole point of a preview.
     */
    const product = await stockRepo.productByName(tx, businessId, command.productMention);
    const stockGate = gateStockChange(command, product?.onHand ?? 0);
    if (stockGate.gate === 'CG1') return plain(replies.arithmeticQuestion(stockGate.question));
    /* Stock has no customer, so a link proposal in the same message is about
     * somebody the merchant mentioned rather than about this entry. Asked
     * only where the `yes` is about a customer. */
    return plain(
      replies.preview(
        correcting
          ? `${replies.correctionTaken().text}\n\n${stockGate.preview}`
          : stockGate.preview,
      ),
    );
  }

  /**
   * CG1 before CG2, always. A preview of numbers we already know are wrong is
   * a request to approve a mistake. The same order holds for money out: a
   * purchase claiming more paid than it cost gets a question, not a preview.
   */
  const gate =
    command.intent === 'RecordSale'
      ? gateSale(command)
      : command.intent === 'RecordExpense'
        ? gateExpense(command)
        : command.intent === 'RecordPurchase'
          ? gatePurchase(command)
          : null;
  if (!gate) return plain(replies.notYet('Recording that kind of entry'));

  if (gate.gate === 'CG1') return plain(replies.arithmeticQuestion(gate.question));

  /* A sale names a customer; an expense and a purchase do not. Only the first
   * ends in a `yes` that is about the person the question asks about. */
  const wrap = command.intent === 'RecordSale' ? withLink : plain;
  return wrap(
    replies.preview(
      correcting ? `${replies.correctionTaken().text}\n\n${gate.preview}` : gate.preview,
    ),
  );
}

/** The classification, in a form the reply layer can read back. */
/**
 * Take one message unit on the app pool, outside the job's transaction.
 *
 * Mirrors `reserveAiCall`, which reserves the daily slot the same way and for
 * the same reason: a counter that every message of a business contends on
 * must never be held across a network call to a model.
 */
function consumeMessage(
  deps: InboundMessageDeps,
  businessId: string,
  period: string,
  allowance: number,
): Promise<boolean> {
  return withBusiness(deps.db, businessId, (tx) =>
    usageRepo.consumeUnit(tx, businessId, period, 'AI_ACTIONS', allowance),
  );
}

/** Put an order unit back. Same standalone transaction as taking one. */
function refundOrder(deps: InboundMessageDeps, businessId: string, period: string): Promise<void> {
  return withBusiness(deps.db, businessId, (tx) =>
    usageRepo.refundUnit(tx, businessId, period, 'CATALOGUE_ORDERS'),
  );
}

/** Put a document unit back. Same standalone transaction as taking one. */
function refundDocument(
  deps: InboundMessageDeps,
  businessId: string,
  period: string,
): Promise<void> {
  return withBusiness(deps.db, businessId, (tx) =>
    usageRepo.refundUnit(tx, businessId, period, 'DOCUMENT_GENERATION'),
  );
}

function refundMessage(
  deps: InboundMessageDeps,
  businessId: string,
  period: string,
): Promise<void> {
  return withBusiness(deps.db, businessId, (tx) =>
    usageRepo.refundUnit(tx, businessId, period, 'AI_ACTIONS'),
  );
}

function describeIntent(intent: DeterministicIntent): string {
  return intent.kind === 'number' ? `[number:${intent.value}]` : `[${intent.kind}]`;
}
