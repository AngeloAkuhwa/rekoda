import { Logger } from '@nestjs/common';
import {
  gateExpense,
  gatePayment,
  parseConfirmationContext,
  type ConfirmationContext,
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
  transcriptDurationsDisagree,
  CUSTOMER_TOKEN,
  continuationAnswer,
  isOneShot,
  FUNDING_ANSWER_WINDOW_SECONDS,
  withinFundingWindow,
  rebuiltPurchaseFate,
  uncountablePeriod,
  answerIsUncertain,
  fundingSourceAnswer,
  type FundingSource,
  periodAnswer,
  purchaseIdentityAnswer,
  purchaseIdentityVerdict,
  purchaseMatches,
  purchaseTotalK,
  commandPurchaseReference,
  describePurchaseReference,
  ownerOf,
  sameRecord,
  PURCHASE_IDENTITY_WINDOW_SECONDS,
  resumedRead,
  chatDraftAccess,
  deterministicAccess,
  needsChatStanding,
  requestKind,
  resumedReadAccess,
  type ChatAccess,
  type ChatStanding,
  type AiModelRole,
  type AnsweredPeriod,
  type ContinuationState,
  type DeterministicIntent,
  type PeriodTopic,
  type PurchaseRecord,
  type Reply,
  type RequestKind,
  type Route,
  type UsageUnit,
} from '@rekoda/core';
import { normalisePhone, InvalidPhoneError } from '@rekoda/core/identity';
import { extractInboundEvents, metaWebhookBody } from '@rekoda/contracts';
import type { StructuredBusinessCommand } from '@rekoda/contracts';
import {
  billingRepo,
  catalogueRepo,
  continuationsRepo,
  conversationsRepo,
  withBusiness,
  customersRepo,
  entitlementsRepo,
  events,
  identity,
  issueRepo,
  jobsRepo,
  ordersRepo,
  purchaseIdentityRepo,
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
import { TextExtractionUnavailable, type ExtractionUsage, type TextExtraction } from '../ai/ocr.js';
import type { CommandBus } from '../commands/command-bus.service.js';
import { recordSaleWork, type RecordSaleInput } from '../commands/sale-commands.js';
import {
  recordPaymentEvidenceWork,
  recordPaymentWork,
  type RecordPaymentInput,
  type RecordPaymentResult,
} from '../commands/payment-commands.js';
import {
  PurchaseIdentityCollision,
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
const authorisationLog = new Logger('InboundMessageJob');

export interface InboundMessageDeps {
  gateway: PrivacyGateway;
  interpreter: Interpreter;
  replySender: ReplySender;
  config: ApiConfig;
  paymentIntents: PaymentIntentsService;
  /** Fetches media a merchant sent, and delivers the OTP template. */
  sender: MessageSender;
  /** The OpenAI transcriber (ADR 0032), or something that refuses honestly. */
  stt: SpeechToText;
  /**
   * How long a voice note runs, read from the bytes before any provider is
   * called. A port, because an ffprobe service answers the same question and
   * a deployment that would rather run one should not have to touch this
   * file.
   */
  audioProbe: AudioMetadataProbe;
  /**
   * The Claude vision reader (ADR 0024/0032), or something that refuses
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
      spoken = await transcribeVoiceNote(
        deps,
        tx,
        businessId,
        inbound,
        log,
        retrying,
        event.receivedAt,
        eventId,
      );
      if (!spoken) {
        /* Already answered inside, and already marked new-or-not. Nothing to
         * interpret and nothing to charge for. Still the newest thing this
         * member said, so whatever was open for them is retired (Build 6). */
        await retireSenderContinuation(tx, businessId, inbound.from, event.receivedAt);
        await events.markProcessed(tx, eventId, null, businessId);
        return;
      }
    } else if (isReceiptPhoto(inbound)) {
      read = await readReceiptPhoto(
        deps,
        tx,
        businessId,
        inbound,
        log,
        retrying,
        event.receivedAt,
        eventId,
      );
      if (!read) {
        await retireSenderContinuation(tx, businessId, inbound.from, event.receivedAt);
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
        await retireSenderContinuation(tx, businessId, inbound.from, event.receivedAt);
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

    /**
     * THE CLASSIFIER GATE (docs/ai-model-strategy.md §1, AI hardening
     * item 1): a cheap read, only where it avoids expensive ones, which
     * means ONLY here — extracted document text about to meet the
     * interpreter. A page with words and no transaction (a meme, a chat
     * screenshot) would otherwise buy a full interpretation and, being
     * gibberish to a bookkeeper, quite possibly an Opus escalation after
     * it. Typed messages and voice notes never pass through this: for them
     * the classifier would be a mandatory toll that saves nothing.
     *
     * FAIL OPEN: only a CONFIDENT `junk` answer skips the interpreter, and
     * the merchant's monthly message unit is untouched either way — the
     * gate sits before the meter on purpose, because a photo of a poster
     * should not cost a message to be told it is a poster.
     */
    if (read && route.route === 'model') {
      const kind = await deps.interpreter.classifyDocument(businessId, tokenised!.text);
      if (kind === 'junk') {
        await retireSenderContinuation(tx, businessId, inbound.from, event.receivedAt);
        await deps.replySender.send(tx, {
          businessId,
          to: inbound.from,
          reply: replies.notABusinessDocument(),
        });
        await events.markProcessed(tx, eventId, null, businessId);
        return;
      }
    }

    /* Mutable copy: a mention resolved during interpretation adds its token
     * here so the SAME table serves the outbound rehydration below. */
    const liveTokens = tokenised ? new Map(tokenised.tokens) : null;

    /**
     * Build 6: does this message continue what Rekoda just asked THIS person,
     * or the read it just answered them? Keyed to the member who sent it,
     * never just the business: a delegate's "last month" must not answer the
     * owner's "Which period?". A sender with no membership has no state.
     *
     * Only ever a READ comes out of here, answered from SQL with no model;
     * its only draft is the read-only Query footprint the same message left
     * before Build 6. Anything that does not fit what was open retires it and
     * is understood exactly as it would have been without it. The financial
     * confirmation path (a "yes" to a preview, G-23) is not consulted, not
     * claimed and not reachable from this branch.
     */
    const actorId = await actorOf(tx, businessId, inbound.from);
    /* Whether this message retired a question Rekoda had asked this member
     * (G-68): a "no" that drops nothing else must not say nothing waited. */
    const outcome: RebuildOutcome = { retiredQuestion: false };
    const continued = actorId
      ? await continueConversation(tx, businessId, actorId, {
          text,
          route,
          messageId: message.id,
          receivedAt: event.receivedAt,
          from: inbound.from,
          outcome,
        })
      : null;

    const answer = continued
      ? continued
      : route.route === 'deterministic'
        ? await deterministicReply(deps, tx, businessId, route.intent, {
            eventId,
            messageId: message.id,
            from: inbound.from,
            retrying,
            receivedAt: event.receivedAt,
            retiredQuestion: outcome.retiredQuestion,
            outcome,
          })
        : await interpretedReply(
            deps,
            tx,
            businessId,
            text,
            tokenised!.text,
            message.id,
            retrying,
            event.receivedAt,
            eventId,
            tokenised!.link,
            inbound.from,
            liveTokens!,
            actorId,
            // Extracted-document text qualifies for dual extraction (item 9).
            read !== null,
            outcome,
          );

    if (answer) {
      const sent = await deps.replySender.send(tx, {
        businessId,
        to: inbound.from,
        reply: answer,
        // Only the model path can produce a reply that names a customer.
        ...(liveTokens ? { tokens: liveTokens } : {}),
      });
      /* G-23: "previewed" means WhatsApp accepted the preview for delivery.
       * A preview whose send failed (swallowed so the draft survives) was
       * not sent. A delivery that fails later, after acceptance, comes back
       * as a status webhook nothing reads yet (G-20) and is not reflected. */
      if (!sent.delivered) {
        await conversationsRepo.markDraftUnseen(tx, businessId, message.id);
        /* Build 6: nor was the question or the answer a continuation holds
         * on to. A member who never saw "Which period?" is not answering it
         * with a later "last month". */
        await continuationsRepo.retireContinuationOpenedBy(
          tx,
          businessId,
          message.id,
          outcome.reaskedHeld && !outcome.supersededContinuation
            ? { keepDraftId: outcome.reaskedHeld.heldId }
            : {},
        );
        /* G-81: a re-asked identity question nobody saw names nothing as
         * declared separate: its instant and window go back to what the
         * merchant last saw, and the question they DID see stays open. */
        if (outcome.reaskedHeld) {
          await conversationsRepo.restoreHeldAsk(
            tx,
            businessId,
            outcome.reaskedHeld.heldId,
            outcome.reaskedHeld.previous,
          );
          /* The question kept open ends with the window it goes back to. */
          await continuationsRepo.alignOpenedByExpiry(
            tx,
            businessId,
            message.id,
            outcome.reaskedHeld.heldId,
            outcome.reaskedHeld.previous.expiresAt,
          );
        }
        /* An identity answer given while another question was open retired
         * that question; nobody saw the reply, so it is open again. */
        if (outcome.supersededContinuation) {
          await continuationsRepo.reopenSuperseded(tx, businessId, outcome.supersededContinuation);
        }
        /* A funding-answer rebuild nobody saw is undone as if it never
         * happened (Codex review): its new draft is superseded (never
         * confirmable), the retired question is restored, and the sender's
         * short answer re-opened inside its window, so "cash" again works. */
        /* A same-member replacement nobody saw is undone too (Codex review):
         * the new preview is superseded (never confirmable) and the rebuilt
         * preview the merchant DID see is pending again, so it is still the
         * one a yes confirms. */
        /* A new preview that closed older questions, nobody saw (Codex
         * review): it is withdrawn and the questions are restored, with the
         * short answer of every member who held one and of the sender, each
         * inside its window, so "cash" answers the question again. */
        /* G-81: an identity question nobody saw asked nobody: its held
         * purchase is withdrawn (the continuation was retired just above).
         * A fresh "separate" preview nobody saw is withdrawn too, and the
         * held purchase is held again with its question re-opened for the
         * sender inside its window, so "separate" again works. */
        for (const heldId of outcome.heldDrafts ?? []) {
          await conversationsRepo.withdrawHeld(tx, businessId, heldId);
        }
        if (outcome.refusedHeld) {
          await conversationsRepo.unholdRefusedPurchase(
            tx,
            businessId,
            outcome.refusedHeld.draftId,
            outcome.refusedHeld.previousExpiresAt,
          );
        }
        if (outcome.separatedFrom && actorId) {
          const { heldId, expiresAt } = outcome.separatedFrom;
          await conversationsRepo.undoSeparate(tx, businessId, message.id, heldId);
          /* Re-opened for the sender only when it was the question open for
           * them; answered past a newer question, that newer one is given
           * back instead, and "separate" still reaches the held purchase. */
          if (
            !outcome.supersededContinuation &&
            expiresAt.getTime() > event.receivedAt.getTime() &&
            (await conversationsRepo.heldPurchaseDraft(tx, businessId, heldId))
          ) {
            await continuationsRepo.openContinuation(tx, {
              businessId,
              userId: actorId,
              sourceMessageId: message.id,
              state: { kind: 'clarification', expects: 'purchase_identity', draftId: heldId },
              expiresAt,
            });
          }
        }
        if (outcome.closedQuestions?.length) {
          await conversationsRepo.withdrawPreviewAndRestore(
            tx,
            businessId,
            message.id,
            outcome.closedQuestions.map((q) => q.id),
          );
          const reopen = new Map<string, { draftId: string; expiresAt: Date }>();
          for (const q of outcome.closedQuestions) {
            const asked = await conversationsRepo.draftStateOf(tx, businessId, q.id);
            if (asked?.state !== 'abandoned') continue;
            for (const held of q.holders) {
              if (!reopen.has(held.userId)) {
                reopen.set(held.userId, { draftId: q.id, expiresAt: held.expiresAt });
              }
            }
          }
          if (actorId && !reopen.has(actorId)) {
            const newest = await continuationsRepo.newestContinuation(tx, businessId, actorId);
            if (
              newest?.kind === 'clarification' &&
              newest.expects === 'funding_source' &&
              outcome.closedQuestions.some((q) => q.id === newest.draftId)
            ) {
              const asked = await conversationsRepo.draftStateOf(tx, businessId, newest.draftId);
              if (asked?.state === 'abandoned') {
                reopen.set(actorId, {
                  draftId: newest.draftId,
                  expiresAt: fundingWindowEnd(asked.createdAt),
                });
              }
            }
          }
          for (const [userId, open] of reopen) {
            if (open.expiresAt.getTime() <= Date.now()) continue;
            await continuationsRepo.openContinuation(tx, {
              businessId,
              userId,
              sourceMessageId: message.id,
              state: { kind: 'clarification', expects: 'funding_source', draftId: open.draftId },
              expiresAt: open.expiresAt,
            });
          }
        }
        if (outcome.replacedRebuilds?.length) {
          /* A funding-answer rebuild that replaced the member's own preview
           * (G-81): mark it the undone rebuild of its question FIRST, or
           * undoReplacement supersedes it unmarked and the question can never
           * be answered again (fan-out review of 8dfce8f). undoRebuild below
           * then finds nothing more to do. */
          if (outcome.rebuiltFrom) {
            await conversationsRepo.undoRebuild(tx, businessId, outcome.rebuiltFrom, message.id);
          }
          await conversationsRepo.undoReplacement(
            tx,
            businessId,
            message.id,
            outcome.replacedRebuilds,
          );
        }
        if (outcome.rebuiltFrom) {
          await conversationsRepo.undoRebuild(tx, businessId, outcome.rebuiltFrom, message.id);
          const asked = await conversationsRepo.draftStateOf(tx, businessId, outcome.rebuiltFrom);
          if (asked?.state === 'abandoned') {
            /* The sender, and EVERY other member whose answer the rebuild
             * retired (Codex review), each inside their own window; no
             * member who never held one is given one. */
            const reopen = new Map<string, Date>();
            if (actorId) reopen.set(actorId, fundingWindowEnd(asked.createdAt));
            for (const held of outcome.retiredHolders ?? []) {
              if (!reopen.has(held.userId)) reopen.set(held.userId, held.expiresAt);
            }
            for (const [userId, expiresAt] of reopen) {
              await continuationsRepo.openContinuation(tx, {
                businessId,
                userId,
                sourceMessageId: message.id,
                state: {
                  kind: 'clarification',
                  expects: 'funding_source',
                  draftId: outcome.rebuiltFrom,
                },
                expiresAt,
              });
            }
          }
        }
      }
    }

    await events.markProcessed(tx, eventId, null, businessId);
    log.debug(`answered an inbound message routed as ${route.route}`);
  };
}

/**
 * What a reply did that a failed send must undo (G-68): whether it retired
 * a question, and, for a funding-answer rebuild, the question it rebuilt and
 * the members whose short answers that rebuild retired.
 */
type RebuildOutcome = {
  retiredQuestion: boolean;
  rebuiltFrom?: string;
  retiredHolders?: { userId: string; expiresAt: Date }[];
  /** Pending rebuilds this message's preview replaced (same member, total). */
  replacedRebuilds?: string[];
  /** Retired questions this message's new preview closed, and who held them. */
  closedQuestions?: { id: string; holders: { userId: string; expiresAt: Date }[] }[];
  /** Purchases HELD and asked about by this message's reply (G-81): its own
   * draft. A draft a yes was refused for is put back as a preview if its
   * question is never delivered (`unholdRefusedPurchase`), not withdrawn. */
  heldDrafts?: string[];
  /** The held purchase this message's "separate" answer closed (G-81). */
  separatedFrom?: { heldId: string; expiresAt: Date };
  /** The held purchase this message asked about again, and what it was (G-81). */
  reaskedHeld?: {
    heldId: string;
    previous: { draftIds: string[]; expenseIds: string[]; expiresAt: Date; reaskedAt: Date | null };
  };
  /** A purchase refused at this yes and held, and the window it had (G-81). */
  refusedHeld?: { draftId: string; previousExpiresAt: Date };
  /** The member's open continuation this message's identity answer retired
   * (G-81): another question, newer than the identity one, they still see. */
  supersededContinuation?: string;
  /** The member's open continuation this message retired because it did not
   * answer it (Codex review of 0e9bf52). Given back only when the reply
   * that replaced it was an identity re-ask nobody received. */
  retiredContinuation?: string;
};

/** A recording somebody made with the microphone button, not an attached file. */
function isVoiceNote(inbound: { messageType: string; audioId: string | null }): boolean {
  return (inbound.messageType === 'audio' || inbound.messageType === 'voice') && !!inbound.audioId;
}

/** A photograph, which for a bookkeeper means a receipt or an invoice. */
function isReceiptPhoto(inbound: { messageType: string; imageId: string | null }): boolean {
  return inbound.messageType === 'image' && !!inbound.imageId;
}

/**
 * One `usage_events` row per hosted vision read (AI hardening item 7) —
 * written for the read that produced text AND for the read that billed
 * tokens and produced nothing, because both are on the invoice.
 */
async function recordVisionRead(
  deps: InboundMessageDeps,
  businessId: string,
  usage: ExtractionUsage,
  messageId: string,
  log: Logger,
  extra?: { reason?: string },
): Promise<void> {
  const cost = costOfCall(usage.model, usage.tokens, deps.config.planningFxNairaPerUsd);
  if (!cost.priced) {
    log.error(`no price for vision model "${usage.model}" — recorded at zero`);
  }
  await withBusiness(deps.db, businessId, (own) =>
    quotaRepo.recordUsage(own, {
      businessId,
      provider: usage.provider,
      usageType: 'ocr_vision',
      quantity: 1,
      providerCostMicros: cost.usdMicros,
      nairaEquivalentK: cost.nairaKobo,
      billingPeriod: billingPeriod(new Date()),
      meta: {
        role: 'vision' satisfies AiModelRole,
        model: usage.model,
        purpose: 'document_extraction',
        priced: cost.priced,
        messageId,
        ...(extra?.reason ? { reason: extra.reason } : {}),
        ...usage.tokens,
      },
    }),
  );
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
 * only engine (ADR 0032). Either way the REASONING model only ever sees
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
  retrying: boolean,
  /** When the photo arrived: its unit belongs to that month on every attempt. */
  receivedAt: Date,
  /** The stored event, where the page's unit is recorded. */
  eventId: string,
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
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: await lapsedReply(tx, businessId, inbound.from),
    });
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

  /* AUTHORISATION BEFORE ANY PROVIDER IS TOUCHED (G-57, OWN-25). Today a
   * photographed document only ever becomes a sale, an expense, a purchase or
   * a payment, all of them changes to the books, so a member who may not
   * change them is refused before the image is downloaded, read, classified
   * or metered. Pinned to what photos do now: a photo feature that only reads
   * would need its own path, not this refusal. */
  if (!(await mayTransact(tx, businessId, inbound.from))) {
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: replies.viewOnlyPhoto(),
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
  /**
   * The DAILY operational ceiling, before the monthly unit (AI hardening
   * item 4). `AI_DOC_EXTRACTIONS_PER_BUSINESS` bounds what one tenant can
   * make Rekoda spend on vision reads in a Lagos day, whatever their plan
   * says about the month — the monthly allowance is what they bought, this
   * is the brake on a runaway day. Race-safe for the same reason the AI
   * call ceiling is: the limit lives in the statement's WHERE clause, so
   * two concurrent photographs cannot both take the last slot.
   */
  const dailyLimit = deps.config.aiDocExtractionsPerBusinessPerDay;
  const daily = await quotaRepo.reserveDocExtraction(deps.db, businessId, {
    perBusinessPerDay: dailyLimit,
    globalPerDay: deps.config.aiDocExtractionsGlobalPerDay,
  });
  if (!daily.ok) {
    /* The platform backstop refusing is Rekoda's busy day, not the
     * merchant's limit — the sentence must not tell them to wait for
     * midnight when trying again in an hour may work. */
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply:
        daily.refusedBy === 'business'
          ? replies.dailyDocumentLimit(dailyLimit)
          : replies.busyRightNow(),
    });
    return null;
  }

  const period = usagePeriod(receivedAt);
  const allowance = await meterAllowance(deps.config, tx, businessId, plan, 'DOCUMENTS_UNDERSTOOD');
  /* Skipped on a retry, as AI_ACTIONS is (see `retrying`): attempt 1's unit
   * committed in its own transaction and survived the job's rollback, and
   * the guard above did not (G-57 final review B). */
  /* The unit is recorded on the message in the same transaction it is
   * taken in. A retry is granted only when the message holds it: attempt 1
   * took it and survived the job's rollback; one that was refused, or took
   * nothing, is metered now, as any message is (G-57 final review B). */
  const granted =
    (retrying && (await holdsUnit(deps, businessId, eventId, 'DOCUMENTS_UNDERSTOOD'))) ||
    (await withBusiness(deps.db, businessId, async (own) => {
      const ok = await usageRepo.consumeUnit(
        own,
        businessId,
        period,
        'DOCUMENTS_UNDERSTOOD',
        allowance,
      );
      if (ok) await events.noteReservedUnit(own, businessId, eventId, 'DOCUMENTS_UNDERSTOOD');
      return ok;
    }));
  if (!granted) {
    // The plan refused after the day allowed: no provider was reached, so
    // the daily slot goes back too.
    await quotaRepo.releaseDocExtraction(deps.db, businessId);
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
    /* Our failure, not the merchant's, so THEIR unit goes back. The image
     * is dropped here and goes nowhere else: no vision model, no retry
     * against a hosted engine, no exception "just this once". */
    log.warn('the OCR engine could not be reached');
    const failure = error instanceof TextExtractionUnavailable ? error : null;
    if (failure?.usage) {
      /* The engine answered, billed us, and read nothing usable. Real
       * money: a priced row, and the daily slot stays counted — the
       * ceiling bounds spend, not success. */
      await recordVisionRead(deps, businessId, failure.usage, recorded.id, log, {
        reason: 'the page had no legible text',
      });
    } else if (failure?.maybeBilled) {
      /* A hosted read that TIMED OUT may still be on the invoice. Zero
       * with `priced: false` is the row reconciliation ties to, and the
       * daily slot stays counted for the same reason as above. */
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
    } else {
      // The provider was never reached: nothing spent, the daily slot back.
      await quotaRepo.releaseDocExtraction(deps.db, businessId);
    }
    /* The page this message holds goes back, whichever attempt took it,
     * exactly once. */
    await giveBackUnit(deps, businessId, eventId, period, 'DOCUMENTS_UNDERSTOOD');
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: replies.photoUnavailable(),
    });
    return null;
  }

  /* WHAT THE READ COST, recorded whatever becomes of the text (item 7 of
   * the AI hardening plan; same contract as the interpreter's rows). Only
   * hosted engines report usage; a result with no usage envelope (a
   * stub) writes no row. `ocr_vision` matches the OCR cost class. */
  if (extracted.usage) {
    await recordVisionRead(deps, businessId, extracted.usage, recorded.id, log);
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
 * exactly one engine (ADR 0032), and the transcript walks the same gateway
 * every typed sentence walks before any reasoning model sees it.
 */
async function transcribeVoiceNote(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  inbound: { externalId: string; from: string; audioId: string | null },
  log: Logger,
  retrying: boolean,
  /** When the note arrived: its seconds belong to that month on every attempt. */
  receivedAt: Date,
  /** The stored event, where the note's seconds are recorded. */
  eventId: string,
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
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: await lapsedReply(tx, businessId, inbound.from),
    });
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
   * The DAILY operational ceilings, before the monthly unit (remediation
   * A4): exactly the seconds the note runs, reserved race-safe against a
   * per-business day and the platform's day. The monthly allowance below
   * is what the merchant bought; this pair bounds what a runaway 24 hours
   * can make Rekoda spend on hosted transcription.
   */
  const dailyVoice = await quotaRepo.reserveVoiceSeconds(deps.db, businessId, seconds, {
    perBusinessPerDay: deps.config.voiceSecondsPerBusinessPerDay,
    globalPerDay: deps.config.voiceSecondsGlobalPerDay,
  });
  if (!dailyVoice.ok) {
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply:
        dailyVoice.refusedBy === 'business' ? replies.dailyVoiceLimit() : replies.busyRightNow(),
    });
    return null;
  }

  /**
   * Exactly the seconds the note runs, taken atomically before the
   * transcriber is called. Its own short transaction, like the message unit,
   * because the counter must not be held across a network call.
   */
  const period = usagePeriod(receivedAt);
  const allowance = await meterAllowance(deps.config, tx, businessId, plan, 'VOICE_MINUTES');
  /* Skipped on a retry, as AI_ACTIONS is (see `retrying`): attempt 1's
   * seconds committed in their own transaction and survived the job's
   * rollback (G-57 final review B). */
  /* As for a photo: recorded where taken, and a retry is granted only when
   * the message holds the seconds (G-57 final review B). */
  const granted =
    (retrying && (await holdsUnit(deps, businessId, eventId, 'VOICE_MINUTES'))) ||
    (await withBusiness(deps.db, businessId, async (own) => {
      const ok = await usageRepo.consumeUnit(
        own,
        businessId,
        period,
        'VOICE_MINUTES',
        allowance,
        seconds,
      );
      if (ok) await events.noteReservedUnit(own, businessId, eventId, 'VOICE_MINUTES');
      return ok;
    }));
  if (!granted) {
    // The plan refused after the day allowed: no provider was reached, so
    // the daily seconds go back too.
    await quotaRepo.releaseVoiceSeconds(deps.db, businessId, seconds);
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
    /* An outage, not the merchant's fault, so THEIR seconds go back. The
     * reason is logged without the audio and without their words. */
    /* The seconds this message holds go back, whichever attempt took them,
     * exactly once. The same note always measures the same seconds. */
    await giveBackUnit(deps, businessId, eventId, period, 'VOICE_MINUTES', seconds);
    /* The DAILY ceiling follows the money, not the merchant: released only
     * when the provider was never reached; kept when the call was billed
     * (an answered-but-unusable response) or may have been (a timeout). */
    const failure = error instanceof TranscriptionUnavailable ? error : null;
    if (!failure?.billed && !failure?.maybeBilled) {
      await quotaRepo.releaseVoiceSeconds(deps.db, businessId, seconds);
    }
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
   * reports usage; a result with no usage envelope (a stub) writes no
   * row. BOTH durations go on the row: the local probe's (what the
   * allowance reserved on) and the provider's (what the bill runs on) —
   * recorded for audit without storing a byte of audio. */
  /* THE CROSS-CHECK (AI hardening item 5): the container's own timestamps
   * and the provider's decoder measured the same audio, and the allowance
   * was charged on the first while the bill runs on the second. A second
   * or two apart is codec rounding; more means one of the meters is wrong,
   * which is worth a loud log and a flag on the row — never the audio, and
   * never a guess about which number to trust. */
  const durationsDisagree = transcriptDurationsDisagree(seconds, transcript.seconds);
  if (durationsDisagree) {
    log.warn(
      `voice durations disagree: the container says ${seconds}s, ` +
        `the transcriber says ${transcript.seconds}s`,
    );
  }

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
          ...(durationsDisagree ? { durationMismatch: true } : {}),
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
  /**
   * When this message reached Rekoda (the webhook's stored event, on the
   * database clock). A draft's confirmation window is judged at THIS
   * instant, never at whenever a worker gets to it (G-23): a "yes" sent in
   * time stays in time through a queue backlog or a retry, and a retry
   * decides exactly as the first attempt did.
   */
  receivedAt: Date;
  /** This message retired a question Rekoda had asked the sender (G-68). */
  retiredQuestion?: boolean;
  /** What this reply did that a failed send must undo (G-81). */
  outcome?: RebuildOutcome;
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
  /* G-65: routed, then entitled, then run. A fixed phrase skips the model,
   * never the product: "who owes me" is the same Chat capability whether the
   * router or the model understood it, so it meets the same boundary before
   * its handler reads, sends, mints or enqueues anything. Consent, erasure,
   * the dashboard and upgrade are not Chat and are not asked (core
   * `DETERMINISTIC_ACCESS` holds the matrix); a "yes" is judged by the draft
   * it would confirm, in `confirmPendingDraft`. */
  if (needsChatStanding(intent.kind)) {
    const access = deterministicAccess(intent.kind, await chatStandingOf(tx, businessId));
    if (access !== 'allow') return chatRefusal(tx, businessId, access, { command: ctx.from });
  }

  /* The yes is the moment a draft becomes a document, so it carries the same
   * role rule as making the draft: view-only members confirm nothing, not
   * even a draft the owner parked. */
  if (intent.kind === 'affirm') {
    if (!(await mayTransact(tx, businessId, ctx.from))) return replies.viewOnlyRole();
    const answer = await confirmPendingDraft(
      deps,
      tx,
      businessId,
      ctx.retrying,
      ctx.receivedAt,
      ctx.eventId,
      {
        messageId: ctx.messageId,
        from: ctx.from,
        receivedAt: ctx.receivedAt,
        /* G-81: a question asked at a refused yes is undone if never sent. */
        ...(ctx.outcome ? { outcome: ctx.outcome } : {}),
      },
    );
    /* G-65: "nothing waiting for a yes" goes on to invite a sale, which a
     * plan without Chat is refused. It is answered from several places in
     * `confirmPendingDraft`, all of them read-only, so it is swapped here. */
    if (answer?.text === replies.nothingToConfirm().text && (await withoutChat(tx, businessId))) {
      return replies.nothingToConfirmWithoutChat();
    }
    /* "A preview is waiting, reply yes" would invite a yes such a plan is
     * refused: it is told nothing was saved instead. Never an erasure ask:
     * it is recorded unpreviewed and nothing marks it previewed, so it can
     * never produce this reply (`confirmPendingDraft` answers it only for a
     * draft recorded as previewed). */
    if (answer?.text === replies.previewAwaitingYes().text) {
      return (await draftRefusalWithoutChat(tx, businessId)) ?? answer;
    }
    return answer;
  }
  if (intent.kind === 'deny' || intent.kind === 'cancel') {
    // A refusal after a preview discards the draft rather than leaving it to
    // be confirmed by an accidental "yes" ten minutes later.
    /* G-23: a preview whose window closed is expired, not cancelled. */
    await conversationsRepo.expireStaleDrafts(tx, businessId, { now: ctx.receivedAt });
    /* A "no" after a retired purchase question closes that question too
     * (G-61), when it is the last thing a "no" can be about: the newest
     * draft that is not a question to the books (`latestDraftToAnswer`), so
     * it still closes past a read asked since (Build 6), exactly as a "yes"
     * there still re-asks it. A question answered long ago by a resend is
     * not what this "no" is about. */
    let latest = await conversationsRepo.latestDraftToAnswer(tx, businessId, {
      asOf: ctx.receivedAt,
    });
    /* G-81: to the member asked "Is this the same purchase?", a "no" could
     * mean "no, not the same" or "no, do not save it", so it is asked
     * again and nothing moves. A "cancel" closes the question and its held
     * purchase (and, as every cancel does, every pending draft). Anybody
     * else's no or cancel is about what they were shown. */
    let closedHeld = false;
    /* The sender's own open question first (Codex review). */
    const asking = await senderBeingAsked(tx, businessId, ctx.from, ctx.receivedAt);
    if (asking && intent.kind === 'deny') {
      return reaskPurchaseIdentity(tx, businessId, asking.heldId, asking.actorId, ctx, {
        afterNo: true,
      });
    }
    if (asking) {
      closedHeld = await conversationsRepo.releaseHeld(tx, businessId, asking.heldId, {
        now: ctx.receivedAt,
      });
      await continuationsRepo.retireContinuationsForDraft(tx, businessId, asking.heldId);
      latest = await conversationsRepo.latestDraftToAnswer(tx, businessId, {
        asOf: ctx.receivedAt,
      });
    }
    if (latest?.state === 'held') {
      const asked = await askedAboutHeld(tx, businessId, latest.id, ctx.from, ctx.receivedAt);
      if (asked && intent.kind === 'deny') {
        return reaskPurchaseIdentity(tx, businessId, latest.id, asked, ctx, { afterNo: true });
      }
      if (asked) {
        closedHeld = await conversationsRepo.releaseHeld(tx, businessId, latest.id, {
          now: ctx.receivedAt,
        });
        await continuationsRepo.retireContinuationsForDraft(tx, businessId, latest.id);
      }
      latest = await conversationsRepo.latestDraftToAnswer(tx, businessId, {
        asOf: ctx.receivedAt,
        skipHeld: true,
      });
    }
    /* The last thing the merchant saw had already expired: this "no" is
     * about it, so nothing else is touched. A clarification or a question
     * that lapsed was never a preview, and is answered as before. */
    if (latest?.state === 'expired') {
      const lapsed = expiredAnswer(latest.command, latest.previewed, 'no');
      if (lapsed) return lapsed;
    }
    const closedQuestion =
      latest?.state === 'abandoned'
        ? await conversationsRepo.closeRetiredDraft(tx, businessId, latest.id)
        : false;
    /* Build 6: every pending draft is still dropped, a question's included,
     * but only a request the merchant could have confirmed is reported as
     * cancelled. A "no" after nothing but a read gets what a "no" after
     * nothing gets. */
    const cancellable = await conversationsRepo.pendingDraftToAnswer(tx, businessId, {
      asOf: ctx.receivedAt,
    });
    await conversationsRepo.supersedePendingDrafts(tx, businessId, { asOf: ctx.receivedAt });
    const dropped = (cancellable ? 1 : 0) + (closedQuestion ? 1 : 0) + (closedHeld ? 1 : 0);
    /* A bare "no" or "cancel" with nothing to refuse is answered, never met
     * with silence, and never told something was cancelled (G-68). */
    if (dropped > 0) return replies.cancelled();
    /* The "no" closed a question Rekoda asked ("Which period?", a numbered
     * list) and nothing else: true to say so, untrue to say nothing was
     * waiting (G-68). A "no" to the funding question closed its retired
     * draft above, so it answers "Cancelled." as before. */
    if (ctx.retiredQuestion) return replies.questionLeft();
    /* `nothingToCancel` invites nothing; `nothingToDecline` invites a sale,
     * so a plan without Chat gets its own (G-65). */
    if (intent.kind === 'cancel') return replies.nothingToCancel();
    return (await withoutChat(tx, businessId))
      ? replies.nothingToDeclineWithoutChat()
      : replies.nothingToDecline();
  }

  switch (intent.kind) {
    case 'unsure':
      return unsureReply(tx, businessId, ctx.receivedAt, {
        messageId: ctx.messageId,
        from: ctx.from,
        receivedAt: ctx.receivedAt,
      });
    /* G-65: the ordinary greeting and help list Chat commands. A plan
     * without Chat is refused every one of them, so it is told what works. */
    case 'greeting': {
      const without = await withoutChat(tx, businessId);
      return without ? replies.greetingWithoutChat(without.lapse) : replies.greeting();
    }
    case 'help': {
      const without = await withoutChat(tx, businessId);
      return without
        ? replies.helpWithoutChat(without.lapse, {
            owner: await isOwner(tx, businessId, ctx.from),
            transacts: await mayTransact(tx, businessId, ctx.from),
          })
        : replies.help();
    }
    case 'stop':
      // The fact first, the sentence second: every proactive send checks this.
      await recordConsent(deps.db, ctx.from, new Date());
      return replies.optedOut();
    case 'start':
      await recordConsent(deps.db, ctx.from, null);
      /* G-65: the ordinary welcome invites a sale; a plan without Chat is
       * pointed at what works instead. */
      return (await withoutChat(tx, businessId)) ? replies.optedInWithoutChat() : replies.optedIn();
    case 'delete_my_data': {
      /* Owner only. This deletes every customer's contact details for the
       * whole business in one irreversible statement, which is not a thing an
       * accountant or a delegate should be able to do from a phone. */
      if (!(await isOwner(tx, businessId, ctx.from))) return replies.erasureNotYours();

      /* Two-message erasure (CG-style): the first ask parks an EraseData
       * draft, the second ask claims it and deletes. Anything else in
       * between keeps the data: ANY inbound message on the thread after
       * the first ask breaks the pair (G-68 review), whatever path it took
       * and whether or not it recorded a draft. That is stricter than
       * before for free deterministic commands ("who owes me" between the
       * asks used to leave the pair intact), which is the safe direction
       * for an irreversible action, and it is what the copy promises. */
      /* G-23: a first ask whose window closed is not waiting any more. */
      await conversationsRepo.expireStaleDrafts(tx, businessId, { now: ctx.receivedAt });
      /* EVERY pending draft counts here, a question to the books included
       * (`pendingDraft`, never `pendingDraftToAnswer`): a model-answered
       * question between the two asks records a draft, breaks the pair, and
       * the data is kept. A resumed read ("last month", answered from
       * continuation state) records one too, as that message did before
       * Build 6. A message that records no draft (a free deterministic
       * command, media, a Pidgin phrase) breaks the pair too, through the
       * inbound-message check just below (G-68 review). */
      const pending = await conversationsRepo.pendingDraft(tx, businessId, {
        asOf: ctx.receivedAt,
      });
      const pendingCommand = pending?.command as { intent?: string } | undefined;
      /* A PAIR only when nothing at all was said in between (G-68 review):
       * any inbound message on this business's thread after the first ask,
       * from any member and by any path (a free command, a Pidgin phrase,
       * another member's answer to their own question), breaks it. The copy
       * says "anything else keeps it", and an irreversible erasure must not
       * depend on which messages happen to record a draft. */
      /* Counted twice, both ways failing closed: the conversation rows
       * written, AND the durable webhook events stored at ingest (Codex
       * review), so a message whose processing failed before its row was
       * written still breaks the pair. */
      const paired =
        pending &&
        pendingCommand?.intent === 'EraseData' &&
        (await conversationsRepo.inboundSinceDraft(
          tx,
          businessId,
          pending.id,
          ctx.messageId,
          ctx.eventId,
        )) === 0 &&
        (await conversationsRepo.inboundEventsSinceDraft(
          tx,
          businessId,
          pending.id,
          ctx.eventId,
        )) === 0;
      const claim = paired
        ? await conversationsRepo.claimDraft(tx, pending.id, { now: ctx.receivedAt })
        : null;
      if (claim?.outcome === 'not_pending') return replies.alreadyConfirmed();
      /* Only a claim inside the window erases. A first ask that expired (even
       * between the line above and the claim) is no confirmation: this ask
       * becomes a new first ask below, and nothing is deleted. */
      if (pending && claim?.outcome === 'claimed') {
        /* No rollout seam (spec §25, Appendix D). EraseData is HIGH_RISK and
         * always crosses the bus: the phrase gate above is the router's own,
         * and it was never the thing a flag could turn off, but the pending
         * confirmation RECORDING what the merchant was told was. That record
         * is the auditable half of the ceremony, so it is no longer optional.
         *
         * The exact phrase was typed twice, and the confirmation opened at
         * the first ask says what they agreed to. If it lapsed, one is opened
         * now recording the same consequence and claimed in the same
         * transaction: the two-message mechanism already did the waiting. */
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
        return replies.erasureDone(run.result.erased, deps.config.webUrl);
      }
      const discarded = await conversationsRepo.supersedePendingDrafts(tx, businessId, {
        asOf: ctx.receivedAt,
      });
      const parked = await conversationsRepo.recordDraft(tx, {
        businessId,
        conversationMessageId: ctx.messageId,
        intent: 'EraseData',
        command: { intent: 'EraseData' },
        model: null,
      });
      /* Appendix D: the confirmation is opened when the merchant is SHOWN
       * the consequence, so the record says what they agreed to. */
      if (parked.isNew) {
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
      return (await withoutChat(tx, businessId))
        ? replies.strayNumberWithoutChat()
        : replies.strayNumber();
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
      if (!member) return dashboardUnavailable(tx, businessId);

      const url = await mintDashboardLink({
        db: deps.db,
        webUrl: deps.config.webUrl,
        userId: member.userId,
        businessId,
      });
      return url ? replies.dashboardLink(url, LINK_MINUTES) : dashboardUnavailable(tx, businessId);
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
 * The plan and whether it holds `REKODA_CHAT`, resolved the way the model
 * path resolves them (G-65): the effective entitlements (plan, explicit
 * grants and add-ons together) and the effective plan, `expired` for a
 * lapsed trial or a lapsed paid plan. Read only; asks nothing of a provider.
 */
async function chatStandingOf(tx: TenantDb, businessId: string): Promise<ChatStanding> {
  const refusal = await entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_CHAT');
  if (refusal) return { plan: refusal.plan, holdsChat: false };
  return { plan: await usageRepo.planFor(tx, businessId), holdsChat: true };
}

/**
 * The sentence a refused Chat request gets, and nothing else happens.
 *
 * A refused "yes" says first that nothing was saved: anything softer after
 * a yes reads as "it went through". A lapsed plan is told which lapse it is,
 * because a merchant whose PAID plan lapsed is not on a "free trial"
 * (`lapseOf`). A refused command gets `chatCommandNotInPlan` on Integrate,
 * since most commands record nothing and `chatNotInPlan` opens with
 * recording.
 */
async function chatRefusal(
  tx: TenantDb,
  businessId: string,
  access: Exclude<ChatAccess, 'allow'>,
  /* A command names its sender: the lapse sentence lists what still works
   * for them. A refused yes names no command and needs none. */
  asked: { command: string } | 'draft',
): Promise<Reply> {
  if (access === 'chat_not_in_plan') {
    return asked === 'draft' ? replies.notSavedNotInPlan() : replies.chatCommandNotInPlan();
  }
  if (asked !== 'draft') return lapsedReply(tx, businessId, asked.command);
  return replies.notSavedPlanEnded((await usageRepo.lapseOf(tx, businessId)) ?? 'trial');
}

/**
 * What a lapsed plan is told (G-65): `trialEnded` for a trial past its date,
 * `planEnded` for a paid plan that lapsed. The same refusal either way; only
 * the sentence is chosen, so a merchant who paid for months is never told
 * their free trial ended.
 */
async function lapsedReply(tx: TenantDb, businessId: string, from: string): Promise<Reply> {
  /* The sentence names what still works, so it names it for this member:
   * a view-only member is not offered *payment details*, which refuses them. */
  const transacts = await mayTransact(tx, businessId, from);
  return (await usageRepo.lapseOf(tx, businessId)) === 'plan'
    ? replies.planEnded(transacts)
    : replies.trialEnded(transacts);
}

/**
 * Null when this business can use Chat; otherwise which lapse, if any, is
 * the reason (G-65). For copy only: the help and greeting a plan without
 * Chat gets must not point at commands it is refused.
 */
async function withoutChat(
  tx: TenantDb,
  businessId: string,
): Promise<{ lapse: replies.Lapse | null } | null> {
  const access = chatDraftAccess(await chatStandingOf(tx, businessId));
  if (access === 'allow') return null;
  return {
    lapse: access === 'plan_lapsed' ? ((await usageRepo.lapseOf(tx, businessId)) ?? 'trial') : null,
  };
}

/**
 * The dashboard link could not be made. The ordinary sentence offers
 * *records* instead, which a live plan without Chat is refused (G-65); a
 * lapsed plan keeps *records*, so it keeps the ordinary sentence.
 */
async function dashboardUnavailable(tx: TenantDb, businessId: string): Promise<Reply> {
  const without = await withoutChat(tx, businessId);
  return without && without.lapse === null
    ? replies.dashboardUnavailableWithoutChat()
    : replies.dashboardUnavailable();
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
      return replies.paymentLinkNeedsConnection(deps.config.webUrl);
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

/**
 * What to say to a "yes" or a "no" whose draft expired (G-23), or null when
 * it was never a preview (answered as if nothing waited).
 *
 * Decided by what the merchant was SHOWN, recorded on the draft, never
 * inferred from its intent: a sale whose total disagreed, or a payment with
 * no invoice to place it on, is stored with a financial intent but was only
 * ever a question, and "that request has expired" would tell the merchant a
 * confirmable request lapsed when they were never invited to confirm one.
 * An erasure ask is never "saved": it was not, and nothing was deleted.
 */
function expiredAnswer(command: unknown, previewed: boolean, answer: 'yes' | 'no'): Reply | null {
  const intent = (command as { intent?: string } | null)?.intent;
  if (intent === 'EraseData') return replies.erasureKept();
  if (!previewed) return null;
  return answer === 'yes' ? replies.draftExpired() : replies.expiredNothingToCancel();
}

/**
 * `expiredAnswer` for a "yes" (or "yes?"), told the truth on every plan
 * (G-65): an erasure ask is still "Kept. Nothing was deleted."; an expired
 * preview on a plan without Chat is told nothing was saved and why, never
 * invited to send it again (a resend it would then be refused). Null when
 * the draft was never a preview, as for `expiredAnswer`.
 */
async function expiredYesReply(
  tx: TenantDb,
  businessId: string,
  command: unknown,
  previewed: boolean,
): Promise<Reply | null> {
  const ordinary = expiredAnswer(command, previewed, 'yes');
  if (!ordinary || ordinary.text !== replies.draftExpired().text) return ordinary;
  const without = await withoutChat(tx, businessId);
  return without ? replies.draftExpiredWithoutChat(without.lapse) : ordinary;
}

/**
 * Give back what a crashed earlier attempt of this "yes" reserved, when the
 * retry executes nothing (G-23).
 *
 * A confirmation meters in its own committed transaction, recording each
 * unit on the message in that same transaction (`noteReservedUnit`), and a
 * retry never meters again. If the retry then executes nothing (the window
 * closed, a correction superseded the draft, another "yes" confirmed it),
 * exactly the recorded units go back, read and cleared in the JOB's
 * transaction: the refund commits only with the attempt that answers, so a
 * retry that dies gives nothing back and leaves the record for the next.
 * Facts, not inference: nothing is refunded that was not reserved, nothing
 * twice. The month is the message's arrival month, which is the month it
 * metered in.
 */
async function refundRecordedReservations(
  tx: TenantDb,
  businessId: string,
  eventId: string,
  period: string,
): Promise<void> {
  /* Only what a confirmation reserves: a voice note's seconds or a
   * message unit recorded on the same event are not a confirmation's. */
  const units = await events.takeReservedUnitsOf(tx, businessId, eventId, [
    'DOCUMENT_GENERATION',
    'CATALOGUE_ORDERS',
  ]);
  for (const unit of units) {
    await usageRepo.refundUnit(tx, businessId, period, unit as UsageUnit);
  }
}

async function confirmPendingDraft(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  retrying: boolean,
  /** When the "yes" reached Rekoda: the instant its window is judged at. */
  receivedAt: Date,
  /** The stored event this "yes" came in on, where its reservations are recorded. */
  eventId: string,
  /** The message and its sender, for re-opening a re-asked funding question,
   * and what its reply did that a failed send must undo (G-81). */
  sender: { messageId: string; from: string; receivedAt: Date; outcome?: RebuildOutcome },
): Promise<Reply | null> {
  /*
   * G-61: the last thing the merchant was shown may be a purchase question
   * answered by sending the purchase again, whose draft is retired. A "yes"
   * straight after it is aimed at that question, never at some OLDER
   * preview still pending behind it: the question is asked again and
   * nothing is claimed.
   */
  /* G-23: every confirmation window that has closed is closed NOW, before
   * anything below picks the draft this "yes" executes, and before a unit
   * is metered for it. */
  await conversationsRepo.expireStaleDrafts(tx, businessId, { now: receivedAt });
  /* Only drafts that existed when this "yes" arrived: a retry overtaken by a
   * newer request confirms what it was sent for, never the newer preview. */
  /* G-81: the sender is being asked "same or separate": this yes is about
   * that question, whatever else is newer (Codex review). */
  const asking = await senderBeingAsked(tx, businessId, sender.from, receivedAt);
  if (asking) {
    if (retrying) {
      await refundRecordedReservations(tx, businessId, eventId, usagePeriod(receivedAt));
    }
    return reaskPurchaseIdentity(tx, businessId, asking.heldId, asking.actorId, sender);
  }
  let latest = await conversationsRepo.latestDraftToAnswer(tx, businessId, {
    asOf: receivedAt,
  });
  /* G-81: a purchase held for its identity question. The yes of the member
   * who was asked is about that question: it is asked again, and nothing
   * older is ever claimed behind it. Anybody else's yes is about what THEY
   * were shown, so the held purchase (never confirmable) is not in its way. */
  if (latest?.state === 'held') {
    const asked = await askedAboutHeld(tx, businessId, latest.id, sender.from, sender.receivedAt);
    if (asked) {
      if (retrying) {
        await refundRecordedReservations(tx, businessId, eventId, usagePeriod(receivedAt));
      }
      return reaskPurchaseIdentity(tx, businessId, latest.id, asked, sender);
    }
    /* A preview that was still WAITING when this yes reached Rekoda, held
     * since by another yes the purchase work refused (Codex review): this
     * yes was about it, so nothing older is ever claimed behind it. */
    if (latest.previewed && latest.updatedAt.getTime() > receivedAt.getTime()) {
      if (retrying) {
        await refundRecordedReservations(tx, businessId, eventId, usagePeriod(receivedAt));
      }
      return replies.previewUnderQuestion();
    }
    latest = await conversationsRepo.latestDraftToAnswer(tx, businessId, {
      asOf: receivedAt,
      skipHeld: true,
    });
  }
  /* `abandoned` is only ever a retired purchase question; a draft the
   * merchant cancelled is `superseded` and is never asked again. */
  if (latest?.state === 'abandoned') {
    const reasked = await reaskRetiredQuestion(tx, businessId, latest, sender);
    if (reasked) return reasked;
    /* Never fall through to an older preview behind the question, even if
     * the stored question no longer gates (rules changed since). */
    return replies.nothingToConfirm();
  }
  /* The last thing the merchant was shown expired (G-23): this "yes" is
   * about it. Say so, and never fall through to an older preview behind it,
   * which the merchant is not looking at. Nothing is metered or claimed. */
  if (latest?.state === 'expired') {
    /* A retry, its "yes" sent inside the window but overtaken by a later
     * message that closed it: nothing executes, and exactly the units an
     * earlier attempt recorded for this message go back. */
    if (retrying) {
      await refundRecordedReservations(tx, businessId, eventId, usagePeriod(receivedAt));
    }
    return (
      (await expiredYesReply(tx, businessId, latest.command, latest.previewed)) ??
      replies.nothingToConfirm()
    );
  }

  let draft = await conversationsRepo.pendingDraftToAnswer(tx, businessId, {
    asOf: receivedAt,
  });
  if (!draft) {
    /* Nothing existed for this yes to agree to. If a preview has been
     * written since (the yes was typed before it arrived, or its job was
     * retried and wrote it again after the merchant had already read it),
     * it is waiting: say so, and let the next yes confirm it. Never confirm
     * it from this one, which cannot be agreement to what it had not seen. */
    /* A retry whose draft was superseded or confirmed while it waited
     * executes nothing either: what its first attempt metered goes back. */
    if (retrying) {
      await refundRecordedReservations(tx, businessId, eventId, usagePeriod(receivedAt));
    }
    const since = await conversationsRepo.pendingDraftToAnswer(tx, businessId);
    return since?.previewed ? replies.previewAwaitingYes() : replies.nothingToConfirm();
  }
  /* A preview from before a retired question is never confirmed by a yes,
   * including a double-tapped yes after the replacement was saved. */
  if (await conversationsRepo.isBehindRetiredQuestion(tx, businessId, draft.id)) {
    return replies.nothingToConfirm();
  }
  /* G-65: the yes is the moment a Chat draft becomes a record, so it meets
   * the boundary the message that made it met: before a unit is metered,
   * before the draft is claimed and before any read below is retired. A
   * plan that lapsed, or switched to Integrate, between the preview and the
   * yes records nothing and changes nothing. The draft is left pending only
   * because a refusal must change nothing (a "no" can still cancel it); it
   * lapses with its window, and since an upgrade is done by a person, the
   * reply tells the merchant nothing was saved and to send it again. A
   * parked erasure ask is not Chat: a yes to it must still keep the data and
   * break the two-ask pair below, on every plan. */
  if (draft.intent !== 'EraseData') {
    const access = chatDraftAccess(await chatStandingOf(tx, businessId));
    if (access !== 'allow') {
      /* Nothing executes, so what an earlier attempt of this message
       * reserved goes back, as on every other exit that records nothing. */
      if (retrying) {
        await refundRecordedReservations(tx, businessId, eventId, usagePeriod(receivedAt));
      }
      /* A draft the merchant was never shown as a preview (a question
       * Rekoda asked, or a preview whose send failed and was marked unseen)
       * is nothing a yes could have saved: "nothing waiting", exactly what a
       * "yes?" is told in the same state (`unsureReply`). A preview the
       * merchant saw is refused as a save. */
      if (draft.previewed !== true) return replies.nothingToConfirmWithoutChat();
      return chatRefusal(tx, businessId, access, 'draft');
    }
  }

  /* Build 6: a question to the books asked SINCE this draft means the
   * merchant was last looking at an answer, and "correct" may be about the
   * figure. Never claimed from this yes.
   *
   * Only a PREVIEW of a financial request (previewed: WhatsApp accepted it)
   * is pointed back at: the NEWEST question's draft is retired (the draft
   * this yes claimed before Build 6), and the merchant is told the preview
   * is waiting. Each yes retires one question, so it takes exactly as many
   * yeses as before Build 6 to reach the preview, which the yes after the
   * last question confirms through the ordinary claim, if its window is
   * still open. Nothing is metered before this point.
   *
   * Anything else waiting (a question Rekoda asked, a parked erasure ask, a
   * preview whose send failed) is not a preview, and saying one is waiting
   * would be false. This yes then does exactly what it did before Build 6:
   * the newest pending draft, the question to the books, is what it is
   * about, and it is answered as that, writing nothing. */
  if (await conversationsRepo.hasReadsAfter(tx, businessId, draft.id, { asOf: receivedAt })) {
    if (draft.previewed === true && !NOT_A_FINANCIAL_PREVIEW.has(draft.intent)) {
      await conversationsRepo.retireNewestReadAfter(tx, businessId, draft.id, { asOf: receivedAt });
      if (retrying) {
        await refundRecordedReservations(tx, businessId, eventId, usagePeriod(receivedAt));
      }
      return replies.previewBehindQuestion();
    }
    const newest = await conversationsRepo.pendingDraft(tx, businessId, { asOf: receivedAt });
    if (newest) draft = newest;
  }

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
  /* Dated by the message's arrival (G-23): the month a "yes" spends from is
   * the month it was sent, the same instant its window is judged at, so a
   * retry's refund lands in the month attempt 1 charged. */
  const period = usagePeriod(receivedAt);
  let documentTaken = false;
  let orderTaken = false;
  /**
   * The one way a reservation goes back.
   *
   * An order costs a document unit AND an order unit, so every exit that
   * produces no invoice owes the merchant both. When each branch decided that
   * for itself the two counters could drift apart: a branch that remembered
   * only the document would leave them paying for capture they never got, and
   * nothing about the branch would look wrong. Reading the counters at call
   * time rather than choosing per branch makes that class of bug unwritable.
   */
  const giveBack = (unit: UsageUnit) =>
    withBusiness(deps.db, businessId, async (own) => {
      await usageRepo.refundUnit(own, businessId, period, unit);
      await events.releaseReservedUnit(own, businessId, eventId, unit);
    });
  const refundReserved = async (): Promise<void> => {
    /* A retry took nothing itself; what an earlier attempt took is on the
     * message (G-23). */
    if (retrying) {
      await refundRecordedReservations(tx, businessId, eventId, period);
      return;
    }
    /* Each unit at most once, however many exits call this. */
    if (documentTaken) {
      documentTaken = false;
      await giveBack('DOCUMENT_GENERATION');
    }
    if (orderTaken) {
      orderTaken = false;
      await giveBack('CATALOGUE_ORDERS');
    }
  };
  if (issuesDocument && !retrying) {
    /* A plan that lapsed between the preview and the yes never reaches
     * here: the G-65 gate above refuses it with its own sentence, before
     * any unit is metered. */
    const plan = await usageRepo.planFor(tx, businessId);
    const allowance = await meterAllowance(
      deps.config,
      tx,
      businessId,
      plan,
      'DOCUMENT_GENERATION',
    );
    /* The reservation is recorded with the consume, in its transaction. */
    const granted = await withBusiness(deps.db, businessId, async (own) => {
      const ok = await usageRepo.consumeUnit(
        own,
        businessId,
        period,
        'DOCUMENT_GENERATION',
        allowance,
      );
      if (ok) await events.noteReservedUnit(own, businessId, eventId, 'DOCUMENT_GENERATION');
      return ok;
    });
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
        await refundReserved();
        return replies.ordersNotInPlan();
      }
      const orderAllowance = await meterAllowance(
        deps.config,
        tx,
        businessId,
        plan,
        'CATALOGUE_ORDERS',
      );
      const orderGranted = await withBusiness(deps.db, businessId, async (own) => {
        const ok = await usageRepo.consumeUnit(
          own,
          businessId,
          period,
          'CATALOGUE_ORDERS',
          orderAllowance,
        );
        if (ok) await events.noteReservedUnit(own, businessId, eventId, 'CATALOGUE_ORDERS');
        return ok;
      });
      if (!orderGranted) {
        await refundReserved();
        return replies.allowanceExhausted(orderAllowance, 'CATALOGUE_ORDERS');
      }
      orderTaken = true;
    }
  }

  /* The claim carries the window itself (G-23), and only for a draft that
   * existed when the "yes" arrived. With the instant fixed, the sweep above
   * has normally settled expiry already; this is the database's last word,
   * not a check that a later write trusts. */
  const claim = await conversationsRepo.claimDraft(tx, draft.id, { now: receivedAt });
  if (claim.outcome !== 'claimed') {
    /* Nothing executes, so whatever this "yes" reserved goes back: two
     * rapid confirmations must cost one document, which is how many the
     * merchant ends up with, and an expired one costs nothing at all. */
    await refundReserved();
    /* The other "yes" won and is issuing the invoice; or the window closed. */
    return claim.outcome === 'expired'
      ? (expiredAnswer(command, draft.previewed === true, 'yes') ?? replies.nothingToConfirm())
      : replies.alreadyConfirmed();
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
    return confirmPurchase(deps, tx, businessId, draft.id, command, sender);
  if (command.intent === 'EraseData') {
    // Erasure confirms ONLY with the exact phrase. A "yes" is "anything
    // else" in the confirmation copy's terms, and anything else keeps the data.
    return replies.erasureKept();
  }
  if (command.intent === 'RecordPayment') {
    /* Refunds its own unit on every path that answers without issuing a
     * receipt: an invoice settled from under the merchant, or a payment we
     * could not place, must not cost them a document they never got. */
    return confirmPayment(deps, tx, businessId, draft, command, refundReserved);
  }
  if (command.intent === 'AdjustInventory') {
    /* No document, so the unit this confirmation reserved goes back. A stock
     * count produces nothing to send and must not cost the merchant one of
     * the documents they are allowed to generate. */
    await refundReserved();
    return confirmStockChange(deps, tx, businessId, draft.id, command as never, receivedAt);
  }
  if (command.intent === 'RecordOrder') {
    return confirmOrder(deps, tx, businessId, draft.id, command as never, refundReserved);
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
    await refundReserved();
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
      await refundReserved();
      return replies.notYet('Recording that sale');
    }
    if (run.replayed) {
      /* The first run already paid for this invoice. */
      await refundReserved();
    }
    return replies.issued(
      run.result.invoiceNumber,
      run.result.totalK,
      run.result.balanceDueK,
      /* A replayed snapshot from before G-48 carries no receipt key. */
      run.result.receiptNumber ?? null,
    );
  }

  const issued = await recordSaleWork(tx, input);
  return replies.issued(
    issued.invoiceNumber,
    money.totalK,
    money.balanceDueK,
    issued.receiptNumber,
  );
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
    if (run.replayed) {
      /* The first run already paid for this order's document and capture.
       * `RecordSale` has guarded its own replay since the bus landed; an
       * order replaying and keeping both units was the same bug with no
       * guard written for it. */
      await refund();
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
  /**
   * When the "yes" reached Rekoda (G-23). The write-off's HIGH_RISK
   * confirmation is judged at the same instant as the draft that carries
   * it: the confirmation is opened just after the draft, so a yes inside the
   * draft's window is inside its window too. Judged at the wall clock, a
   * queued or retried yes claimed the draft and was then refused here,
   * leaving it confirmed with nothing applied.
   */
  receivedAt: Date,
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
  /* Adding stock is STANDARD and the rollout flag still chooses its
   * plumbing. Writing stock OFF is D.2's destructive adjustment, HIGH_RISK by
   * `riskOf`, and crosses the bus whatever the flag says: configuration may
   * choose an implementation, never whether a confirmation is required. */
  if (destructive || deps.config.commandAdjustInventory) {
    let confirmationId: string | null = null;
    if (destructive) {
      const open = (await riskRepo.openConfirmationsFor(tx, businessId, receivedAt)).find(
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
        now: receivedAt,
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
  /** The yes: who sent it, and when it reached Rekoda (G-81). */
  sender: { messageId: string; from: string; receivedAt: Date; outcome?: RebuildOutcome },
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
    /* The account the merchant named, which the gate required (G-61). */
    method: gate.method,
    sourceType: 'chat',
    sourceId: draftId,
    supplierId,
    /* The supplier's own document number the merchant confirmed, onto the
     * bill a credit purchase raises (Codex review). */
    /* Name-free: its kind and number ("Invoice 2231"), never letters. */
    supplierReference: describePurchaseReference(command['supplierReference']),
    arrivals: arriving
      ? [{ product: arriving.productMention, quantity: arriving.quantity, costK: gate.amountK }]
      : [],
  };

  /* The A1 rollout seam (spec §25), inside a SAVEPOINT (G-81): the purchase
   * work refuses a purchase that may be one booked since this preview was
   * shown, before its first posting, and the savepoint takes back whatever
   * the attempt wrote (the bus's idempotency claim included), so a refusal
   * leaves no row, posting, stock movement, bill, number or event. */
  let recorded: Awaited<ReturnType<typeof recordPurchaseWork>> | null;
  try {
    recorded = await tx.transaction(async (sp) => {
      if (deps.config.commandRecordPurchase) {
        const run = await deps.commandBus.run(
          sp,
          {
            businessId,
            command: 'RecordPurchase',
            payload: input,
            actor: 'system',
            ingress: 'CHAT',
            idempotencyKey: `draft:${draftId}`,
          },
          () => recordPurchaseWork(sp, input),
        );
        return run.outcome === 'done' ? run.result : null;
      }
      return recordPurchaseWork(sp, input);
    });
  } catch (error) {
    if (!(error instanceof PurchaseIdentityCollision)) throw error;
    /* The claim this yes made is turned into a held question in the same
     * transaction, so it never stands for a purchase that was not booked,
     * and the member who said yes is asked "same or separate". */
    /* Asked now, on the database clock, naming the booking it matched. */
    const refused = await conversationsRepo.holdRefusedPurchase(tx, businessId, draftId, [
      error.match.self,
    ]);
    /* Remembered, so a question that never reaches the merchant puts the
     * preview back as it was (fresh review of #262): the next yes is refused
     * and asked again, never answered by an older preview behind it. */
    if (sender.outcome && refused) {
      sender.outcome.refusedHeld = { draftId, previousExpiresAt: refused.previousExpiresAt };
    }
    const actorId = await actorOf(tx, businessId, sender.from);
    if (actorId) {
      const held = await conversationsRepo.heldPurchaseDraft(tx, businessId, draftId);
      await continuationsRepo.openContinuation(tx, {
        businessId,
        userId: actorId,
        sourceMessageId: sender.messageId,
        state: { kind: 'clarification', expects: 'purchase_identity', draftId },
        ...(held ? { expiresAt: held.expiresAt } : {}),
      });
    }
    return replies.purchaseIdentityAtYes(identitySubject(error.match, actorId), sender.receivedAt);
  }
  if (!recorded) return replies.notYet('Recording that purchase');

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
 *
 * Build 6: a question over a window that named none is ASKED ("Which
 * period?") rather than answered for this month, and the question is
 * returned as a continuation so the merchant's "last month" resumes it. Every
 * answer returns the read's subject the same way, for a follow-up.
 */
async function answerQuery(
  tx: TenantDb,
  businessId: string,
  command: Extract<StructuredBusinessCommand, { intent: 'Query' }>,
  now: Date,
): Promise<{ reply: Reply; continuation: ContinuationState }> {
  const subject = (
    period: AnsweredPeriod | null,
    customerToken: string | null = null,
  ): ContinuationState => ({
    kind: 'query',
    topic: command.topic,
    period,
    customerToken,
    documentRef: null,
  });

  switch (command.topic) {
    case 'sales_summary':
    case 'expenses_summary': {
      /* The window the merchant named: one of the model's three, or their
       * own words (`custom`) when they are exactly a period core can draw.
       * Anything else is a question, never a guess. */
      /* A named window that comes with words is trusted only when the words
       * draw the SAME window. "month" with "last month", "today" with
       * "yesterday", "week" with "last week": asked, never guessed. */
      const named =
        command.period === 'today' || command.period === 'week' || command.period === 'month'
          ? command.period
          : null;
      const words = (command.periodText ?? '').trim();
      const fromWords = words !== '' ? periodAnswer(words) : null;
      const period =
        named !== null
          ? words === '' || fromWords === named
            ? named
            : null
          : command.period === 'custom'
            ? fromWords
            : null;
      if (!period) {
        const subject = command.topic === 'sales_summary' ? 'sales' : 'spending';
        /* A window the merchant NAMED that core cannot draw ("yesterday",
         * "in March") gets its own honest sentence, never the bare question
         * that reads as if they said nothing. Either way the question stays
         * open, so "last month" next resumes it. */
        const uncountable = words !== '' && fromWords === null;
        return {
          reply: uncountable ? replies.periodNotCountable(subject) : replies.whichPeriod(subject),
          continuation: { kind: 'clarification', expects: 'period', topic: command.topic },
        };
      }
      return {
        reply: await answerPeriodQuery(tx, businessId, command.topic, period, now),
        continuation: subject(period),
      };
    }

    case 'debtors': {
      const debtors = await reportsRepo.debtorsFor(tx, businessId, 8);
      return {
        reply: replies.debtorList(
          debtors.rows.map((r) => ({
            invoiceNumber: r.invoiceNumber,
            balanceDueK: r.balanceDueK,
            daysOverdue: daysOverdue(r.dueDate, r.balanceDueK, now),
          })),
          debtors.totalK,
          debtors.count,
        ),
        continuation: subject(null),
      };
    }

    case 'customer_balance': {
      const token = customerTokenOf(command as never);
      /* No token means the model heard a name it could not resolve to
       * anybody we know. Asking is better than answering about the wrong
       * person, or about everybody. */
      if (!token) return { reply: replies.paymentNoOpenInvoice(), continuation: subject(null) };
      const owed = await issueRepo.openInvoicesForCustomer(tx, businessId, token);
      return {
        reply: replies.customerBalanceAnswer(
          owed.map((r) => ({ invoiceNumber: r.invoiceNumber, balanceDueK: r.balanceDueK })),
          owed.reduce((n, r) => n + r.balanceDueK, 0),
        ),
        /* The subject as its vault token, never the name: what a later
         * build needs to continue ("send it as PDF") about the same person,
         * with nothing a leak could read. No such follow-up is answered yet. */
        continuation: subject(null, CUSTOMER_TOKEN.test(token) ? token : null),
      };
    }

    case 'supplier_balances': {
      const overview = await reportsRepo.overviewFor(tx, businessId);
      return { reply: replies.suppliersAnswer(overview.youOweK), continuation: subject(null) };
    }

    case 'unreconciled': {
      const overview = await reportsRepo.overviewFor(tx, businessId);
      return {
        reply: replies.unreconciledAnswer(overview.exceptionsOpen),
        continuation: subject(null),
      };
    }

    case 'report_request':
      return { reply: replies.reportRequestAnswer(), continuation: subject(null) };
  }
}

/** Sales or spending over a window core draws, every figure from SQL. */
async function answerPeriodQuery(
  tx: TenantDb,
  businessId: string,
  topic: PeriodTopic,
  name: AnsweredPeriod,
  now: Date,
): Promise<Reply> {
  const period = resolvePeriod(name, now);
  const summary = await reportsRepo.summaryFor(tx, businessId, period.from, period.to);
  return topic === 'sales_summary'
    ? replies.salesAnswer({ label: period.label, ...summary })
    : replies.expensesAnswer({ label: period.label, ...summary });
}

/**
 * Drafts a "yes" is never pointed back at as "a preview waiting" (Build 6):
 * a question to the books, a question Rekoda asked, a parked erasure ask.
 */
const NOT_A_FINANCIAL_PREVIEW: ReadonlySet<string> = new Set(['Query', 'Unclear', 'EraseData']);

/**
 * The member behind a sender (Build 6): continuation state belongs to the
 * PERSON who was asked, never just the business. Null for a number that
 * cannot be read or holds no membership; such a sender has no state.
 */
async function actorOf(tx: TenantDb, businessId: string, from: string): Promise<string | null> {
  let phone: string;
  try {
    phone = normalisePhone(from);
  } catch (error) {
    /* Only an unreadable number means "no member". A database failure is
     * not a stranger: it must fail the job, not silently drop the state. */
    if (error instanceof InvalidPhoneError) return null;
    throw error;
  }
  return (await identity.memberByPhone(tx, businessId, phone))?.userId ?? null;
}

/**
 * A newly recorded message that ends before the continuation step (a junk
 * photo, unsupported or unreadable media, a voice note that could not be
 * heard) is still the newest thing its sender said, so whatever was open for
 * them is retired, exactly as an unrelated text retires it (Build 6).
 *
 * Safe on a replayed message too: the retire only reaches rows that existed
 * when this message was RECEIVED (`created_at <= now`), so a continuation a
 * later message opened is never touched by an older message's replay.
 */
async function retireSenderContinuation(
  tx: TenantDb,
  businessId: string,
  from: string,
  receivedAt: Date,
): Promise<void> {
  const actorId = await actorOf(tx, businessId, from);
  if (actorId) {
    await continuationsRepo.retireContinuations(tx, businessId, actorId, { now: receivedAt });
  }
}

/**
 * The G-61 funding-source question answered with a short "bank" or "cash"
 * (G-68 Phase 2): the purchase it asked about, rebuilt with the account
 * filled in, shown as a FRESH preview.
 *
 * Never an execution. The retired draft is never claimed, confirmed or
 * revived: it is CLOSED (`superseded`) by the one answer that rebuilds it, so
 * it can be answered only once. The rebuilt command walks the same gates a
 * typed purchase does at this point: the role rule (only a member who may
 * transact gets a draft to say yes to), a lapsed trial, the Chat entitlement,
 * and `gatePurchase` (CG1 before CG2). It records a NEW draft, previewed,
 * which only a normal "yes" confirms (CG3, inside its own G-23 window). No
 * model is called, so no `AI_ACTIONS` unit is taken, as for every
 * router-served turn; the stock and ledger rules run at the yes, unchanged.
 *
 * The supplier's name is not on the rebuilt preview: it is never stored
 * (ADR 0005), only the vault row it resolved to, which the confirmation
 * stamps on the purchase exactly as before.
 */
async function answerFundingSource(
  tx: TenantDb,
  businessId: string,
  draftId: string,
  source: FundingSource,
  message: {
    messageId: string;
    from: string;
    receivedAt: Date;
    outcome?: RebuildOutcome;
  },
): Promise<Reply> {
  const retired = await conversationsRepo.retiredPurchaseDraft(tx, businessId, draftId);
  /* Closed since it was asked (a "no", from this member or another one), or
   * blocked by something newer: nothing to rebuild, and that is said. */
  if (!retired) {
    return closedQuestionReply(tx, businessId, draftId, message.receivedAt, message.from, source);
  }
  const refused = await fundingGateRefusal(tx, businessId, message.from);
  if (refused) return refused;

  const stored = retired.command as Record<string, unknown>;
  const rebuilt = { ...stored, paymentMethod: source };
  const gate = gatePurchase(rebuilt as never);
  if (gate.gate !== 'CG2') return replies.arithmeticQuestion(gate.question);
  /* ONE-SHOT (G-68 review): the question is answered once, by whoever
   * answers first. Closing the retired draft (abandoned -> superseded) is a
   * conditional UPDATE in this transaction, so of two answers, from two
   * members or racing, exactly one rebuilds; the other is told the question
   * was closed. Two previews of one purchase would let two yeses book it
   * twice, which G-61 exists to prevent. */
  if (!(await conversationsRepo.closeRetiredDraft(tx, businessId, retired.id))) {
    return closedQuestionReply(tx, businessId, draftId, message.receivedAt, message.from, source);
  }
  /* Nobody else's short answer can reach it now. */
  const holders = await continuationsRepo.retireContinuationsForDraft(tx, businessId, retired.id);
  /* Remembered, so a preview that never reaches the merchant is undone,
   * every member's answer this retired included. */
  if (message.outcome) {
    message.outcome.rebuiltFrom = retired.id;
    message.outcome.retiredHolders = holders;
  }
  /* G-81: the rebuilt purchase is compared exactly as a typed one is, and
   * held and asked about when it may be one already waiting or booked. */
  const actorId = await actorOf(tx, businessId, message.from);
  const identity = await purchaseIdentityCheck(tx, businessId, {
    messageId: message.messageId,
    receivedAt: message.receivedAt,
    actorId,
    stored: rebuilt,
  });
  const holding = identity?.ask != null;
  const draft = await conversationsRepo.recordDraft(tx, {
    businessId,
    conversationMessageId: message.messageId,
    intent: 'RecordPurchase',
    command: rebuilt,
    model: null,
    previewed: true,
    requestedBy: actorId,
    rebuiltFrom: retired.id,
    held: holding,
    separateFrom: holding ? null : (identity?.inheritFrom ?? null),
  });
  let shown = replies.preview(gate.preview);
  if (holding && identity?.ask) {
    shown = replies.purchaseIdentityQuestion(
      identitySubject(identity.ask, actorId),
      message.receivedAt,
      { named: identity.asked.length },
    );
    if (draft.isNew) {
      await conversationsRepo.nameHeldRecords(
        tx,
        businessId,
        draft.id,
        identity.asked.map((r) => r.self),
      );
      if (actorId) {
        const held = await conversationsRepo.heldPurchaseDraft(tx, businessId, draft.id);
        await continuationsRepo.openContinuation(tx, {
          businessId,
          userId: actorId,
          sourceMessageId: message.messageId,
          state: { kind: 'clarification', expects: 'purchase_identity', draftId: draft.id },
          ...(held ? { expiresAt: held.expiresAt } : {}),
        });
      }
      if (message.outcome) (message.outcome.heldDrafts ??= []).push(draft.id);
    }
  }
  if (identity && draft.isNew && !holding) {
    shown = await replaceOwnPreviews(
      tx,
      businessId,
      identity.replace,
      shown,
      message.outcome,
      identity.unseen,
    );
  }
  return shown;
}

/**
 * Is a stock purchase about to be previewed possibly one already waiting or
 * booked (G-81, OD-23)? The facts are read from SQL and decided in core
 * (`purchaseMatches`): the same total (integer kobo), a waiting preview or
 * a purchase booked in the last 24 hours, and nothing that PROVES them
 * separate (a different stated supplier reference, or two different
 * catalogue-linked products: owner ruling D3). Suppliers, quantity, raw
 * names and wording are never proof. Read-only; the caller decides what to
 * write. Null for a command that is not a readable purchase.
 *
 * Records are read by message ORDER, never by mixing the webhook's clock
 * with processing stamps (fresh review of #262). A resend of the member's
 * own fresh "separate" preview inherits what that preview was declared
 * separate from, so it replaces it instead of asking the same question
 * again (`inheritFrom`, stored on the new draft as its `separate_from`).
 */
async function purchaseIdentityCheck(
  tx: TenantDb,
  businessId: string,
  input: {
    messageId: string;
    receivedAt: Date;
    actorId: string | null;
    /** The command as it will be stored: supplier resolved to a vault row. */
    stored: Record<string, unknown>;
    /** The held purchase a "separate" answer is about, if this is one. */
    separateFrom?: string;
    /** The draft being answered, never its own duplicate. */
    excludeDraftId?: string;
  },
): Promise<{
  replace: readonly PurchaseRecord[];
  asked: readonly PurchaseRecord[];
  ask: PurchaseRecord | null;
  inheritFrom: string | null;
  /** The sender's own drafts of this total whose preview never reached
   * them: replaced silently when this one is previewed (Codex review of
   * 5bfe87e). */
  unseen: readonly string[];
} | null> {
  const amountK = purchaseTotalK(input.stored);
  if (amountK === null) return null;
  let facts = await purchaseIdentityRepo.newPurchaseFacts(tx, businessId, {
    messageId: input.messageId,
    amountK,
    /* Only the product that will actually arrive (Codex review of 7f173b6):
     * with no usable quantity nothing is delivered, so there is no product
     * to prove anything by. */
    productMention: purchaseArrival(input.stored as never)?.productMention ?? null,
    /* The reference exactly as it will be stored (its total and reported
     * payment checked), so the preview and the yes compare one value
     * (Codex review of 5bfe87e). */
    reference: commandPurchaseReference(input.stored),
    separateFrom: input.separateFrom ?? null,
  });
  const { records } = await purchaseIdentityRepo.purchaseRecords(tx, businessId, amountK, {
    asOf: input.receivedAt,
    excludeDraftId: input.excludeDraftId ?? null,
    messageId: input.messageId,
  });
  /* Ordered by message, so no upper bound by clock (fresh review of #262). */
  const window = {
    from: new Date(input.receivedAt.getTime() - PURCHASE_IDENTITY_WINDOW_SECONDS * 1000),
    to: null,
  };
  let verdict = purchaseIdentityVerdict(
    purchaseMatches(facts, records, input.receivedAt, window),
    input.actorId,
  );
  let inheritFrom: string | null = null;
  if (!input.separateFrom) {
    for (const own of verdict.replace) {
      if (own.separateFrom.length === 0) continue;
      const from = await conversationsRepo.separateFromOf(tx, businessId, own.id);
      if (!from) continue;
      inheritFrom = from;
      facts = { ...facts, separateFrom: [...facts.separateFrom, ...own.separateFrom] };
    }
    if (inheritFrom) {
      verdict = purchaseIdentityVerdict(
        purchaseMatches(facts, records, input.receivedAt, window),
        input.actorId,
      );
    }
  }
  /* The sender's own undelivered drafts are compared exactly as any other
   * record (references, products, a "separate" answer's line), and one is
   * replaced only when it is the SINGLE own draft that may be this purchase
   * and no waiting preview of theirs is being replaced already: two or more
   * coexist only because something proved them separate (final-head review
   * of ffb5404). Otherwise they are left as they are, and the purchase work
   * at the yes still refuses a second booking. */
  const unseenRecords = input.actorId
    ? await purchaseIdentityRepo.unseenOwnPurchaseDrafts(tx, businessId, amountK, {
        actorId: input.actorId,
        asOf: input.receivedAt,
        messageId: input.messageId,
        excludeDraftId: input.excludeDraftId ?? null,
      })
    : [];
  const unseenMatches = purchaseMatches(facts, unseenRecords, input.receivedAt, window);
  const unseen =
    unseenMatches.length === 1 && verdict.replace.length === 0 ? [unseenMatches[0]!.id] : [];
  return { ...verdict, inheritFrom, unseen };
}

/** What the merchant is told about a matching record: never a name. */
function identitySubject(record: PurchaseRecord, actorId: string | null) {
  return {
    state: record.state,
    amountK: record.amountK,
    owner: ownerOf(record, actorId),
    bookedAt: record.bookedAt,
    billNumber: record.billNumber,
  } as const;
}

/**
 * D4: the member's OWN waiting previews of the same purchase are replaced by
 * the newer one, and the reply always says so with the total, exactly as
 * Build 7 replaces their own rebuild, so their one purchase is never two
 * confirmable previews. Only when the newer one is itself a preview: a
 * purchase held for a question replaces nothing (fresh review of #262), so
 * "replaced by this one" is never said of something nothing can confirm.
 * Remembered, so a reply that never reaches them gives back the preview
 * they saw.
 */
async function replaceOwnPreviews(
  tx: TenantDb,
  businessId: string,
  replace: readonly PurchaseRecord[],
  shown: Reply,
  outcome?: RebuildOutcome,
  /** The sender's own drafts whose preview never reached them: replaced
   * too, but silently, since they never saw them (Codex review of 5bfe87e). */
  unseen: readonly string[] = [],
): Promise<Reply> {
  let reply = shown;
  for (const own of replace) {
    if (await conversationsRepo.supersedeOwnPreview(tx, businessId, own.id)) {
      reply = replies.earlierPreviewReplaced(reply, own.amountK);
      if (outcome) (outcome.replacedRebuilds ??= []).push(own.id);
    }
  }
  for (const id of unseen) {
    if (await conversationsRepo.supersedeOwnPreview(tx, businessId, id)) {
      if (outcome) (outcome.replacedRebuilds ??= []).push(id);
    }
  }
  return reply;
}

/**
 * Was this sender asked the identity question about this held purchase?
 * Only then is their yes, no or doubtful answer about it.
 */
async function askedAboutHeld(
  tx: TenantDb,
  businessId: string,
  heldId: string,
  from: string,
  /** When the reply reached Rekoda: a question opened after it was never
   * asked of it (Codex review). */
  receivedAt: Date,
): Promise<string | null> {
  const actorId = await actorOf(tx, businessId, from);
  if (!actorId) return null;
  return (await continuationsRepo.wasAskedAbout(tx, businessId, actorId, heldId, {
    now: receivedAt,
  }))
    ? actorId
    : null;
}

/**
 * The identity question this SENDER is still being asked (Codex review;
 * fresh review of #262): a purchase still held and inside its window that
 * they were asked about, NEWER than the preview their yes, no or doubt
 * would otherwise reach. Found whether or not its continuation is still open
 * (another message from them retires it), and whatever another member's
 * held question hides. Such a reply is about that question: it re-asks, and
 * never confirms or drops an older preview.
 */
async function senderBeingAsked(
  tx: TenantDb,
  businessId: string,
  from: string,
  receivedAt: Date,
): Promise<{ heldId: string; actorId: string } | null> {
  const actorId = await actorOf(tx, businessId, from);
  if (!actorId) return null;
  const candidate = await conversationsRepo.pendingDraftToAnswer(tx, businessId, {
    asOf: receivedAt,
  });
  const heldId = await conversationsRepo.askedHeldNewerThan(
    tx,
    businessId,
    actorId,
    candidate?.id ?? null,
    { now: receivedAt },
  );
  return heldId ? { heldId, actorId } : null;
}

/**
 * A yes, a no or a doubtful answer from the member who was asked "same or
 * separate" (G-81): never an answer, never a confirmation of any older
 * preview. Inside the question's window it is asked again, and the short
 * answer re-opened for them; after it, the question has closed. After a
 * "no", the merchant is told that *same* saves nothing more (never
 * *cancel*, which withdraws every waiting preview in the business).
 */
async function reaskPurchaseIdentity(
  tx: TenantDb,
  businessId: string,
  heldId: string,
  actorId: string,
  sender: { messageId: string; receivedAt: Date; outcome?: RebuildOutcome },
  options: { afterNo?: boolean } = {},
): Promise<Reply> {
  /* A newer question this message retired on its way here (a "yes" past
   * "Which period?"; Codex review of 0e9bf52) is given back if this re-ask
   * never reaches the member, as for a "same" or "separate". */
  if (sender.outcome?.retiredContinuation && !sender.outcome.supersededContinuation) {
    sender.outcome.supersededContinuation = sender.outcome.retiredContinuation;
  }
  /* G-65: the re-ask invites "separate", which a plan without Chat refuses:
   * such a plan is told nothing was saved, as `reaskRetiredQuestion` is. */
  const refused = await draftRefusalWithoutChat(tx, businessId);
  if (refused) return refused;
  const held = await conversationsRepo.heldPurchaseDraft(tx, businessId, heldId, {
    now: sender.receivedAt,
  });
  if (!held || held.expiresAt.getTime() <= sender.receivedAt.getTime()) {
    return identityClosedReply(tx, businessId);
  }
  const live = await continuationsRepo.currentContinuation(tx, businessId, actorId, {
    now: sender.receivedAt,
  });
  const open =
    live?.state.kind === 'clarification' &&
    live.state.expects === 'purchase_identity' &&
    live.state.draftId === heldId;
  if (!open) {
    await continuationsRepo.openContinuation(tx, {
      businessId,
      userId: actorId,
      sourceMessageId: sender.messageId,
      state: { kind: 'clarification', expects: 'purchase_identity', draftId: heldId },
      now: sender.receivedAt,
      expiresAt: held.expiresAt,
    });
  }
  return replies.purchaseIdentityReask(options);
}

/**
 * "That question has closed" (G-81), or, on a plan without Chat, what
 * `closedQuestionReply` says there (G-65): the closed reply invites sending
 * the purchase again, which such a plan refuses.
 */
async function identityClosedReply(
  tx: TenantDb,
  businessId: string,
  options: { freshPreviewWaiting?: boolean } = {},
): Promise<Reply> {
  return (await draftRefusalWithoutChat(tx, businessId)) ?? replies.purchaseIdentityClosed(options);
}

/**
 * The answer to "Is this the same purchase?" (G-81), from the member who was
 * asked, inside the question's window. The continuation was claimed by the
 * caller.
 *
 *  - "same": the held purchase is closed and NOTHING is written: no purchase,
 *    stock movement, posting, bill, document or unit. Older retired purchase
 *    questions it was blocking are closed too. The merchant is pointed,
 *    truthfully, at the record the question NAMED, as it stands now.
 *  - "separate": after the read-only gates (role, plan, Chat, run by the
 *    caller before the question is claimed), the purchase is compared again
 *    with ONLY the records the question named excused; anything else that
 *    matches is asked about (and added to what the question names).
 *    Otherwise the held purchase is closed and a FRESH preview is recorded,
 *    with its own G-23 window, declared separate from exactly those records;
 *    only a normal yes books it.
 */
async function answerPurchaseIdentity(
  tx: TenantDb,
  businessId: string,
  actorId: string,
  heldId: string,
  answer: 'same' | 'separate',
  message: { messageId: string; from: string; receivedAt: Date; outcome?: RebuildOutcome },
): Promise<Reply> {
  const held = await conversationsRepo.heldPurchaseDraft(tx, businessId, heldId, {
    now: message.receivedAt,
  });
  if (!held || held.expiresAt.getTime() <= message.receivedAt.getTime()) {
    return identityClosedReply(tx, businessId);
  }
  const command = held.command as Record<string, unknown>;
  const amountK = purchaseTotalK(command);

  if (answer === 'same') {
    if (
      !(await conversationsRepo.releaseHeld(tx, businessId, heldId, { now: message.receivedAt }))
    ) {
      return identityClosedReply(tx, businessId);
    }
    /* The held purchase was the newest thing in the way of older retired
     * G-61 questions; with it gone, no member is asked a stale one. */
    for (const closed of await conversationsRepo.closeRetiredQuestionsBefore(
      tx,
      businessId,
      heldId,
    )) {
      await continuationsRepo.retireContinuationsForDraft(tx, businessId, closed);
    }
    if (amountK === null) {
      return replies.samePurchase(null, message.receivedAt, {
        withoutChat: (await withoutChat(tx, businessId)) !== null,
      });
    }
    const { records } = await purchaseIdentityRepo.purchaseRecords(tx, businessId, amountK, {
      asOf: message.receivedAt,
      excludeDraftId: heldId,
    });
    const named = [
      ...held.askedAbout.draftIds.map((draftId) => ({ draftId, expenseId: null })),
      ...held.askedAbout.expenseIds.map((expenseId) => ({ draftId: null, expenseId })),
    ];
    const pointedAt = records.filter((r) => named.some((n) => sameRecord(n, r.self)));
    const pointed = pointedAt.find((m) => m.state === 'booked') ?? pointedAt[0] ?? null;
    /* "same" writes nothing, so it is answered on every plan (G-65); without
     * Chat its copy invites neither a yes nor a resend that would be refused. */
    return replies.samePurchase(
      pointed ? identitySubject(pointed, actorId) : null,
      message.receivedAt,
      {
        withoutChat: (await withoutChat(tx, businessId)) !== null,
      },
    );
  }

  /* A "separate" sent before the question was re-asked answered it as it
   * then stood (Codex review of 30a5c8f): what the re-ask added was never
   * shown to that reply, so it excuses nothing and the question is asked
   * again. Nothing is written. */
  if (held.reaskedAt && message.receivedAt.getTime() < held.reaskedAt.getTime()) {
    return reaskPurchaseIdentity(tx, businessId, heldId, actorId, message);
  }
  /* The read-only gates (role, plan, Chat) ran in the caller BEFORE the
   * question was claimed, so a refusal leaves it open. */
  const gate = gatePurchase(command as never);
  if (gate.gate !== 'CG2') return replies.arithmeticQuestion(gate.question);

  const verdict = await purchaseIdentityCheck(tx, businessId, {
    messageId: message.messageId,
    receivedAt: message.receivedAt,
    actorId,
    stored: command,
    separateFrom: heldId,
    excludeDraftId: heldId,
  });
  if (verdict?.ask) {
    /* Something matching that the question did NOT name: the merchant
     * answered about what they were shown, not about this. It is named now,
     * added to what the question names, with a fresh window. */
    const again = await conversationsRepo.reaskHeld(
      tx,
      businessId,
      heldId,
      verdict.asked.map((r) => r.self),
    );
    if (!again) return identityClosedReply(tx, businessId);
    if (message.outcome) message.outcome.reaskedHeld = { heldId, previous: again.previous };
    await continuationsRepo.openContinuation(tx, {
      businessId,
      userId: actorId,
      sourceMessageId: message.messageId,
      state: { kind: 'clarification', expects: 'purchase_identity', draftId: heldId },
      now: message.receivedAt,
      expiresAt: again.expiresAt,
    });
    return replies.purchaseIdentityQuestion(
      identitySubject(verdict.ask, actorId),
      message.receivedAt,
      { named: verdict.asked.length, newSince: true },
    );
  }
  if (!(await conversationsRepo.releaseHeld(tx, businessId, heldId, { now: message.receivedAt }))) {
    return identityClosedReply(tx, businessId);
  }
  const draft = await conversationsRepo.recordDraft(tx, {
    businessId,
    conversationMessageId: message.messageId,
    intent: 'RecordPurchase',
    command,
    model: null,
    previewed: true,
    requestedBy: actorId,
    separateFrom: heldId,
    /* A held rebuild stays a rebuild (fresh review of #262). */
    rebuiltFrom: held.rebuiltFrom,
  });
  if (message.outcome) {
    message.outcome.separatedFrom = { heldId, expiresAt: held.expiresAt };
  }
  let shown = replies.separatePurchase(replies.preview(gate.preview));
  if (draft.isNew) {
    shown = await replaceOwnPreviews(
      tx,
      businessId,
      verdict?.replace ?? [],
      shown,
      message.outcome,
      verdict?.unseen ?? [],
    );
    shown = await afterNewPreview(
      tx,
      businessId,
      draft.id,
      command,
      actorId,
      shown,
      message.outcome,
    );
  }
  return shown;
}

/**
 * What every NEW financial preview does once recorded (G-68, kept as Build 7
 * wrote it, and shared with the "separate" answer since G-81): the SAME
 * member's pending funding-answer rebuild of the same total is superseded
 * and the reply says so (a different total, or references that prove two
 * purchases since G-81, leaves it waiting, and the reply says that too); never across members, never for a rebuild with no
 * recorded requester. And every older retired purchase question is closed,
 * with every member's short answer to it, so nobody can rebuild it into a
 * second preview of the same purchase.
 */
async function afterNewPreview(
  tx: TenantDb,
  businessId: string,
  draftId: string,
  command: unknown,
  actorId: string | null,
  shown: Reply,
  outcome?: RebuildOutcome,
): Promise<Reply> {
  let reply = shown;
  if (actorId && (command as { intent?: unknown } | null)?.intent === 'RecordPurchase') {
    /* What a "separate" answer declared this purchase apart from (its
     * `separate_from` line): a rebuild named there is a different purchase
     * by the member's own answer, never replaced (Codex review of 5bfe87e). */
    const declared = (await purchaseIdentityRepo.draftFacts(tx, businessId, draftId))?.separateFrom;
    for (const older of await conversationsRepo.pendingRebuildsBefore(tx, businessId, draftId)) {
      if (older.requestedBy !== actorId) continue;
      if (declared?.some((ref) => ref.draftId === older.id)) continue;
      const fate = rebuiltPurchaseFate(older.command, command);
      if (!fate) continue;
      if (fate.replace) {
        if (await conversationsRepo.supersedeRebuild(tx, businessId, older.id)) {
          reply = replies.earlierPreviewReplaced(reply, fate.totalK);
          if (outcome) (outcome.replacedRebuilds ??= []).push(older.id);
        }
      } else {
        reply = replies.earlierPreviewStillWaiting(reply, fate.totalK);
      }
    }
  }
  for (const closed of await conversationsRepo.closeRetiredQuestionsBefore(
    tx,
    businessId,
    draftId,
  )) {
    const holders = await continuationsRepo.retireContinuationsForDraft(tx, businessId, closed);
    if (outcome) (outcome.closedQuestions ??= []).push({ id: closed, holders });
  }
  return reply;
}

/**
 * "na so?", "yes?", "e correct 🤔": an affirmation asked as a question
 * (G-68). It confirms NOTHING, ever, and calls no model. What it is told
 * depends on what is waiting, read without claiming anything:
 *  - a retired G-61 question: the question again, as a "yes" gets it;
 *  - an expired preview: that it expired, as a "yes" is told;
 *  - a live preview: that only a plain yes saves it;
 *  - nothing: that nothing is waiting for a yes.
 */
async function unsureReply(
  tx: TenantDb,
  businessId: string,
  receivedAt: Date,
  sender: { messageId: string; from: string; receivedAt: Date },
): Promise<Reply> {
  /* The yes it is not would carry the role rule; so does this answer. A
   * view-only member is never told "reply yes to save it". */
  if (!(await mayTransact(tx, businessId, sender.from))) return replies.viewOnlyRole();
  await conversationsRepo.expireStaleDrafts(tx, businessId, { now: receivedAt });

  /* The two-ask erasure (G-68 review): before G-68 "yes?" was a yes, which
   * claimed a parked erasure ask and kept the data, so a later "delete my
   * data" was a NEW first ask. A questioned yes must do exactly the same,
   * never leave the ask parked for the second phrase to complete. */
  const parked = await conversationsRepo.pendingDraft(tx, businessId, { asOf: receivedAt });
  if ((parked?.command as { intent?: string } | undefined)?.intent === 'EraseData') {
    await conversationsRepo.claimDraft(tx, parked!.id, { now: receivedAt });
    return replies.erasureKept();
  }

  /* G-81 first: doubt from a member still being asked "same or separate" is
   * about that question (gated without Chat inside the re-ask). */
  const asking = await senderBeingAsked(tx, businessId, sender.from, receivedAt);
  if (asking) return reaskPurchaseIdentity(tx, businessId, asking.heldId, asking.actorId, sender);

  /* G-65: every answer below invites a plain yes (or re-asks a question a
   * "bank" answers), which a plan without Chat is then refused. Such a plan
   * is told nothing was saved when something was waiting, and pointed at
   * what works when nothing was. */
  if (await withoutChat(tx, businessId)) {
    const waiting = await conversationsRepo.latestDraftToAnswer(tx, businessId, {
      asOf: receivedAt,
    });
    /* An expired draft gets what a plain yes gets (an erasure ask is still
     * kept; a lapsed preview is told nothing was saved, inviting no resend;
     * a clarification that never became a preview, nothing waiting). */
    if (waiting?.state === 'expired') {
      return (
        (await expiredYesReply(tx, businessId, waiting.command, waiting.previewed)) ??
        replies.nothingToConfirmWithoutChat()
      );
    }
    /* Waiting means something a yes could have saved: a preview, or a
     * retired funding question a "bank" answers. A live question Rekoda
     * asked (never a preview) is not, exactly as the path below says
     * (Codex review). */
    const pending = await conversationsRepo.pendingDraftToAnswer(tx, businessId, {
      asOf: receivedAt,
    });
    const live = waiting?.state === 'abandoned' || pending?.previewed === true;
    return live
      ? ((await draftRefusalWithoutChat(tx, businessId)) ?? replies.nothingToConfirmWithoutChat())
      : replies.nothingToConfirmWithoutChat();
  }

  let latest = await conversationsRepo.latestDraftToAnswer(tx, businessId, { asOf: receivedAt });
  /* G-81: doubt about the identity question asks it again, from the member
   * who was asked; nobody else is held up by it. */
  if (latest?.state === 'held') {
    const asked = await askedAboutHeld(tx, businessId, latest.id, sender.from, sender.receivedAt);
    if (asked) return reaskPurchaseIdentity(tx, businessId, latest.id, asked, sender);
    latest = await conversationsRepo.latestDraftToAnswer(tx, businessId, {
      asOf: receivedAt,
      skipHeld: true,
    });
  }
  if (latest?.state === 'abandoned') {
    return (
      (await reaskRetiredQuestion(tx, businessId, latest, sender)) ?? replies.nothingToConfirm()
    );
  }
  if (latest?.state === 'expired') {
    return expiredAnswer(latest.command, latest.previewed, 'yes') ?? replies.nothingToConfirm();
  }
  const pending = await conversationsRepo.pendingDraftToAnswer(tx, businessId, {
    asOf: receivedAt,
  });
  if (!pending?.previewed) return replies.nothingToConfirm();
  /* A question to the books asked since the preview: point back at the
   * preview, as a yes would, without retiring anything. */
  if (await conversationsRepo.hasReadsAfter(tx, businessId, pending.id, { asOf: receivedAt })) {
    return replies.previewBehindQuestion();
  }
  return replies.plainYesNeeded();
}

/**
 * Ask a retired G-61 purchase question again (to a "yes", "na so?" or a
 * questioned funding answer), and, for the funding-source question, RE-OPEN
 * the short answer for the member who sent this message (G-68 review). The
 * question says "Reply *bank* or *cash*", and that must be true however old
 * the question is: its first continuation may have expired, been superseded
 * by an unrelated reply, or belong to another member. Re-opened through the
 * ordinary `openContinuation` (newest wins), naming the same retired draft,
 * only while it is still `abandoned` and only for a sender with a
 * membership. Null when the retired draft asks nothing.
 */
async function reaskRetiredQuestion(
  tx: TenantDb,
  businessId: string,
  retired: { id: string; state: string; command: unknown },
  sender: { messageId: string; from: string; receivedAt: Date },
): Promise<Reply | null> {
  if (retired.state !== 'abandoned') return null;
  const asked = retired.command as { intent?: string } & Record<string, unknown>;
  if (asked.intent !== 'RecordPurchase') return null;
  /* G-65: asked again, the question says "Reply *bank* or *cash*" and
   * re-opens that answer, which a plan without Chat is refused. Such a plan
   * is told nothing was saved instead, and nothing is re-opened. */
  const refused = await draftRefusalWithoutChat(tx, businessId);
  if (refused) return refused;
  /* The short answer is offered, and re-opened, only inside the answer
   * window (F3, OD-19); after it the question offers only "send it again",
   * so it never promises an answer Rekoda will not take. */
  const row = await conversationsRepo.retiredPurchaseDraft(tx, businessId, retired.id);
  const inWindow = row !== null && insideFundingWindow(row.createdAt, sender.receivedAt);
  const gate = gatePurchase(asked as never, { shortAnswer: inWindow });
  if (gate.gate !== 'CG1') return null;
  if (inWindow && 'reason' in gate && gate.reason === 'funding_source') {
    const now = { now: sender.receivedAt };
    const actorId = await actorOf(tx, businessId, sender.from);
    /* Already open for this member, about this draft: nothing to re-open. */
    const live = actorId
      ? await continuationsRepo.currentContinuation(tx, businessId, actorId, now)
      : null;
    const alreadyOpen =
      live?.state.kind === 'clarification' &&
      live.state.expects === 'funding_source' &&
      live.state.draftId === retired.id;
    if (actorId && !alreadyOpen) {
      await continuationsRepo.openContinuation(tx, {
        businessId,
        userId: actorId,
        sourceMessageId: sender.messageId,
        state: { kind: 'clarification', expects: 'funding_source', draftId: retired.id },
        now: sender.receivedAt,
        expiresAt: fundingWindowEnd(row!.createdAt),
      });
    }
  }
  return replies.arithmeticQuestion(gate.question);
}

/**
 * The read-only gates a rebuilt purchase walks, in order, or null when all
 * pass: the role rule (only a member who may transact gets a draft to say
 * yes to), a lapsed trial, and the Chat entitlement. One function so the
 * refusals can be routed through a shared refusal later (Build 8) in one
 * place; it reads only, so it can run before the answer is claimed.
 */
async function fundingGateRefusal(
  tx: TenantDb,
  businessId: string,
  from: string,
): Promise<Reply | null> {
  if (!(await mayTransact(tx, businessId, from))) return replies.viewOnlyRole();
  /* G-65: the lapse, then the Chat entitlement, as before, decided by the
   * same draft boundary a yes meets. The sentences are Build 7's, except
   * that a lapse is told which kind it is (`lapsedReply`): a merchant whose
   * PAID plan lapsed is never told their free trial ended. */
  const access = chatDraftAccess(await chatStandingOf(tx, businessId));
  if (access === 'plan_lapsed') return lapsedReply(tx, businessId, from);
  if (access === 'chat_not_in_plan') return replies.chatNotInPlan();
  return null;
}

/**
 * Null when this business may make or confirm a Chat draft; otherwise the
 * refusal a refused yes gets (G-65), which says nothing was saved. Read
 * only, so it runs before anything is claimed, re-opened or rebuilt: a
 * question re-asked, or a preview pointed at, would invite a "yes" or a
 * "bank" this plan is then refused.
 */
async function draftRefusalWithoutChat(tx: TenantDb, businessId: string): Promise<Reply | null> {
  const access = chatDraftAccess(await chatStandingOf(tx, businessId));
  return access === 'allow' ? null : chatRefusal(tx, businessId, access, 'draft');
}

/**
 * What a funding answer that cannot rebuild anything is told (G-68 review),
 * true in every state, and never inviting a resend while a live preview
 * waits (two previews of one purchase could be booked twice):
 *  - the member's OWN live preview is waiting: point at it, naming its
 *    account when it differs from the one just named;
 *  - another member's, or one Rekoda cannot attribute (requested_by null):
 *    say so, inviting neither a yes nor a resend;
 *  - nothing live is waiting: the question can no longer be answered.
 * "Waiting" is only ever the purchase rebuilt from THIS question
 * (`rebuilt_from`), never some other preview that happens to be pending.
 */
async function closedQuestionReply(
  tx: TenantDb,
  businessId: string,
  /** The retired question the funding answer was about. */
  questionId: string,
  receivedAt: Date,
  from: string,
  /** The account the member just named, when the message named one. */
  named?: FundingSource | null,
): Promise<Reply> {
  /* G-65: every answer below points at a "yes" or a resend, which a plan
   * without Chat is refused; it is told nothing was saved instead. */
  const refused = await draftRefusalWithoutChat(tx, businessId);
  if (refused) return refused;
  /* "Waiting" only for the purchase rebuilt from THIS question (0157,
   * `rebuilt_from`), and only when it is what the next yes would actually
   * reach: the newest pending preview, live (its window not closed at this
   * message), with no read after it (a yes would get the pointer reply
   * instead), not behind a retired question, and with no retired question
   * as the latest thing to answer (a yes would re-ask that instead). Then
   * WHOSE it is (final-head review): another member's preview names an
   * account this member did not choose, so it is never offered as theirs to
   * confirm, and a resend is not invited either. Read-only. */
  const latest = await conversationsRepo.latestDraftToAnswer(tx, businessId, { asOf: receivedAt });
  if (latest?.state === 'abandoned') return replies.fundingQuestionClosed();
  const waiting = await conversationsRepo.pendingDraftToAnswer(tx, businessId, {
    asOf: receivedAt,
  });
  const reachable =
    waiting !== null &&
    waiting.intent === 'RecordPurchase' &&
    waiting.rebuiltFrom === questionId &&
    waiting.previewed === true &&
    !(await conversationsRepo.hasReadsAfter(tx, businessId, waiting.id, { asOf: receivedAt })) &&
    waiting.expiresAt !== undefined &&
    waiting.expiresAt.getTime() > receivedAt.getTime() &&
    !(await conversationsRepo.isBehindRetiredQuestion(tx, businessId, waiting.id));
  if (!reachable) return replies.fundingQuestionClosed();
  const member = await actorOf(tx, businessId, from);
  if (member === null || !waiting.requestedBy) return replies.previewWaitingUnattributed();
  if (waiting.requestedBy !== member) return replies.previewWaitingForAnotherMember();
  const paid = (waiting.command as { paymentMethod?: unknown }).paymentMethod;
  const differs = named && (paid === 'transfer' || paid === 'cash') && paid !== named;
  return replies.previewAlreadyWaiting(differs ? paid : undefined);
}

/** How long after an identity question closes "same" or "separate" is still
 * told it closed (G-81); after it, the words are an ordinary message. */
const IDENTITY_CLOSED_GRACE_MS = 2 * 60 * 60 * 1000;

/** When a funding question's answer window closes (OD-19). */
function fundingWindowEnd(askedAt: Date): Date {
  return new Date(askedAt.getTime() + FUNDING_ANSWER_WINDOW_SECONDS * 1000);
}

/** Was the retired funding question asked within FUNDING_ANSWER_WINDOW_SECONDS? */
function insideFundingWindow(askedAt: Date, receivedAt: Date): boolean {
  return withinFundingWindow(askedAt, receivedAt);
}

/**
 * A short reply that continues what was open for this member (Build 6), or
 * null to be understood as an ordinary message.
 *
 *  - Nothing open, or the reply does not fit what was expected ("I bought 10
 *    cartons for 100k" after "Which period?", a "2" while a period is
 *    expected, a "yes"): whatever was open is retired, because the newest
 *    thing said wins, and null sends the message down its ordinary path.
 *  - A clarification that fits is CLAIMED, once, with every predicate in the
 *    UPDATE: two replies racing for one question cannot both answer it, and
 *    a claim that loses (or lands after the window) is treated as absent.
 *  - What resumes is a READ answered from SQL: no model, no preview,
 *    nothing a "yes" could confirm. It records a read-only Query draft,
 *    exactly the footprint the message left before Build 6. The read just
 *    answered then stays open as the subject of the next follow-up.
 */
async function continueConversation(
  tx: TenantDb,
  businessId: string,
  actorId: string,
  message: {
    text: string;
    route: Route;
    messageId: string;
    receivedAt: Date;
    from: string;
    outcome?: RebuildOutcome;
  },
): Promise<Reply | null> {
  const now = { now: message.receivedAt };
  const open = await continuationsRepo.currentContinuation(tx, businessId, actorId, now);

  /* A short "cash" or "bank" with nothing open, when this member's newest
   * continuation was a funding question whose purchase has since been
   * answered or closed (by them, by another member, by a "no", or by the
   * purchase being sent again), inside its window: told so, truthfully,
   * with no model call (G-68 review). Never a rebuild. */
  if (!open && message.route.route === 'model' && fundingSourceAnswer(message.text)) {
    const newest = await continuationsRepo.newestContinuation(tx, businessId, actorId, now);
    if (newest?.kind === 'clarification' && newest.expects === 'funding_source') {
      const asked = await conversationsRepo.draftStateOf(tx, businessId, newest.draftId);
      if (
        asked &&
        asked.state !== 'abandoned' &&
        insideFundingWindow(asked.createdAt, message.receivedAt)
      ) {
        return closedQuestionReply(
          tx,
          businessId,
          newest.draftId,
          message.receivedAt,
          message.from,
          fundingSourceAnswer(message.text),
        );
      }
    }
  }

  /* G-81: "same" or "separate" with nothing open, when this member's
   * newest continuation was the identity question (fresh review of #262):
   *  - its purchase is still held and inside its window (another message
   *    retired the short answer): it IS the answer, taken as one;
   *  - it was answered "separate" and that fresh preview still waits: said;
   *  - otherwise, only shortly after the question closed, that it closed.
   * Days later a bare "same" is an ordinary message. No model call. */
  /* "same" or "separate" while another, newer continuation is open (say
   * "Which period?" after a spending question): it answers the sender's
   * own held identity question, still inside its window and asked BEFORE
   * this reply, never the newer question (Codex review). */
  const spokenAnswer =
    message.route.route === 'model' ? purchaseIdentityAnswer(message.text) : null;
  if (
    spokenAnswer &&
    !(open?.state.kind === 'clarification' && open.state.expects === 'purchase_identity')
  ) {
    const heldId = await conversationsRepo.askedHeldNewerThan(tx, businessId, actorId, null, now);
    if (heldId) {
      /* The open question this answer retires, given back if the reply
       * never reaches the member. */
      if (open && message.outcome) message.outcome.supersededContinuation = open.id;
      if (answerIsUncertain(message.text)) {
        return reaskPurchaseIdentity(tx, businessId, heldId, actorId, message);
      }
      if (spokenAnswer === 'separate') {
        const refused = await fundingGateRefusal(tx, businessId, message.from);
        if (refused) return refused;
      }
      await continuationsRepo.retireContinuations(tx, businessId, actorId, now);
      return answerPurchaseIdentity(tx, businessId, actorId, heldId, spokenAnswer, message);
    }
  }
  const identityAnswer = !open ? spokenAnswer : null;
  if (identityAnswer) {
    const newest = await continuationsRepo.newestContinuation(tx, businessId, actorId, now);
    if (newest?.kind === 'clarification' && newest.expects === 'purchase_identity') {
      const asked = await conversationsRepo.identityQuestionState(
        tx,
        businessId,
        newest.draftId,
        now,
      );
      const t = message.receivedAt.getTime();
      if (
        asked?.state === 'held' &&
        asked.expiresAt.getTime() > t &&
        !answerIsUncertain(message.text)
      ) {
        if (identityAnswer === 'separate') {
          const refused = await fundingGateRefusal(tx, businessId, message.from);
          if (refused) return refused;
        }
        return answerPurchaseIdentity(
          tx,
          businessId,
          actorId,
          newest.draftId,
          identityAnswer,
          message,
        );
      }
      if (asked?.freshPreviewWaiting) {
        return identityClosedReply(tx, businessId, { freshPreviewWaiting: true });
      }
      if (asked && t < asked.expiresAt.getTime() + IDENTITY_CLOSED_GRACE_MS) {
        return identityClosedReply(tx, businessId);
      }
    }
  }

  /* G-81: a "yes", "na so", "no" or "cancel" while the identity question is
   * open is about the question, never an answer to it: it goes down its
   * ordinary path, which asks the question again (or, for a cancel, closes
   * it), and the question stays open for the short answer it asks for. */
  if (
    open?.state.kind === 'clarification' &&
    open.state.expects === 'purchase_identity' &&
    message.route.route === 'deterministic' &&
    (message.route.intent.kind === 'affirm' ||
      message.route.intent.kind === 'unsure' ||
      message.route.intent.kind === 'deny' ||
      message.route.intent.kind === 'cancel')
  ) {
    return null;
  }

  /* G-61: a "yes" (or "na so", "oya") to the funding-source question is
   * about the question itself, and is answered by asking it again, exactly
   * as before (G-68 Phase 2). The question stays open for the short answer
   * it asks for; the "yes" goes down its ordinary path. */
  if (
    open?.state.kind === 'clarification' &&
    open.state.expects === 'funding_source' &&
    message.route.route === 'deterministic' &&
    (message.route.intent.kind === 'affirm' || message.route.intent.kind === 'unsure')
  ) {
    return null;
  }

  const answer = open ? continuationAnswer(open.state, message) : null;

  /* A short answer naming a funding account (G-68 Phase 2). Claimed once,
   * then answered by a FRESH preview of the rebuilt purchase. */
  if (
    open &&
    answer?.kind === 'funding_source' &&
    open.state.kind === 'clarification' &&
    open.state.expects === 'funding_source'
  ) {
    const draftId = open.state.draftId;
    const retired = await conversationsRepo.retiredPurchaseDraft(tx, businessId, draftId);
    /* Past the answer window (F3, OD-19) a short "bank" rebuilds nothing:
     * the question is retired and the message routes as it otherwise would. */
    if (retired && !insideFundingWindow(retired.createdAt, message.receivedAt)) {
      await continuationsRepo.retireContinuations(tx, businessId, actorId, now);
      return null;
    }
    /* "cash?", "bank 🤔", "cash ❌", "bank 👎": asked or contradicted, not
     * answered (G-68 review; Codex review: the same emoji rule as a yes).
     * The question stays open and is asked again; nothing is rebuilt. */
    if (answerIsUncertain(message.text)) {
      return retired
        ? ((await reaskRetiredQuestion(
            tx,
            businessId,
            { ...retired, state: 'abandoned' },
            message,
          )) ??
            (await closedQuestionReply(tx, businessId, draftId, message.receivedAt, message.from)))
        : closedQuestionReply(tx, businessId, draftId, message.receivedAt, message.from);
    }
    /* The read-only gates run BEFORE the answer is claimed (Codex review):
     * a refusal leaves the question open, so the same "cash" works the
     * moment access is restored. */
    const refused = await fundingGateRefusal(tx, businessId, message.from);
    if (refused) return refused;
    const claimed = await continuationsRepo.consumeContinuation(
      tx,
      businessId,
      actorId,
      open.id,
      now,
    );
    if (!claimed) {
      await continuationsRepo.retireContinuations(tx, businessId, actorId, now);
      return null;
    }
    return answerFundingSource(tx, businessId, draftId, answer.source, message);
  }

  /* "same" or "separate" to the identity question (G-81, OD-23), from the
   * member who was asked, inside its window. Doubt ("same?", "separate 🤔")
   * asks again and acts on nothing. "separate" meets the read-only gates
   * BEFORE the question is claimed, so a refusal leaves it open. Claimed
   * once, then answered: "same" writes nothing, "separate" shows a FRESH
   * preview that only a normal yes books. */
  if (
    open &&
    answer?.kind === 'purchase_identity' &&
    open.state.kind === 'clarification' &&
    open.state.expects === 'purchase_identity'
  ) {
    const heldId = open.state.draftId;
    if (answerIsUncertain(message.text)) {
      return reaskPurchaseIdentity(tx, businessId, heldId, actorId, message);
    }
    if (answer.answer === 'separate') {
      const refused = await fundingGateRefusal(tx, businessId, message.from);
      if (refused) return refused;
    }
    const claimed = await continuationsRepo.consumeContinuation(
      tx,
      businessId,
      actorId,
      open.id,
      now,
    );
    if (!claimed) {
      await continuationsRepo.retireContinuations(tx, businessId, actorId, now);
      return null;
    }
    return answerPurchaseIdentity(tx, businessId, actorId, heldId, answer.answer, message);
  }

  /* "2" from an explicit numbered list this member was shown and that is
   * still open (G-68 Phase 2): the list is CONSUMED by its answer, never
   * merely superseded. No question in Rekoda presents a numbered list yet,
   * so nothing opens one in production; the answer names the line chosen
   * and the commands that take it, and acts on nothing. */
  if (open && answer?.kind === 'choice') {
    const claimed = await continuationsRepo.consumeContinuation(
      tx,
      businessId,
      actorId,
      open.id,
      now,
    );
    if (!claimed) {
      await continuationsRepo.retireContinuations(tx, businessId, actorId, now);
      return null;
    }
    /* G-65: the choice suggests *remind*, which a live plan without Chat is
     * refused; such a plan is pointed at what works instead. */
    return (await withoutChat(tx, businessId))?.lapse === null
      ? replies.optionChosenWithoutChat(answer.option.ref.invoiceNumber)
      : replies.optionChosen(answer.option.ref.invoiceNumber);
  }

  /* "Which period?" answered with a window Rekoda cannot count here
   * ("yesterday", "last week", "in March"): the question stays OPEN and says
   * which windows it can count, so the next reply can still answer it
   * (Build 6's note, G-68 Phase 2). Nothing is retired or consumed. */
  if (
    open?.state.kind === 'clarification' &&
    open.state.expects === 'period' &&
    !answer &&
    message.route.route === 'model' &&
    uncountablePeriod(message.text) &&
    /* G-65: it keeps the question open for a read this plan is refused. */
    resumedReadAccess(await chatStandingOf(tx, businessId)) === 'allow'
  ) {
    return replies.periodNotCountable(open.state.topic === 'sales_summary' ? 'sales' : 'spending');
  }

  const fitted = open && answer ? resumedRead(open.state, answer) : null;
  /* G-65: a resumed read answers a question about the books, the same Chat
   * capability as `records`, so a plan without Chat does not resume it (a
   * lapsed plan keeps it, as it keeps `records`). The continuation is
   * retired and the message goes the ordinary way, which is itself gated:
   * "last month" reaches the model path and its refusal, unmetered. */
  const read =
    fitted && resumedReadAccess(await chatStandingOf(tx, businessId)) === 'allow' ? fitted : null;
  const claimed =
    open && read && isOneShot(open.state)
      ? await continuationsRepo.consumeContinuation(tx, businessId, actorId, open.id, now)
      : read !== null;
  if (!read || !claimed) {
    /* G-81 (fresh review of #262): a reply that is not an answer leaves the
     * identity question open while its purchase can still be answered, so
     * a later "separate" is never told the question closed while a yes
     * would re-ask it. */
    if (
      open?.state.kind === 'clarification' &&
      open.state.expects === 'purchase_identity' &&
      message.route.route === 'model'
    ) {
      const held = await conversationsRepo.heldPurchaseDraft(tx, businessId, open.state.draftId, {
        now: message.receivedAt,
      });
      if (held) {
        /* "cash" again after a funding answer whose purchase is now asked
         * about: the funding question was answered, and the identity
         * question is what is open, so that is what is asked again. */
        if (held.rebuiltFrom && fundingSourceAnswer(message.text)) {
          return reaskPurchaseIdentity(tx, businessId, held.id, actorId, message);
        }
        return null;
      }
    }
    const retired = await continuationsRepo.retireContinuations(tx, businessId, actorId, now);
    if (retired > 0 && open?.state.kind === 'clarification' && message.outcome) {
      message.outcome.retiredQuestion = true;
    }
    if (retired > 0 && open && message.outcome) message.outcome.retiredContinuation = open.id;
    return null;
  }

  const reply = await answerPeriodQuery(
    tx,
    businessId,
    read.topic,
    read.period,
    message.receivedAt,
  );
  /* The footprint the same message left before Build 6, when it went to the
   * model and was answered as a question: a read-only Query draft keyed to
   * it. That draft is what keeps a later "yes" from reaching PAST this read
   * to an older preview (`hasReadsAfter`), and what breaks a two-ask
   * erasure pair a message lands between, whichever member sent it. It
   * carries only the topic and the window core resolved, never the
   * merchant's words: `last_month` has no named period in the contract, so
   * it is `custom` with no text. Nothing can confirm it. */
  await conversationsRepo.recordDraft(tx, {
    businessId,
    conversationMessageId: message.messageId,
    intent: 'Query',
    command: {
      intent: 'Query',
      topic: read.topic,
      customer: null,
      period: read.period === 'last_month' ? 'custom' : read.period,
      periodText: null,
      format: null,
    },
    model: null,
  });
  await continuationsRepo.openContinuation(tx, {
    businessId,
    userId: actorId,
    sourceMessageId: message.messageId,
    state: {
      kind: 'query',
      topic: read.topic,
      period: read.period,
      customerToken: null,
      documentRef: null,
    },
  });
  return reply;
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
  draft: { id: string; messageKind: string | null; confirmationContext?: unknown },
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

  const gate = gatePayment(command as never, invoice.invoiceNumber, invoice.balanceDueK, {
    customerLinked: invoice.customerId !== null,
  });
  if (gate.gate !== 'CG2') {
    await refundDocumentUnit();
    return replies.arithmeticQuestion(gate.question);
  }

  /*
   * OWN-16: an overpayment is booked only as the merchant SAW it. The draft
   * carries the figures its preview showed; if the payment is an overpayment
   * now, or was one when previewed, those figures must still be the truth:
   * same invoice, same amount, same balance. Anything else is a stale
   * confirmation, so nothing is written and they are asked again. An exact
   * payment previewed at 150,000 that finds 50,000 owing is never turned into
   * 100,000 of credit nobody was shown. The repository repeats the balance
   * check under the invoice's row lock; this one answers before any work.
   */
  const shown = parseConfirmationContext(draft.confirmationContext);
  let confirmedOverpayment: { expectedBalanceK: number } | null = null;
  if (gate.creditK > 0 || shown !== null) {
    if (
      shown === null ||
      shown.invoiceId !== invoice.id ||
      shown.amountReceivedK !== gate.amountK ||
      shown.balanceShownK !== invoice.balanceDueK
    ) {
      await refundDocumentUnit();
      /* With figures on the draft, the balance may have risen as well as
       * fallen (a reversed payment reopens it), so the reply names no cause;
       * with none, the preview was not an overpayment and the balance fell. */
      return replies.paymentBalanceMoved(
        invoice.invoiceNumber,
        invoice.balanceDueK,
        shown === null ? gate.amountK - invoice.balanceDueK : 0,
      );
    }
    confirmedOverpayment = { expectedBalanceK: shown.balanceShownK };
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
    ...(confirmedOverpayment ? { confirmedOverpayment } : {}),
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
    /* A confirmed overpayment is refused under the lock on ANY change, up or
     * down, so that refusal names no cause (G-49). */
    return replies.paymentBalanceMoved(
      recorded.invoiceNumber,
      recorded.balanceDueK,
      confirmedOverpayment ? 0 : recorded.excessK,
    );
  }
  if (recorded.outcome !== 'recorded') {
    /* `not_found` cannot happen on the id path; honest fallback, unit back. */
    await refundDocumentUnit();
    return replies.paymentNoOpenInvoice();
  }

  /* Every figure here comes from the WRITE, never from the gate. The gate
   * read the balance without a lock, so its amount is what we hoped to post;
   * `recorded.amountK` is what the ledger actually took. A snapshot from
   * before G-49 carries no `creditK`, and had none. */
  const creditK = recorded.creditK ?? 0;
  if (creditK > 0) {
    return replies.paymentRecordedOverpaid(
      recorded.receiptNumber,
      recorded.receivedK ?? recorded.amountK + creditK,
      recorded.amountK,
      creditK,
      recorded.invoiceNumber,
      /* The write decided where the excess went, under the lock. */
      recorded.excessDisposition
        ? recorded.excessDisposition === 'customer_credit'
        : invoice.customerId !== null,
    );
  }
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
  /** When this message reached Rekoda; see CommandContext.receivedAt. */
  receivedAt: Date,
  /** The stored event this message came in on, where its unit is recorded. */
  eventId: string,
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
  /** The member who sent this (Build 6), or null for a sender with none. */
  actorId: string | null,
  /** True when this text was extracted from a photographed document. */
  fromDocument = false,
  /** What this reply did that a failed send must undo (G-68). */
  outcome?: RebuildOutcome,
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
   * refuses; what changes is what the merchant is told, and a lapsed PAID
   * plan is not told its free trial ended (G-65, `lapsedReply`). */
  if (plan === 'expired') return lapsedReply(tx, businessId, from);

  /* ENTITLEMENT BEFORE METER, and before the model is paid for (spec §4.3,
   * rules 1 to 3). An Integrate-only merchant holds the customer-facing half
   * and not this one, and refusing here means no unit is taken and no
   * provider is called — so there is nothing to refund and no path where the
   * meter can drift. */
  if (await entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_CHAT')) {
    return replies.chatNotInPlan();
  }

  /**
   * AUTHORISATION BEFORE METER, and before the model is paid for (G-57,
   * OWN-25; spec §4.3, rules 2 to 4).
   *
   * A member who may not change the books is refused here when the message
   * plainly asks to change them, and is asked for a question when it could be
   * either: in both cases no unit is taken and no model is called. Only a
   * plain question about the books goes on. Owners and delegates never pass
   * through this; what they send reaches the model exactly as before.
   *
   * `requestKind` names the kind of request and nothing else; `mayTransact`
   * is still the role rule, and the check after the model below still
   * refuses a write this let through. A photographed document is refused
   * before it is read (`readReceiptPhoto`), which is what saves its cost;
   * refusing one here too only keeps the authorisation true if a document
   * ever reaches this path another way, by which time it was paid for.
   */
  const transacts = await mayTransact(tx, businessId, from);
  let asked: RequestKind | null = null;
  if (!transacts) {
    /* Not `viewOnlyPhoto`: by now the photo WAS read, and that reply says it
     * was not. Reached only by a member demoted while their photo was read;
     * a refused request consumes nothing (spec §4.3 rule 4), so the page's
     * unit goes back (G-57 final review B). The reading itself was paid
     * for and stays on Rekoda's books. */
    if (fromDocument) {
      await giveBackUnit(
        deps,
        businessId,
        eventId,
        usagePeriod(receivedAt),
        'DOCUMENTS_UNDERSTOOD',
      );
      return replies.viewOnlyRole();
    }
    asked = requestKind(safeText);
    if (asked === 'write') return replies.viewOnlyRole();
    if (asked === 'unknown') return replies.viewOnlyAskAQuestion();
  }

  const monthlyMessages = await meterAllowance(deps.config, tx, businessId, plan, 'AI_ACTIONS');
  /* The month this message ARRIVED in, not the month an attempt runs in:
   * a retry that crosses midnight at a month's end must give back the unit
   * it took in the old month, never take one from the new (G-57, Codex). */
  const period = usagePeriod(receivedAt);

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
  /* A retry is granted only when the message holds its unit: attempt 1
   * took it. One refused at the allowance, or that took nothing, is metered
   * now (G-57 final review B). */
  const granted =
    (retrying && (await holdsUnit(deps, businessId, eventId, 'AI_ACTIONS'))) ||
    (await consumeMessage(deps, businessId, eventId, period, monthlyMessages));
  if (!granted) return replies.allowanceExhausted(monthlyMessages);

  const interpreted = await deps.interpreter.interpret(
    businessId,
    safeText,
    fromDocument ? { document: true } : undefined,
  );

  /**
   * The meter only moves when the product worked. If the model never ran
   * (daily ceiling, provider down) or its answer was unusable, the unit goes
   * back — a merchant must never watch their allowance shrink on Rekoda's
   * failures.
   */
  /* Run on a retry too (G-57 final review B): attempt 1's unit may still be
   * held if its reply failed after the model answered, and this attempt
   * delivered nothing. `refundMessage` gives back the recorded reservation
   * exactly once, in the month it was taken. */
  if (interpreted.outcome !== 'command') {
    await refundMessage(tx, businessId, eventId, period);
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
  /* Two independent readers disagreed on a high-value document (item 9).
   * Nothing was drafted from either reading; the merchant states the
   * figures and the typed sentence walks the ordinary confirm gate. The
   * message unit was already refunded above with the other non-command
   * outcomes. */
  if (interpreted.outcome === 'disagreement') {
    return replies.extractionDisagreement(interpreted.fields);
  }

  /**
   * The role rule, applied again where the intent is fully known.
   *
   * A question is a read and answers for every member; anything else changes
   * the books, and a view-only member does not get a draft to say yes to.
   * The check above turned away the messages its small grammar could tell
   * were records, or could not tell at all (G-57); this one is the
   * authority, and catches a question that the model reads as a record. That costs the call the
   * early check exists to save (the unit is refunded below), so it is logged
   * (the intent and nothing the merchant wrote) as evidence for widening the
   * early grammar.
   */
  if (
    interpreted.command.intent !== 'Query' &&
    interpreted.command.intent !== 'Unclear' &&
    /* Read again, not reused: the model call can take twenty seconds, and a
     * member demoted meanwhile must not get a draft. */
    !(await mayTransact(tx, businessId, from))
  ) {
    if (asked === 'read') {
      authorisationLog.warn(
        `view-only message read as a question before the model, as ${interpreted.command.intent} after it`,
      );
    }
    /* A refused request consumes nothing (spec §4.3 rule 4): the call is
     * spent, but the unit goes back, as for every outcome that did not
     * deliver. Run on a retry too (Codex P2): the recorded reservation is
     * given back exactly once, in the month it was taken, whichever attempt
     * answers. */
    await refundMessage(tx, businessId, eventId, period);
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
  /* G-23: an expired preview is not there to be corrected; a "sorry, 3 not
   * 4" after it is a new request with its own fresh window. */
  await conversationsRepo.expireStaleDrafts(tx, businessId, { now: receivedAt });
  /* A correction is about something a "yes" could confirm, never a read:
   * "sorry, 3 not 4" after only a question is a new request (Build 6). */
  const existing = await conversationsRepo.pendingDraftToAnswer(tx, businessId, {
    asOf: receivedAt,
  });
  const correcting = looksLikeCorrection(rawText, existing !== null);
  if (correcting) {
    await conversationsRepo.supersedePendingDrafts(tx, businessId, { asOf: receivedAt });
  }

  /**
   * The answer is built BEFORE the draft is stored, because what the draft
   * carries depends on what the merchant was actually asked.
   *
   * A link proposal is only saved when the question about it reached them. A
   * CG1 arithmetic question comes first and leaves no room for a second
   * question, and storing the proposal anyway would mean a later `yes` joining
   * two customer records nobody was ever asked about.
   */
  const answered = await acknowledge(tx, businessId, command, correcting, link, receivedAt);

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

  /* G-81 (OD-23): a purchase that would be previewed is first compared with
   * every purchase of the same total waiting for a yes or booked in the last
   * 24 hours. The member's OWN waiting preview of it is replaced (D4, as
   * Build 7 replaces their own rebuild). Anything else that may be the same
   * purchase, booked by anyone, waiting for another member, or waiting with
   * no recorded requester (never treated as "you"), makes this purchase
   * HELD and asked about instead: never silently dropped, never silently
   * previewed for a second booking. A question Rekoda must ask first (CG1,
   * the G-61 funding source) is asked first; the comparison waits for the
   * purchase to be previewable. */
  const identity =
    command.intent === 'RecordPurchase' && answered.previewed === true
      ? await purchaseIdentityCheck(tx, businessId, {
          messageId: conversationMessageId,
          receivedAt,
          actorId,
          stored,
        })
      : null;
  const holding = identity?.ask != null;

  const draft = await conversationsRepo.recordDraft(tx, {
    businessId,
    conversationMessageId,
    intent: command.intent,
    command: stored,
    model: deps.config.aiModelDefault,
    identityLink: answered.linkAsked && !holding ? link : null,
    previewed: answered.previewed === true,
    confirmationContext: answered.confirmationContext ?? null,
    requestedBy: actorId ?? null,
    held: holding,
    separateFrom: holding ? null : (identity?.inheritFrom ?? null),
  });

  /* Build 6: a read Rekoda just answered, or the one question it asked
   * about it ("Which period?"), stays open for this member's next short
   * reply. Only ever a read: `acknowledge` returns a continuation for a
   * Query and for nothing else. */
  if (answered.continuation && actorId) {
    await continuationsRepo.openContinuation(tx, {
      businessId,
      userId: actorId,
      sourceMessageId: conversationMessageId,
      state: answered.continuation,
    });
  }

  let shown = answered.reply;
  if (holding && identity?.ask) {
    /* The question, never the preview: nothing a yes could confirm exists.
     * "same" or "separate" is answered through a typed, member-scoped,
     * expiring continuation naming the held draft. A sender with no
     * membership cannot reach a purchase at all (the role rule above); if
     * one ever did, nobody could answer, and nothing would be confirmable. */
    shown = replies.purchaseIdentityQuestion(identitySubject(identity.ask, actorId), receivedAt, {
      named: identity.asked.length,
    });
    if (draft.isNew) {
      /* Exactly what the question names, so "separate" excuses only those. */
      await conversationsRepo.nameHeldRecords(
        tx,
        businessId,
        draft.id,
        identity.asked.map((r) => r.self),
      );
      if (actorId) {
        /* The question's window opens when it is ASKED, on the database
         * clock, never when a delayed message arrived (Codex review), and
         * the continuation closes exactly with it. */
        const held = await conversationsRepo.heldPurchaseDraft(tx, businessId, draft.id);
        await continuationsRepo.openContinuation(tx, {
          businessId,
          userId: actorId,
          sourceMessageId: conversationMessageId,
          state: { kind: 'clarification', expects: 'purchase_identity', draftId: draft.id },
          ...(held ? { expiresAt: held.expiresAt } : {}),
        });
      }
      if (outcome) (outcome.heldDrafts ??= []).push(draft.id);
    }
  }
  /* A purchase held for a question replaces nothing (fresh review of #262):
   * the member's own waiting preview stays the one confirmable preview. */
  if (identity && draft.isNew && !holding) {
    shown = await replaceOwnPreviews(
      tx,
      businessId,
      identity.replace,
      shown,
      outcome,
      identity.unseen,
    );
  }

  /* G-68 review: a NEW financial preview means the merchant has moved on
   * from any retired purchase question asked before it (typically they sent
   * the purchase again, the base way to answer it). Each such question is
   * closed in this transaction, and every member's short answer to it is
   * retired, so nobody can rebuild it into a second preview of the same
   * purchase. And the SAME member's pending rebuilt preview of the same
   * TOTAL (integer kobo) is superseded, so their two yeses cannot book one
   * purchase twice, and the reply ALWAYS says so (final-head review); a
   * different total, or references that prove two purchases (G-81), leaves
   * it waiting, and the reply says that too. Never across members, and never for a rebuild with no recorded requester. */
  if (answered.previewed === true && draft.isNew && !holding) {
    shown = await afterNewPreview(tx, businessId, draft.id, command, actorId, shown, outcome);
  }

  /* G-61: the draft that asked a purchase question is kept on the record,
   * retired (`abandoned`), so it can never be confirmed. It is closed
   * (`superseded`) when the question is answered: by a short "bank" or
   * "cash" (a one-shot rebuild), or by any new financial preview such as
   * the purchase sent again (above). A second "yes" finds nothing to
   * resurrect, and nothing can record the purchase twice. */
  if (answered.retireDraft) {
    /* Only on the first delivery: a replayed message changes nothing. The
     * question becomes the conversation, so a preview left waiting from
     * before it is closed, not left pending and never confirmable. */
    if (draft.isNew) await conversationsRepo.supersedeDraftsBefore(tx, businessId, draft.id);
    /* The newest question wins, business-wide (Codex review): a NEW
     * purchase question closes every older one, and every member's short
     * answer naming one is retired, in this transaction. Nobody can then
     * rebuild an old purchase however the newer question ends. */
    if (draft.isNew && command.intent === 'RecordPurchase') {
      for (const closed of await conversationsRepo.closeRetiredQuestionsBefore(
        tx,
        businessId,
        draft.id,
      )) {
        await continuationsRepo.retireContinuationsForDraft(tx, businessId, closed);
      }
    }
    await conversationsRepo.retireDraft(tx, businessId, draft.id);
    /* G-68 Phase 2: the question also takes a short answer ("bank",
     * "cash", "na cash") from the member who was asked, through a typed
     * continuation naming this retired draft. The answer rebuilds the
     * purchase and shows a FRESH preview; it never executes this draft. */
    if (answered.fundingQuestion && actorId && draft.isNew) {
      const asked = await conversationsRepo.draftStateOf(tx, businessId, draft.id);
      await continuationsRepo.openContinuation(tx, {
        businessId,
        userId: actorId,
        sourceMessageId: conversationMessageId,
        state: { kind: 'clarification', expects: 'funding_source', draftId: draft.id },
        /* The short answer works for the whole answer window it offers
         * (OD-19), not just the 600-second continuation default. */
        ...(asked ? { expiresAt: fundingWindowEnd(asked.createdAt) } : {}),
      });
    }
  }

  /* Appendix D: a preview that shows stock DISAPPEARING opens the
   * confirmation the yes will claim, recording the exact consequence the
   * merchant read. Additions stay STANDARD and open nothing. */
  if (command.intent === 'AdjustInventory' && draft.isNew) {
    const product = await stockRepo.productByName(tx, businessId, command.productMention);
    const gate = gateStockChange(command, product?.onHand ?? 0);
    if (gate.gate === 'CG2' && gate.quantityDelta < 0) {
      const asked = await deps.commandBus.riskPolicy.ask(tx, {
        businessId,
        command: 'AdjustInventory',
        subject: `draft:${draft.id}`,
        actor: 'system',
        ingress: 'CHAT',
        consequence: gate.preview,
        reason: 'stock written off by merchant count',
        context: { destructive: true },
      });
      /* The draft's window, exactly, on the database clock, never this
       * host's (G-23): a yes inside one is inside the other. `asked.expiresAt`
       * is the figure before this line; the row holds the draft's. */
      await riskRepo.alignConfirmationWithDraft(tx, businessId, asked.id, draft.id);
    }
  }

  return shown;
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
  link: IdentityLinkProposal | null,
  /** When the message reached Rekoda: the instant a period is drawn from. */
  receivedAt: Date,
): Promise<{
  reply: Reply;
  linkAsked: boolean;
  /** A read's subject, or the question asked about it (Build 6). Reads only. */
  continuation?: ContinuationState;
  /** What an overpayment preview showed, stored on the draft (OWN-16). */
  confirmationContext?: ConfirmationContext;
  /** The answer was the G-61 funding-source question: the draft is kept for
   * the record but must not stay confirmable. */
  retireDraft?: boolean;
  /** That question was WHERE THE MONEY CAME FROM, which a short "bank" or
   * "cash" may answer through a continuation (G-68 Phase 2). */
  fundingQuestion?: boolean;
  /** The answer was a PREVIEW a "yes" confirms, not a question (G-23). */
  previewed?: boolean;
}> {
  /**
   * The link question rides a PREVIEW and nothing else. A clarification, an
   * answered query and a CG1 arithmetic question are all the wrong moment:
   * none of them ends in the `yes` that would confirm it.
   */
  const withLink = (preview: Reply): { reply: Reply; linkAsked: boolean; previewed: true } => {
    if (!link) return { reply: preview, linkAsked: false, previewed: true };
    return {
      reply: replies.preview(
        `${preview.text}\n\n${replies.linkQuestion(link.survivorToken, link.orphanToken)}`,
      ),
      linkAsked: true,
      previewed: true,
    };
  };
  const plain = (reply: Reply) => ({ reply, linkAsked: false });
  /* A preview with no customer to ask about: still a preview (G-23). */
  const shown = (preview: Reply) => ({ reply: preview, linkAsked: false, previewed: true });

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
  if (command.intent === 'Query') {
    const answered = await answerQuery(tx, businessId, command, receivedAt);
    return { ...plain(answered.reply), continuation: answered.continuation };
  }

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

    const paymentGate = gatePayment(command, invoice.invoiceNumber, invoice.balanceDueK, {
      customerLinked: invoice.customerId !== null,
    });
    if (paymentGate.gate === 'CG1') {
      return plain(replies.arithmeticQuestion(paymentGate.question));
    }
    const previewed = withLink(
      replies.preview(
        correcting
          ? `${replies.correctionTaken().text}\n\n${paymentGate.preview}`
          : paymentGate.preview,
      ),
    );
    /* An overpayment preview is a promise about specific figures; the draft
     * keeps them so `yes` can prove it is confirming what was shown. */
    if (paymentGate.creditK === 0) return previewed;
    return {
      ...previewed,
      confirmationContext: {
        kind: 'payment_overpayment',
        invoiceId: invoice.id,
        balanceShownK: invoice.balanceDueK,
        amountReceivedK: paymentGate.amountK,
        allocatedK: paymentGate.allocatedK,
        creditK: paymentGate.creditK,
      },
    };
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
    return shown(
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
      ? gateSale(command, {
          /* The preview promises customer credit for an overpayment only if
           * the sale will carry a customer record (G-49): the same lookup the
           * confirmation makes. */
          customerLinked:
            (await customerIdFor(tx, businessId, customerTokenOf(command as never))) !== null,
        })
      : command.intent === 'RecordExpense'
        ? gateExpense(command)
        : command.intent === 'RecordPurchase'
          ? gatePurchase(command)
          : null;
  if (!gate) return plain(replies.notYet('Recording that kind of entry'));

  if (gate.gate === 'CG1') {
    const asked = plain(replies.arithmeticQuestion(gate.question));
    /* Answered by sending the purchase again (funding source, ₦0): the
     * asking draft is retired so only the replacement is confirmable. */
    if (!('reason' in gate) || gate.reason === undefined) return asked;
    /* The funding-source question (G-61) may also be answered with a short
     * "bank" or "cash" (G-68 Phase 2): the caller opens a typed continuation
     * for it. A ₦0 amount is answered only by sending the purchase again. */
    return gate.reason === 'funding_source'
      ? { ...asked, retireDraft: true, fundingQuestion: true }
      : { ...asked, retireDraft: true };
  }

  /* A sale names a customer; an expense and a purchase do not. Only the first
   * ends in a `yes` that is about the person the question asks about. */
  const wrap = command.intent === 'RecordSale' ? withLink : shown;
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
  eventId: string,
  period: string,
  allowance: number,
): Promise<boolean> {
  /* The unit is recorded on the message in the SAME committed transaction
   * as the consume, so every later attempt knows exactly what this message
   * holds, in which month (G-57: the reservation's identity). */
  return withBusiness(deps.db, businessId, async (tx) => {
    const ok = await usageRepo.consumeUnit(tx, businessId, period, 'AI_ACTIONS', allowance);
    if (ok) await events.noteReservedUnit(tx, businessId, eventId, 'AI_ACTIONS');
    return ok;
  });
}

/** Does this message hold a unit of `unit`, taken by an earlier attempt? */
function holdsUnit(
  deps: InboundMessageDeps,
  businessId: string,
  eventId: string,
  unit: UsageUnit,
): Promise<boolean> {
  return withBusiness(deps.db, businessId, (own) =>
    events.holdsReservedUnit(own, businessId, eventId, unit),
  );
}

/**
 * Give back the `unit` this message holds, if it holds one: taken off the
 * message and refunded in one short transaction, so exactly once, in the
 * month it was taken, never for an attempt that took nothing.
 */
function giveBackUnit(
  deps: InboundMessageDeps,
  businessId: string,
  eventId: string,
  period: string,
  unit: UsageUnit,
  n = 1,
): Promise<void> {
  return withBusiness(deps.db, businessId, async (own) => {
    if (await events.takeReservedUnit(own, businessId, eventId, unit)) {
      await usageRepo.refundUnit(own, businessId, period, unit, n);
    }
  });
}

/**
 * Give back the message unit this message holds, if it holds one.
 *
 * Taken and refunded in the JOB's transaction: the refund commits only with
 * the attempt that answers, so an attempt that dies after refunding gives
 * nothing back and leaves the reservation for the next. Exactly once, in
 * the month it was taken, never below zero, never twice, and never for an
 * attempt that took nothing (G-57; replaces the earlier retry under-count).
 */
async function refundMessage(
  tx: TenantDb,
  businessId: string,
  eventId: string,
  period: string,
): Promise<void> {
  if (await events.takeReservedUnit(tx, businessId, eventId, 'AI_ACTIONS')) {
    await usageRepo.refundUnit(tx, businessId, period, 'AI_ACTIONS');
  }
}

function describeIntent(intent: DeterministicIntent): string {
  return intent.kind === 'number' ? `[number:${intent.value}]` : `[${intent.kind}]`;
}
