import { Logger } from '@nestjs/common';
import { replies } from '@rekoda/core';
import { redactForLog } from '@rekoda/core/privacy';
import { identity, issueRepo, type Db } from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import type { PaymentIntentsService } from '../payments/payment-intents.service.js';
import type { ReplySender } from '../replies/reply.service.js';
import { describeFailure, type JobContext, type JobHandler } from './runner.js';

export interface PaymentLinkDeps {
  paymentIntents: PaymentIntentsService;
  replySender: ReplySender;
  /** For the owner's WhatsApp number, a question that lives above the tenant. */
  db: Db;
  config: ApiConfig;
}

/**
 * The payable link for an invoice that has just been raised (payments-v1
 * §160, MASTER-PLAN §5.3.5).
 *
 * A job, and it has to be. `PaymentIntentsService` opens its own transactions
 * and talks to a provider over HTTP; the invoice it needs to read is written
 * by the transaction that confirms the order, so a mint attempted in that
 * same breath would be looking for a row that has not committed yet. The job
 * is enqueued inside that transaction and runs after it, which is the same
 * discipline `document.render` already follows for the same reason.
 *
 * ── why almost every outcome is silent ─────────────────────────────────────
 *
 * This message is not one the merchant asked for by name. It arrives on the
 * back of a yes about something else, so the bar for sending it is that it
 * carries something they can use: a URL to forward. Every other outcome is a
 * fact about Rekoda's plumbing that they can already get, in better words, by
 * typing "send payment details" — and a shop with no Paystack connection
 * would otherwise be told so after every single order, forever.
 *
 * So: a link, or nothing.
 */
export function paymentLinkHandler(deps: PaymentLinkDeps): JobHandler {
  const log = new Logger('PaymentLinkJob');

  return async ({ tx, payload, businessId }: JobContext): Promise<void> => {
    const invoiceId = typeof payload['invoiceId'] === 'string' ? payload['invoiceId'] : null;
    if (!invoiceId) throw new Error('payment.link: payload is missing invoiceId');

    const to = await identity.ownerPhoneFor(deps.db, businessId);
    if (!to) throw new Error('payment.link: business has no owner to send to');

    /**
     * STOP is honoured, and this is the conservative reading of it.
     *
     * A merchant who confirmed an order thirty seconds ago is arguably asking
     * for what follows from it. But they have also said in as many words that
     * Rekoda should stop messaging them, and a follow-up they did not name is
     * exactly the kind of message that instruction covers. They keep the
     * explicit route: "send payment details" is one line and answers in full.
     */
    if (await identity.optedOutAt(deps.db, to)) {
      log.log('payment link suppressed: the owner has opted out of messages');
      return;
    }

    const invoice = await issueRepo.invoiceForPayment(tx, businessId, invoiceId);
    if (!invoice) {
      /* Another tenant's id, or an invoice voided between the confirmation
       * and this job. Nothing to retry and nothing to say. */
      log.warn('payment.link: no such invoice for this tenant');
      return;
    }

    let outcome;
    try {
      outcome = await deps.paymentIntents.createForInvoice(businessId, invoiceId);
    } catch (error: unknown) {
      /* A provider outage is not a reason to retry forever behind the
       * merchant's back: they have the invoice, and the explicit command is
       * there when they want the link. Logged and dropped. */
      log.warn(`payment link failed at the provider: ${redactForLog(describeFailure(error))}`);
      return;
    }

    if (outcome.state !== 'ready') {
      log.log(`payment link not offered: ${outcome.state}`);
      return;
    }

    await deps.replySender.send(tx, {
      businessId,
      to,
      reply: replies.paymentLinkReady(invoice.invoiceNumber, outcome.amountK, outcome.checkoutUrl),
    });
  };
}
