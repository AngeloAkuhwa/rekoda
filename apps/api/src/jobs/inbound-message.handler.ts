import { normaliseFacet } from '@rekoda/core/vault';
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
  clearlyCorrects,
  draftFigures,
  explicitlyCorrects,
  replacedFiguresFit,
  unnamedFiguresChanged,
  correctionHoldsOtherFigures,
  correctionWordsExplained,
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
  spendKindOf,
  spendTotalK,
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
  MoneyError,
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
import type {
  IdentityLinkProposal,
  LiveTokens,
  ResolvedCustomer,
  PrivacyGateway,
} from '../privacy/gateway.service.js';
import type { ReplySender, SendReplyInput } from '../replies/reply.service.js';
import type { PaymentIntentsService } from '../payments/payment-intents.service.js';
import { openPayload } from '../privacy/payload-vault.js';
import { neutraliseTokens, protectedSpans, redactForLog, STORED_BODY } from '@rekoda/core/privacy';
import { describeFailure, JobDeferred, type JobContext, type JobHandler } from './runner.js';
import { JobKind } from './queue.service.js';
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
import type { BillingEmailService } from '../billing/billing-email.service.js';

/** The MERCHANT thread identity, stated at the ingress (Appendix F.2).
 * This ingress hears the merchant talking to Rekoda; customer threads
 * arrive with their own stated identity when Integrate routing lands. */
const merchantThread = (businessId: string) =>
  ({ kind: 'MERCHANT', businessId, channel: 'meta' }) as const;

const paymentLog = new Logger('InboundMessageJob');
const authorisationLog = new Logger('InboundMessageJob');

/**
 * A voice note or photo an earlier run already answered and committed (a
 * reclaimed job, a redelivered webhook). It delivered, so what it holds
 * stays charged; only "nothing delivered" gives units back (final review).
 */
const ALREADY_ANSWERED = Symbol('already answered');

/**
 * Every string in a command with each provisional token swapped for the stored
 * one it became (G-135). The model may copy a token into any free-text field (a
 * description, a note), and a record must never keep a provisional token that
 * names nobody once this job ends.
 */
function withTokensReplaced<T>(value: T, replaced: ReadonlyMap<string, string>): T {
  if (replaced.size === 0) return value;
  if (typeof value === 'string') {
    let out: string = value;
    for (const [from, to] of replaced) out = out.split(from).join(to);
    return out as T;
  }
  if (Array.isArray(value)) return value.map((v) => withTokensReplaced(v, replaced)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, withTokensReplaced(v, replaced)]),
    ) as T;
  }
  return value;
}

/** The records that have a customer: the only ones a phone or email may become one for. */
const CUSTOMER_BEARING: ReadonlySet<string> = new Set([
  'RecordSale',
  'RecordPayment',
  'RecordOrder',
]);

/** Every string of a record except its `customer`, which is a reference, not words. */
function wordsOf(value: unknown, top = true): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((v) => wordsOf(v, false));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      top && k === 'customer' ? [] : wordsOf(v, false),
    );
  }
  return [];
}

/** Which of `candidates` appear in a record's words (owner review of #437). */
function tokensInWords(command: StructuredBusinessCommand, candidates: string[]): Set<string> {
  const words = wordsOf(command);
  return new Set(candidates.filter((t) => words.some((w) => w.includes(t))));
}

/** A record with `neutraliseTokens` applied to every string except its `customer`. */
function withWordsNeutralised<T>(
  value: T,
  keep: ReadonlySet<string>,
  placeholders: ReadonlyMap<string, string>,
  top = true,
): T {
  if (typeof value === 'string') return neutraliseTokens(value, keep, placeholders) as T;
  if (Array.isArray(value)) {
    return value.map((v) => withWordsNeutralised(v, keep, placeholders, false)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        top && k === 'customer' ? v : withWordsNeutralised(v, keep, placeholders, false),
      ]),
    ) as T;
  }
  return value;
}

/**
 * A balance read whose figures would not survive as exact kobo (a bigint past
 * 2^53: `MoneyError` from the repository) is answered, never rounded and
 * never left to kill the job: a retried job would buy the interpretation again
 * and the merchant would hear nothing (owner directive on #437).
 */
async function exactOrRefused<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof MoneyError) {
      paymentLog.error(`a balance could not be stated exactly: ${error.message}`);
      return null;
    }
    throw error;
  }
}

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
  /**
   * The business email's confirmation (OWN-83): "my email is X" on WhatsApp starts the same
   * mailed, single-use link the billing page sends. It never marks an address verified.
   */
  businessEmail: Pick<BillingEmailService, 'requestVerification'>;
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
     * charging an attempt. An older `delivery.status` job counts too (G-20):
     * a failed receipt queued before this message must unsee its preview
     * first, or a "yes" would confirm a draft the merchant never received.
     */
    if (await jobsRepo.hasEarlierLiveJob(tx, jobId, [JobKind.DeliveryStatus])) {
      throw new JobDeferred();
    }

    /* A failed-receipt job that exhausted its retries is dead and will never
     * run; apply it here, under the lock and before any "yes" is read, so the
     * preview it names is never left confirmable (G-20), and a trial reminder
     * it names reads 'undelivered' (REM-01). */
    const reconciled = await conversationsRepo.reconcileDeadReceipts(tx, businessId);
    if (reconciled > 0) log.warn(`applied ${reconciled} failed receipt(s) from dead jobs`);
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

    /* OWN-74: an answer waits for every earlier message still live, even one backing off after
     * a failure that `hasEarlierLiveJob` lets a request pass. If that message never succeeds it
     * dies and is reconciled below before this answer is read, so a lost "cancel" is never
     * overtaken by a "yes" sent while it retried. A voice note may say "yes" too and is not
     * heard until it is transcribed, so it waits the same way, before any provider is paid. */
    const answerRoute = typeof inbound.text === 'string' ? routeMessage(inbound.text) : null;
    const answerKind =
      answerRoute?.route === 'deterministic' &&
      ['affirm', 'deny', 'cancel', 'unsure'].includes(answerRoute.intent.kind)
        ? answerRoute.intent.kind
        : null;
    /* A short answer to a question Rekoda asked (the funding source, a period, a choice, "same or
     * separate") is an answer too: it cannot be told from a new request before it is read, so while
     * a clarification is open it waits behind an earlier live message the same way (CodeRabbit on
     * #428). With no question open, requests are not held up. */
    /* "cash", "bank", "same" or "separate" can answer a question whose continuation is no longer
     * open: a bare "same" or "separate" still answers a purchase held for its identity question
     * after another message retired that question's continuation (G-81). Those words wait on
     * their own, so a held purchase is never rebuilt past a retrying "cancel" (CodeRabbit on #428).
     * They are never a new request on their own, so nothing else is held up. */
    const answerWords =
      typeof inbound.text === 'string' &&
      (fundingSourceAnswer(inbound.text) !== null || purchaseIdentityAnswer(inbound.text) !== null);
    const mayAnswer =
      Boolean(answerKind) ||
      answerWords ||
      isVoiceNote(inbound) ||
      (await continuationsRepo.hasOpenClarification(tx, businessId, event.receivedAt));
    if (mayAnswer && (await jobsRepo.hasEarlierLiveJobByArrival(tx, jobId))) {
      throw new JobDeferred();
    }
    /* An earlier inbound message whose job died was never processed (owner ruling, 4 Nov 2026):
     * every draft pending then is retired here, under the lock and before any "yes" is read, so a
     * lost "cancel" can never be overtaken by a later "yes". Only a run that can go on to tell the
     * merchant does it: the early returns above must not consume the lost message silently (Qodo
     * on #428). Counts only, never content.
     *
     * It runs AFTER the live-message check above, not before (Codex on #428): a message that is
     * still live when that check runs defers the answer, and one that is dead or done by then is
     * read as dead here. Reconciling first left a window in which a stale job reclaimed as dead
     * between the two reads was seen as neither, and the answer proceeded. */
    const lost = await conversationsRepo.reconcileDeadInboundMessages(tx, businessId, jobId);

    /* Logged only once this run is going ahead: a deferral rolls the retirement back. */
    if (lost.messages > 0) {
      log.warn(
        `retired ${lost.drafts} draft(s) and ${lost.continuations} question(s) behind ${lost.messages} inbound message(s) whose job died`,
      );
    }
    /* OWN-74: the merchant is told that a waiting request was withdrawn. A typed "yes", "no" or
     * "cancel" is told by its own answer when that answer is about the withdrawn request; when it
     * is not (it answered a newer request, or returned before reaching it), the notice follows
     * the answer below, so a withdrawal is never silent. Any other message is told here, first.
     * A voice note is told here too, before it is heard, so it is told even if it cannot be
     * transcribed; a spoken "yes" or "no" then also gets its own answer. */
    if (
      (lost.drafts > 0 || lost.continuations > 0) &&
      answerKind !== 'affirm' &&
      answerKind !== 'deny' &&
      answerKind !== 'cancel'
    ) {
      await deps.replySender.send(tx, {
        businessId,
        to: inbound.from,
        reply: replies.earlierMessageLostNo(),
      });
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
    let read: { text: string; messageId: string; caption: string | null } | null = null;
    if (isVoiceNote(inbound)) {
      const heard = await transcribeVoiceNote(
        deps,
        tx,
        businessId,
        inbound,
        log,
        retrying,
        event.receivedAt,
        eventId,
      );
      if (heard === ALREADY_ANSWERED) {
        await events.markProcessed(tx, eventId, null, businessId);
        return;
      }
      if (refusedReading(heard)) {
        /* Refused inside and already marked new-or-not, but not yet answered:
         * the refusal is recorded below before its reply is sent. Nothing to
         * interpret and nothing to charge for: whatever an earlier attempt
         * of this message took goes back (G-57 final review B). Still the
         * newest thing this member said, so whatever was open for them is
         * retired (Build 6). */
        await releaseHeldUnits(deps, businessId, eventId, usagePeriod(event.receivedAt));
        await retireSenderContinuation(tx, businessId, inbound.from, event.receivedAt);
        await recordRefusal(
          deps,
          tx,
          businessId,
          heard.refusedIn,
          await actorOf(tx, businessId, inbound.from),
          '[voice note not read]',
          inbound.from,
        );
        await deps.replySender.send(tx, { businessId, to: inbound.from, reply: heard.reply });
        await events.markProcessed(tx, eventId, null, businessId);
        return;
      }
      spoken = heard;
    } else if (isReceiptPhoto(inbound)) {
      const seen = await readReceiptPhoto(
        deps,
        tx,
        businessId,
        inbound,
        log,
        retrying,
        event.receivedAt,
        eventId,
      );
      if (seen === ALREADY_ANSWERED) {
        await events.markProcessed(tx, eventId, null, businessId);
        return;
      }
      if (refusedReading(seen)) {
        /* Refused or failed before anything was delivered: whatever an
         * earlier attempt of this message took goes back. */
        await releaseHeldUnits(deps, businessId, eventId, usagePeriod(event.receivedAt));
        await retireSenderContinuation(tx, businessId, inbound.from, event.receivedAt);
        await recordRefusal(
          deps,
          tx,
          businessId,
          seen.refusedIn,
          await actorOf(tx, businessId, inbound.from),
          '[photo not read]',
          inbound.from,
        );
        await deps.replySender.send(tx, { businessId, to: inbound.from, reply: seen.reply });
        await events.markProcessed(tx, eventId, null, businessId);
        return;
      }
      read = seen;
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
        /* Recorded before the send, never after it: the send cannot be rolled back, and a write
         * after it that fails would roll this message back and answer it again on the retry
         * (CodeRabbit on #437 at ebeeadb). */
        await recordRefusal(
          deps,
          tx,
          businessId,
          recorded.id,
          await actorOf(tx, businessId, inbound.from),
          replies.onlyText().text,
          inbound.from,
        );
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
    /* G-78: words read off a photograph are document text, never a command.
     * A sign or a screenshot reading STOP or YES must not opt the merchant out
     * or confirm the waiting preview, so a photograph skips the deterministic
     * router and goes to the model path as an ordinary message. */
    const route: Route = read ? { route: 'model', reason: 'unrecognised' } : routeMessage(text);
    const tokenised =
      route.route === 'deterministic'
        ? null
        : /* Provisional (G-135): a phone or email nobody recorded creates no
           * customer until a record needs one, so a question never does. */
          await deps.gateway.tokenise(businessId, text, undefined, { provisional: true });

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
    /**
     * What the history keeps of a model-routed message: what it WAS, never
     * what it said (G-136, owner directive on #437, 20 Nov 2026).
     *
     * The tokenised text still holds any name nobody recorded, and the only
     * thing that could take one out was a scrub after a successful
     * interpretation, which replaced only the words the model returned and
     * never ran on a refusal, a failure, an `Unclear` or a supplier. Nothing
     * in production reads this column (the model is given only the current
     * message, in memory), so the text is not kept at all: a structural
     * placeholder, written in the job's own transaction, is all that ever
     * commits. The words live only in `safeText` while this job runs.
     */
    const stored =
      route.route === 'deterministic'
        ? describeIntent(route.intent)
        : tokenised!.unread
          ? tokenised!.text
          : spoken
            ? STORED_BODY.voice
            : read
              ? STORED_BODY.photo
              : STORED_BODY.text;
    const claimed = spoken?.messageId ?? read?.messageId ?? null;
    const message = claimed
      ? {
          id: claimed,
          isNew: await conversationsRepo.setInboundBody(tx, businessId, claimed, stored),
        }
      : await conversationsRepo.recordInbound(
          tx,
          {
            businessId,
            channel: 'meta',
            kind: 'text',
            body: stored,
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

    /* The gateway would not hand the message on (G-60, G-07): an unfinished
     * known-name pass could miss a stored name, and text still holding a
     * protected detail is refused by every model. No model reads it, no unit
     * is metered, and the merchant is told what to do. A photo's page or a
     * voice note's seconds, taken when it was read, go back: nothing was
     * recorded from it (Codex on #273). The provider-spend reservation stays. */
    if (tokenised?.unread) {
      await releaseHeldUnits(deps, businessId, eventId, usagePeriod(event.receivedAt));
      await retireSenderContinuation(tx, businessId, inbound.from, event.receivedAt);
      /* Recorded before the send: a write after it that failed would answer again on the retry
       * (independent review of #437 at 4480bc2). */
      await recordRefusal(
        deps,
        tx,
        businessId,
        message.id,
        await actorOf(tx, businessId, inbound.from),
        '[message not read]',
        inbound.from,
      );
      await deps.replySender.send(tx, {
        businessId,
        to: inbound.from,
        reply:
          tokenised.unread === 'too_long'
            ? replies.messageTooLong()
            : read
              ? replies.documentNotReadSafely()
              : replies.messageNotReadSafely(),
      });
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
      const kind = await deps.interpreter.classifyDocument(businessId, tokenised!.text, [
        ...tokenised!.tokens.keys(),
      ]);
      /* A refusal ends here too (OWN-98): the page one model declined is
       * never handed to another. Before the meter, as junk is, so this
       * attempt takes no message unit. But an earlier attempt may have
       * passed this gate, taken the message unit (committed on its own) and
       * rolled back (CodeRabbit and Codex on 1404dfb), so:
       *   - refused: nothing was understood or delivered, so everything the
       *     message holds goes back, the page unit included, as for any
       *     unreadable input (OWN-98; CodeRabbit and Codex on 0412af4);
       *   - junk: the page WAS understood (as not a business document) and
       *     keeps its unit (J7, docs/REKODA_LAUNCH_READINESS.md), but being
       *     told so never costs a message, so a held message unit goes back.
       * Each unit is taken off this message once, so a retry or redelivery
       * never refunds it twice. The read's bill and daily slot stay. */
      if (kind === 'junk' || kind === 'refused') {
        const period = usagePeriod(event.receivedAt);
        if (kind === 'refused') {
          await releaseHeldUnits(deps, businessId, eventId, period);
        } else {
          await giveBackUnit(deps, businessId, eventId, period, 'AI_ACTIONS');
        }
        await retireSenderContinuation(tx, businessId, inbound.from, event.receivedAt);
        /* Recorded before the send, as above (independent review of #437 at 4480bc2). */
        await recordRefusal(
          deps,
          tx,
          businessId,
          message.id,
          await actorOf(tx, businessId, inbound.from),
          '[photo not read]',
          inbound.from,
        );
        await deps.replySender.send(tx, {
          businessId,
          to: inbound.from,
          reply: kind === 'junk' ? replies.notABusinessDocument() : replies.couldNotRead(),
        });
        await events.markProcessed(tx, eventId, null, businessId);
        return;
      }
    }

    /* Mutable copy: a mention resolved during interpretation adds its token
     * here so the SAME table serves the outbound rehydration below. */
    const liveTokens: LiveTokens | null = tokenised
      ? {
          displays: new Map(tokenised.tokens),
          facets: new Map([...tokenised.facets].map(([token, typed]) => [token, [...typed]])),
          provisional: new Map(tokenised.provisional),
        }
      : null;

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
    /* G-78: a photograph does not answer a question Rekoda asked ("cash or
     * bank?"), so it never reaches the continuation step; whatever was open for
     * its sender is retired, as for any other new thing they send. */
    if (actorId && read) {
      await retireSenderContinuation(tx, businessId, inbound.from, event.receivedAt);
    }
    const continued =
      actorId && !read
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
            tokenised!.customers,
            inbound.from,
            liveTokens!,
            actorId,
            // Extracted-document text qualifies for dual extraction (item 9).
            read !== null,
            outcome,
            jobId,
            read?.caption ?? null,
          );

    if (answer) {
      const sent = await deps.replySender.send(tx, {
        businessId,
        to: inbound.from,
        reply: answer,
        // Only the model path can produce a reply that names a customer.
        ...(liveTokens ? { tokens: liveTokens.displays } : {}),
        /* G-20: the reply records which message it answered, so a delivery
         * that fails after acceptance finds this message's preview. */
        inReplyTo: message.id,
      });
      /* G-23: "previewed" means WhatsApp accepted the preview for delivery.
       * A preview whose send failed (swallowed so the draft survives) was
       * not sent. A delivery that fails later, after acceptance, comes back
       * as a `failed` status webhook (G-20): the `delivery.status` job then
       * marks this message's pending preview unseen, as below. Only that:
       * the continuations and re-asked holds undone below on a send-time
       * failure are rebuilt from this job's in-memory `outcome`, which a
       * webhook arriving later does not have. */
      /* A link question cut from a long preview was not asked: the
       * proposal goes, so a yes to what the merchant read never joins two
       * customers (G-60, Codex on #271). */
      if (sent.delivered) {
        /* #439 (OD-70 Option B): the identity question this reply asked or re-asked is now the
         * held purchase's latest, the only one whose late failed receipt withdraws it. */
        for (const heldId of new Set(
          [
            ...(outcome.heldDrafts ?? []),
            outcome.heldQuestion,
            outcome.refusedHeld?.draftId,
          ].filter((id): id is string => Boolean(id)),
        )) {
          await conversationsRepo.setHeldQuestionMessage(tx, businessId, heldId, message.id);
        }
        const proposal = identityLinkOf(
          await conversationsRepo.draftIdentityLink(tx, businessId, message.id),
        );
        if (
          proposal &&
          !(
            proposal.survivorToken &&
            proposal.orphanToken &&
            sent.shown?.includes(replies.linkQuestion(proposal.survivorToken, proposal.orphanToken))
          )
        ) {
          await conversationsRepo.clearDraftIdentityLink(tx, businessId, message.id);
        }
      }
      if (!sent.delivered) {
        /* The answer to a refusal never arrived: the refusal and the questions it closed are
         * put back, so the merchant's repeated yes is about the refusal again (Codex on #437). */
        if (outcome.closedByAnswer?.length) {
          await conversationsRepo.reopenClosedDrafts(tx, businessId, outcome.closedByAnswer);
        }
        /* The pointer back at a preview never arrived either: the question it retired is put
         * back, so the repeated yes is pointed again (CodeRabbit on #437 at 400ca58). */
        await conversationsRepo.reopenReadsRetiredBy(tx, businessId, message.id);
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
          /* Withdraws the replacement only: what it replaced stays superseded (OD-63(b)). */
          await conversationsRepo.undoReplacement(tx, businessId, message.id);
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

    /* OWN-74: a typed answer that did not itself report the withdrawn request (see above). */
    if (
      (lost.drafts > 0 || lost.continuations > 0) &&
      (answerKind === 'affirm' || answerKind === 'deny' || answerKind === 'cancel') &&
      !outcome.toldEarlierMessageLost
    ) {
      await deps.replySender.send(tx, {
        businessId,
        to: inbound.from,
        reply: replies.earlierMessageLostNo(),
      });
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
  /** A refusal this answer closed and the questions it retired: put back if the reply never
   * reached the merchant, so a repeated yes is still about the refusal (Codex on #437). */
  closedByAnswer?: string[];
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
  /** The held purchase this message's reply asked about again (any re-ask: after a no, a yes,
   * doubt or a "separate" that found a new match). Once WhatsApp accepts the reply it is the
   * hold's latest question (#439). */
  heldQuestion?: string;
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
  /** OWN-74: this message's answer was itself the notice that a waiting request was withdrawn
   * behind a lost message, so the handler sends no second one. */
  toldEarlierMessageLost?: boolean;
};

/** A recording somebody made with the microphone button, not an attached file. */
/**
 * The "all used" refusal, quoting what the merchant actually had this month:
 * the plan allowance PLUS any pack they bought (G-107). The meter lets a
 * counter reach `allowance + bonus`, so quoting the bare allowance told a
 * merchant with a pack they had used fewer than they had.
 */
async function exhaustedReply(
  db: Db,
  businessId: string,
  allowance: number,
  unit: UsageUnit,
  plan: string,
): Promise<Reply> {
  const bonus = await withBusiness(db, businessId, async (tx) => {
    const rows = await usageRepo.usageFor(tx, businessId, usagePeriod(new Date()));
    return rows.find((row) => row.unit === unit)?.bonus ?? 0;
  });
  /* A trial's allowance is one budget for its 14 days (G-109), never "this month". */
  return replies.allowanceExhausted(allowance + bonus, unit, plan === 'trial' ? 'trial' : 'month');
}

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
  extra?: { reason?: string; refusalCategory?: string | null },
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
        ...(extra?.refusalCategory === undefined ? {} : { refusalCategory: extra.refusalCategory }),
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
/**
 * A refusal or a failed reading, recorded as the sender's newest draft (owner
 * review of #437 at 3a60b0f): a pending `Unclear` marked `refused`, holding the
 * sentence only. A "yes" or a "no" right after it is about it, never about an
 * older preview (`isRefusalDraft`, `closeRefusalDraft`). Not a preview, and no
 * words of the merchant's or token is kept.
 */
async function recordRefusal(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  conversationMessageId: string,
  requestedBy: string | null,
  text: string,
  /** The sender, when the caller has not already established they may transact. */
  from?: string,
): Promise<void> {
  /* A member who may not change the books has nothing a "yes" could post, and
   * their refusal must touch nothing (G-57): no draft. */
  if (from !== undefined && !(await mayTransact(tx, businessId, from))) return;
  await conversationsRepo.recordDraft(tx, {
    businessId,
    conversationMessageId,
    intent: 'Unclear',
    command: { intent: 'Unclear', clarification: text, refused: true },
    model: deps.config.aiModelDefault,
    identityLink: null,
    previewed: false,
    confirmationContext: null,
    requestedBy,
    held: false,
    separateFrom: null,
  });
}

/**
 * The newest pending draft a "yes" or "no" from `from` can be about, past refusals that are
 * not theirs to answer (owner review of #437; CodeRabbit and Qodo on it):
 *  - another member's refusal is looked past and LEFT as it is, so it still guards that
 *    member's own older preview when they answer it;
 *  - the sender's own refusal is theirs to answer only while it is the last thing they
 *    recorded (`ownRefusal`); once they have recorded anything since, it is stale and is
 *    closed here.
 */
async function pastRefusals(
  tx: TenantDb,
  businessId: string,
  from: string,
  asOf: Date,
  /* `readOnly`: a scan that answers a doubt ("yes?") changes nothing, so the sender's stale refusal
   * is looked past, not closed (CodeRabbit on #437 at b2703e7). */
  options: { readOnly?: boolean } = {},
): Promise<{
  draft: conversationsRepo.DraftRow | null;
  ownRefusal: conversationsRepo.DraftRow | null;
  except: string[];
}> {
  const actor = await actorOf(tx, businessId, from);
  const except: string[] = [];
  /* The newest request a "yes" or "no" would reach, kept while the scan looks further back for the
   * sender's own refusal: another member's newer preview never stands in front of the refusal this
   * sender was last shown (CodeRabbit on #437). The scan stops at the sender's own request, which
   * is newer than any refusal of theirs behind it. */
  let first: conversationsRepo.DraftRow | null = null;
  for (;;) {
    const draft = await conversationsRepo.pendingDraftToAnswer(tx, businessId, { asOf, except });
    if (!draft) return { draft: first, ownRefusal: null, except };
    if (!conversationsRepo.isRefusalDraft(draft)) {
      first ??= draft;
      /* The sender's own request stops the scan only if they read it: one whose preview never
       * reached them is no answer to their refusal (the rule `hasDraftsAfterBy` applies), so the
       * scan goes on to that refusal and another member's newer preview is never booked by this
       * sender's yes (CodeRabbit on #437 at cacc734). */
      /* Nor is one whose reply's failed receipt is stored and not yet applied: it was never read
       * either (CodeRabbit on #437 at c5392f0). */
      if (
        actor !== null &&
        draft.requestedBy === actor &&
        (unseenRecord(draft) ||
          (await conversationsRepo.hasUnappliedFailedReceipt(tx, businessId, draft.id)))
      ) {
        except.push(draft.id);
        continue;
      }
      if (actor === null || draft.requestedBy === actor) {
        return { draft: first, ownRefusal: null, except };
      }
      except.push(draft.id);
      continue;
    }
    const mine = actor !== null && draft.requestedBy === actor;
    if (
      mine &&
      !(await conversationsRepo.hasDraftsAfterBy(tx, businessId, draft.id, actor, { asOf }))
    ) {
      return { draft: first ?? draft, ownRefusal: draft, except };
    }
    if (mine && !options.readOnly)
      await conversationsRepo.closeRefusalDraft(tx, businessId, draft.id);
    else except.push(draft.id);
  }
}

/** A record's preview the member never read (`hasDraftsAfterBy`'s rule): not previewed, not held. */
function unseenRecord(draft: conversationsRepo.DraftRow): boolean {
  return (
    !['Query', 'Unclear', 'EraseData'].includes(draft.intent) &&
    draft.previewed !== true &&
    draft.state !== 'held'
  );
}

/** What DELETE MY DATA erases, as recorded with the merchant's two asks (Appendix D). */
const ERASURE_CONSEQUENCE =
  'Every customer contact detail for this business, and the stored copies of its chat messages that Rekoda has finished processing, will be permanently deleted.';

/** What a voice note or photo reader answered instead of reading: a refusal, NOT yet sent. The
 * caller records the refusal first and sends `reply` after it: the send cannot be rolled back, and a
 * failed write after it would roll the message back and answer it again on the retry (CodeRabbit on
 * #437 at c5392f0). */
interface RefusedReading {
  readonly refusedIn: string;
  readonly reply: SendReplyInput['reply'];
}
const refusedReading = (value: unknown): value is RefusedReading =>
  typeof value === 'object' && value !== null && 'refusedIn' in value;

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
): Promise<
  | { text: string; messageId: string; caption: string | null }
  | RefusedReading
  | typeof ALREADY_ANSWERED
> {
  const recorded = await conversationsRepo.recordInbound(
    tx,
    {
      businessId,
      channel: 'meta',
      kind: 'media',
      body: STORED_BODY.photo,
      providerMessageId: inbound.externalId,
    },
    merchantThread(businessId),
  );
  /* A redelivered webhook must not read, meter and answer twice. */
  if (!recorded.isNew) return ALREADY_ANSWERED;

  const plan = await usageRepo.planFor(tx, businessId);
  if (plan === 'expired') {
    return { refusedIn: recorded.id, reply: await lapsedReply(tx, businessId, inbound.from) };
  }

  /* ENTITLEMENT BEFORE ANY PROVIDER IS TOUCHED (spec §4.3, rules 1 and 2).
   * Reading a receipt is a Chat capability. An Integrate-only merchant who
   * photographs one is refused here, which is before the media fetch and a
   * long way before the OCR engine: the refusal costs Rekoda nothing and
   * costs the merchant nothing, so there is no unit to give back. */
  if (await entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_CHAT')) {
    return { refusedIn: recorded.id, reply: replies.chatNotInPlan() };
  }

  /* AUTHORISATION BEFORE ANY PROVIDER IS TOUCHED (G-57, OWN-25). Today a
   * photographed document only ever becomes a sale, an expense, a purchase or
   * a payment, all of them changes to the books, so a member who may not
   * change them is refused before the image is downloaded, read, classified
   * or metered. Pinned to what photos do now: a photo feature that only reads
   * would need its own path, not this refusal. */
  if (!(await mayTransact(tx, businessId, inbound.from))) {
    /* A retry whose member was demoted after attempt 1 read the page gives
     * that page back: the request ends refused (Codex P2). */
    await giveBackUnit(deps, businessId, eventId, usagePeriod(receivedAt), 'DOCUMENTS_UNDERSTOOD');
    return { refusedIn: recorded.id, reply: replies.viewOnlyPhoto() };
  }

  let image;
  try {
    image = await deps.sender.fetchMedia(inbound.imageId!);
  } catch {
    log.warn('could not fetch a photograph from the provider');
    return { refusedIn: recorded.id, reply: replies.photoUnavailable() };
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
    return {
      refusedIn: recorded.id,
      reply:
        daily.refusedBy === 'business'
          ? replies.dailyDocumentLimit(dailyLimit)
          : replies.busyRightNow(),
    };
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
      const spent = await usageRepo.reserveUnit(
        own,
        businessId,
        period,
        'DOCUMENTS_UNDERSTOOD',
        allowance,
      );
      if (spent.granted) {
        await events.noteReservedUnit(
          own,
          businessId,
          eventId,
          'DOCUMENTS_UNDERSTOOD',
          spent.meter,
        );
      }
      return spent.granted;
    }));
  if (!granted) {
    // The plan refused after the day allowed: no provider was reached, so
    // the daily slot goes back too.
    await quotaRepo.releaseDocExtraction(deps.db, businessId);
    return {
      refusedIn: recorded.id,
      reply: await exhaustedReply(deps.db, businessId, allowance, 'DOCUMENTS_UNDERSTOOD', plan),
    };
  }

  let extracted;
  try {
    extracted = await deps.ocr.extract(image.bytes, image.mimeType);
  } catch (error) {
    /* Our failure, not the merchant's, so THEIR unit goes back. The image
     * is dropped here and goes nowhere else: no vision model, no retry
     * against a hosted engine, no exception "just this once". */
    const failure = error instanceof TextExtractionUnavailable ? error : null;
    /* Named for what happened (G-134 review N1): a refusal and an illegible
     * page both billed us, and only the provider being unreachable did not. */
    log.warn(
      failure?.refusal
        ? 'the vision engine declined the image'
        : failure?.usage
          ? 'the page had no legible text'
          : 'the OCR engine could not be reached',
    );
    if (failure?.usage) {
      /* The engine answered, billed us, and read nothing usable. Real
       * money: a priced row, and the daily slot stays counted — the
       * ceiling bounds spend, not success. A refusal (OWN-98) is recorded
       * as one, with its allow-listed category. */
      await recordVisionRead(deps, businessId, failure.usage, recorded.id, log, {
        reason: failure.refusal
          ? 'the vision engine declined the image'
          : 'the page had no legible text',
        ...(failure.refusal ? { refusalCategory: failure.refusal.category } : {}),
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
    return { refusedIn: recorded.id, reply: replies.photoUnavailable() };
  }

  /* WHAT THE READ COST, recorded whatever becomes of the text (item 7 of
   * the AI hardening plan; same contract as the interpreter's rows). Only
   * hosted engines report usage; a result with no usage envelope (a
   * stub) writes no row. `ocr_vision` matches the OCR cost class. */
  if (extracted.usage) {
    await recordVisionRead(deps, businessId, extracted.usage, recorded.id, log);
  }

  /* A member demoted while the page was being read is refused here, before
   * the paid document classifier, and the page goes back (Codex P2). */
  if (!(await mayTransact(tx, businessId, inbound.from))) {
    await giveBackUnit(deps, businessId, eventId, period, 'DOCUMENTS_UNDERSTOOD');
    return { refusedIn: recorded.id, reply: replies.viewOnlyRole() };
  }

  /* The caption is what the merchant TYPED, and it says what the photograph
   * is for. Kept in front of the extracted text so "this is my fuel receipt"
   * reaches the interpreter as the instruction it is. */
  const caption = inbound.caption?.trim();
  const text = caption ? `${caption}\n${extracted.text}` : extracted.text;
  return { text, messageId: recorded.id, caption: caption || null };
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
): Promise<
  { transcript: Transcript; messageId: string } | RefusedReading | typeof ALREADY_ANSWERED
> {
  const recorded = await conversationsRepo.recordInbound(
    tx,
    {
      businessId,
      channel: 'meta',
      kind: 'voice',
      body: STORED_BODY.voice,
      providerMessageId: inbound.externalId,
    },
    merchantThread(businessId),
  );
  /* A redelivered webhook must not transcribe, meter and answer twice. The
   * body is replaced with the transcript below only on the first pass. */
  if (!recorded.isNew) return ALREADY_ANSWERED;

  const plan = await usageRepo.planFor(tx, businessId);
  if (plan === 'expired') {
    return { refusedIn: recorded.id, reply: await lapsedReply(tx, businessId, inbound.from) };
  }

  /* ENTITLEMENT BEFORE ANY PROVIDER IS TOUCHED (spec §4.3, rules 1 and 2).
   * Speaking to Rekoda is a Chat capability, and an Integrate-only merchant
   * refused here never reaches the transcriber. Nothing was reserved, so
   * there is nothing to give back. */
  if (await entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_CHAT')) {
    return { refusedIn: recorded.id, reply: replies.chatNotInPlan() };
  }

  let audio;
  try {
    audio = await deps.sender.fetchMedia(inbound.audioId!);
  } catch {
    log.warn('could not fetch a voice note from the provider');
    return { refusedIn: recorded.id, reply: replies.voiceUnavailable() };
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
    return { refusedIn: recorded.id, reply: replies.voiceUnreadable() };
  }

  const maxSeconds = deps.config.voiceNoteMaxDurationSeconds;
  if (seconds > maxSeconds) {
    /* The commercial limit, enforced where it protects money rather than
     * where it merely reports it. Nothing is metered: the merchant did not
     * use anything, they were told to send it differently. */
    return { refusedIn: recorded.id, reply: replies.voiceTooLong(maxSeconds) };
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
    return {
      refusedIn: recorded.id,
      reply:
        dailyVoice.refusedBy === 'business' ? replies.dailyVoiceLimit() : replies.busyRightNow(),
    };
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
      const spent = await usageRepo.reserveUnit(
        own,
        businessId,
        period,
        'VOICE_MINUTES',
        allowance,
        seconds,
      );
      /* The seconds are recorded with the unit, so a give-back returns
       * exactly what was taken (G-57 final review B), and the meter row they
       * were spent on, so it returns them to that row. */
      if (spent.granted) {
        await events.noteReservedUnit(
          own,
          businessId,
          eventId,
          `VOICE_MINUTES:${seconds}`,
          spent.meter,
        );
      }
      return spent.granted;
    }));
  if (!granted) {
    // The plan refused after the day allowed: no provider was reached, so
    // the daily seconds go back too.
    await quotaRepo.releaseVoiceSeconds(deps.db, businessId, seconds);
    return {
      refusedIn: recorded.id,
      reply: await exhaustedReply(deps.db, businessId, allowance, 'VOICE_MINUTES', plan),
    };
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
    return { refusedIn: recorded.id, reply: replies.voiceUnavailable() };
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
    if (!(await mayTransact(tx, businessId, ctx.from))) {
      /* A yes an earlier attempt reserved for, refused now (the member was
       * demoted between attempts): it confirmed nothing, so what it reserved
       * goes back, in the month it was taken (final exact-head review). */
      await refundRecordedReservations(tx, businessId, ctx.eventId, usagePeriod(ctx.receivedAt));
      return replies.viewOnlyRole();
    }
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
    /* G-79: the no and the cancel carry the yes's role rule. They supersede
     * every pending draft, the owner's included, so a view-only member's no
     * would otherwise cancel a preview they may not confirm. */
    if (!(await mayTransact(tx, businessId, ctx.from))) return replies.viewOnlyRole();
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
    /* Another member's refusal is looked past, as for a "yes" (CodeRabbit on #437 at ebeeadb). */
    const answering = await actorOf(tx, businessId, ctx.from);
    let latest = await conversationsRepo.latestDraftToAnswer(tx, businessId, {
      asOf: ctx.receivedAt,
      skipRefusalsNotBy: answering,
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
        skipRefusalsNotBy: answering,
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
        skipRefusalsNotBy: answering,
      });
    }
    /* The last thing the merchant saw had already expired: this "no" is
     * about it, so nothing else is touched. A clarification or a question
     * that lapsed was never a preview, and is answered as before. */
    if (latest?.state === 'expired') {
      const lapsed = expiredAnswer(latest.command, latest.previewed, 'no');
      if (lapsed) return lapsed;
    }
    /* The request this "no" is about was withdrawn because an earlier message was lost. */
    if (latest?.retiredReason === conversationsRepo.INBOUND_MESSAGE_FAILED) {
      if (ctx.outcome) ctx.outcome.toldEarlierMessageLost = true;
      return replies.earlierMessageLostNo();
    }
    /* Build 6: every pending draft is still dropped, a question's included,
     * but only a request the merchant could have confirmed is reported as
     * cancelled. A "no" after nothing but a read gets what a "no" after
     * nothing gets. */
    /* A refusal is not a request (`refusedAs`). A bare "no" straight after the
     * sender's own refusal is about the refusal: it closes it, keeps whatever
     * waits behind it, and says so (CodeRabbit on #437). "cancel" still drops
     * everything, the refusal included, and never reports the refusal as
     * cancelled. Another member's refusal is looked past (`pastRefusals`). */
    const past = await pastRefusals(tx, businessId, ctx.from, ctx.receivedAt);
    if (past.ownRefusal) {
      /* Only a bare "no" is recoverable: its acknowledgement that never reached the merchant puts
       * the refusal back (OD-62(o)). "cancel" dismisses the refusal for good (owner rule, CodeRabbit
       * on #437), so it carries no recovery marker and is never offered to a send-failure restore:
       * neither a failed send nor a late failed receipt may reopen what the merchant cancelled. */
      if (intent.kind === 'deny') {
        await conversationsRepo.closeRefusalDraft(tx, businessId, past.ownRefusal.id, {
          answeredBy: ctx.messageId,
        });
        if (ctx.outcome) (ctx.outcome.closedByAnswer ??= []).push(past.ownRefusal.id);
      } else {
        await conversationsRepo.closeRefusalDraft(tx, businessId, past.ownRefusal.id);
      }
      if (intent.kind === 'deny') {
        const behind = await pastRefusals(tx, businessId, ctx.from, ctx.receivedAt);
        /* Pointing at a preview only a "yes" could save, and only while Chat stands (G-65). */
        if (behind.draft?.previewed === true && !(await withoutChat(tx, businessId))) {
          const member = await actorOf(tx, businessId, ctx.from);
          if (behind.draft.requestedBy !== member) {
            return replies.previewWaitingForAnotherMember();
          }
          /* As for a yes: the next yes is the one the reply promises saves it. */
          const retired = await conversationsRepo.retireReadsAfter(
            tx,
            businessId,
            behind.draft.id,
            { asOf: ctx.receivedAt, askedBy: member, forRefusal: past.ownRefusal.id },
          );
          if (ctx.outcome) (ctx.outcome.closedByAnswer ??= []).push(...retired);
          return (await conversationsRepo.hasReadsAfter(tx, businessId, behind.draft.id, {
            asOf: ctx.receivedAt,
          }))
            ? replies.previewBehindQuestion()
            : replies.previewBehindRefusal();
        }
        return (await withoutChat(tx, businessId))
          ? replies.nothingToDeclineWithoutChat()
          : replies.nothingToDecline();
      }
    }
    /* A retired question is closed only once the sender's own refusal has had its answer: a bare
     * "no" after it is about it (returned above), never about another member's funding question
     * asked since (CodeRabbit on #437 at ccdcc8e). "cancel" still drops everything. */
    const closedQuestion =
      latest?.state === 'abandoned'
        ? await conversationsRepo.closeRetiredDraft(tx, businessId, latest.id)
        : false;
    const cancellable = past.ownRefusal
      ? (await pastRefusals(tx, businessId, ctx.from, ctx.receivedAt)).draft
      : past.draft;
    /* Every pending draft, but never another member's refusal: it is theirs to answer and still
     * guards what they were shown (CodeRabbit on #437 at 3d66867). */
    await conversationsRepo.supersedePendingDrafts(tx, businessId, {
      asOf: ctx.receivedAt,
      skipRefusalsNotBy: await actorOf(tx, businessId, ctx.from),
    });
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
      /* The outcome too, so a re-ask from doubt is recorded as the hold's latest question and
       * undone like any other re-ask if it is never delivered (#439; CodeRabbit on #437). */
      return unsureReply(tx, businessId, ctx.receivedAt, {
        messageId: ctx.messageId,
        from: ctx.from,
        receivedAt: ctx.receivedAt,
        ...(ctx.outcome ? { outcome: ctx.outcome } : {}),
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
      /* The first ask must have shown the consequence that runs now, judged at this message's
       * arrival as the draft window is, never at a late worker's clock (CodeRabbit on #437 at
       * 0114957 and ce75a9e). One recorded with an older,
       * narrower one (before the erasure reached stored chat copies) is no agreement to this: this
       * ask becomes a new first ask below, shown and recorded under the current consequence, and
       * nothing is erased (CodeRabbit on #437 at 3d66867). */
      const askedBefore = paired
        ? (await riskRepo.openConfirmationsFor(tx, businessId, ctx.receivedAt)).filter(
            (c) => c.command === 'EraseData' && c.subject === `draft:${pending.id}`,
          )
        : [];
      /* And the first ask's prompt must have reached WhatsApp: a prompt whose send failed showed
       * the merchant nothing, so this ask is a new first ask (CodeRabbit on #437 at 58dd68b). */
      /* A first ask with no recorded consequence proves nothing was shown: one parked before the
       * recording became mandatory, or whose record is gone, is a new first ask too (CodeRabbit on
       * #437 at 56c4140). */
      const shownBefore =
        (!paired || askedBefore.some((c) => c.consequence === ERASURE_CONSEQUENCE)) &&
        (!paired ||
          (await conversationsRepo.draftReplyWasSent(tx, businessId, pending.id, {
            before: ctx.receivedAt,
          })));
      const claim =
        paired && shownBefore
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
        /* Judged at this message's arrival, as `askedBefore` was (OWN-102(7); CodeRabbit on #437 at
         * cacc734). A confirmation that lapsed by then authorises nothing, and none is opened in its
         * place: nothing is erased, and the merchant may ask again. */
        const confirmation = (
          await riskRepo.openConfirmationsFor(tx, businessId, ctx.receivedAt)
        ).find(
          (c) =>
            c.command === 'EraseData' &&
            c.subject === subject &&
            c.consequence === ERASURE_CONSEQUENCE,
        );
        if (!confirmation) return replies.erasureKept();
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
            memberPhone: ctx.from,
            now: ctx.receivedAt,
          },
          () => eraseDataWork(tx, { businessId, sourceType: 'chat' }),
        );
        if (run.outcome !== 'done') return replies.erasureKept();
        return replies.erasureDone(run.result.erased, deps.config.webUrl);
      }
      /* A first ask asked again under the current consequence is not a preview the merchant
       * loses: it is not counted as discarded. Another member's refusal is left theirs to answer,
       * as a bare "no" and a correction leave it (CodeRabbit on #437 at aff3f63). */
      const discarded =
        (await conversationsRepo.supersedePendingDrafts(tx, businessId, {
          asOf: ctx.receivedAt,
          skipRefusalsNotBy: await actorOf(tx, businessId, ctx.from),
        })) - (paired && !shownBefore ? 1 : 0);
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
          consequence: ERASURE_CONSEQUENCE,
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
      const debtors = await exactOrRefused(() => reportsRepo.debtorsFor(tx, businessId, 8));
      if (!debtors) return replies.balanceNotStated();
      /* Oldest promise first, with how late each one is: a debtors list is a
       * work queue, and a merchant standing in a shop needs to know who to
       * call before they need the total. */
      const now = new Date();
      return replies.wholeBusiness(
        replies.debtorList(
          debtors.rows.map((r) => ({
            invoiceNumber: r.invoiceNumber,
            balanceDueK: r.balanceDueK,
            daysOverdue: daysOverdue(r.dueDate, r.balanceDueK, now),
          })),
          debtors.totalK,
          debtors.count,
        ),
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
      return replies.wholeBusiness(replies.recordsSummary(overview));
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
    case 'business_email':
      return businessEmailReply(deps, tx, businessId, ctx.from, intent.email);
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
 * "my email is X" (OWN-83). The owner only: the business email is where customers' replies to
 * reminder emails go, so a helper or an accountant cannot point them elsewhere. Saving the address
 * and mailing the link is the billing-email service's (rate limits, the address limit across
 * businesses, an unknown send outcome); this only says what happened. The address is confirmed
 * only when the link is opened under the owner's dashboard session. The address itself is never
 * logged and never written to the conversation (`describeIntent`).
 */
async function businessEmailReply(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  from: string,
  email: string,
): Promise<Reply> {
  if (!(await isOwner(tx, businessId, from))) return replies.businessEmailOwnerOnly();
  const out = await deps.businessEmail.requestVerification(businessId, email);
  switch (out.state) {
    case 'sent':
      return replies.businessEmailLinkSent(out.maskedEmail);
    case 'delivery_uncertain':
      return replies.businessEmailLinkMaybeSent(out.maskedEmail);
    case 'already_verified':
      return replies.businessEmailAlreadyConfirmed(out.maskedEmail);
    case 'invalid_billing_email':
    case 'requires_billing_email':
      return replies.businessEmailInvalid();
    case 'rate_limited':
      return replies.businessEmailTryLater(Math.ceil(out.retryAfterSeconds / 60));
    case 'unavailable':
      return out.reason === 'address_unusable'
        ? replies.businessEmailUndeliverable()
        : replies.businessEmailUnavailable(out.reason);
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
function identityLinkOf(value: unknown): {
  survivorId: string;
  orphanId: string;
  survivorToken: string | null;
  orphanToken: string | null;
} | null {
  if (!value || typeof value !== 'object') return null;
  const link = value as {
    survivorId?: unknown;
    orphanId?: unknown;
    survivorToken?: unknown;
    orphanToken?: unknown;
  };
  return typeof link.survivorId === 'string' && typeof link.orphanId === 'string'
    ? {
        survivorId: link.survivorId,
        orphanId: link.orphanId,
        survivorToken: typeof link.survivorToken === 'string' ? link.survivorToken : null,
        orphanToken: typeof link.orphanToken === 'string' ? link.orphanToken : null,
      }
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
  for (const { unit, meter } of units) {
    await usageRepo.refundUnit(
      tx,
      businessId,
      usageRepo.storedMeter(meter, period),
      unit as UsageUnit,
    );
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
  /* Another member's refusal is looked past here exactly as `pastRefusals` looks past it below:
   * it never hides this member's own retired question (CodeRabbit on #437 at ebeeadb). */
  const answering = await actorOf(tx, businessId, sender.from);
  let latest = await conversationsRepo.latestDraftToAnswer(tx, businessId, {
    asOf: receivedAt,
    skipRefusalsNotBy: answering,
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
      skipRefusalsNotBy: answering,
    });
  }
  /* `abandoned` is only ever a retired purchase question; a draft the
   * merchant cancelled is `superseded` and is never asked again. Another member's question waits
   * behind the sender's own standing refusal: that refusal is what this yes is about, and it is
   * answered below (CodeRabbit on #437 at aff3f63). */
  if (
    latest?.state === 'abandoned' &&
    !(await ownRefusalBehindAnothers(tx, businessId, latest, answering, sender))
  ) {
    const reasked = await reaskRetiredQuestion(tx, businessId, latest, sender);
    if (reasked) return reasked;
    /* Never fall through to an older preview behind the question, even if
     * the stored question no longer gates (rules changed since). */
    return replies.nothingToConfirm();
  }
  /* The last thing the merchant was shown was withdrawn because an earlier message of theirs
   * was never processed (owner ruling, 4 Nov 2026): this "yes" is about it. Nothing is claimed
   * or metered, nothing older is reached behind it, and the merchant is told to send it again. */
  if (latest?.retiredReason === conversationsRepo.INBOUND_MESSAGE_FAILED) {
    if (retrying) {
      await refundRecordedReservations(tx, businessId, eventId, usagePeriod(receivedAt));
    }
    if (sender.outcome) sender.outcome.toldEarlierMessageLost = true;
    return replies.earlierMessageLostYes();
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

  let draft: conversationsRepo.DraftRow | null;
  /* The newest thing waiting is a refusal (`refusedAs`): this yes is about it
   * when it is the sender's own and still the last thing they recorded, so it
   * saves nothing and says whether a preview is still waiting. Another member's
   * refusal is looked past without being touched (`pastRefusals`). */
  {
    const past = await pastRefusals(tx, businessId, sender.from, receivedAt);
    if (past.ownRefusal) {
      await conversationsRepo.closeRefusalDraft(tx, businessId, past.ownRefusal.id, {
        answeredBy: sender.messageId,
      });
      if (sender.outcome) (sender.outcome.closedByAnswer ??= []).push(past.ownRefusal.id);
      if (retrying) {
        await refundRecordedReservations(tx, businessId, eventId, usagePeriod(receivedAt));
      }
      const behind = await pastRefusals(tx, businessId, sender.from, receivedAt);
      if (behind.draft?.previewed !== true) return replies.nothingToConfirm();
      /* A preview no "yes" could save while Chat is lapsed is never pointed at, whoever asked for
       * it (G-65; CodeRabbit on #437). */
      const access = chatDraftAccess(await chatStandingOf(tx, businessId));
      if (access !== 'allow') return chatRefusal(tx, businessId, access, 'draft');
      /* Another member's preview is theirs, never described as one this sender saw before their
       * refusal (CodeRabbit on #437). */
      const member = await actorOf(tx, businessId, sender.from);
      if (behind.draft.requestedBy !== member) {
        return replies.previewWaitingForAnotherMember();
      }
      /* The reply points at the preview and says a yes saves it, so it must: a question asked
       * before the refusal would otherwise take that next yes (CodeRabbit on #437 at 96b1b52).
       * Only this member's questions: another member's stays the barrier it is to their own next
       * yes, and the reply then says a question stands in the way (CodeRabbit at 0e12742). */
      const retired = await conversationsRepo.retireReadsAfter(tx, businessId, behind.draft.id, {
        asOf: receivedAt,
        askedBy: member,
        forRefusal: past.ownRefusal.id,
      });
      if (sender.outcome) (sender.outcome.closedByAnswer ??= []).push(...retired);
      return (await conversationsRepo.hasReadsAfter(tx, businessId, behind.draft.id, {
        asOf: receivedAt,
      }))
        ? replies.previewBehindQuestion()
        : replies.previewBehindRefusal();
    }
    draft = past.draft;
  }
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
      await conversationsRepo.retireNewestReadAfter(tx, businessId, draft.id, {
        asOf: receivedAt,
        retiredBy: sender.messageId,
      });
      if (retrying) {
        await refundRecordedReservations(tx, businessId, eventId, usagePeriod(receivedAt));
      }
      return replies.previewBehindQuestion();
    }
    /* Another member's refusal is theirs to answer, never claimed by this yes: looked past and
     * left as it is, exactly as `pastRefusals` does (independent review of #437 at ebeeadb). */
    const lookedPast: string[] = [];
    for (;;) {
      const newest = await conversationsRepo.pendingDraft(tx, businessId, {
        asOf: receivedAt,
        except: lookedPast,
      });
      if (newest && conversationsRepo.isRefusalDraft(newest) && newest.requestedBy !== answering) {
        lookedPast.push(newest.id);
        continue;
      }
      if (newest) draft = newest;
      break;
    }
  }

  /* A failed receipt is stored, not yet applied, for the pointer that stood in front of this preview
   * (past a question it retired, or past the member's own refusal it answered): it will put that
   * guard back, so this yes books nothing and is pointed again (CodeRabbit on #437). Answered, never
   * deferred: a deferred spoken yes would be transcribed and metered again on every re-run. */
  const pointerHeld = NOT_A_FINANCIAL_PREVIEW.has(draft.intent)
    ? null
    : await conversationsRepo.hasLivePointerReceipt(tx, businessId, draft.id, answering);
  if (pointerHeld) {
    if (retrying) {
      await refundRecordedReservations(tx, businessId, eventId, usagePeriod(receivedAt));
    }
    return pointerHeld === 'refusal'
      ? replies.previewBehindRefusal()
      : replies.previewBehindQuestion();
  }

  let command = draft.command as { intent?: string } & Record<string, unknown>;

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
      /* The row the unit was spent on, recorded with the reservation; taking
       * the record and refunding it are one step, so it goes back once. */
      const taken = await events.takeReservedUnit(own, businessId, eventId, unit);
      if (taken) {
        await usageRepo.refundUnit(
          own,
          businessId,
          usageRepo.storedMeter(taken.meter, period),
          unit,
        );
      }
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
      const spent = await usageRepo.reserveUnit(
        own,
        businessId,
        period,
        'DOCUMENT_GENERATION',
        allowance,
      );
      if (spent.granted) {
        await events.noteReservedUnit(own, businessId, eventId, 'DOCUMENT_GENERATION', spent.meter);
      }
      return spent.granted;
    });
    if (!granted)
      return exhaustedReply(deps.db, businessId, allowance, 'DOCUMENT_GENERATION', plan);
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
        const spent = await usageRepo.reserveUnit(
          own,
          businessId,
          period,
          'CATALOGUE_ORDERS',
          orderAllowance,
        );
        if (spent.granted) {
          await events.noteReservedUnit(own, businessId, eventId, 'CATALOGUE_ORDERS', spent.meter);
        }
        return spent.granted;
      });
      if (!orderGranted) {
        await refundReserved();
        return exhaustedReply(deps.db, businessId, orderAllowance, 'CATALOGUE_ORDERS', plan);
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
    /* A preview that never reached the merchant is not something a "yes"
     * confirms (G-20): nothing executes, and they are told to ask again. */
    if (claim.outcome === 'unseen') return replies.nothingToConfirm();
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
    const linked = await customersRepo.linkCustomers(
      tx,
      businessId,
      proposal.survivorId,
      proposal.orphanId,
    );
    /* A request naming the record this yes just absorbed names the one that
     * survived: the sale lands on a customer that exists, by id and by token
     * (G-60). A mention resolved to the new record always does. */
    if (
      linked &&
      proposal.survivorToken &&
      proposal.orphanToken &&
      customerTokenOf(command) === proposal.orphanToken
    ) {
      command = { ...command, customer: { kind: 'token', token: proposal.survivorToken } };
    }
  }

  if (command.intent === 'RecordExpense')
    return confirmExpense(deps, tx, businessId, draft.id, command, sender);
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
    return confirmPayment(deps, tx, businessId, sender.from, draft, command, refundReserved);
  }
  if (command.intent === 'AdjustInventory') {
    /* No document, so the unit this confirmation reserved goes back. A stock
     * count produces nothing to send and must not cost the merchant one of
     * the documents they are allowed to generate. */
    await refundReserved();
    return confirmStockChange(
      deps,
      tx,
      businessId,
      sender.from,
      draft.id,
      command as never,
      receivedAt,
    );
  }
  if (command.intent === 'RecordOrder') {
    return confirmOrder(
      deps,
      tx,
      businessId,
      sender.from,
      draft.id,
      command as never,
      refundReserved,
    );
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
        memberPhone: sender.from,
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
  /** The member who said yes, for the bus's role check (G-99). */
  memberPhone: string,
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
        memberPhone,
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
  /** The member who said yes, for the bus's role check (G-99). */
  memberPhone: string,
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
        memberPhone,
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
  /** The yes: who sent it (the bus's role check, G-99), and when (G-87). */
  sender: { messageId: string; from: string; receivedAt: Date; outcome?: RebuildOutcome },
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
   * whether the bus's gates wrap the call. Inside a SAVEPOINT (G-87): the
   * expense work refuses an expense that may be a stock purchase booked
   * since this preview was shown, before its posting, and the savepoint
   * takes back whatever the attempt wrote, as for a purchase (G-81). */
  let done: boolean;
  try {
    done = await tx.transaction(async (sp) => {
      if (deps.config.commandRecordExpense) {
        const run = await deps.commandBus.run(
          sp,
          {
            businessId,
            command: 'RecordExpense',
            payload: input,
            actor: 'system',
            ingress: 'CHAT',
            memberPhone: sender.from,
            idempotencyKey: `draft:${draftId}`,
          },
          () => recordExpenseWork(sp, input),
        );
        return run.outcome === 'done';
      }
      await recordExpenseWork(sp, input);
      return true;
    });
  } catch (error) {
    if (!(error instanceof PurchaseIdentityCollision)) throw error;
    return askAtRefusedYes(tx, businessId, draftId, error, sender, 'expense');
  }
  if (!done) return replies.notYet('Recording that expense');
  return replies.expenseSaved(gate.amountK, description);
}

/**
 * A yes the spend work refused (G-81, G-87): a record of the same total
 * that nothing proves separate was booked since the preview was shown. The
 * claim this yes made is turned into a held question in the same
 * transaction, so it never stands for something that was not booked, and
 * the member who said yes is asked "same or separate".
 */
async function askAtRefusedYes(
  tx: TenantDb,
  businessId: string,
  draftId: string,
  error: PurchaseIdentityCollision,
  sender: { messageId: string; from: string; receivedAt: Date; outcome?: RebuildOutcome },
  asking: 'purchase' | 'expense',
): Promise<Reply> {
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
  return replies.purchaseIdentityAtYes(
    identitySubject(error.match, actorId, asking),
    sender.receivedAt,
  );
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
            memberPhone: sender.from,
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
    return askAtRefusedYes(tx, businessId, draftId, error, sender, 'purchase');
  }
  if (!recorded) return replies.notYet('Recording that purchase');

  const landed = recorded.arrived[0];
  return landed
    ? replies.purchaseSaved(gate.amountK, recorded.owedK, landed)
    : replies.purchaseSaved(gate.amountK, recorded.owedK);
}

/**
 * The subject left by a question about a customer that was not answered with
 * figures (G-135): a balance with nobody in it. It supersedes any older open
 * read, and a balance has no period, so "last month" next resumes nothing
 * (`resumedRead`) and is read afresh, never widened to the business's totals.
 */
const NO_PERIOD_TO_RESUME: ContinuationState = {
  kind: 'query',
  topic: 'customer_balance',
  period: null,
  customerToken: null,
  documentRef: null,
};

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
    topic,
    period,
    customerToken,
    documentRef: null,
  });

  /* A customer named on a topic that has no figures per customer (G-135, owner
   * review of #437): "how much did Ada buy this month" must not be answered with
   * the whole business's sales as if they were hers. Only a balance is kept per
   * customer; anything else is asked again, never widened to the business. */
  /* "Who owes me, Ada?" filed as the debtors list is her balance. */
  const topic =
    command.topic === 'debtors' && command.customer?.kind === 'token'
      ? 'customer_balance'
      : command.topic;
  if (topic !== 'customer_balance' && command.customer?.kind === 'token') {
    return { reply: replies.customerFiguresNotKept(), continuation: NO_PERIOD_TO_RESUME };
  }

  switch (topic) {
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
        const subject = topic === 'sales_summary' ? 'sales' : 'spending';
        /* A window the merchant NAMED that core cannot draw ("yesterday",
         * "in March") gets its own honest sentence, never the bare question
         * that reads as if they said nothing. Either way the question stays
         * open, so "last month" next resumes it. */
        const uncountable = words !== '' && fromWords === null;
        return {
          reply: uncountable ? replies.periodNotCountable(subject) : replies.whichPeriod(subject),
          continuation: { kind: 'clarification', expects: 'period', topic: topic },
        };
      }
      return {
        reply: await answerPeriodQuery(tx, businessId, topic, period, now),
        continuation: subject(period),
      };
    }

    case 'debtors': {
      const debtors = await exactOrRefused(() => reportsRepo.debtorsFor(tx, businessId, 8));
      if (!debtors) return { reply: replies.balanceNotStated(), continuation: subject(null) };
      return {
        reply: replies.wholeBusiness(
          replies.debtorList(
            debtors.rows.map((r) => ({
              invoiceNumber: r.invoiceNumber,
              balanceDueK: r.balanceDueK,
              daysOverdue: daysOverdue(r.dueDate, r.balanceDueK, now),
            })),
            debtors.totalK,
            debtors.count,
          ),
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
      const owed = await exactOrRefused(() =>
        issueRepo.openInvoicesForCustomer(tx, businessId, token),
      );
      if (!owed) return { reply: replies.balanceNotStated(), continuation: subject(null) };
      return {
        reply: replies.customerBalanceAnswer(
          owed.rows.map((r) => ({ invoiceNumber: r.invoiceNumber, balanceDueK: r.balanceDueK })),
          owed.totalK,
          owed.count,
        ),
        /* The subject as its vault token, never the name: what a later
         * build needs to continue ("send it as PDF") about the same person,
         * with nothing a leak could read. No such follow-up is answered yet. */
        continuation: subject(null, CUSTOMER_TOKEN.test(token) ? token : null),
      };
    }

    case 'supplier_balances': {
      const overview = await reportsRepo.overviewFor(tx, businessId);
      return {
        reply: replies.wholeBusiness(replies.suppliersAnswer(overview.youOweK)),
        continuation: subject(null),
      };
    }

    case 'unreconciled': {
      const overview = await reportsRepo.overviewFor(tx, businessId);
      return {
        reply: replies.wholeBusiness(replies.unreconciledAnswer(overview.exceptionsOpen)),
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
  /* The whole business's figures, and the reply says so (OD-66 Option C, OWN-103(2)). */
  return replies.wholeBusiness(
    topic === 'sales_summary'
      ? replies.salesAnswer({ label: period.label, ...summary })
      : replies.expensesAnswer({ label: period.label, ...summary }),
  );
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
      { named: identity.asked.length, kinds: identity.asked.map((r) => r.kind ?? 'purchase') },
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
 * separate (two different catalogue-linked products: owner ruling D3).
 * Suppliers, quantity, raw names, wording and, since OWN-32 (G-92(5)),
 * document references are never proof. Read-only; the caller decides what to
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
   * 5bfe87e). Purchases only. */
  unseen: readonly string[];
  /** What the spend being checked is (G-87). */
  kind: 'purchase' | 'expense';
} | null> {
  /* A stock purchase or an expense (G-87): compared across the two kinds,
   * never expense with expense (core). */
  const kind = spendKindOf(input.stored);
  const amountK = spendTotalK(input.stored);
  if (kind === null || amountK === null) return null;
  let facts = await purchaseIdentityRepo.newPurchaseFacts(tx, businessId, {
    messageId: input.messageId,
    kind,
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
    withExpenses: true,
  });
  /* Ordered by message, so no upper bound by clock (fresh review of #262). */
  const window = {
    from: new Date(input.receivedAt.getTime() - PURCHASE_IDENTITY_WINDOW_SECONDS * 1000),
    to: null,
  };
  let verdict = purchaseIdentityVerdict(
    purchaseMatches(facts, records, input.receivedAt, window),
    input.actorId,
    kind,
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
        kind,
      );
    }
  }
  /* The sender's own undelivered drafts are compared exactly as any other
   * record (trusted products, a "separate" answer's line), and one is
   * replaced only when it is the SINGLE own draft that may be this purchase
   * and no waiting preview of theirs is being replaced already: two or more
   * coexist only because something set them apart, or were left from before
   * OWN-32 (final-head review of ffb5404). Otherwise they are left as they are, and the purchase work
   * at the yes still refuses a second booking. */
  const unseenRecords =
    input.actorId && kind === 'purchase'
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
  return { ...verdict, inheritFrom, unseen, kind };
}

/** What the merchant is told about a matching record: never a name. */
function identitySubject(
  record: PurchaseRecord,
  actorId: string | null,
  /** What the spend being asked about is (G-87). */
  asking: 'purchase' | 'expense' = 'purchase',
) {
  return {
    state: record.state,
    amountK: record.amountK,
    owner: ownerOf(record, actorId),
    bookedAt: record.bookedAt,
    billNumber: record.billNumber,
    kind: record.kind ?? 'purchase',
    asking,
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
  if (sender.outcome) sender.outcome.heldQuestion = heldId;
  return replies.purchaseIdentityReask({
    ...options,
    kind: spendKindOf(held.command) ?? 'purchase',
  });
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
  /* A held stock purchase or a held expense (G-87). */
  const kind = spendKindOf(command) ?? 'purchase';
  const amountK = spendTotalK(command);

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
      withExpenses: true,
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
      pointed ? identitySubject(pointed, actorId, kind) : null,
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
  const gate = kind === 'expense' ? gateExpense(command as never) : gatePurchase(command as never);
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
    if (message.outcome) {
      message.outcome.heldQuestion = heldId;
      message.outcome.reaskedHeld = { heldId, previous: again.previous };
    }
    await continuationsRepo.openContinuation(tx, {
      businessId,
      userId: actorId,
      sourceMessageId: message.messageId,
      state: { kind: 'clarification', expects: 'purchase_identity', draftId: heldId },
      now: message.receivedAt,
      expiresAt: again.expiresAt,
    });
    return replies.purchaseIdentityQuestion(
      identitySubject(verdict.ask, actorId, kind),
      message.receivedAt,
      {
        named: verdict.asked.length,
        newSince: true,
        kinds: verdict.asked.map((r) => r.kind ?? 'purchase'),
      },
    );
  }
  if (!(await conversationsRepo.releaseHeld(tx, businessId, heldId, { now: message.receivedAt }))) {
    return identityClosedReply(tx, businessId);
  }
  const draft = await conversationsRepo.recordDraft(tx, {
    businessId,
    conversationMessageId: message.messageId,
    intent: kind === 'expense' ? 'RecordExpense' : 'RecordPurchase',
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
  let shown = replies.separatePurchase(replies.preview(gate.preview), kind);
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
 * and the reply says so (a different total leaves it waiting, and the reply
 * says that too; references never set it apart since OWN-32); never across members, never for a rebuild with no
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
  sender: { messageId: string; from: string; receivedAt: Date; outcome?: RebuildOutcome },
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

  /* Read-only, and member-aware as a yes is: another member's refusal is looked past, never
   * touched (CodeRabbit on #437 at 96b1b52). */
  const doubting = await actorOf(tx, businessId, sender.from);
  let latest = await conversationsRepo.latestDraftToAnswer(tx, businessId, {
    asOf: receivedAt,
    skipRefusalsNotBy: doubting,
  });
  /* G-81: doubt about the identity question asks it again, from the member
   * who was asked; nobody else is held up by it. */
  if (latest?.state === 'held') {
    const asked = await askedAboutHeld(tx, businessId, latest.id, sender.from, sender.receivedAt);
    if (asked) return reaskPurchaseIdentity(tx, businessId, latest.id, asked, sender);
    latest = await conversationsRepo.latestDraftToAnswer(tx, businessId, {
      asOf: receivedAt,
      skipHeld: true,
      skipRefusalsNotBy: doubting,
    });
  }
  if (
    latest?.state === 'abandoned' &&
    !(await ownRefusalBehindAnothers(tx, businessId, latest, doubting, sender, { readOnly: true }))
  ) {
    return (
      (await reaskRetiredQuestion(tx, businessId, latest, sender)) ?? replies.nothingToConfirm()
    );
  }
  if (latest?.state === 'expired') {
    return expiredAnswer(latest.command, latest.previewed, 'yes') ?? replies.nothingToConfirm();
  }
  /* Close to the scan a plain yes makes (`pastRefusals`), read-only: another member's refusal is
   * looked past, and so is another member's newer request while the sender's own refusal may stand
   * behind it. Found behind another member's preview and still the last thing the sender recorded,
   * that refusal is what a plain yes would be about, so this answers as that yes does, never as an
   * invitation to send it (CodeRabbit on #437 at 0e12742). Where a plain yes would close the
   * sender's own refusal and point at a preview behind it, this still answers "nothing waiting"
   * (OD-62(p)); nothing is saved either way. */
  const lookedPast: string[] = [];
  let first: conversationsRepo.DraftRow | null = null;
  let pending = await conversationsRepo.pendingDraftToAnswer(tx, businessId, {
    asOf: receivedAt,
  });
  /* No bound the plain yes's scan lacks: each pass looks past one more draft, so it ends, and it
   * reaches the refusal `pastRefusals` reaches (CodeRabbit on #437 at 503acf3). */
  while (pending) {
    if (conversationsRepo.isRefusalDraft(pending)) {
      if (
        doubting !== null &&
        pending.requestedBy === doubting &&
        !(await conversationsRepo.hasDraftsAfterBy(tx, businessId, pending.id, doubting, {
          asOf: receivedAt,
        }))
      ) {
        if (first?.previewed === true) return replies.previewWaitingForAnotherMember();
        break;
      }
      if (pending.requestedBy === doubting && first === null) break;
    } else {
      first ??= pending;
      /* The sender's own record whose preview never reached them hides no refusal of theirs, as in
       * `pastRefusals`: the scan goes on, so this answers as a plain yes would (CodeRabbit on #437
       * at b2703e7). */
      const ownUnseen =
        doubting !== null && pending.requestedBy === doubting && unseenRecord(pending);
      if (!ownUnseen && (doubting === null || pending.requestedBy === doubting)) break;
    }
    lookedPast.push(pending.id);
    pending = await conversationsRepo.pendingDraftToAnswer(tx, businessId, {
      asOf: receivedAt,
      except: lookedPast,
    });
  }
  pending = first ?? pending;
  if (!pending?.previewed) return replies.nothingToConfirm();
  /* A question to the books asked since the preview: point back at the
   * preview, as a yes would, without retiring anything. */
  if (await conversationsRepo.hasReadsAfter(tx, businessId, pending.id, { asOf: receivedAt })) {
    return replies.previewBehindQuestion();
  }
  return replies.plainYesNeeded();
}

/**
 * Whether `retired` is another member's question with the sender's own refusal standing behind it,
 * so a yes or a doubt is about that refusal and never re-asks their question for the sender
 * (CodeRabbit on #437 at aff3f63).
 */
async function ownRefusalBehindAnothers(
  tx: TenantDb,
  businessId: string,
  retired: { requestedBy: string | null },
  sender: string | null,
  at: { from: string; receivedAt: Date },
  options: { readOnly?: boolean } = {},
): Promise<boolean> {
  if (!sender || retired.requestedBy === null || retired.requestedBy === sender) return false;
  return (await pastRefusals(tx, businessId, at.from, at.receivedAt, options)).ownRefusal !== null;
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
    /* The member who asked, as for an interpreted read, so their own refusal answer retires it
     * (CodeRabbit on #437 at c5392f0). */
    requestedBy: actorId,
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
 * The invoice is the one the PREVIEW showed (OD-57, OWN-101), read back by id
 * from what the draft recorded, never resolved afresh: a newer invoice issued
 * to the same customer before the "yes" would otherwise take the payment. Its
 * payable state is read AGAIN, because a provider payment or another reported
 * one may have landed since the preview: a balance that is not the one shown
 * is a stale confirmation and is asked again, here and under the row lock. A
 * draft with nothing recorded (previewed before this rule) is asked again too.
 */
async function confirmPayment(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  /** The member who said yes, for the bus's role check (G-99). */
  memberPhone: string,
  draft: { id: string; messageKind: string | null; confirmationContext?: unknown },
  command: Record<string, unknown>,
  refundDocumentUnit: () => Promise<void>,
): Promise<Reply> {
  const shown = parseConfirmationContext(draft.confirmationContext);
  if (shown === null) {
    await refundDocumentUnit();
    return replies.paymentPreviewOutOfDate();
  }
  const target = await issueRepo.shownInvoiceForPayment(tx, businessId, shown.invoiceId, {
    invoiceNumber: (command['documentRef'] as string | null) ?? null,
    customerToken: customerTokenOf(command),
  });
  if (target.outcome === 'settled') {
    await refundDocumentUnit();
    return replies.paymentAlreadySettled(target.invoiceNumber);
  }
  if (target.outcome === 'unavailable') {
    await refundDocumentUnit();
    return replies.paymentPreviewOutOfDate();
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
  let confirmedOverpayment: { expectedBalanceK: number } | null = null;
  if (shown.kind === 'payment_invoice') {
    /* OD-57: the preview's "Still owing after this" was computed from the
     * balance it showed. Any other balance, up or down, makes the preview
     * untrue, so nothing is written and they are asked again. The same check
     * runs again under the row lock (`expectedBalanceK`). */
    if (shown.balanceShownK !== invoice.balanceDueK || shown.amountShownK !== gate.amountK) {
      await refundDocumentUnit();
      return replies.paymentBalanceMoved(
        invoice.invoiceNumber,
        invoice.balanceDueK,
        Math.max(0, gate.amountK - invoice.balanceDueK),
      );
    }
  } else {
    if (
      shown.invoiceId !== invoice.id ||
      shown.amountReceivedK !== gate.amountK ||
      shown.balanceShownK !== invoice.balanceDueK
    ) {
      await refundDocumentUnit();
      /* With figures on the draft, the balance may have risen as well as
       * fallen (a reversed payment reopens it), so the reply names no cause;
       * with none, the preview was not an overpayment and the balance fell. */
      return replies.paymentBalanceMoved(invoice.invoiceNumber, invoice.balanceDueK, 0);
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
          memberPhone,
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
    ...(confirmedOverpayment
      ? { confirmedOverpayment }
      : { expectedBalanceK: shown.balanceShownK }),
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
        memberPhone,
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

/**
 * The words a draft holds about what it records: its items' names, never who and never the
 * model's free text (a `dueDescription` of "when Tunde comes" must not explain "make it 5
 * Tunde"; independent review of #437 at 4480bc2). What a correction's one free word may be.
 */
function draftVocabulary(command: Record<string, unknown>): string[] {
  const items = command['items'];
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => (item && typeof item === 'object' ? (item as { name?: unknown }).name : null))
    .filter((name): name is string => typeof name === 'string' && !/[A-Z]+_[0-9A-Z]+/u.test(name));
}

/** Whether `name` appears in `text` as whole words, ignoring case, spacing and composition. */
function typedIn(text: string, name: string): boolean {
  const fold = (v: string) => v.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
  const needle = fold(name);
  if (!needle) return false;
  /* A contact is not a name the merchant typed: an email (its local part included) and a link
   * are taken out first, so "ada@example.com" never counts as typing "Ada" (CodeRabbit on #437).
   * A removed contact also separates the words either side of it: each segment is searched on
   * its own, so "Ada ada@example.test Obi" never counts as typing "Ada Obi" (CodeRabbit on #437
   * at b497318). */
  return text
    .split(/\S+@\S+|https?:\/\/\S+/gu)
    .some((segment) => typedWithin(fold(segment), needle));
}

/** Whether the folded `needle` occurs in the folded `hay` as whole words. */
function typedWithin(hay: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : hay[at - 1]!;
    const after = hay[at + needle.length] ?? '';
    /* A combining mark continues the word it follows (CodeRabbit on #437 at 56c4140). */
    /* A hyphen joins a name ("Ada-Bola" is one name, as the gateway reads it), so a fragment of it
     * is no name typed (CodeRabbit on #437 at cacc734). */
    if (!/[\p{L}\p{N}\p{M}-]/u.test(before) && !/[\p{L}\p{N}\p{M}-]/u.test(after)) return true;
    from = at + 1;
  }
}

/** Whether a waiting draft names a customer or an invoice, so its clarification says it is kept. */
function draftNamesSomeone(
  stored: Record<string, unknown>,
  target: conversationsRepo.DraftRow,
): boolean {
  if (customerTokenOf(stored) !== null) return true;
  const ref = stored['documentRef'];
  return target.intent === 'RecordPayment' && typeof ref === 'string' && ref.length > 0;
}

/**
 * The labels a page puts in front of its buyer. Never a seller, supplier or delivery label: a
 * "Deliver to" contact or the merchant's own header is not who bought.
 */
/* A prepositional label ("Sold to", "Bill to") is a field only at the start of a line, or followed
 * by its colon or dash: "Not sold to Ada" inside a sentence labels nobody (CodeRabbit on #437 at
 * 9c587bd). The whole label: "Sold today" is no "Sold to" (CodeRabbit on #437 at b8330cd). */
const PREP_LABEL = String.raw`(?:(?:bill(?:ed)?|invoice(?:d)?|sold)\s+to|received\s+from)(?![\p{L}\p{N}\p{M}])`;
const BUYER_LABEL = new RegExp(
  String.raw`(?:(?:^|\n)[^\S\n]*${PREP_LABEL}[^\S\n]*[:\-\u2013]?|\b${PREP_LABEL}[^\S\n]*[:\-\u2013]|\b(?:customer(?:\s+name)?|buyer|client)\s*[:\-\u2013])[^\S\r\n]*`,
  'giu',
);
/* A single-word label ("Customer", "Buyer", "Client") counts only with its colon or dash: a heading
 * such as "Customer Support Ltd" labels nobody (CodeRabbit on #437 at ccdcc8e). */

/**
 * Whether a photographed page names `name` as its buyer: the caption the merchant typed names
 * them, or `name` opens the words right after one of the page's buyer labels ("Bill to: Bola Ige").
 * Any other name on the page (its header, the merchant's own business name, a supplier, a
 * delivery contact) is not the buyer, so the record is asked about (owner ruling 22 Nov 2026).
 */
function photoBuyerNamed(
  rawText: string,
  caption: string | null,
  names: readonly string[],
): boolean {
  /* A buyer the caption labels must agree with the page's: a caption that labels somebody else
   * contradicts the chosen customer (independent review on #437 at 5e5267c). */
  /* A caption field the merchant negates ("Not sold to: Ada Obi") rules that person out, so it is no
   * buyer field (Codex on #437 at 1ec5a22). */
  const fields = [
    ...pageBuyerFields(rawText, caption),
    ...(caption === null ? [] : buyerFieldsIn(caption.replace(NEGATED_BUYER, '\n'))),
  ];
  /* A caption can name the buyer directly. An email must match as a whole address. A name the
   * caption labels as somebody else ("Seller: Ada Obi") is no evidence of the buyer, so those
   * segments are taken out first, and the words either side of one never join into a name
   * (CodeRabbit on #437 at 600a155; independent review at 5e5267c). */
  /* A segment that rules somebody out ("Not sold to Ada Obi", "not for Ada") is no evidence
   * either: from its negation to the end of its clause it is taken out the same way (CodeRabbit on
   * #437 at 400ca58). A negation after the name ("Sold to Ada Obi, not paid yet") leaves it. */
  const typed =
    caption === null
      ? []
      : caption.split(NON_BUYER_SEGMENT).flatMap((part) => part.split(NEGATED_SEGMENT));
  if (
    names.some(
      (name) =>
        name.trim() &&
        typed.some(
          (part) =>
            /* A clause offering alternatives ("For Ada Obi or Bola Ige") selects nobody: the buyer
             * is ambiguous and asked about (OWN-103(4); CodeRabbit on #437 at c5392f0). */
            !ALTERNATIVE_BUYER.test(part) &&
            (name.includes('@') ? addressIn(part, name) : typedIn(part, name)),
        ),
    ) &&
    fields.every(
      (field) =>
        !ALTERNATIVE_BUYER.test(field.split(/[\n;]/u)[0] ?? '') &&
        names.some((name) => name.trim() && fieldNames(field, name)),
    )
  ) {
    return true;
  }
  /* Every field must name the buyer. Recorded names and contacts can be different facets of
   * the same issued token, while a field belonging to somebody else is contradictory. A field
   * offering alternatives ("Buyer: Ada Obi, or Bola Ige") names nobody: asked about (OWN-103(4);
   * Codex on #437 at e9b1cb4). */
  return (
    fields.length > 0 &&
    fields.every(
      (field) =>
        !ALTERNATIVE_BUYER.test(field.split(/[\n;]/u)[0] ?? '') &&
        names.some((name) => name.trim() && fieldNames(field, name)),
    )
  );
}

/**
 * Whether the caption the merchant typed carries a customer token this message was issued: a
 * recorded customer's name, phone or email, or a new phone or email (OD-72 Option A, owner ruling
 * 25 Nov 2026). Read with no customer, such a sale is asked about, never previewed as anonymous,
 * and nobody is created or attached. Only issued tokens count: an unrecorded name typed without a
 * label issues none, so no capitalised word is ever taken for a person (OD-66). A clause naming
 * another party ("Supplier: Ada Obi", "Deliver to …") or ruling the person out ("Not sold to Ada
 * Obi") is taken out first, as in `photoBuyerNamed`.
 */
function captionNamesIssuedCustomer(tokens: LiveTokens, caption: string | null): boolean {
  if (caption === null || !caption.trim()) return false;
  /* Only a negation that rules a buyer out ("Not sold to Ada", "not for Ada") is taken out here:
   * "Not paid yet Ada Obi" still names Ada (independent review of 42a2422). */
  const typed = caption
    .split(NON_BUYER_SEGMENT)
    .flatMap((part) => part.split(NEGATED_BUYER))
    .filter((part) => part.trim());
  if (typed.length === 0) return false;
  const issued = new Set([...tokens.displays.keys(), ...(tokens.provisional?.keys() ?? [])]);
  return [...issued].some((token) => {
    const facets = [
      ...(tokens.facets.get(token) ?? []),
      ...(tokens.provisional?.get(token) ? [tokens.provisional.get(token)!] : []),
    ];
    return facets.some(({ facet, value }) => {
      if (!value.trim()) return false;
      if (facet === 'phone') return typed.some((part) => phoneIn(part, value));
      return typed.some((part) =>
        value.includes('@') ? addressWithin(part, value) : typedIn(part, value),
      );
    });
  });
}

/**
 * A caption clause that rules a buyer out: "not sold to Ada", "wasn’t bought by Ada". A bare
 * "not for" is not one: "Not for credit Ada Obi" still names Ada, and "Not for Ada" is asked
 * about, which fails safe (second review of 42a2422..20a95c4).
 */
/* A word that offers a choice: "or", "either", "nor". */
const ALTERNATIVE_BUYER = /(?<![\p{L}\p{N}\p{M}])(?:or|either|nor)(?![\p{L}\p{N}\p{M}])/iu;
const NEGATED_BUYER =
  /\b(?:not|never|isn['’]?t|wasn['’]?t|didn['’]?t|no\s+longer)\s+(?:(?:sold|billed|invoiced|delivered)\s+to|bought\s+by)\b[^\n,;]*/giu;

/** Whether `text` holds the address `address` between non-address characters ("email:ada@…"). */
function addressWithin(text: string, address: string): boolean {
  const hay = text.toLowerCase();
  const want = address.trim().toLowerCase();
  if (!want) return false;
  for (let at = hay.indexOf(want); at >= 0; at = hay.indexOf(want, at + 1)) {
    const before = at === 0 ? '' : hay[at - 1]!;
    const after = hay.slice(at + want.length);
    if (/[\p{L}\p{N}._%+-]/u.test(before)) continue;
    if (/^(?:[\p{L}\p{N}_%+-]|\.[\p{L}\p{N}])/u.test(after)) continue;
    return true;
  }
  return false;
}

/**
 * Whether `text` holds the phone `phone`, however it is spaced or prefixed ("0803 555 1234",
 * "+234 803 555 1234"). Neighbouring digit groups ("… 1234 2 wigs") never join it: any run of
 * whole groups may be the phone. A run stops growing once it is longer than any written form of
 * the phone could be, so a caption of many digit groups is read in linear time (independent
 * review of 42a2422).
 */
function phoneIn(text: string, phone: string): boolean {
  const want = normaliseFacet('phone', phone);
  if (want.length < 7) return false;
  /* The longest written form: "+234" or "0234" in front, then the number. */
  const longest = want.length + 4;
  for (const run of text.matchAll(/\+?\d[\d \t().-]*/gu)) {
    const groups = run[0].split(/[^\d]+/u).filter(Boolean);
    for (let from = 0; from < groups.length; from += 1) {
      let digits = '';
      for (let to = from; to < groups.length; to += 1) {
        digits += groups[to];
        if (digits.length > longest) break;
        if (normaliseFacet('phone', digits) === want) return true;
      }
    }
  }
  return false;
}

/** The page without the caption the merchant typed in front of it. */
function pageOf(rawText: string, caption: string | null): string {
  return caption && rawText.startsWith(`${caption}\n`)
    ? rawText.slice(caption.length + 1)
    : rawText;
}

const foldField = (v: string) => v.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

/* A section or column heading just below an empty field is not its value. */
const RECEIPT_HEADING =
  /^(?:(?:(?:#|no\.?)\s+)?(?:items?|description|product)\s+(?:qty|quantity|unit|price|amount)\b|(?:(?:line )?items?|subtotal|total)\s*(?::|$|(?=\d))|(?:buyer|client|customer(?: name)?|(?:bill(?:ed)?|invoice(?:d)?|sold) to|received from|receipt|invoice|seller|supplier|merchant|date|payment)\s*[:#\-\u2013])/u;

/**
 * What each of a page's buyer labels holds: the first line with words after the label ("Bill
 * to:\nBola Ige" too). A heading on a following line belongs to a new receipt section.
 * A field can name a buyer by name, address or phone.
 */
function pageBuyerFields(rawText: string, caption: string | null): string[] {
  return buyerFieldsIn(pageOf(rawText, caption));
}

/** What each buyer label in `page` holds (see `pageBuyerFields`). */
function buyerFieldsIn(page: string): string[] {
  const fields: string[] = [];
  for (const label of page.matchAll(BUYER_LABEL)) {
    const lines = page.slice(label.index + label[0].length).split(/\r?\n/u);
    let after = foldField(lines.find((line) => line.trim()) ?? '');
    if (!lines[0]?.trim() && RECEIPT_HEADING.test(after)) continue;
    /* A contact heading after the label, on its line or the next ("Buyer: Tel: 0803…",
     * "Buyer:\nTel: 0803…"), is not the buyer's value: what follows it is, and an empty one holds
     * nothing (CodeRabbit and an independent review on #437 at 6b3fc05 and 600a155). A valued
     * contact still labels a buyer, so a sale read with nobody is asked about, never booked as
     * anonymous (OWN-103(4)). */
    const contact = CONTACT_HEADING.exec(after);
    if (contact) {
      after = after.slice(contact[0].length).trim();
      if (!after) {
        /* An empty heading's value may sit on the line below it ("Buyer: Tel:\n0803…", with or
         * without a name beside it): a line holding a phone or an address is that contact. On
         * the label's own line, an empty heading with nothing of the kind below still labels a
         * buyer, as it did before the heading was read there, so a sale read with nobody is
         * asked about; on the next line it leaves the field empty (independent reviews on #437
         * at 5e5267c and a4ba72d). */
        const at = lines.findIndex((line) => line.trim());
        const below = foldField(lines.slice(at + 1).find((line) => line.trim()) ?? '');
        const valued = /^e-?mail/u.test(contact[0])
          ? /\S@\S/u.test(below)
          : (/\+?\d[\d\s\-().]*\d/u.exec(below)?.[0] ?? '').replace(/\D/gu, '').length >= 10;
        /* A value that is no usable field ("• 0803…") falls back like no value at all. */
        if (valued && isFieldValue(below)) after = below;
        else if (lines[0]?.trim()) after = contact[0].trim();
        else continue;
      }
    }
    if (isFieldValue(after)) fields.push(after);
  }
  return fields;
}

/** Whether a folded field value can name a buyer: a word, an address or a phone. */
function isFieldValue(after: string): boolean {
  const first = after.split(/\s/u)[0] ?? '';
  return /^[\p{L}]/u.test(after) || first.includes('@') || leadingPhoneDigits(after).length >= 10;
}

/** Read the whole leading phone run, including any extra digits after separators. */
function leadingPhoneDigits(text: string): string {
  return (/^\+?[\d\s\-().]+/u.exec(text)?.[0] ?? '').replace(/\D/gu, '');
}

/** Whether one buyer field names `name`. */
function fieldNames(after: string, name: string): boolean {
  /* An address is the whole address in the field, never a prefix of a longer one
   * ("sales@example.test" is not "sales@example.test.ng"; CodeRabbit on #437 at cacc734). */
  if (name.includes('@')) return addressIn(after.split(/\s/u)[0] ?? '', name);
  /* An address is no name: "Ada" never names the buyer "ada@example.test" (CodeRabbit on #437 at
   * b2703e7). */
  if ((after.split(/\s/u)[0] ?? '').includes('@')) return false;
  const needle = foldField(name);
  if (/^\+?[\d\s\-().]+$/u.test(needle)) {
    const digits = leadingPhoneDigits(needle);
    return digits.length >= 10 && digits.length <= 15 && leadingPhoneDigits(after) === digits;
  }
  /* The whole name, not its first word: after it the field ends, or what follows is no more of a
   * name (a phone, a comma, the items). "Ada" is not the buyer "Ada Obi" (CodeRabbit on #437 at
   * aff3f63). */
  return (
    after.startsWith(needle) &&
    !/[\p{L}\p{N}\p{M}-]/u.test(after[needle.length] ?? '') &&
    (!/^\s+[\p{L}\p{M}]/u.test(after.slice(needle.length)) ||
      /* …unless it is the next field's label ("Bill to: Bola Ige Tel: …"; CodeRabbit on #437
       * at 88258dc). */
      NEXT_FIELD.test(after.slice(needle.length)))
  );
}

/** A caption segment that names somebody other than the buyer: "Seller: Ada Obi", "sold by Ada". */
const NON_BUYER_SEGMENT =
  /\b(?:seller|supplier|vendor|cashier|sales\s*(?:person|rep)|sold\s+by|served\s+by|issued\s+by|(?:deliver(?:y|ed)?|ship(?:ped)?)\s+to)\b\s*[:#\-\u2013]?[^\n,;]*/giu;

/** A caption clause from a negation to its end: "not sold to Ada", "never Ada's". */
/* The apostrophe as typed or as phone keyboards curl it ("wasn’t"; independent review of 55f4e22). */
const NEGATED_SEGMENT = /\b(?:not|never|isn['’]?t|wasn['’]?t|didn['’]?t|no\s+longer)\b[^\n,;]*/giu;

/** A contact heading at the start of a line, with its separator: "Tel:", "Email -". */
const CONTACT_HEADING = /^(?:tel|telephone|phone|mobile|whatsapp|email|e-mail)\b\.?\s*[:#-]\s*/iu;

/** A field label after a buyer's name on the same line: it ends the name. */
const NEXT_FIELD =
  /^\s+(?:tel|telephone|phone|mobile|whatsapp|email|e-mail|address|addr|date|invoice|inv|receipt|ref)\b\.?\s*[:#-]/iu;

/** Whether `text` holds the whole address `address`, ignoring case. */
function addressIn(text: string, address: string): boolean {
  const want = address.trim().toLowerCase();
  return (
    text
      .toLowerCase()
      /* Quotes delimit an address too ('For "ada@example.test"'); a longer address it only prefixes
       * still differs (CodeRabbit on #437 at 1ec5a22). */
      .split(/[\s,;()<>"'\u2018\u2019\u201C\u201D]+/u)
      .some((word) => word.replace(/[.:!?]+$/u, '') === want)
  );
}

/** Every value this message holds for `token`: its typed facets and any provisional contact. */
function facetValuesOf(tokens: LiveTokens, token: string): string[] {
  const values = (tokens.facets.get(token) ?? []).map((f) => f.value);
  const provisional = tokens.provisional?.get(token);
  return provisional ? [...values, provisional.value] : values;
}

function customerTokenOf(command: Record<string, unknown>): string | null {
  const customer = command['customer'] as { kind?: string; token?: string } | undefined;
  return customer?.kind === 'token' ? (customer.token ?? null) : null;
}

/**
 * What a correction carries over from the draft it corrects (CG5). Customer inheritance is
 * OWN-100 (owner ruling 21 Nov 2026); the `correctionMayChange` eligibility gate is OD-60 Option
 * A, implemented provisionally while that ruling is still to be recorded (CodeRabbit on #437 at
 * 56c4140).
 *
 * The model reads a correction from its own words and never sees an earlier turn, so "No, 4
 * not 3" names nobody. The customer comes from the TRUSTED pending draft, never from a token
 * the model wrote: a token this message was not issued is still refused by the G-137 guard
 * after this, so no earlier token is ever whitelisted.
 *
 * Every record read as a correction of a live waiting draft first passes `correctionMayChange`
 * (OD-60): one draft waiting, of the same kind, the member's own, nothing in front of it or since
 * its preview. Failing it, the correction is `unclear`: asked about,
 * superseding nothing. Passing it, the correction supersedes the draft. Only a sale, a payment or
 * an order the model read with no customer at all also keeps the draft's customer, and then the
 * draft must also be:
 *  - clearly corrected (`clearlyCorrects`: says what replaces what), not merely "no" or a "not";
 *  - previewed to the merchant;
 *  - with every word of the correction explained (`correctionWordsExplained`) and no customer
 *    token issued to the message;
 *  - with no earlier message of the business still retrying (`hasEarlierLiveJobByArrival`);
 *  - naming a customer this business holds (or, for a payment, an invoice).
 * Then the customer (and a payment's invoice reference, when the correction gives none) is
 * kept, the draft is superseded by the ordinary CG5 path, and the new preview needs its own
 * "yes". When a draft with a customer is waiting but any of that fails, the correction is
 * `unclear`: asked about, changing nothing. With nothing live waiting it is a new request
 * and inherits nobody. Read-only.
 */
type Inherited =
  /** Not a correction of anything waiting: a new request, superseding nothing. */
  | { readonly kind: 'none' }
  /** A correction of the waiting draft that keeps no customer: it supersedes that draft. */
  | { readonly kind: 'supersede' }
  /** A correction that supersedes the waiting draft but cannot keep its customer yet: asked. */
  | { readonly kind: 'withdraw' }
  /** Read as a correction, but which draft it changes, or how, is unclear: asked about. */
  | { readonly kind: 'unclear'; readonly ask: 'customer' | 'figure' | 'unnamed' | CorrectionBlock }
  | {
      readonly kind: 'inherit';
      readonly customer: { readonly token: string; readonly customerId: string } | null;
      readonly documentRef: string | null;
    };

/**
 * The one CG5 contract (OD-60): whether a message read as a correction may change the draft it is
 * about at all. Both outcomes of a correction, superseding the draft and keeping its customer, pass
 * it first, so the two can never disagree. The draft must be:
 *  - the only one waiting in the business (`answerableDraftCount`);
 *  - of the kind the model read this message as (a "No, 4 not 3" read as an expense never
 *    replaces a waiting sale);
 *  - this member's own (`requestedBy`), never another member's or an unattributed one;
 *  - with no refusal in front of it, and no question, refusal or other message since its preview
 *    (`hasReadsAfter`, `hasRefusalOrQuestionSince`, `hasInboundBetween`).
 * An earlier message still retrying does not stop a supersession: a "yes" retried after the
 * merchant corrected its preview then finds it superseded and books nothing (G-23). It does stop
 * a correction keeping the draft's customer (`correctionInheritance`). Read-only.
 */
/**
 * Why `correctionMayChange` refused, which decides what the merchant is told (independent review
 * of #437 at 42ed8bb): several requests waiting, another member's request, or anything else about
 * the member's one waiting request.
 */
type CorrectionBlock = 'several' | 'another' | 'correction';

async function correctionMayChange(
  tx: TenantDb,
  businessId: string,
  target: conversationsRepo.DraftRow,
  input: {
    command: StructuredBusinessCommand;
    actorId: string | null;
    receivedAt: Date;
    refusalInFront: boolean;
    messageId: string;
  },
): Promise<CorrectionBlock | null> {
  const { receivedAt } = input;
  /* Two or more previews waiting: which one this corrects is a question (OWN-100). Checked
   * first, so the reply never advises a "cancel" that would drop more than one request. */
  if ((await conversationsRepo.answerableDraftCount(tx, businessId, { asOf: receivedAt })) > 1) {
    return 'several';
  }
  if (input.actorId === null || target.requestedBy !== input.actorId) return 'another';
  const may =
    !input.refusalInFront &&
    /* A live draft the merchant was shown (OWN-102(1)): a preview that never reached them is no
     * request they can be correcting (CodeRabbit on #437 at cacc734). */
    target.previewed === true &&
    target.intent === input.command.intent &&
    !(await conversationsRepo.hasReadsAfter(tx, businessId, target.id, { asOf: receivedAt })) &&
    /* A refusal or a question since the preview, in any state: a "yes" that closed or retired it
     * leaves the preview waiting, never the barrier gone (CodeRabbit on #437). */
    !(await conversationsRepo.hasRefusalOrQuestionSince(tx, businessId, target.id, {
      asOf: receivedAt,
    })) &&
    /* Any message since the preview, a free question ("who owes me") included, which writes no
     * draft: the merchant thread shows it, whichever member sent it (CodeRabbit on #437). */
    !(await conversationsRepo.hasInboundBetween(tx, businessId, target.id, input.messageId));
  return may ? null : 'correction';
}

async function correctionInheritance(
  tx: TenantDb,
  businessId: string,
  input: {
    rawText: string;
    command: StructuredBusinessCommand;
    actorId: string | null;
    receivedAt: Date;
    fromDocument: boolean;
    /** This correction's own stored message. */
    messageId: string;
    /** This correction's own job; null only where no job runs it. */
    jobId: string | null;
    /** Whether the gateway issued this message any customer token, recorded or provisional. */
    namesSomeone: boolean;
  },
): Promise<Inherited> {
  const none = { kind: 'none' } as const;
  const { command, receivedAt } = input;
  /* G-78: words on a photograph are never a correction. Only a record corrects a record: a
   * reading the model could not make (`Unclear`) or a question is answered and leaves the preview
   * as it was (independent review of #437, OWN-100). */
  if (input.fromDocument || command.intent === 'Unclear' || command.intent === 'Query') return none;
  /* Wording first: it needs no draft, so an ordinary record skips the draft scan below while the
   * business lock is held (CodeRabbit on #437 at 56c4140). */
  if (!looksLikeCorrection(input.rawText, true)) return none;

  const except: string[] = [];
  let refusalInFront = false;
  let target: conversationsRepo.DraftRow | null = null;
  for (;;) {
    const draft = await conversationsRepo.pendingDraftToAnswer(tx, businessId, {
      asOf: receivedAt,
      except,
    });
    if (!draft || !conversationsRepo.isRefusalDraft(draft)) {
      target = draft;
      break;
    }
    refusalInFront = true;
    except.push(draft.id);
  }
  /* Nothing waiting, or its window closed (G-23): a new request, with nobody inherited. */
  if (!target || !target.expiresAt || target.expiresAt.getTime() <= receivedAt.getTime()) {
    return none;
  }

  const stored = (target.command ?? {}) as Record<string, unknown>;
  const bearing = CUSTOMER_BEARING.has(command.intent);
  const named = bearing && 'customer' in command ? command.customer : null;
  /* What the waiting draft holds that a correction naming nobody would keep. */
  const token = bearing && !(named && named.kind !== 'none') ? customerTokenOf(stored) : null;
  const ref = stored['documentRef'];
  const draftRef =
    /* The waiting draft's own reference, whatever the correction reads as: a sale correction to a
     * payment preview then fails the same-kind check and is asked about (CodeRabbit). */
    bearing &&
    !(named && named.kind !== 'none') &&
    target.intent === 'RecordPayment' &&
    typeof ref === 'string' &&
    ref.length > 0
      ? ref
      : null;

  const blocked = await correctionMayChange(tx, businessId, target, {
    command,
    actorId: input.actorId,
    receivedAt,
    refusalInFront,
    messageId: input.messageId,
  });
  /* Which request it changes, or whether it is a new one, is the question (OD-60). */
  if (blocked) return { kind: 'unclear', ask: blocked };

  /* Only a message that says it is a correction may replace the draft (OD-60 A+, owner ruling
   * OWN-102(2)): "no, it was Bola not Ada" and "No, 4 not 3" go on to the rules below. One whose only
   * cue is a hesitation ("Wait, I also sold 2 bags for 20k") is asked whether it changes the waiting
   * request or is a new record, and supersedes nothing, whatever the draft holds. */
  if (!explicitlyCorrects(input.rawText)) {
    return { kind: 'unclear', ask: draftNamesSomeone(stored, target) ? 'customer' : 'correction' };
  }

  /* A figure the correction says was wrong must be one the draft holds, read as money or as a
   * quantity (OD-67 Option B, fail closed; owner ruling OWN-103(3)): "4 not 3" beside a ₦5,000
   * expense says nothing about it, so it is asked about and changes nothing, whatever kind. */
  if (!replacedFiguresFit(input.rawText, draftFigures(stored))) {
    return { kind: 'unclear', ask: 'figure' };
  }
  /* Nor may it change a financial figure the merchant did not name (OD-76 Option A, OWN-107): a
   * reading of "No, 4 not 3" that also moves the payment is asked about, never previewed. */
  if (unnamedFiguresChanged(input.rawText, stored, command as unknown as Record<string, unknown>)) {
    return { kind: 'unclear', ask: 'unnamed' };
  }
  /* Nor may it carry a figure that belongs to something else (OWN-102(2)): "No, 4 not 3. Sold 2 bags
   * at 10k to someone else" holds a sale the replacement would drop, whether or not the waiting
   * draft names a customer, so it is asked about and nothing is replaced (CodeRabbit on #437 at
   * 156621f). */
  if (
    correctionHoldsOtherFigures(
      input.rawText,
      stored,
      command as unknown as Record<string, unknown>,
    )
  ) {
    return { kind: 'unclear', ask: draftNamesSomeone(stored, target) ? 'customer' : 'correction' };
  }

  /* A customer the correction names, by a name or by any token, is its own: a different one
   * is never overridden, and an unissued token is the G-137 guard's to refuse. */
  if (!bearing || (named && named.kind !== 'none')) return { kind: 'supersede' };

  const customerId = token ? await customerIdFor(tx, businessId, token) : null;
  /* The draft named a customer this business no longer holds by that token (merged since): asked
   * about, never turned into a sale to nobody. */
  if (token && !customerId) return { kind: 'unclear', ask: 'customer' };
  /* The draft named nobody: nothing to carry. An anonymous sale's correction is still held to the
   * words it may use: one whose words the draft does not explain ("No, 4 not 3. Sold 4 caps at 50k
   * to someone else") is asked about, so another sale it carries is never dropped when its figures
   * happen to be the draft's (independent review of #437 at a9b955a). With no customer to carry, a
   * spoken particle ("abeg", "please", "o") is no one's name and is set aside (review at f39710b). */
  if (!customerId && !draftRef) {
    const spoken = input.rawText.replace(
      /(?<![\p{L}\p{N}])(?:abeg|please|pls|plz|o|oh)(?![\p{L}\p{N}])/giu,
      ' ',
    );
    if (
      command.intent === 'RecordSale' &&
      !correctionWordsExplained(spoken, draftVocabulary(stored))
    ) {
      return { kind: 'unclear', ask: 'correction' };
    }
    return { kind: 'supersede' };
  }

  /* The model's own invoice number on a payment correction that names nobody cannot have come
   * from its words ("no, 60k not 50k"): only the draft's own, or none, is kept (independent review
   * of #437 at ebeeadb). Another one may be another customer's invoice. */
  const modelRef =
    command.intent === 'RecordPayment' && typeof command.documentRef === 'string'
      ? command.documentRef
      : null;
  const eligible =
    /* An explicit correction that is not clearly one of this draft ("No, I also sold 2 bags"): never
     * given the draft's customer. */
    clearlyCorrects(input.rawText) &&
    /* Somebody named in the correction's own words, recorded (a token) or not (a word the draft
     * does not hold), is never overridden by the draft's customer (OWN-100; CodeRabbit and the
     * independent review of #437 at ebeeadb). */
    !input.namesSomeone &&
    correctionWordsExplained(input.rawText, draftVocabulary(stored)) &&
    (modelRef === null || modelRef.length === 0 || modelRef === draftRef) &&
    target.previewed === true;
  /* An earlier message still retrying has no row for the checks in `correctionMayChange` to see,
   * so while one is live (or with no job to ask) the correction never inherits (owner review of
   * #437 at 49f2586). It still supersedes the draft it corrects, so a "yes" retried after it books
   * nothing the merchant corrected, and the merchant is asked for the record with its customer
   * (CodeRabbit on #437 at 1db1a0a). */
  /* Only a correction that is otherwise eligible: one that is not clearly a correction of this
   * draft ("No, I also sold 2 bags") is asked about below and leaves the preview alone, so a yes
   * the merchant sent before it still books what they confirmed (independent review of e40b95d). */
  if (
    eligible &&
    (input.jobId === null || (await jobsRepo.hasEarlierLiveJobByArrival(tx, input.jobId)))
  ) {
    return { kind: 'withdraw' };
  }
  /* Any draft that reaches here names a customer or an invoice: an ineligible correction is asked
   * about and never supersedes it (CodeRabbit on #437). */
  if (!eligible) return { kind: 'unclear', ask: 'customer' };
  return {
    kind: 'inherit',
    customer: token && customerId ? { token, customerId } : null,
    documentRef: draftRef,
  };
}

/**
 * What a customer the trusted draft named reads as in this reply: "The same customer as before",
 * never their stored name. Rehydrating a vault identity outside the authorised output layer is
 * forbidden (R12, `docs/safety-review.md`; CLAUDE.md invariant 4), and Rekoda's replies already
 * name stored customers by what the merchant typed or not at all ("who owes me" lists invoice
 * numbers). Nothing is decrypted, stored or sent to a model.
 */
export const INHERITED_CUSTOMER_DISPLAY = 'The same customer as before';

function noteInheritedCustomer(tokens: LiveTokens, token: string): void {
  tokens.displays.set(token, INHERITED_CUSTOMER_DISPLAY);
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
  /** Every customer the message referenced, for a link a mention reveals. */
  referenced: readonly ResolvedCustomer[],
  /** The sender's wa id, for the role check on write commands. */
  from: string,
  /**
   * The gateway's token table for THIS message, shared with the reply send.
   * A mention resolved below adds its token here, which is what lets the
   * preview say the customer's name over the wire while every stored copy
   * holds the token.
   */
  tokens: LiveTokens,
  /** The member who sent this (Build 6), or null for a sender with none. */
  actorId: string | null,
  /** True when this text was extracted from a photographed document. */
  fromDocument = false,
  /** What this reply did that a failed send must undo (G-68). */
  outcome?: RebuildOutcome,
  /** This message's own job, for the CG5 check that no earlier message is still live. */
  jobId: string | null = null,
  /** A photo's caption, the only words of a photo the merchant typed; null for any other. */
  documentCaption: string | null = null,
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
  if (plan === 'expired') {
    /* A retry after the plan lapsed: attempt 1's unit goes back. */
    await refundMessage(tx, businessId, eventId, usagePeriod(receivedAt));
    return lapsedReply(tx, businessId, from);
  }

  /* ENTITLEMENT BEFORE METER, and before the model is paid for (spec §4.3,
   * rules 1 to 3). An Integrate-only merchant holds the customer-facing half
   * and not this one, and refusing here means no unit is taken and no
   * provider is called — so there is nothing to refund and no path where the
   * meter can drift. */
  if (await entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_CHAT')) {
    await refundMessage(tx, businessId, eventId, usagePeriod(receivedAt));
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
      await refundMessage(tx, businessId, eventId, usagePeriod(receivedAt));
      return replies.viewOnlyRole();
    }
    asked = requestKind(safeText);
    if (asked !== 'read') {
      /* A member demoted between attempts may have left a unit on the
       * message from attempt 1; a refused request consumes nothing, so it
       * goes back, once (Codex P2). Nothing is held on a first attempt. */
      await refundMessage(tx, businessId, eventId, usagePeriod(receivedAt));
      return asked === 'write' ? replies.viewOnlyRole() : replies.viewOnlyAskAQuestion();
    }
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
  /**
   * A message that was not turned into a record is answered with a sentence,
   * and that sentence is the last thing the merchant read. It stands as their
   * newest draft, a pending `Unclear` marked `refused`, so a "yes" now is
   * about it and never confirms an older preview behind it (owner review of
   * #437: before this a "yes" after "I am very busy right now" or "I could not
   * tell which customer" posted the sale previewed before it). That "yes"
   * closes it, saves nothing and says whether a preview is still waiting; the
   * next "yes" is about that preview (`answerRefusal`). It carries the
   * sentence only, never the merchant's words or a token, and it is not a
   * preview.
   */
  const refusedAs = async (refusal: Reply): Promise<Reply> => {
    await recordRefusal(
      deps,
      tx,
      businessId,
      conversationMessageId,
      actorId ?? null,
      refusal.text,
      from,
    );
    return refusal;
  };

  const granted =
    (retrying && (await holdsUnit(deps, businessId, eventId, 'AI_ACTIONS'))) ||
    (await consumeMessage(deps, businessId, eventId, period, monthlyMessages));
  if (!granted) {
    return refusedAs(
      await exhaustedReply(deps.db, businessId, monthlyMessages, 'AI_ACTIONS', plan),
    );
  }

  const interpreted = await deps.interpreter.interpret(businessId, safeText, {
    ...(fromDocument ? { document: true } : {}),
    tokens: [...tokens.displays.keys()],
  });

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
    return refusedAs(
      interpreted.refusedBy === 'business'
        ? replies.quotaReachedForBusiness()
        : replies.busyRightNow(),
    );
  }
  if (interpreted.outcome === 'unavailable') return refusedAs(replies.busyRightNow());
  if (interpreted.outcome === 'unusable') return refusedAs(replies.couldNotRead());
  /* Two independent readers disagreed on a high-value document (item 9).
   * Nothing was drafted from either reading; the merchant states the
   * figures and the typed sentence walks the ordinary confirm gate. The
   * message unit was already refunded above with the other non-command
   * outcomes. */
  if (interpreted.outcome === 'disagreement') {
    return refusedAs(replies.extractionDisagreement(interpreted.fields));
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
  let nameNotKnown = false;
  /** The second facet PR #77 asks about, created only once the question is asked. */
  let pendingBeside: string | null = null;
  /**
   * A phone or email nobody recorded stood as a provisional token (G-135).
   *
   * A question names nobody by it: it is answered as unknown and creates
   * nothing (BA-OD-3). A record is checked first (G-137: a provisional token is
   * one this message issued, an invented one is refused below and creates
   * nobody). Only a record that names a customer, or carries a provisional
   * token in any of its fields, needs them: those are found or created now,
   * exactly as the gateway used to do for every message, and every field of
   * the command carries the stored token instead: a number a record keeps in
   * its words is kept in the vault, never as plaintext in the books. A record
   * whose fields never carry the token (the model wrote "plumber", not the
   * number), a question and an unclear message create nobody.
   */
  if (tokens.provisional?.size) {
    const asked = command.intent === 'Query' ? command.customer : null;
    if (asked?.kind === 'token' && tokens.provisional.has(asked.token)) {
      nameNotKnown = true;
      command = { ...command, customer: { kind: 'none' } } as StructuredBusinessCommand;
    }
  }
  /**
   * CG5: a correction that names nobody keeps the customer of the draft it corrects, taken
   * from that trusted draft and never from the model (owner ruling 21 Nov 2026,
   * `correctionInheritance`). Decided before the G-137 guard below, which still refuses any
   * token this message was not issued. An unclear correction is asked about: nothing is
   * superseded or drafted, and the unit goes back as for any refused request.
   */
  /* Carried from the trusted draft for the record's `customer` only, never allowed in its words. */
  let inheritedToken: string | null = null;
  /* Whether this message corrects, and so supersedes, the waiting draft (CG5, OD-60): decided once,
   * by `correctionInheritance`, so supersession and inheritance can never disagree. */
  let correcting = false;
  {
    const carried = await correctionInheritance(tx, businessId, {
      rawText,
      command,
      actorId,
      receivedAt,
      fromDocument,
      messageId: conversationMessageId,
      jobId,
      namesSomeone: tokens.displays.size > 0 || (tokens.provisional?.size ?? 0) > 0,
    });
    if (carried.kind === 'unclear') {
      await refundMessage(tx, businessId, eventId, period);
      return refusedAs(
        carried.ask === 'customer'
          ? replies.correctionCustomerNotClear()
          : carried.ask === 'several'
            ? replies.correctionNotClearSeveral()
            : carried.ask === 'another'
              ? replies.correctionForAnotherMember()
              : carried.ask === 'figure'
                ? replies.correctionFigureNotInDraft()
                : carried.ask === 'unnamed'
                  ? replies.correctionChangedUnnamedFigure()
                  : replies.correctionNotClear(),
      );
    }
    if (carried.kind === 'withdraw') {
      /* A window that closed is closed first, so a later yes about it is told it expired (G-23). */
      await conversationsRepo.expireStaleDrafts(tx, businessId, { now: receivedAt });
      await conversationsRepo.supersedePendingDrafts(tx, businessId, {
        asOf: receivedAt,
        skipRefusalsNotBy: actorId,
      });
      await refundMessage(tx, businessId, eventId, period);
      return refusedAs(replies.correctionWithdrawn());
    }
    correcting = carried.kind !== 'none';
    if (carried.kind === 'inherit') {
      if (carried.customer) {
        noteInheritedCustomer(tokens, carried.customer.token);
        inheritedToken = carried.customer.token;
        command = {
          ...command,
          customer: { kind: 'token', token: carried.customer.token },
        } as StructuredBusinessCommand;
      }
      if (carried.documentRef && command.intent === 'RecordPayment' && !command.documentRef) {
        command = { ...command, documentRef: carried.documentRef };
      }
    }
  }
  /**
   * A record names a customer only by a token this message was issued (G-137).
   *
   * The model sees tokens as opaque and only ever this message's: the
   * gateway's output (stored or provisional), or a name resolved below. Any
   * other well-formed token is one the model made up or copied, and it may
   * belong to another real customer of this business, so a payment preview
   * would point at their invoice and a "yes" would post it there. Token syntax
   * is not authority: nothing is drafted or created, the unit goes back as for
   * any refused request, and the merchant is asked to say who.
   */
  if (
    command.intent !== 'Query' &&
    'customer' in command &&
    command.customer?.kind === 'token' &&
    !tokens.displays.has(command.customer.token)
  ) {
    authorisationLog.warn(`${command.intent} carried a customer token this message was not issued`);
    await refundMessage(tx, businessId, eventId, period);
    return refusedAs(replies.customerNotRecognised());
  }
  /* A recorded customer, or a phone or email, found anywhere on a photographed page is issued a
   * token, but being on the page does not make them the buyer: only one the caption types or the
   * page labels as the buyer is (owner ruling 22 Nov 2026 on photo-extracted customer names). */
  if (
    fromDocument &&
    command.intent !== 'Query' &&
    'customer' in command &&
    command.customer?.kind === 'token' &&
    !photoBuyerNamed(rawText, documentCaption, facetValuesOf(tokens, command.customer.token))
  ) {
    authorisationLog.warn(`${command.intent} named a buyer the photo does not label`);
    await refundMessage(tx, businessId, eventId, period);
    return refusedAs(replies.customerNotRecognised());
  }
  /* A page that labels a buyer, read with no customer, is not an anonymous sale: the receivable
   * would lose its owner. Only a page that labels nobody is (OWN-103(4); CodeRabbit on #437 at
   * 4a5fd80). */
  if (
    fromDocument &&
    CUSTOMER_BEARING.has(command.intent) &&
    'customer' in command &&
    command.customer?.kind === 'none' &&
    (pageBuyerFields(rawText, documentCaption).length > 0 ||
      /* A buyer the caption labels is as much a buyer as one the page labels (CodeRabbit on #437
       * at 600a155). */
      (documentCaption !== null && buyerFieldsIn(documentCaption).length > 0) ||
      /* A caption that carries a customer token this message was issued names a buyer the
       * model left out (OD-72 Option A, owner ruling 25 Nov 2026). */
      captionNamesIssuedCustomer(tokens, documentCaption))
  ) {
    authorisationLog.warn(`${command.intent} named no buyer on a page that labels one`);
    await refundMessage(tx, businessId, eventId, period);
    return refusedAs(replies.customerNotRecognised());
  }
  /**
   * Which of this message's provisional phones and emails become customers
   * follows what the record MEANS, never where the model put the token (owner
   * review of #437 at 3a60b0f). Only a sale, a payment and an order have a
   * customer, and only their `customer` is one:
   *  - the record's own customer, typed as a phone or email, is created;
   *  - a second facet typed beside that customer, and placed in none of the
   *    record's words, is created only where PR #77's owner rule asks about it
   *    in the preview ("same customer?"): a real split, exactly two people in
   *    the message, at least one of them new, and only once the preview that
   *    carries the question is really the answer (`pendingBeside`, after
   *    `acknowledge`). An arithmetic question, a "which invoice?" or any other
   *    answer asks nothing, so it creates nothing (independent review of the
   *    owner review's fixes). Anywhere else nobody would be asked, so nobody
   *    is created;
   *  - every other phone or email (an expense's plumber, a supplier, a
   *    contact in an order's note, forwarded text) creates nobody, and the
   *    record's words keep "[phone]" or "[email]" in its place: no number in
   *    the books, no token that would mean nothing once this job ends.
   * A customer token in a record's words that this message was not issued
   * reads "[customer]" (`neutraliseTokens`): it may be another real
   * customer's, and must never resolve to them later.
   */
  const customer = 'customer' in command ? command.customer : null;
  /* Count identities before any provisional contact is materialised or dropped. A third
   * contact still rules out a link even if the record will never need that contact. */
  const people =
    referenced.length + (tokens.provisional?.size ?? 0) + (customer?.kind === 'mention' ? 1 : 0);
  if (command.intent !== 'Query' && command.intent !== 'Unclear') {
    const provisional = tokens.provisional ?? new Map();
    const bearing = CUSTOMER_BEARING.has(command.intent) && customer && customer.kind !== 'none';
    const own =
      bearing && customer.kind === 'token' && provisional.has(customer.token)
        ? customer.token
        : null;
    const inWords = tokensInWords(command, [...provisional.keys()]);
    const beside = bearing
      ? [...provisional.keys()].filter((t) => t !== own && !inWords.has(t))
      : [];
    const besideFacet = beside.length === 1 ? provisional.get(beside[0]!)?.facet : undefined;
    /* PR #77's rule as `proposeLink` and `linkAfterMention` apply it: beside a
     * name the merchant typed, only a phone can be asked about (the new name is
     * the orphan, a phone the survivor), and only when the name is new. */
    /* On a photo, a phone or email printed on the page beside the buyer (the seller's own, a
     * delivery contact's) is nobody's until the page labels it as the buyer's or the caption types
     * it: never asked about, so never created (owner ruling OWN-102(6); independent review of #437
     * at ccdcc8e). It stays a placeholder in the record's words. */
    const besideValue = beside.length === 1 ? provisional.get(beside[0]!)?.value : undefined;
    const asked =
      besideFacet !== undefined &&
      people === 2 &&
      (!fromDocument ||
        (besideValue !== undefined && photoBuyerNamed(rawText, documentCaption, [besideValue]))) &&
      (customer?.kind !== 'mention' ||
        (besideFacet === 'phone' &&
          !(await deps.gateway.findMention(businessId, customer.mention))));
    const needed = new Set<string>(own ? [own] : []);
    const placeholders = new Map<string, string>(
      [...provisional]
        .filter(([t]) => !needed.has(t) && !(asked && t === beside[0]))
        .map(([t, { facet }]) => [t, facet === 'email' ? '[email]' : '[phone]']),
    );
    let recordCustomer: ResolvedCustomer | undefined;
    if (needed.size > 0) {
      const made = await deps.gateway.materialise(businessId, tokens, needed);
      const fresh = made.resolved.filter(
        (c) => !referenced.some((r) => r.customerId === c.customerId),
      );
      referenced = [...referenced, ...fresh];
      recordCustomer = made.resolved[0];
      if (!asked && people === 2) link ??= deps.gateway.linkFor(referenced);
      command = withTokensReplaced(command, made.replaced);
    } else if (customer?.kind === 'token') {
      recordCustomer = referenced.find((r) => r.token === customer.token);
    }
    for (const t of [...provisional.keys()]) if (!(asked && t === beside[0])) provisional.delete(t);
    if (asked) {
      const asking = beside[0]!;
      pendingBeside = asking;
      /* The question names the beside facet by its provisional token, which the
       * reply reads back as what the merchant typed; it becomes a customer, and
       * the link its ids, only if the question is really asked (below). */
      if (customer?.kind === 'token' && recordCustomer) {
        const besideSurvives =
          recordCustomer.created && recordCustomer.facet !== 'phone' && besideFacet === 'phone';
        link ??= besideSurvives
          ? {
              survivorId: '',
              survivorToken: asking,
              orphanId: recordCustomer.customerId,
              orphanToken: recordCustomer.token,
            }
          : {
              survivorId: recordCustomer.customerId,
              survivorToken: recordCustomer.token,
              orphanId: '',
              orphanToken: asking,
            };
      }
    }
    command = withWordsNeutralised(
      command,
      new Set([...tokens.displays.keys()].filter((t) => t !== inheritedToken)),
      placeholders,
    );
  }
  /**
   * A question resolves a name by LOOKUP only (OD-3, owner ruling 20 Nov 2026).
   *
   * A read must not add a customer: find-or-create below is for records the
   * merchant will confirm. A known name becomes its token, exactly as a sale
   * would find it. An unknown one names nobody: the question is answered
   * honestly, and the stored message never held the name (G-136).
   */
  if (command.intent === 'Query' && command.customer?.kind === 'mention') {
    const mention = command.customer.mention;
    const found = await deps.gateway.findMention(businessId, mention);
    /* Only a name the merchant typed, or a customer this message was issued, is the one asked
     * about: a recorded name the model wrote is unknown here, never answered with that customer's
     * balance (CodeRabbit on #437 at 3d66867; the record path's rule, G-137). */
    const known =
      found && (typedIn(rawText, mention) || tokens.displays.has(found.token)) ? found : null;
    if (known) deps.gateway.noteMention(tokens, known.token, mention);
    /* Answered through the ordinary path, not by returning here: a question
     * leaves its read-only Query draft, which is what stops a later "yes"
     * reaching past it to an older preview (`hasReadsAfter`, Codex on #437). */
    /* Whatever the topic: an unknown name is said to be unknown, never
     * answered with the whole business's figures as if they were theirs. */
    nameNotKnown = !known;
    command = {
      ...command,
      customer: known ? { kind: 'token', token: known.token } : { kind: 'none' },
    };
  }
  /* A question's token must be one this message was issued (G-135): the model
   * sees tokens as opaque and only ever this message's. Any other names nobody
   * here, so it is answered as unknown, never "nothing outstanding". */
  if (
    command.intent === 'Query' &&
    command.customer?.kind === 'token' &&
    !tokens.displays.has(command.customer.token)
  ) {
    nameNotKnown = true;
    command = { ...command, customer: { kind: 'none' } };
  }
  if ('customer' in command && command.customer && command.customer.kind === 'mention') {
    const mention = command.customer.mention;
    /* A mention nowhere in the merchant's words is the model's, not theirs: refused like an
     * unissued token, and whether or not the vault holds that name (G-137; OD-62(n), CodeRabbit
     * on #437 at ebeeadb and 58dd68b). A recorded name the merchant typed was tokenised before
     * the model read the message; a new one they typed keeps the vault path (ADR 0005 case 4). A
     * photo's words are its caption and the page's extracted text, so a buyer the model names
     * that the receipt never shows is refused the same way (CodeRabbit on #437 at 56c4140). */
    /* On a photo, the page names many people (the seller, the merchant, a supplier, a delivery
     * contact): a buyer is one the caption types or the page labels as the buyer, never any name
     * on it, recorded or not (owner ruling 22 Nov 2026 on photo-extracted customer names). */
    /* The same customer can be named through several buyer fields (`Buyer: Ada Obi`,
     * `Client: ada@example.test`). When the mention is a recorded customer this message was
     * issued, it is judged by that customer's observed facets, as a returned token is, so a field
     * that names them another way is not a contradiction. Read-only lookup, before anything is
     * created; a mention that is nobody recorded, or whose token this message was not issued, is
     * judged by its own words alone, and the complete name is still required (CodeRabbit on #437). */
    const photoNames = async (): Promise<string[]> => {
      const recorded = await deps.gateway.findMention(businessId, mention);
      const observed =
        recorded && tokens.displays.has(recorded.token)
          ? facetValuesOf(tokens, recorded.token)
          : [];
      return observed.length > 0 ? [mention, ...observed] : [mention];
    };
    if (fromDocument && !photoBuyerNamed(rawText, documentCaption, await photoNames())) {
      authorisationLog.warn(`${command.intent} named a buyer the photo does not label`);
      await refundMessage(tx, businessId, eventId, period);
      return refusedAs(replies.customerNotRecognised());
    }
    if (!typedIn(rawText, mention)) {
      const recorded = await deps.gateway.findMention(businessId, mention);
      /* Unless this message was issued that recorded customer's token, by a phone or an email of
       * theirs ("sold 3 wigs to 0803…" composes with their name, G-60). */
      if (!recorded || !tokens.displays.has(recorded.token)) {
        authorisationLog.warn(`${command.intent} named a customer the message did not`);
        await refundMessage(tx, businessId, eventId, period);
        return refusedAs(replies.customerNotRecognised());
      }
    }
    const named = await deps.gateway.resolveMention(businessId, mention);
    /* A name that is new beside a customer the message already named (a
     * storefront buyer's phone) may be one person: asked, never joined
     * (G-60 owner decision, 14 Oct 2026). */
    const asking = pendingBeside;
    if (asking && named.created) {
      /* A new name beside a new phone: the phone survives, the name is the
       * orphan, exactly as `linkAfterMention` would propose it. */
      link ??= {
        survivorId: '',
        survivorToken: asking,
        orphanId: named.customerId,
        orphanToken: named.token,
      };
    } else {
      pendingBeside = null;
      tokens.provisional?.clear();
    }
    if (people === 2) link ??= await deps.gateway.linkAfterMention(businessId, referenced, named);
    /* Composed with whatever the merchant typed for the same customer, so a
     * phone and the name the model resolved read as one person (G-60). */
    deps.gateway.noteMention(tokens, named.token, mention);
    command = {
      ...command,
      customer: { kind: 'token', token: named.token },
    } as StructuredBusinessCommand;

    /* Nothing to scrub from the stored message: it holds a placeholder, never
     * the text (G-136), so the name the model just resolved was never kept. */
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
  /* A correction is about something a "yes" could confirm, never a read: "sorry, 3 not 4" after
   * only a question is a new request (Build 6). Whether this is one was decided above, against the
   * same draft and the same window (`correctionInheritance`, OD-60). */
  if (correcting) {
    /* Another member's refusal stays theirs to answer, as a bare "no" leaves it (CodeRabbit on
     * #437 at 0e12742): superseded here, their next yes would confirm this replacement preview,
     * which was never sent to them. */
    await conversationsRepo.supersedePendingDrafts(tx, businessId, {
      asOf: receivedAt,
      skipRefusalsNotBy: actorId,
    });
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
  /* A question about a name the books do not hold reads nothing: answering it
   * through `acknowledge` would read the business's own figures only to throw
   * them away, and a failure of that read would leave no reply (CodeRabbit on
   * #437). The answer is the one set just below. */
  /* A period total asked by a message that names a customer is never answered with the whole
   * business's figures: the model leaving `customer` empty is no proof the merchant named nobody
   * (OWN-102(3)). Only a balance is kept per customer, so this is told as that is (G-135; CodeRabbit
   * on #437 at b2703e7). A question that names nobody keeps the business-wide answer. */
  /* "Who owes me, Ada?" read as the debtors list with no customer: the one recorded customer this
   * message was issued is the one asked about, as when the model returns her token, never widened to
   * every debtor; one nobody recorded is unknown (CodeRabbit on #437 at 88258dc). Several are asked
   * about below. */
  const issuedCustomers = [...tokens.displays.keys()].filter((t) => t.startsWith('CUSTOMER_'));
  if (
    command.intent === 'Query' &&
    /* A balance question too, never answered "no unpaid invoice" (CodeRabbit on #437 at 9c587bd). */
    (command.topic === 'debtors' || command.topic === 'customer_balance') &&
    (command.customer?.kind ?? 'none') === 'none' &&
    issuedCustomers.length === 1
  ) {
    const only = issuedCustomers[0]!;
    if (tokens.provisional?.has(only)) nameNotKnown = true;
    else command = { ...command, customer: { kind: 'token', token: only } };
  }
  /* Every topic, as `acknowledge` refuses a customer token on any topic but a balance: payables
   * ("how much do I owe Ada") included (CodeRabbit on #437 at cf96697). A balance question with one
   * issued customer was taken as hers above, so only one naming several reaches here (fadc878). */
  const namedButUnscoped =
    command.intent === 'Query' &&
    (command.customer?.kind ?? 'none') === 'none' &&
    /* A customer token, recorded or provisional: an `ACCOUNT_n` names nobody (independent review
     * of #437 at 81d0b03). */
    issuedCustomers.length > 0;
  const acknowledged =
    nameNotKnown && command.intent === 'Query'
      ? { reply: replies.customerNotKnown(), linkAsked: false, continuation: NO_PERIOD_TO_RESUME }
      : namedButUnscoped
        ? {
            reply: replies.customerFiguresNotKept(),
            linkAsked: false,
            continuation: NO_PERIOD_TO_RESUME,
          }
        : await acknowledge(
            tx,
            businessId,
            /* The preview names the supplier the stored draft will carry, never a token or placeholder
             * the stored draft drops (CodeRabbit on #437 at 0e12742). */
            command.intent === 'RecordPurchase'
              ? ({
                  ...command,
                  supplierMention: supplierNameOf(command, tokens.displays.keys()) || null,
                } as StructuredBusinessCommand)
              : command,
            correcting,
            link,
            receivedAt,
          );
  /* A balance question about a name the books do not hold is answered honestly above, never
   * "they owe nothing" (G-135), and never with a subject a later "last month" could resume into
   * the business's totals (independent review of #437). */
  let answered = acknowledged;

  /* The beside facet is created now, and only because the preview really asks
   * about it; the reply and the link then carry its stored token and id. When
   * the answer asks nothing, it is never created and the link is dropped. */
  if (pendingBeside) {
    const beside = pendingBeside;
    if (answered.linkAsked && link) {
      const made = await deps.gateway.materialise(businessId, tokens, new Set([beside]));
      const created = made.resolved[0];
      if (created) {
        referenced = [...referenced, created];
        link = {
          survivorId: link.survivorId || created.customerId,
          survivorToken: made.replaced.get(link.survivorToken) ?? link.survivorToken,
          orphanId: link.orphanId || created.customerId,
          orphanToken: made.replaced.get(link.orphanToken) ?? link.orphanToken,
        };
        answered = {
          ...answered,
          reply: {
            ...answered.reply,
            text: withTokensReplaced(answered.reply.text, made.replaced),
          },
        };
      }
    } else if (link && (link.survivorToken === beside || link.orphanToken === beside)) {
      link = null;
    }
    tokens.provisional?.clear();
    pendingBeside = null;
  }

  /* Supplier names are never persisted (ADR 0005): the preview above
   * already said "From: ...". What the stored draft keeps instead is the
   * VAULT ROW the mention resolved to (migration 0050) — an opaque id the
   * confirm can stamp on the purchase, never the name itself. */
  let stored: Record<string, unknown> = command;
  /* A model's clarifying question may repeat a name nobody recorded. It is sent once, from the
   * reply above, and nothing reads it back from the draft, so the draft keeps a placeholder
   * (independent review of #437 at ebeeadb; ADR 0005 Amendment 1: never what Rekoda stores). */
  if (command.intent === 'Unclear') {
    stored = { ...command, clarification: STORED_BODY.clarification };
  }
  if (command.intent === 'RecordPurchase') {
    /* What the record's words keep in place of a phone, an email or a foreign
     * token names nobody, so it is never part of a supplier's name: "[phone]"
     * alone would vault ONE supplier called "[phone]" for every supplier known
     * only by number, merging their payables (independent review of the owner
     * review's fixes). What remains, if anything, is the name. */
    /* Nor is a customer token: a supplier named after a pseudonym would take
     * that customer's token into the supplier vault (CodeRabbit on #437). Every
     * token span is found the way the gateway finds them (`protectedSpans`). */
    const mention = supplierNameOf(command, tokens.displays.keys());
    const supplier =
      mention.length > 0 ? await deps.gateway.resolveSupplierMention(businessId, mention) : null;
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
    (command.intent === 'RecordPurchase' || command.intent === 'RecordExpense') &&
    answered.previewed === true
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
    shown = replies.purchaseIdentityQuestion(
      identitySubject(identity.ask, actorId, identity.kind),
      receivedAt,
      { named: identity.asked.length, kinds: identity.asked.map((r) => r.kind ?? 'purchase') },
    );
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
   * different total leaves it waiting, and the reply says that too
   * (references never set it apart since OWN-32). Never across members, and never for a rebuild with no recorded requester. */
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
    if (draft.isNew) {
      /* Never another member's refusal: it still guards what they were shown (CodeRabbit on #437
       * at ce75a9e), as the correction path keeps it. */
      await conversationsRepo.supersedeDraftsBefore(tx, businessId, draft.id, {
        skipRefusalsNotBy: actorId,
      });
    }
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
/**
 * The supplier name a purchase's `supplierMention` leaves once every token span (found the way the
 * gateway finds them, `protectedSpans`) and every placeholder for a phone, an email or a customer
 * is taken out: what is vaulted as the supplier, and what its preview shows. Empty when nothing
 * names a supplier.
 */
function supplierNameOf(command: StructuredBusinessCommand, displays: Iterable<string>): string {
  const raw = (command as { supplierMention?: unknown }).supplierMention;
  const words = typeof raw === 'string' ? raw : '';
  let untokened = '';
  let cursor = 0;
  for (const span of protectedSpans(words, displays)) {
    untokened += `${words.slice(cursor, span.start)} `;
    cursor = Math.max(cursor, span.end);
  }
  untokened += words.slice(cursor);
  const name = untokened
    .replace(/\[(?:phone|email|customer)\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  /* What is left of "[phone], [email]" is punctuation, which names nobody: no "From:" line and no
   * supplier row (CodeRabbit on #437 at ce75a9e). A name keeps its own punctuation. */
  /* And only a name the supplier lookup accepts, so the preview never shows a supplier the record
   * would drop ("From: K"; CodeRabbit on #437 at cacc734). */
  return /[\p{L}\p{N}]/u.test(name) && normaliseFacet('supplier_name', name).length >= 2
    ? name
    : '';
}

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
    /* A preview is a promise about specific figures on a specific invoice; the
     * draft keeps them so `yes` can prove it is confirming what was shown and
     * books to that invoice, never a newer one (OD-57, OWN-101). */
    if (paymentGate.creditK === 0) {
      return {
        ...previewed,
        confirmationContext: {
          kind: 'payment_invoice',
          invoiceId: invoice.id,
          balanceShownK: invoice.balanceDueK,
          amountShownK: paymentGate.amountK,
        },
      };
    }
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
          ? `${replies.correctionTaken().text}\n\n${orderPreview(order, command.note, customerTokenOf(command as never))}`
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
    const spent = await usageRepo.reserveUnit(tx, businessId, period, 'AI_ACTIONS', allowance);
    if (spent.granted) {
      await events.noteReservedUnit(tx, businessId, eventId, 'AI_ACTIONS', spent.meter);
    }
    return spent.granted;
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
    const held = await events.takeRecordedUnit(own, businessId, eventId, unit);
    if (!held) return;
    /* The quantity recorded when it was taken, if there is one. */
    const recorded = Number(held.held.split(':')[1]);
    await usageRepo.refundUnit(
      own,
      businessId,
      usageRepo.storedMeter(held.meter, period),
      unit,
      recorded > 0 ? recorded : n,
    );
  });
}

/**
 * Give back EVERYTHING this message holds: its message unit, a page, a
 * note's seconds, and what a spoken or photographed "yes" reserved on an
 * attempt that rolled back (Codex P2). For a message that ends delivering nothing (a refusal or
 * a failure before the interpreter answered), on whichever attempt: a unit
 * an earlier attempt took is never left charged (G-57 final review B). On a
 * first attempt that took nothing, it gives back nothing.
 */
async function releaseHeldUnits(
  deps: InboundMessageDeps,
  businessId: string,
  eventId: string,
  period: string,
): Promise<void> {
  for (const unit of [
    'AI_ACTIONS',
    'DOCUMENTS_UNDERSTOOD',
    'VOICE_MINUTES',
    'DOCUMENT_GENERATION',
    'CATALOGUE_ORDERS',
  ] as const) {
    await giveBackUnit(deps, businessId, eventId, period, unit);
  }
}

/**
 * Give back the message unit this message holds, if it holds one.
 *
 * Taken and refunded in the JOB's transaction: the refund commits only with
 * the attempt that answers, so an attempt that dies after refunding gives
 * nothing back and leaves the reservation for the next. The counter row is
 * therefore held until the job commits, through the reply send, as the G-23
 * confirmation refund already is; inbound jobs for a business are
 * serialised anyway, and the only other writer (a pack credit) waits. Lock
 * order differs from the consume's (event, then counter), which is safe
 * only because every writer of an event row holds the business lock. Exactly once, in
 * the month it was taken, never below zero, never twice, and never for an
 * attempt that took nothing (G-57; replaces the earlier retry under-count).
 */
async function refundMessage(
  tx: TenantDb,
  businessId: string,
  eventId: string,
  period: string,
): Promise<void> {
  const taken = await events.takeReservedUnit(tx, businessId, eventId, 'AI_ACTIONS');
  if (taken) {
    await usageRepo.refundUnit(
      tx,
      businessId,
      usageRepo.storedMeter(taken.meter, period),
      'AI_ACTIONS',
    );
  }
}

function describeIntent(intent: DeterministicIntent): string {
  return intent.kind === 'number' ? `[number:${intent.value}]` : `[${intent.kind}]`;
}
