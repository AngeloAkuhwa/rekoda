import { Logger } from '@nestjs/common';
import { redactForLog } from '@rekoda/core/privacy';
import {
  billingPeriod,
  MESSAGE_COST_MICROS,
  messageCostK,
  replies,
  serviceWindowOpen,
} from '@rekoda/core';
import {
  conversationsRepo,
  identity,
  issueRepo,
  quotaRepo,
  settleRepo,
  type Db,
  type TenantDb,
} from '@rekoda/db';
import { OUTSIDE_SERVICE_WINDOW, SendFailed, type MessageSender } from '../channels/sender.js';
import type { ApiConfig } from '../config.js';
import type { DocumentStorage } from '../documents/storage.js';
import type { JobContext, JobHandler } from './runner.js';

export interface DeliverDocumentDeps {
  storage: DocumentStorage;
  sender: MessageSender;
  /** For the owner's WhatsApp number — a question that lives above the tenant. */
  db: Db;
  config: ApiConfig;
}

/**
 * Put the document in the merchant's hands (MASTER-PLAN §5.3.6).
 *
 * A third job, after issue and render, and for the same reason render was
 * split from issue: this one fails when Meta is unreachable or a token has
 * expired, and neither is a reason to un-issue a sale or re-render a PDF that
 * is already sitting in storage. Retried, it re-uploads the same bytes.
 *
 * The bytes go to Meta directly rather than as a link. A link would need the
 * PDF to be publicly reachable, which is precisely what the unguessable
 * storage key exists to avoid.
 */
export function deliverDocumentHandler(deps: DeliverDocumentDeps): JobHandler {
  const log = new Logger('DeliverDocumentJob');

  return async ({ tx, payload, businessId }: JobContext): Promise<void> => {
    const documentId = typeof payload['documentId'] === 'string' ? payload['documentId'] : null;
    if (!documentId) throw new Error('document.deliver: payload is missing documentId');

    const stored = await issueRepo.documentById(tx, businessId, documentId);
    if (!stored) {
      // Another tenant's id, or a truncated fixture. Nothing to retry.
      log.warn('document.deliver: no document for this tenant');
      return;
    }

    /**
     * STOP is honoured HERE, not just in the reply copy. A delivery is a
     * proactive send, so an opted-out owner gets nothing — unless they asked
     * for this exact document ("resend"), which is its own fresh consent.
     * The job completes rather than retries: consent is not an outage.
     */
    const requested = payload['requestedByMerchant'] === true;
    const to = await identity.ownerPhoneFor(deps.db, businessId);
    if (to && !requested && (await identity.optedOutAt(deps.db, to))) {
      log.log('delivery suppressed: the owner has opted out of messages');
      return;
    }
    if (!to) {
      /**
       * A business with no owner should be impossible — `createBusinessWithOwner`
       * writes both in one transaction. Throwing rather than returning quietly
       * means the retries and the dead-letter state make it visible, because
       * this would be a real corruption rather than an ordinary miss.
       */
      throw new Error('document.deliver: business has no owner to send to');
    }

    const bytes = await deps.storage.get(stored.storageKey);
    if (!bytes) {
      // The row exists and the object does not. Worth retrying — a bucket can
      // be briefly unreachable — and worth failing loudly if it persists.
      throw new Error('document.deliver: the stored object could not be read');
    }

    const filename = `${stored.refNumber ?? 'document'}.pdf`;
    const caption = await captionFor(tx, businessId, stored.kind, stored.refNumber);

    const sendPdf = async (): Promise<void> => {
      const result = await deps.sender.sendDocument({
        to,
        bytes,
        filename,
        contentType: 'application/pdf',
        caption,
      });

      /**
       * Recorded as an outbound message, so the conversation history shows what
       * the merchant actually received. The body is the caption — no customer
       * name passes through here, because the caption names the document.
       */
      const recorded = await conversationsRepo.recordOutbound(tx, {
        businessId,
        channel: 'meta',
        kind: 'media',
        body: caption,
      });
      await conversationsRepo.markOutboundSent(tx, recorded.id, result.providerMessageId);

      /**
       * A delivered PDF is a Meta MEDIA message, and media is chargeable from
       * 1 October 2026. Text replies have been writing a cost row since the
       * reply layer shipped; documents were not, so the baseline being built
       * for the repricing had a hole in it exactly where the expensive
       * message class sits.
       */
      const costMicros = deps.config.metaServiceReplyCostMicros;
      await quotaRepo.recordUsage(tx, {
        businessId,
        provider: 'meta',
        usageType: 'SERVICE_MESSAGE',
        quantity: 1,
        providerCostMicros: costMicros,
        nairaEquivalentK: messageCostK(costMicros, deps.config.planningFxNairaPerUsd),
        billingPeriod: billingPeriod(new Date()),
        meta: { window: 'service', kind: 'media', documentKind: stored.kind },
      });
      log.debug(`delivered ${filename}`);
    };

    /**
     * G-67: a free-form PDF is only deliverable inside the 24 hours after the
     * owner last wrote to this number; Meta rejects it outside (131047) and
     * the job would die with the owner none the wiser. Ask first. Messages
     * carry no sender phone, so a delegate's message can make the window look
     * open - Meta's own rejection is then the second check.
     */
    const inbound = await conversationsRepo.lastMerchantInboundAt(tx, businessId);
    const windowOpen = serviceWindowOpen(inbound.at, inbound.now);

    /* A resend the owner just asked for is attempted whatever the clock says:
     * their message is what reopens the window, and a notice asking them to
     * reply "resend" again would only send them round in a circle. */
    if (windowOpen || requested) {
      try {
        await sendPdf();
        return;
      } catch (error) {
        const closed = error instanceof SendFailed && error.providerCode === OUTSIDE_SERVICE_WINDOW;
        if (!closed || requested) {
          if (error instanceof SendFailed) {
            /**
             * Rethrown, unlike a failed text reply.
             *
             * A reply that does not arrive is a sentence the merchant misses. A
             * document that does not arrive is the thing they asked for, and the
             * PDF already exists in storage - so a retry is cheap, correct, and
             * the only way they ever get it.
             */
            log.warn(`document not delivered, will retry: ${redactForLog(error.message)}`);
          }
          throw error;
        }
        log.log('document.deliver: Meta reports the service window closed; sending the notice');
      }
    }

    /**
     * Outside the window the only message Meta accepts is an approved
     * template. It tells the owner a document is waiting; their reply opens a
     * window and "resend" delivers the PDF inside it (the resend path already
     * overrides STOP for the one delivery they asked for).
     *
     * An unconfigured or failing template THROWS, like a failed PDF: the job
     * is retried a few times and then dies VISIBLY rather than dropping
     * silently, and the owner can still say "resend" at any time.
     */
    try {
      const result = await deps.sender.sendDocumentNotice({
        to,
        documentLabel: documentLabelOf(stored.kind),
        reference: stored.refNumber ?? 'n/a',
      });
      const recorded = await conversationsRepo.recordOutbound(tx, {
        businessId,
        channel: 'meta',
        kind: 'text',
        body: `${documentLabelOf(stored.kind)} ${stored.refNumber ?? ''} is ready; reply RESEND to receive it`.replace(
          /\s+/g,
          ' ',
        ),
      });
      await conversationsRepo.markOutboundSent(tx, recorded.id, result.providerMessageId);
      const costMicros = MESSAGE_COST_MICROS.UTILITY_TEMPLATE;
      await quotaRepo.recordUsage(tx, {
        businessId,
        provider: 'meta',
        usageType: 'UTILITY_TEMPLATE',
        quantity: 1,
        providerCostMicros: costMicros,
        nairaEquivalentK: messageCostK(costMicros, deps.config.planningFxNairaPerUsd),
        billingPeriod: billingPeriod(new Date()),
        meta: { template: 'document', documentKind: stored.kind },
      });
      log.log(`document ${stored.refNumber ?? ''} not sent: window closed, owner notified`);
    } catch (error) {
      if (error instanceof SendFailed) {
        log.warn(`document notice not delivered, will retry: ${redactForLog(error.message)}`);
      }
      throw error;
    }
  };
}

/**
 * A receipt's caption is the owner's payment notification — the one WhatsApp
 * message that says confirmed money arrived, with the figure in it, so the
 * decision to release goods never requires opening a PDF. Everything else
 * keeps the generic "here is your copy" caption.
 *
 * Falls back to the generic caption if the receipt row cannot be found, which
 * would take manual data surgery — a slightly duller caption is the right
 * failure there, not an undelivered document.
 */
async function captionFor(
  tx: TenantDb,
  businessId: string,
  kind: string,
  refNumber: string | null,
): Promise<string> {
  if (kind === 'receipt_pdf' && refNumber) {
    const receipt = await settleRepo.receiptByNumber(tx, businessId, refNumber);
    const snapshot = receipt?.snapshot as Record<string, unknown> | undefined;
    if (snapshot) {
      const amountK = Number(snapshot['amountK'] ?? 0);
      const invoiceNumber = String(snapshot['invoiceNumber'] ?? '');
      /* "Confirmed" is a claim about a provider, not about a receipt, and
       * this caption is the message the merchant forwards. A payment they
       * reported themselves gets the caption that matches its receipt. */
      return snapshot['verified'] === false
        ? replies.receiptRecordedReady(amountK, invoiceNumber, refNumber).text
        : replies.paymentConfirmed(amountK, invoiceNumber, refNumber).text;
    }
  }
  return replies.documentSent(refNumber ?? 'Your document').text;
}

/** What the owner is told is waiting. Never the customer, never an amount. */
function documentLabelOf(kind: string): string {
  switch (kind) {
    case 'receipt_pdf':
      return 'receipt';
    case 'invoice_pdf':
      return 'invoice';
    case 'quote_pdf':
      return 'quote';
    default:
      return 'document';
  }
}
