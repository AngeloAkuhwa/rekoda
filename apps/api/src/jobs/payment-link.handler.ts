import { Logger } from '@nestjs/common';
import { replies } from '@rekoda/core';
import { redactForLog } from '@rekoda/core/privacy';
import { decryptFacet } from '@rekoda/core/vault';
import { customersRepo, identity, issueRepo, type Db, type TenantDb } from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import type { PaymentIntentsService } from '../payments/payment-intents.service.js';
import type { ReplySender } from '../replies/reply.service.js';
import type {
  SendCustomerTextInput,
  SendCustomerTextOutcome,
} from '../channels/waba-templates.service.js';
import { describeFailure, type JobContext, type JobHandler } from './runner.js';

/** The one door PR-089/PR-090 need from the WABA send-time machinery (PR-061). */
export interface CustomerTexts {
  sendCustomerText(
    businessId: string,
    input: SendCustomerTextInput,
    /** A caller mid-transaction passes its tx so its own uncommitted
     * window touch is visible; the send then commits with its work. */
    outerTx?: TenantDb,
  ): Promise<SendCustomerTextOutcome>;
}

export interface PaymentLinkDeps {
  paymentIntents: PaymentIntentsService;
  replySender: ReplySender;
  /** The customer's thread on the merchant's own WABA (spec §3.2; PR-089). */
  customerTexts: CustomerTexts;
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
 * Two shapes now live here, split by the invoice's OWN provenance:
 *
 * A chat or storefront invoice keeps the original contract — the merchant
 * gets a URL to forward, or nothing. This message is not one the merchant
 * asked for by name, so the bar for sending it is that it carries something
 * they can use; every other outcome is a fact about Rekoda's plumbing they
 * can get, in better words, by typing "send payment details".
 *
 * A `waba_catalogue` invoice is §3.2's journey mid-flight: the CUSTOMER
 * composed the order in their own thread on the merchant's WABA, so the
 * checkout goes back into that thread — the same service window their cart
 * opened, through the same metered door every customer send uses — and the
 * merchant's message becomes a notice of the order rather than a link to
 * forward. When the customer cannot be reached (window somehow closed,
 * capacity at zero, no phone facet), the forwardable link falls back to the
 * merchant, because a checkout nobody holds collects nothing; and when no
 * link could be raised at all, the merchant still hears the order landed,
 * because an invisible order does not get fulfilled.
 */
export function paymentLinkHandler(deps: PaymentLinkDeps): JobHandler {
  const log = new Logger('PaymentLinkJob');

  return async ({ tx, payload, businessId }: JobContext): Promise<void> => {
    const invoiceId = typeof payload['invoiceId'] === 'string' ? payload['invoiceId'] : null;
    if (!invoiceId) throw new Error('payment.link: payload is missing invoiceId');

    const invoice = await issueRepo.invoiceForPayment(tx, businessId, invoiceId);
    if (!invoice) {
      /* Another tenant's id, or an invoice voided between the confirmation
       * and this job. Nothing to retry and nothing to say. */
      log.warn('payment.link: no such invoice for this tenant');
      return;
    }

    if (invoice.sourceType === 'waba_catalogue') {
      await catalogueCheckout(deps, log, tx, businessId, invoice);
      return;
    }

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

    const outcome = await mintLink(deps, log, businessId, invoiceId);
    if (!outcome || outcome.state !== 'ready') return;

    await deps.replySender.send(tx, {
      businessId,
      to,
      reply: replies.paymentLinkReady(invoice.invoiceNumber, outcome.amountK, outcome.checkoutUrl),
    });
  };
}

/** The provider mint, with an outage logged and dropped rather than retried
 * forever behind the merchant's back. Null means the provider failed. */
async function mintLink(
  deps: PaymentLinkDeps,
  log: Logger,
  businessId: string,
  invoiceId: string,
): Promise<Awaited<ReturnType<PaymentIntentsService['createForInvoice']>> | null> {
  try {
    return await deps.paymentIntents.createForInvoice(businessId, invoiceId);
  } catch (error: unknown) {
    log.warn(`payment link failed at the provider: ${redactForLog(describeFailure(error))}`);
    return null;
  }
}

/**
 * §3.2's checkout leg: the validated figure into the customer's thread,
 * the order's fact into the merchant's.
 */
async function catalogueCheckout(
  deps: PaymentLinkDeps,
  log: Logger,
  tx: TenantDb,
  businessId: string,
  invoice: NonNullable<Awaited<ReturnType<typeof issueRepo.invoiceForPayment>>>,
): Promise<void> {
  const outcome = await mintLink(deps, log, businessId, invoice.id);
  if (outcome?.state === 'nothing_to_pay') return; // Settled already; the loop is closed.
  if (outcome && outcome.state !== 'ready' && outcome.state !== 'requires_customer_information') {
    log.log(`payment link not offered: ${outcome.state}`);
  }
  const checkoutUrl = outcome?.state === 'ready' ? outcome.checkoutUrl : null;
  const amountK = outcome?.state === 'ready' ? outcome.amountK : invoice.balanceDueK;

  /* The customer, in the thread their cart opened. The raw number exists in
   * memory for the length of this send — decrypted at this authorised
   * boundary exactly as the mint decrypts their email — and any failure in
   * this leg must not cost the merchant their own message: a checkout that
   * cannot reach the customer falls back to a forwardable link. */
  let customerSent = false;
  const phone = invoice.customerId
    ? await customerPhone(deps, tx, businessId, invoice.customerId)
    : null;
  if (phone) {
    try {
      const sent = await deps.customerTexts.sendCustomerText(businessId, {
        to: phone,
        text: replies.catalogueCheckout(invoice.invoiceNumber, amountK, checkoutUrl).text,
      });
      customerSent = sent.outcome === 'sent';
      if (!customerSent) log.log(`customer checkout not delivered: ${sent.outcome}`);
    } catch (error: unknown) {
      log.warn(`customer checkout send failed: ${redactForLog(describeFailure(error))}`);
    }
  }

  /* The merchant's notice — STOP honoured exactly as the chat shape honours
   * it, because this too is a message they did not ask for by name. The
   * customer leg above is not covered by their STOP: it goes out on THEIR
   * channel to THEIR customer, which is the product working, not Rekoda
   * messaging them. */
  const to = await identity.ownerPhoneFor(deps.db, businessId);
  if (!to) throw new Error('payment.link: business has no owner to send to');
  if (await identity.optedOutAt(deps.db, to)) {
    log.log('order notice suppressed: the owner has opted out of messages');
    return;
  }

  const reply =
    customerSent && checkoutUrl
      ? replies.catalogueOrderDelivered(invoice.invoiceNumber, amountK)
      : checkoutUrl
        ? replies.paymentLinkReady(invoice.invoiceNumber, amountK, checkoutUrl)
        : replies.catalogueOrderNoLink(invoice.invoiceNumber, amountK);
  await deps.replySender.send(tx, { businessId, to, reply });
}

/**
 * The customer's real phone, or null. Decrypted HERE — the same authorised
 * boundary as `PaymentIntentsService.customerEmail` — held in memory for the
 * send and never stored, logged or placed in a payload (F.3).
 */
async function customerPhone(
  deps: PaymentLinkDeps,
  tx: TenantDb,
  businessId: string,
  customerId: string,
): Promise<string | null> {
  const facets = await customersRepo.identityFacetsFor(tx, businessId, customerId);
  const phoneFacet = facets.find((f) => f.facet === 'phone');
  if (!phoneFacet) return null;
  return decryptFacet(phoneFacet.ciphertext, deps.config.vaultKey, `${businessId}:phone`);
}
