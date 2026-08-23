/**
 * Minting payment intents (docs/payments-v1.md §8–13).
 *
 * The order is the architecture: the PaymentIntent exists BEFORE anything
 * reaches a provider, under a reference Rekoda minted. The provider call
 * happens OUTSIDE any database transaction — network I/O holding a
 * connection open is how pools die — so an intent whose initialisation
 * failed simply stays `created`, retryable and expirable, never half-written.
 *
 * The mint itself runs in its OWN small transaction per attempt, for a
 * PostgreSQL reason worth remembering: after a unique violation the enclosing
 * transaction is aborted, so "catch and retry inside the same transaction"
 * dies on the retry with 25P02. Each attempt is a fresh transaction, and the
 * two ways of losing are told apart by constraint: a reference collision
 * retries with a fresh reference, a live-intent collision looks up the
 * winner — one obligation, one reference, decided by the database
 * (`payment_intents_live_invoice_ux`), not by a read-then-write.
 *
 * Everything the provider receives is read deterministically from domain
 * records: the amount from the invoice, the email from the customer's
 * encrypted facet (decrypted here, at the authorised boundary, and handed
 * straight to the provider adapter). No model output touches this path, and
 * no email is ever invented — a customer Rekoda cannot identify gets
 * `requires_customer_information`, which is a product state, not an error.
 */
import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { paymentReference } from '@rekoda/core';
import { decryptFacet } from '@rekoda/core/vault';
import {
  customersRepo,
  issueRepo,
  paymentsHub,
  withBusiness,
  type Db,
  type TenantDb,
} from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import { PAYMENT_PROVIDER, type PaymentProviderPort } from './provider.port.js';

const MINT_ATTEMPTS = 3;
const INTENT_TTL_MS = 24 * 60 * 60 * 1000;

export type IntentCreation =
  | { state: 'ready'; reference: string; checkoutUrl: string; amountK: number }
  | {
      state: 'requires_customer_information';
      missing: readonly string[];
      /** Pre-mint no-email is fixable by the merchant; a post-mint provider
       * rejection is not their doing and must not be blamed on their records. */
      reason: 'no_email_on_file' | 'provider_rejected_details';
    }
  | { state: 'connection_not_active'; connectionStatus: string }
  | { state: 'nothing_to_pay' };

interface PreparedMint {
  state: 'mint';
  customerId: string | null;
  amountK: number;
  currency: string;
  connectionId: string;
  email: string;
  subaccountCode: string | null;
}

interface ReusableIntent {
  state: 'have_intent';
  intentId: string;
  reference: string;
  amountK: number;
  currency: string;
  checkoutUrl: string | null;
  email: string;
  subaccountCode: string | null;
}

@Injectable()
export class PaymentIntentsService {
  private readonly log = new Logger(PaymentIntentsService.name);

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderPort,
  ) {}

  /** The one entry point: an obligation (an invoice) becomes a payable link. */
  async createForInvoice(businessId: string, invoiceId: string): Promise<IntentCreation> {
    /* Phase 1 — everything the mint needs, in one pinned read. Overdue
     * intents are expired FIRST, so a stale reference is never "reused". */
    const prepared = await withBusiness(this.db, businessId, async (tx) => {
      await paymentsHub.expireOverdueIntents(tx, businessId);

      const invoice = await issueRepo.invoiceForPayment(tx, businessId, invoiceId);
      if (!invoice) throw new Error('createForInvoice: no such invoice for this tenant');
      if (invoice.balanceDueK <= 0) return { state: 'nothing_to_pay' as const };

      const connection = await paymentsHub.connectionFor(
        tx,
        businessId,
        this.provider.providerType,
      );
      if (!connection || connection.status !== 'active') {
        // §47: no provider traffic for a business whose connection is not
        // ACTIVE — pending KYC, suspended and disconnected all stop here.
        return {
          state: 'connection_not_active' as const,
          connectionStatus: connection?.status ?? 'not_configured',
        };
      }

      const email = await this.customerEmail(tx, businessId, invoice.customerId);
      if (!email) {
        return {
          state: 'requires_customer_information' as const,
          missing: ['email'],
          reason: 'no_email_on_file' as const,
        };
      }

      /* Re-offering payment for the same invoice reuses the live intent —
       * one obligation, one reference. */
      const existing = await paymentsHub.liveIntentForInvoice(tx, businessId, invoiceId);
      if (existing) {
        return {
          state: 'have_intent',
          intentId: existing.id,
          reference: existing.reference,
          amountK: existing.expectedAmountK,
          currency: existing.currency,
          checkoutUrl: existing.providerCheckoutRef,
          email,
          subaccountCode: connection.externalSubaccountId,
        } satisfies ReusableIntent;
      }

      return {
        state: 'mint',
        customerId: invoice.customerId,
        amountK: invoice.balanceDueK,
        currency: invoice.currency,
        connectionId: connection.id,
        email,
        subaccountCode: connection.externalSubaccountId,
      } satisfies PreparedMint;
    });

    if (
      prepared.state === 'nothing_to_pay' ||
      prepared.state === 'connection_not_active' ||
      prepared.state === 'requires_customer_information'
    ) {
      return prepared;
    }

    const intent =
      prepared.state === 'have_intent'
        ? prepared
        : await this.mintIntent(businessId, invoiceId, prepared);

    /* Already initialised on a previous call: hand back the same checkout. */
    if (intent.checkoutUrl) {
      return {
        state: 'ready',
        reference: intent.reference,
        checkoutUrl: intent.checkoutUrl,
        amountK: intent.amountK,
      };
    }

    /* Phase 2 — the provider, outside any transaction. */
    const initialised = await this.provider.initializeTransaction({
      reference: intent.reference,
      amountK: intent.amountK,
      currency: intent.currency,
      customerEmail: prepared.email,
      subaccountCode: prepared.subaccountCode,
    });
    if (initialised.state === 'requires_customer_information') {
      return { ...initialised, reason: 'provider_rejected_details' };
    }

    /* Phase 3 — record what the provider handed back. */
    await withBusiness(this.db, businessId, async (tx) => {
      const advanced = await paymentsHub.advanceIntent(tx, intent.intentId, 'awaiting_customer', {
        providerCheckoutRef: initialised.checkoutUrl,
      });
      if (!advanced) this.log.warn('intent went terminal while being initialised');
    });

    return {
      state: 'ready',
      reference: intent.reference,
      checkoutUrl: initialised.checkoutUrl,
      amountK: intent.amountK,
    };
  }

  /**
   * Mint, one transaction per attempt. Losing to a reference collision means
   * a fresh reference; losing to the live-invoice index means another caller
   * minted first, and their intent is the answer.
   */
  private async mintIntent(
    businessId: string,
    invoiceId: string,
    input: PreparedMint,
  ): Promise<{
    intentId: string;
    reference: string;
    amountK: number;
    currency: string;
    checkoutUrl: string | null;
  }> {
    for (let attempt = 1; attempt <= MINT_ATTEMPTS; attempt++) {
      try {
        const minted = await withBusiness(this.db, businessId, (tx) =>
          paymentsHub.createIntent(tx, {
            businessId,
            reference: paymentReference(new Date(), randomBytes),
            expectedAmountK: input.amountK,
            currency: input.currency,
            providerType: this.provider.providerType,
            paymentConnectionId: input.connectionId,
            customerId: input.customerId,
            invoiceId,
            expiresAt: new Date(Date.now() + INTENT_TTL_MS),
          }),
        );
        return {
          intentId: minted.id,
          reference: minted.reference,
          amountK: minted.expectedAmountK,
          currency: minted.currency,
          checkoutUrl: null,
        };
      } catch (error) {
        if (error instanceof paymentsHub.LiveIntentExists) {
          const winner = await withBusiness(this.db, businessId, (tx) =>
            paymentsHub.liveIntentForInvoice(tx, businessId, invoiceId),
          );
          if (winner) {
            return {
              intentId: winner.id,
              reference: winner.reference,
              amountK: winner.expectedAmountK,
              currency: winner.currency,
              checkoutUrl: winner.providerCheckoutRef,
            };
          }
          continue; // the winner went terminal in the gap — mint again
        }
        if (error instanceof paymentsHub.ReferenceCollision && attempt < MINT_ATTEMPTS) continue;
        throw error;
      }
    }
    throw new Error('mintIntent: could not mint a unique reference');
  }

  /**
   * The customer's real email, or null. Decrypted HERE — the same authorised
   * boundary as ReplySender — and handed only to the provider adapter.
   */
  private async customerEmail(
    tx: TenantDb,
    businessId: string,
    customerId: string | null,
  ): Promise<string | null> {
    if (!customerId) return null;
    const facets = await customersRepo.identityFacetsFor(tx, businessId, customerId);
    const emailFacet = facets.find((f) => f.facet === 'email');
    if (!emailFacet) return null;
    return decryptFacet(emailFacet.ciphertext, this.config.vaultKey, `${businessId}:email`);
  }
}
