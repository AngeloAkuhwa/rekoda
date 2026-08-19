/**
 * Minting payment intents (docs/payments-v1.md §8–13).
 *
 * The order is the architecture: the PaymentIntent exists BEFORE anything
 * reaches a provider, under a reference Rekoda minted. The provider call
 * happens OUTSIDE the database transaction — network I/O holding a connection
 * open is how pools die — so an intent whose initialisation failed simply
 * stays `created`, retryable and expirable, never half-written.
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
  | { state: 'requires_customer_information'; missing: readonly string[] }
  | { state: 'connection_not_active'; connectionStatus: string }
  | { state: 'nothing_to_pay' };

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
    /* Phase 1 — everything the provider call needs, in one pinned read. */
    const prepared = await withBusiness(this.db, businessId, async (tx) => {
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
      if (!email) return { state: 'requires_customer_information' as const, missing: ['email'] };

      /* Re-offering payment for the same invoice reuses the live intent —
       * one obligation, one reference. */
      const existing = await paymentsHub.liveIntentForInvoice(tx, businessId, invoiceId);
      if (existing?.providerCheckoutRef) {
        return {
          state: 'reuse' as const,
          reference: existing.reference,
          checkoutUrl: existing.providerCheckoutRef,
          amountK: existing.expectedAmountK,
        };
      }

      const intent =
        existing ??
        (await this.mintIntent(tx, {
          businessId,
          invoiceId,
          customerId: invoice.customerId,
          amountK: invoice.balanceDueK,
          currency: invoice.currency,
          connectionId: connection.id,
        }));

      return {
        state: 'initialise' as const,
        intentId: intent.id,
        reference: intent.reference,
        amountK: intent.expectedAmountK,
        currency: intent.currency,
        email,
        subaccountCode: connection.externalSubaccountId,
      };
    });

    if (prepared.state !== 'initialise') {
      if (prepared.state === 'reuse') {
        return {
          state: 'ready',
          reference: prepared.reference,
          checkoutUrl: prepared.checkoutUrl,
          amountK: prepared.amountK,
        };
      }
      return prepared;
    }

    /* Phase 2 — the provider, outside any transaction. */
    const initialised = await this.provider.initializeTransaction({
      reference: prepared.reference,
      amountK: prepared.amountK,
      currency: prepared.currency,
      customerEmail: prepared.email,
      subaccountCode: prepared.subaccountCode,
    });
    if (initialised.state === 'requires_customer_information') return initialised;

    /* Phase 3 — record what the provider handed back. */
    await withBusiness(this.db, businessId, async (tx) => {
      const advanced = await paymentsHub.advanceIntent(tx, prepared.intentId, 'awaiting_customer', {
        providerCheckoutRef: initialised.checkoutUrl,
      });
      if (!advanced) this.log.warn('intent went terminal while being initialised');
    });

    return {
      state: 'ready',
      reference: prepared.reference,
      checkoutUrl: initialised.checkoutUrl,
      amountK: prepared.amountK,
    };
  }

  /** Mint with retry: the database owns uniqueness, we own persistence. */
  private async mintIntent(
    tx: TenantDb,
    input: {
      businessId: string;
      invoiceId: string;
      customerId: string | null;
      amountK: number;
      currency: string;
      connectionId: string;
    },
  ) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await paymentsHub.createIntent(tx, {
          businessId: input.businessId,
          reference: paymentReference(new Date(), randomBytes),
          expectedAmountK: input.amountK,
          currency: input.currency,
          providerType: this.provider.providerType,
          paymentConnectionId: input.connectionId,
          customerId: input.customerId,
          invoiceId: input.invoiceId,
          expiresAt: new Date(Date.now() + INTENT_TTL_MS),
        });
      } catch (error) {
        if (error instanceof paymentsHub.ReferenceCollision && attempt < MINT_ATTEMPTS) continue;
        throw error;
      }
    }
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
    return decryptFacet(emailFacet.ciphertext, this.config.vaultKey);
  }
}
