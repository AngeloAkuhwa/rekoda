/**
 * Connection onboarding (docs/payments-v1.md §3–5, §47).
 *
 * The merchant hands over exactly what §3 allows to be collected: bank code,
 * account number, account name. The account number lives ONE hop in
 * plaintext — form → provider over TLS — and is stored only as a
 * CONNECTION_KEY cipher plus last4. No response, log or reply carries it
 * back out; every surface renders "•••• 4821".
 *
 * §47 runs in code, not in a runbook: a LIVE Paystack key refuses to create
 * subaccounts until REKODA_PAYSTACK_PLATFORM_CONFIRMED records that the
 * written platform-model confirmation exists. Test keys proceed, because
 * sandbox-first (§36) is how the confirmation gets earned.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { encryptFacet } from '@rekoda/core/vault';
import { paymentsHub, withBusiness, type Db } from '@rekoda/db';
import type { SubmitConnectionRequest } from '@rekoda/contracts';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import { PAYMENT_PROVIDER, type PaymentProviderPort } from './provider.port.js';

export type ConnectionView = {
  status: string;
  kycStatus: string | null;
  providerType: string | null;
  bankCode: string | null;
  accountLast4: string | null;
  accountName: string | null;
};

const NOT_CONFIGURED: ConnectionView = {
  status: 'not_configured',
  kycStatus: null,
  providerType: null,
  bankCode: null,
  accountLast4: null,
  accountName: null,
};

export type SubmitOutcome =
  /** Details stored. `held` says why activation has not happened yet. */
  | { state: 'submitted'; connection: ConnectionView; held?: 'awaiting_platform_confirmation' }
  /** Nothing stored: the deployment cannot hold the account number safely. */
  | { state: 'unavailable'; reason: 'connection_key_missing' };

@Injectable()
export class PaymentConnectionsService {
  private readonly log = new Logger(PaymentConnectionsService.name);

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderPort,
  ) {}

  async view(businessId: string): Promise<ConnectionView> {
    const row = await withBusiness(this.db, businessId, (tx) =>
      paymentsHub.connectionFor(tx, businessId, this.provider.providerType),
    );
    return row ? this.toView(row) : NOT_CONFIGURED;
  }

  /**
   * Store the settlement details and, where policy allows, create the
   * provider-side subaccount. The provider call happens OUTSIDE any database
   * transaction; a crash in between leaves `pending_provider_creation`,
   * which is retryable by resubmitting, never half-active.
   */
  async submit(businessId: string, input: SubmitConnectionRequest): Promise<SubmitOutcome> {
    if (!this.config.connectionKey) {
      // A deployment without the key cannot store the account safely, so it
      // refuses plainly instead of storing it unsafely.
      return { state: 'unavailable', reason: 'connection_key_missing' };
    }

    const businessName = await withBusiness(this.db, businessId, async (tx) => {
      const connection = await paymentsHub.upsertConnection(tx, {
        businessId,
        providerType: this.provider.providerType,
        settlementBankCode: input.bankCode,
        /* Bound to this business and this column: a blob moved onto another
         * row fails authentication rather than reading as that merchant's
         * account. Any future payout path must decrypt with the same aad. */
        settlementAccountCipher: encryptFacet(
          input.accountNumber,
          this.config.connectionKey,
          `${businessId}:settlement_account`,
        ),
        settlementAccountLast4: input.accountNumber.slice(-4),
        settlementAccountName: input.accountName,
      });
      return { connectionId: connection.id, name: input.accountName };
    });

    /**
     * §47: live keys wait for the written confirmation. The connection row
     * exists (details captured once, safely) and surfaces the honest state;
     * flipping the flag later activates on the next submit, with nothing
     * re-entered.
     */
    const liveKey = this.config.paystackSecretKey.startsWith('sk_live');
    if (!this.config.paystackSecretKey || (liveKey && !this.config.paystackPlatformConfirmed)) {
      if (liveKey) this.log.warn('subaccount creation held: §47 confirmation flag is not set');
      // Details are stored ONCE, safely; the row honestly reads
      // pending_provider_creation, and flipping the §47 flag (or adding a
      // key) activates on resubmit with nothing re-entered.
      return {
        state: 'submitted',
        connection: await this.view(businessId),
        held: 'awaiting_platform_confirmation',
      };
    }

    const created = await this.provider.createSubaccount({
      businessName: businessName.name,
      settlementBankCode: input.bankCode,
      settlementAccountNumber: input.accountNumber,
    });

    const connection = await withBusiness(this.db, businessId, async (tx) => {
      const row = await paymentsHub.connectionFor(tx, businessId, this.provider.providerType);
      if (!row) throw new Error('submit: connection row vanished mid-flight');
      if (created.state === 'created') {
        /**
         * Straight to ACTIVE: Paystack validates the account at creation,
         * and V1 has no further KYC step of its own (§47 keeps provider
         * KYC in the provider). pending_settlement_verification exists in
         * the state machine for providers that need it.
         */
        await paymentsHub.setConnectionState(tx, row.id, {
          status: 'active',
          kycStatus: 'provider_validated',
          externalSubaccountId: created.subaccountCode,
        });
      } else {
        await paymentsHub.setConnectionState(tx, row.id, { status: 'failed' });
      }
      return paymentsHub.connectionFor(tx, businessId, this.provider.providerType);
    });

    return {
      state: 'submitted',
      connection: connection ? this.toView(connection) : NOT_CONFIGURED,
    };
  }

  private toView(row: {
    status: string;
    kycStatus: string;
    settlementBankCode: string | null;
    settlementAccountLast4: string | null;
    settlementAccountName: string | null;
  }): ConnectionView {
    return {
      status: row.status,
      kycStatus: row.kycStatus,
      providerType: this.provider.providerType,
      bankCode: row.settlementBankCode,
      accountLast4: row.settlementAccountLast4,
      accountName: row.settlementAccountName,
    };
  }
}
