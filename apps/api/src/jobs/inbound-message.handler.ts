import { Logger } from '@nestjs/common';
import {
  allowanceFor,
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
  replies,
  routeMessage,
  usagePeriod,
  type DeterministicIntent,
  type Reply,
} from '@rekoda/core';
import { normalisePhone } from '@rekoda/core/identity';
import { extractInboundEvents, metaWebhookBody } from '@rekoda/contracts';
import type { StructuredBusinessCommand } from '@rekoda/contracts';
import {
  billingRepo,
  conversationsRepo,
  withBusiness,
  customersRepo,
  events,
  identity,
  issueRepo,
  jobsRepo,
  reportsRepo,
  settleRepo,
  spendRepo,
  stockRepo,
  usageRepo,
  type Db,
  type TenantDb,
} from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import type { Interpreter } from '../ai/interpreter.service.js';
import type { PrivacyGateway } from '../privacy/gateway.service.js';
import type { ReplySender } from '../replies/reply.service.js';
import type { PaymentIntentsService } from '../payments/payment-intents.service.js';
import { openPayload } from '../privacy/payload-vault.js';
import { redactForLog } from '@rekoda/core/privacy';
import { describeFailure, type JobContext, type JobHandler } from './runner.js';
import type { SpeechToText, Transcript } from '../ai/stt.js';
import type { TextExtraction } from '../ai/ocr.js';
import type { MessageSender } from '../channels/sender.js';

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
   * The self-hosted OCR sidecar (ADR 0024), or something that refuses
   * honestly. Never a vision model: see `ocr.ts` for why there is no such
   * option and must not be one.
   */
  ocr: TextExtraction;
  /** The app pool, for the rows that live ABOVE tenancy: users' consent state. */
  db: Db;
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

  return async ({ tx, payload, businessId, attempt }: JobContext): Promise<void> => {
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
      const recorded = await conversationsRepo.recordInbound(tx, {
        businessId,
        channel: 'meta',
        kind: 'media',
        body: `[${inbound.messageType} message]`,
        providerMessageId: inbound.externalId,
      });
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
      : await conversationsRepo.recordInbound(tx, {
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
        ? await deterministicReply(deps, tx, businessId, route.intent, {
            eventId,
            messageId: message.id,
            from: inbound.from,
            retrying,
          })
        : await interpretedReply(deps, tx, businessId, text, tokenised!.text, message.id, retrying);

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

/** A recording somebody made with the microphone button, not an attached file. */
function isVoiceNote(inbound: { messageType: string; audioId: string | null }): boolean {
  return (inbound.messageType === 'audio' || inbound.messageType === 'voice') && !!inbound.audioId;
}

/** A photograph, which for a bookkeeper means a receipt or an invoice. */
function isReceiptPhoto(inbound: { messageType: string; imageId: string | null }): boolean {
  return inbound.messageType === 'image' && !!inbound.imageId;
}

/**
 * A photograph, turned into text by our own OCR, or an honest answer.
 *
 * Returns null when there is nothing to interpret, having already replied:
 * somebody who photographed a receipt is holding their phone waiting.
 *
 * THE IMAGE IS NEVER STORED and never leaves infrastructure we control. ADR
 * 0024 fixed the pipeline - photo, self-hosted OCR, PII tokenisation, then a
 * model - because the privacy gateway tokenises TEXT and cannot tokenise an
 * image. A photograph handed to a model provider carries a customer's name,
 * phone and address intact.
 *
 * There is no branch below that sends the image anywhere when extraction
 * fails. That is the whole design, and it is why the failure path answers
 * with a sentence rather than a second attempt somewhere else.
 */
async function readReceiptPhoto(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  inbound: { externalId: string; from: string; imageId: string | null; caption: string | null },
  log: Logger,
): Promise<{ text: string; messageId: string } | null> {
  const recorded = await conversationsRepo.recordInbound(tx, {
    businessId,
    channel: 'meta',
    kind: 'media',
    body: '[receipt photo]',
    providerMessageId: inbound.externalId,
  });
  /* A redelivered webhook must not read, meter and answer twice. */
  if (!recorded.isNew) return null;

  const plan = await usageRepo.planFor(tx, businessId);
  if (plan === 'expired') {
    await deps.replySender.send(tx, { businessId, to: inbound.from, reply: replies.trialEnded() });
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

  let extracted;
  try {
    extracted = await deps.ocr.extract(image.bytes, image.mimeType);
  } catch {
    /* Our failure, not the merchant's, and nothing metered. The image is
     * dropped here and goes nowhere else: no vision model, no retry against a
     * hosted engine, no exception "just this once". */
    log.warn('the OCR engine could not be reached');
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: replies.photoUnavailable(),
    });
    return null;
  }

  /**
   * Metered as a document UNDERSTOOD, which is the unit that exists for
   * exactly this and has never been consumed by anything. Charged after the
   * work, like voice seconds, because a page nobody could read is a page
   * nobody should pay for.
   */
  const period = usagePeriod(new Date());
  const allowance = allowanceFor(plan, 'documents_understood');
  const granted = await withBusiness(deps.db, businessId, (own) =>
    usageRepo.consumeUnit(own, businessId, period, 'documents_understood', allowance),
  );
  if (!granted) {
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: replies.allowanceExhausted(allowance, 'documents_understood'),
    });
    return null;
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
 * THE AUDIO IS NEVER STORED. It is fetched, passed to the sidecar, and left
 * to the garbage collector. A merchant's voice is the most identifying thing
 * they can send us, "audio never leaves Rekoda" is a promise we make out
 * loud, and the only way that stays true is if there is nowhere for it to
 * leave from.
 */
async function transcribeVoiceNote(
  deps: InboundMessageDeps,
  tx: TenantDb,
  businessId: string,
  inbound: { externalId: string; from: string; audioId: string | null },
  log: Logger,
): Promise<{ transcript: Transcript; messageId: string } | null> {
  const recorded = await conversationsRepo.recordInbound(tx, {
    businessId,
    channel: 'meta',
    kind: 'voice',
    body: '[voice note]',
    providerMessageId: inbound.externalId,
  });
  /* A redelivered webhook must not transcribe, meter and answer twice. The
   * body is replaced with the transcript below only on the first pass. */
  if (!recorded.isNew) return null;

  const plan = await usageRepo.planFor(tx, businessId);
  if (plan === 'expired') {
    await deps.replySender.send(tx, { businessId, to: inbound.from, reply: replies.trialEnded() });
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

  let transcript: Transcript;
  try {
    transcript = await deps.stt.transcribe(audio.bytes, audio.mimeType);
  } catch {
    /* An outage, not the merchant's fault, and nothing metered. The reason is
     * logged without the audio and without their words. */
    log.warn('the transcriber could not be reached');
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: replies.voiceUnavailable(),
    });
    return null;
  }

  /**
   * Metered AFTER the work, unlike messages, because the unit is seconds and
   * nobody knows how many there are until the sidecar says so. Consumed in
   * its own transaction for the same reason the message unit is: the counter
   * must not be held across a network call.
   */
  const period = usagePeriod(new Date());
  const allowance = allowanceFor(plan, 'voice_seconds');
  const granted = await withBusiness(deps.db, businessId, (own) =>
    usageRepo.consumeUnit(own, businessId, period, 'voice_seconds', allowance, transcript.seconds),
  );
  if (!granted) {
    await deps.replySender.send(tx, {
      businessId,
      to: inbound.from,
      reply: replies.allowanceExhausted(allowance, 'voice_seconds'),
    });
    return null;
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
  if (intent.kind === 'affirm') return confirmPendingDraft(deps, tx, businessId, ctx.retrying);
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
        const erased = await customersRepo.eraseAllIdentities(tx, businessId, 'chat');
        return replies.erasureDone(erased);
      }
      const discarded = await conversationsRepo.supersedePendingDrafts(tx, businessId);
      await conversationsRepo.recordDraft(tx, {
        businessId,
        conversationMessageId: ctx.messageId,
        intent: 'EraseData',
        command: { intent: 'EraseData' },
        model: null,
      });
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
      return paymentDetailsReply(deps, tx, businessId);
    case 'remind':
      return remindReply(deps, tx, businessId, ctx, intent.invoiceNumber);
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
      const rows = await stockRepo.stockList(tx, businessId, 20);
      return replies.stockList(rows.map((p) => ({ name: p.name, onHand: p.onHand })));
    }
    case 'resend':
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
  } catch {
    // InvalidPhoneError only: upstream attribution already accepted this
    // sender, so anything else here would have failed there first.
  }
}

/**
 * "resend": the newest stored document goes back through the same delivery
 * job that sent it the first time — same bytes, same caption rules, same
 * retries. The singleton key carries the event id, so a redelivered webhook
 * cannot queue the same resend twice while a fresh ask always can.
 */
async function resendReply(tx: TenantDb, businessId: string, eventId: string): Promise<Reply> {
  const stored = await issueRepo.documentsFor(tx, businessId);
  const newest = stored.at(-1);
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
    case 'ready':
      return replies.paymentLinkReady(invoice.invoiceNumber, outcome.amountK, outcome.checkoutUrl);
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
  const issuesDocument = command.intent === 'RecordSale' || command.intent === 'RecordPayment';
  const period = usagePeriod(new Date());
  let documentTaken = false;
  if (issuesDocument && !retrying) {
    const plan = await usageRepo.planFor(tx, businessId);
    /* A trial that lapsed between the preview and the yes is its own
     * sentence. The allowance path would refuse correctly and say "you have
     * used all 0 invoices this month", which is true of the number and
     * useless about the reason. */
    if (plan === 'expired') return replies.trialEnded();
    const allowance = allowanceFor(plan, 'documents');
    const granted = await withBusiness(deps.db, businessId, (own) =>
      usageRepo.consumeUnit(own, businessId, period, 'documents', allowance),
    );
    if (!granted) return replies.allowanceExhausted(allowance, 'documents');
    documentTaken = true;
  }

  if (!(await conversationsRepo.claimDraft(tx, draft.id))) {
    /* The other "yes" won. It is issuing the invoice and it took its own
     * unit, so this one goes back: two rapid confirmations must cost one
     * document, which is how many the merchant ends up with. */
    if (documentTaken) await refundDocument(deps, businessId, period);
    return replies.alreadyConfirmed();
  }
  if (command.intent === 'RecordExpense') return confirmExpense(tx, businessId, draft.id, command);
  if (command.intent === 'RecordPurchase')
    return confirmPurchase(tx, businessId, draft.id, command);
  if (command.intent === 'EraseData') {
    // Erasure confirms ONLY with the exact phrase. A "yes" is "anything
    // else" in the confirmation copy's terms, and anything else keeps the data.
    return replies.erasureKept();
  }
  if (command.intent === 'RecordPayment') {
    /* Refunds its own unit on every path that answers without issuing a
     * receipt: an invoice settled from under the merchant, or a payment we
     * could not place, must not cost them a document they never got. */
    return confirmPayment(tx, businessId, draft.id, command, () =>
      documentTaken ? refundDocument(deps, businessId, period) : Promise.resolve(),
    );
  }
  if (command.intent === 'AdjustInventory') {
    /* No document, so the unit this confirmation reserved goes back. A stock
     * count produces nothing to send and must not cost the merchant one of
     * the documents they are allowed to generate. */
    if (documentTaken) await refundDocument(deps, businessId, period);
    return confirmStockChange(tx, businessId, command as never);
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
  const issued = await issueRepo.issueSale(tx, {
    businessId,
    customerId: null,
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
  });

  /**
   * Enqueued INSIDE the same transaction as the sale (MASTER-PLAN §5.3.5 step
   * 9). The invoice and "render its PDF" commit together, so there is no
   * window where a document exists that nothing will ever produce paper for —
   * and a rollback takes the job with it rather than leaving one pointing at
   * an invoice that was never issued.
   *
   * The singleton key is the invoice id: a re-enqueue cannot produce two PDFs
   * with two storage keys for one sale.
   */
  await jobsRepo.enqueue(tx, {
    businessId,
    kind: 'document.render',
    payload: { invoiceId: issued.invoiceId },
    singletonKey: issued.invoiceId,
  });

  /**
   * Stock comes off the shelf in the same transaction as the invoice.
   *
   * Only for lines naming something the shop ALREADY counts. A sale of
   * something never counted must not create a product and then report it as
   * minus three: a merchant who has not told Rekoda they stock something has
   * not asked Rekoda to count it, and a stock figure that appears uninvited
   * is a stock figure nobody trusts.
   */
  await stockRepo.recordSaleMovements(tx, businessId, items, issued.invoiceNumber);

  return replies.issued(issued.invoiceNumber, money.totalK, money.balanceDueK);
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
  tx: TenantDb,
  businessId: string,
  command: StructuredBusinessCommand & { intent: 'AdjustInventory' },
): Promise<Reply> {
  const product = await stockRepo.findOrCreateProduct(tx, businessId, command.productMention);
  const gate = gateStockChange(command, product.onHand);
  /* The count moved under the merchant between preview and confirmation. The
   * gate says why in the merchant's own terms; nothing is written. */
  if (gate.gate === 'CG1') return replies.arithmeticQuestion(gate.question);

  await stockRepo.recordMovement(tx, {
    businessId,
    productId: product.id,
    delta: gate.quantityDelta,
    reason: 'adjustment',
    sourceType: 'chat',
    sourceId: null,
  });
  return replies.stockSaved(product.name, gate.quantityDelta, gate.onHandAfter);
}

/**
 * A confirmed expense: the row and its balanced posting, one transaction, and
 * a reply that says "in your books" rather than pretending a document exists.
 * No render job follows — there is no paper to make.
 */
async function confirmExpense(
  tx: TenantDb,
  businessId: string,
  draftId: string,
  command: Record<string, unknown>,
): Promise<Reply> {
  const gate = gateExpense(command as never);
  if (gate.gate !== 'CG2') return replies.arithmeticQuestion(gate.question);

  const description = String(command['description'] ?? '');
  await spendRepo.recordExpense(tx, {
    businessId,
    description,
    category: typeof command['category'] === 'string' ? command['category'] : null,
    amountK: gate.amountK,
    method: command['paymentMethod'] === 'transfer' ? 'transfer' : 'cash',
    sourceType: 'chat',
    sourceId: draftId,
  });
  return replies.expenseSaved(gate.amountK, description);
}

/**
 * A confirmed stock purchase. The supplier MENTION is deliberately dropped at
 * this boundary — names live in the identity vault or nowhere (see spend.ts).
 * What survives is what the books need: the stock, the cost, and what is
 * still owed.
 */
async function confirmPurchase(
  tx: TenantDb,
  businessId: string,
  draftId: string,
  command: Record<string, unknown>,
): Promise<Reply> {
  const gate = gatePurchase(command as never);
  if (gate.gate !== 'CG2') return replies.arithmeticQuestion(gate.question);

  const recorded = await spendRepo.recordPurchase(tx, {
    businessId,
    description: String(command['description'] ?? ''),
    amountK: gate.amountK,
    paidK: gate.paidK,
    sourceType: 'chat',
    sourceId: draftId,
  });

  /**
   * A purchase is a delivery too, when the merchant counted one.
   *
   * Same transaction as the money, so a shop can never hold the payment
   * without the goods. Only when they named a countable thing AND a number:
   * inferring a quantity from an amount would put a stock count in their
   * books that nobody took.
   */
  const arriving = purchaseArrival(command as never);
  if (arriving) {
    const product = await stockRepo.findOrCreateProduct(tx, businessId, arriving.productMention);
    await stockRepo.recordMovement(tx, {
      businessId,
      productId: product.id,
      delta: arriving.quantity,
      reason: 'purchase',
      sourceType: 'chat',
      sourceId: draftId,
    });
    return replies.purchaseSaved(gate.amountK, recorded.owedK, {
      name: product.name,
      onHand: product.onHand + arriving.quantity,
    });
  }

  return replies.purchaseSaved(gate.amountK, recorded.owedK);
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
  tx: TenantDb,
  businessId: string,
  draftId: string,
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

  /* The gate read the balance without a lock; the write takes one. If a
   * provider payment settled the invoice in between, the write refuses.
   * Caught here because the alternative is what it used to do: throw, fail
   * the job, retry to exhaustion, and leave the merchant who typed "yes"
   * with no answer at all. */
  let recorded: Awaited<ReturnType<typeof settleRepo.recordMerchantPayment>>;
  try {
    recorded = await settleRepo.recordMerchantPayment(tx, {
      businessId,
      invoiceId: invoice.id,
      amountK: gate.amountK,
      method: command['paymentMethod'] === 'cash' ? 'cash' : 'transfer',
      sourceType: 'chat',
      sourceId: draftId,
      actor: 'system',
    });
  } catch (error) {
    if (error instanceof settleRepo.AlreadySettled) {
      await refundDocumentUnit();
      return replies.paymentAlreadySettled(invoice.invoiceNumber);
    }
    if (error instanceof settleRepo.BalanceMoved) {
      await refundDocumentUnit();
      return replies.paymentBalanceMoved(error.invoiceNumber, error.balanceDueK, error.excessK);
    }
    throw error;
  }

  /* The receipt gets the same render-then-deliver treatment a verified
   * payment's does, enqueued in this transaction so paper and record commit
   * together. */
  await jobsRepo.enqueue(tx, {
    businessId,
    kind: 'document.render',
    payload: { receiptId: recorded.receiptId },
    singletonKey: `receipt:${recorded.receiptId}`,
  });

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

  const monthlyMessages = allowanceFor(plan, 'messages');
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
   * CG5 — a correction REPLACES the pending draft rather than sitting beside
   * it. Superseded, not deleted: what the merchant first said is part of the
   * record, and it is the only way to answer "why does this say 3 when I said
   * 4". Getting the direction wrong makes a merchant fixing a quantity lose
   * the sale they were fixing.
   */
  const existing = await conversationsRepo.pendingDraft(tx, businessId);
  const correcting = looksLikeCorrection(rawText, existing !== null);
  if (correcting) await conversationsRepo.supersedePendingDrafts(tx, businessId);

  await conversationsRepo.recordDraft(tx, {
    businessId,
    conversationMessageId,
    intent: interpreted.command.intent,
    command: interpreted.command,
    model: deps.config.aiModelDefault,
  });

  return acknowledge(tx, businessId, interpreted.command, correcting);
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
): Promise<Reply> {
  if (command.intent === 'Unclear') return replies.clarification(command.clarification);

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
  if (command.intent === 'Query') return answerQuery(tx, businessId, command);

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
    if (target.outcome === 'none') return replies.paymentNoOpenInvoice();
    if (target.outcome === 'ambiguous') return replies.paymentWhichInvoice(target.openCount);
    const invoice = target.invoice;

    const paymentGate = gatePayment(command, invoice.invoiceNumber, invoice.balanceDueK);
    if (paymentGate.gate === 'CG1') return replies.arithmeticQuestion(paymentGate.question);
    return replies.preview(
      correcting
        ? `${replies.correctionTaken().text}\n\n${paymentGate.preview}`
        : paymentGate.preview,
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
    if (stockGate.gate === 'CG1') return replies.arithmeticQuestion(stockGate.question);
    return replies.preview(
      correcting ? `${replies.correctionTaken().text}\n\n${stockGate.preview}` : stockGate.preview,
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
  if (!gate) return replies.notYet('Recording that kind of entry');

  if (gate.gate === 'CG1') return replies.arithmeticQuestion(gate.question);
  return replies.preview(
    correcting ? `${replies.correctionTaken().text}\n\n${gate.preview}` : gate.preview,
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
    usageRepo.consumeUnit(tx, businessId, period, 'messages', allowance),
  );
}

/** Put a document unit back. Same standalone transaction as taking one. */
function refundDocument(
  deps: InboundMessageDeps,
  businessId: string,
  period: string,
): Promise<void> {
  return withBusiness(deps.db, businessId, (tx) =>
    usageRepo.refundUnit(tx, businessId, period, 'documents'),
  );
}

function refundMessage(
  deps: InboundMessageDeps,
  businessId: string,
  period: string,
): Promise<void> {
  return withBusiness(deps.db, businessId, (tx) =>
    usageRepo.refundUnit(tx, businessId, period, 'messages'),
  );
}

function describeIntent(intent: DeterministicIntent): string {
  return intent.kind === 'number' ? `[number:${intent.value}]` : `[${intent.kind}]`;
}
