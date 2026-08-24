/**
 * Pay with Transfer on the merchant's own key (ADR 0016 + 0019, fix-plan 6
 * M5c).
 *
 * The storefront's collection path, and deliberately NOT the platform
 * `PaymentIntentsService`: that service charges Rekoda's Paystack
 * integration and waits on the §47 confirmation; this one charges the
 * MERCHANT's, whose key M5a vaulted, so the money lands in their own
 * balance and Rekoda never enters the flow.
 *
 * The shape per invoice is the ADR's: one temporary account per
 * transaction, generous expiry, and when it lapses unpaid the invoice
 * simply stays open and the next ask mints a fresh number. Confirmation is
 * verify-first — the customer's word starts a server-side verify against
 * the merchant's key, and only Paystack's own answer books money.
 *
 * The customer's email exists because Paystack's charge requires one. It
 * travels to the provider and is not stored: a buyer's address given for
 * one payment is not a record Rekoda keeps.
 */
import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  GRADUATION_NUDGE_K,
  judgeProviderPayment,
  paymentReference,
  type FeePolicy,
} from '@rekoda/core';
import { decryptFacet } from '@rekoda/core/vault';
import {
  issueRepo,
  jobsRepo,
  ordersRepo,
  paymentsHub,
  settleRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import {
  createTransferCharge,
  PaystackApiError,
  verifyPaystackTransaction,
} from './paystack.provider.js';

/**
 * How long a temporary account works. ADR 0016: hours, not the 15-minute
 * minimum — WhatsApp commerce is not instant. Six hours sits inside
 * Paystack's 8-hour ceiling with room for clock skew. The INTENT expires
 * with the account, which is what makes "get a fresh number" one call: the
 * lapsed intent leaves the live-invoice index on the next expiry sweep.
 */
const ACCOUNT_TTL_MS = 6 * 60 * 60 * 1000;
/** An account about to lapse is not re-offered; a fresh one is. */
const REUSE_MARGIN_MS = 10 * 60 * 1000;
const MINT_ATTEMPTS = 3;
const PROVIDER = 'paystack';

export type TransferAccountOutcome =
  | {
      state: 'account';
      bankName: string;
      accountNumber: string;
      accountName: string | null;
      amountK: number;
      expiresAtIso: string | null;
      reference: string;
    }
  | { state: 'not_available' }
  | { state: 'order_gone' }
  | { state: 'nothing_to_pay' }
  | { state: 'provider_down' };

export type TransferStatusOutcome =
  | { state: 'paid'; receiptNumber: string | null }
  | { state: 'pending' }
  | { state: 'expired' }
  | { state: 'order_gone' };

interface MerchantKeyDeps {
  appDb: Db;
  connectionKey: string;
  paystackBaseUrl: string;
}

@Injectable()
export class MerchantTransferService {
  private readonly log = new Logger(MerchantTransferService.name);

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
  ) {}

  private deps(): MerchantKeyDeps {
    return {
      appDb: this.db,
      connectionKey: this.config.connectionKey,
      paystackBaseUrl: this.config.paystackBaseUrl,
    };
  }

  /**
   * A temporary account for the order this clientRef placed. Re-shows a
   * still-valid number rather than minting a second; mints fresh once the
   * old one has lapsed or is about to.
   */
  async accountFor(
    businessId: string,
    clientRef: string,
    email: string,
  ): Promise<TransferAccountOutcome> {
    if (!this.config.connectionKey) return { state: 'not_available' };

    const prepared = await withBusiness(this.db, businessId, async (tx) => {
      const order = await ordersRepo.orderByExternalRef(tx, businessId, `shop:${clientRef}`);
      if (!order?.invoiceId) return { state: 'order_gone' as const };
      const invoice = await issueRepo.invoiceForPayment(tx, businessId, order.invoiceId);
      if (!invoice) return { state: 'order_gone' as const };
      if (invoice.balanceDueK <= 0) return { state: 'nothing_to_pay' as const };

      const connection = await paymentsHub.connectionFor(tx, businessId, PROVIDER);
      if (!connection || connection.status !== 'active' || connection.keyMode !== 'merchant_key') {
        return { state: 'not_available' as const };
      }
      const cipher = await paymentsHub.merchantKeyCipherFor(tx, businessId, PROVIDER);
      if (!cipher) return { state: 'not_available' as const };

      /* Lapsed accounts leave the live-invoice index here, which is exactly
       * how "get a fresh number" stays one call. */
      await paymentsHub.expireOverdueIntents(tx, businessId);

      const live = await paymentsHub.liveIntentForInvoice(tx, businessId, order.invoiceId);
      if (live) {
        const account = await paymentsHub.transferAccountFor(tx, businessId, live.id);
        if (
          account &&
          (!account.expiresAt || account.expiresAt.getTime() > Date.now() + REUSE_MARGIN_MS)
        ) {
          return {
            state: 'reuse' as const,
            account,
            reference: live.reference,
            amountK: live.expectedAmountK,
          };
        }
        /* A live intent with no usable account: a near-lapsed number, or a
         * platform-path intent from before the keyMode guard. Retire it so
         * one obligation keeps one live reference. */
        await paymentsHub.advanceIntent(tx, live.id, 'cancelled');
      }

      return {
        state: 'mint' as const,
        invoiceId: order.invoiceId,
        customerId: invoice.customerId,
        amountK: invoice.balanceDueK,
        currency: invoice.currency,
        cipher,
      };
    });

    if (prepared.state === 'reuse') {
      return {
        state: 'account',
        bankName: prepared.account.bank,
        accountNumber: prepared.account.accountNumber,
        accountName: prepared.account.accountName,
        amountK: prepared.amountK,
        expiresAtIso: prepared.account.expiresAt?.toISOString() ?? null,
        reference: prepared.reference,
      };
    }
    if (prepared.state !== 'mint') return prepared;

    const secretKey = decryptFacet(
      prepared.cipher,
      this.config.connectionKey,
      `${businessId}:merchant_key`,
    );

    /* Phase 1 — the intent, before any provider traffic, expiring WITH the
     * account it is about to carry. */
    const expiresAt = new Date(Date.now() + ACCOUNT_TTL_MS);
    const intent = await this.mint(businessId, prepared, expiresAt);

    /* Phase 2 — the provider, outside any transaction, on the MERCHANT's key. */
    let charged;
    try {
      charged = await createTransferCharge(secretKey, this.config.paystackBaseUrl, {
        reference: intent.reference,
        amountK: intent.amountK,
        currency: intent.currency,
        email,
        expiresAtIso: expiresAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof PaystackApiError) {
        /* The intent stays `created` and expires on its own; nothing was
         * charged, so nothing needs undoing. */
        this.log.warn('Pay with Transfer: Paystack would not answer');
        return { state: 'provider_down' };
      }
      throw error;
    }
    if (charged.state === 'refused') {
      /* Paystack looked and said no — a dead key, a disabled channel. The
       * intent is retired so the next attempt starts clean. */
      await withBusiness(this.db, businessId, (tx) =>
        paymentsHub.advanceIntent(tx, intent.id, 'cancelled'),
      );
      this.log.warn('Pay with Transfer: the merchant integration refused the charge');
      return { state: 'not_available' };
    }

    /* Phase 3 — record what the provider handed back. */
    const account = {
      bank: charged.bankName,
      accountNumber: charged.accountNumber,
      accountName: charged.accountName,
      expiresAt: charged.expiresAtIso ? new Date(charged.expiresAtIso) : expiresAt,
    };
    await withBusiness(this.db, businessId, async (tx) => {
      await paymentsHub.recordTransferAccount(tx, intent.id, account);
      await paymentsHub.advanceIntent(tx, intent.id, 'awaiting_customer');
    });

    return {
      state: 'account',
      bankName: charged.bankName,
      accountNumber: charged.accountNumber,
      accountName: charged.accountName,
      amountK: intent.amountK,
      expiresAtIso: account.expiresAt.toISOString(),
      reference: intent.reference,
    };
  }

  /**
   * Has the transfer landed? Verify-first: the reference is checked against
   * the merchant's own key, and only a confirmed success books.
   */
  async statusFor(businessId: string, clientRef: string): Promise<TransferStatusOutcome> {
    const read = await withBusiness(this.db, businessId, async (tx) => {
      const order = await ordersRepo.orderByExternalRef(tx, businessId, `shop:${clientRef}`);
      if (!order?.invoiceId) return { state: 'order_gone' as const };
      const invoice = await issueRepo.invoiceForPayment(tx, businessId, order.invoiceId);
      if (!invoice) return { state: 'order_gone' as const };
      if (invoice.balanceDueK <= 0) return { state: 'paid' as const };

      await paymentsHub.expireOverdueIntents(tx, businessId);
      const live = await paymentsHub.liveIntentForInvoice(tx, businessId, order.invoiceId);
      if (!live) return { state: 'expired' as const };

      const cipher = await paymentsHub.merchantKeyCipherFor(tx, businessId, PROVIDER);
      if (!cipher) return { state: 'expired' as const };
      return { state: 'check' as const, reference: live.reference, cipher };
    });

    if (read.state === 'paid') return { state: 'paid', receiptNumber: null };
    if (read.state !== 'check') return read;

    const secretKey = decryptFacet(
      read.cipher,
      this.config.connectionKey,
      `${businessId}:merchant_key`,
    );
    const booked = await verifyAndBook(
      this.deps(),
      businessId,
      read.reference,
      secretKey,
      this.log,
    );
    if (booked.state === 'booked' || booked.state === 'already_booked') {
      return { state: 'paid', receiptNumber: booked.receiptNumber };
    }
    return { state: 'pending' };
  }

  /** Mint with the same two-constraint retry the platform service earned. */
  private async mint(
    businessId: string,
    input: { invoiceId: string; customerId: string | null; amountK: number; currency: string },
    expiresAt: Date,
  ): Promise<{ id: string; reference: string; amountK: number; currency: string }> {
    for (let attempt = 1; attempt <= MINT_ATTEMPTS; attempt++) {
      try {
        const minted = await withBusiness(this.db, businessId, (tx) =>
          paymentsHub.createIntent(tx, {
            businessId,
            reference: paymentReference(new Date(), randomBytes),
            expectedAmountK: input.amountK,
            currency: input.currency,
            providerType: PROVIDER,
            customerId: input.customerId,
            invoiceId: input.invoiceId,
            expiresAt,
          }),
        );
        return {
          id: minted.id,
          reference: minted.reference,
          amountK: minted.expectedAmountK,
          currency: minted.currency,
        };
      } catch (error) {
        if (error instanceof paymentsHub.LiveIntentExists) {
          /* The caller just cancelled or found no live intent; losing here
           * means another checkout tab won the mint. Reuse the winner. */
          const winner = await withBusiness(this.db, businessId, (tx) =>
            paymentsHub.liveIntentForInvoice(tx, businessId, input.invoiceId),
          );
          if (winner) {
            return {
              id: winner.id,
              reference: winner.reference,
              amountK: winner.expectedAmountK,
              currency: winner.currency,
            };
          }
          continue;
        }
        if (error instanceof paymentsHub.ReferenceCollision && attempt < MINT_ATTEMPTS) continue;
        throw error;
      }
    }
    throw new Error('merchant transfer mint: could not mint a unique reference');
  }
}

type VerifyAndBookOutcome =
  | { state: 'booked'; receiptNumber: string | null }
  | { state: 'already_booked'; receiptNumber: null }
  | { state: 'pending' }
  | { state: 'not_money' };

/**
 * Verify one reference on the merchant's key and, when Paystack confirms it,
 * book it exactly as the webhook path does: same judge, same one-winner
 * intent transition, same `bookVerifiedPayment`, receipt render enqueued in
 * the same transaction. Shared between the checkout's status poll and the
 * reconciliation sweep so there is exactly one way money books.
 */
async function verifyAndBook(
  deps: MerchantKeyDeps,
  businessId: string,
  reference: string,
  secretKey: string,
  log: Logger,
): Promise<VerifyAndBookOutcome> {
  let verified;
  try {
    verified = await verifyPaystackTransaction(secretKey, deps.paystackBaseUrl, reference);
  } catch (error) {
    if (error instanceof PaystackApiError) return { state: 'pending' };
    throw error;
  }
  if (!verified.found || !verified.transaction.succeeded) return { state: 'pending' };
  const t = verified.transaction;

  return withBusiness(deps.appDb, businessId, async (tx) => {
    const intent = await paymentsHub.intentByReference(tx, businessId, reference);
    if (!intent) return { state: 'pending' as const };

    const judgement = judgeProviderPayment(
      { reference: intent.reference, amountK: intent.expectedAmountK, currency: intent.currency },
      { reference: t.reference, amountK: t.amountK, currency: t.currency, succeeded: t.succeeded },
    );
    if (judgement.verdict === 'rejected') {
      /* Confirmed money that does not match the obligation — a human's
       * puzzle, recorded loudly, never booked quietly. */
      await settleRepo.recordException(tx, {
        businessId,
        reason: judgement.reason,
        expectationKind: intent.invoiceId ? 'invoice' : 'intent',
        expectationId: intent.invoiceId ?? intent.id,
        amountK: t.amountK,
      });
      log.warn(`Pay with Transfer: verified money did not match (${judgement.reason})`);
      return { state: 'not_money' as const };
    }

    const won = await paymentsHub.advanceIntent(tx, intent.id, 'succeeded', {
      providerReference: t.providerTransactionId,
    });
    if (!won) {
      const current = await paymentsHub.intentByReference(tx, businessId, reference);
      if (current?.status === 'succeeded')
        return { state: 'already_booked' as const, receiptNumber: null };
      /* Real money against a lapsed intent: late by definition (§37). */
      await settleRepo.recordException(tx, {
        businessId,
        reason: 'late_confirmation',
        expectationKind: intent.invoiceId ? 'invoice' : 'intent',
        expectationId: intent.invoiceId ?? intent.id,
        amountK: judgement.amountK,
      });
      return { state: 'not_money' as const };
    }

    const connection = await paymentsHub.connectionFor(tx, businessId, PROVIDER);
    const booked = await settleRepo.bookVerifiedPayment(tx, {
      businessId,
      intent: {
        id: intent.id,
        reference: intent.reference,
        invoiceId: intent.invoiceId,
        customerId: intent.customerId,
      },
      confirmedAmountK: judgement.amountK,
      currency: t.currency.toUpperCase(),
      providerType: PROVIDER,
      providerRef: t.providerTransactionId,
      providerStatus: t.providerStatus,
      providerFeeK: t.providerFeeK,
      feePolicy: (connection?.feePolicy ?? 'merchant_bearing') as FeePolicy,
      method: t.method,
      actor: 'system:payments',
      /* No webhook carried this: the poll found it. The provider's own
       * transaction id is the audit anchor. */
      eventId: t.providerTransactionId,
      sourceType: 'reconciliation',
    });
    if (booked.receiptId) {
      await jobsRepo.enqueue(tx, {
        businessId,
        kind: 'document.render',
        payload: { receiptId: booked.receiptId },
        singletonKey: `render:receipt:${booked.receiptId}`,
      });
    }

    /* Graduation telemetry (ADR 0019, M5d): the moment lifetime collections
     * cross the pre-cap threshold, tell the merchant ONCE — inside this
     * transaction, so the claim, the booking that crossed the line and the
     * queued message are one fact. The claim's NULL predicate picks one
     * winner however many payments land in the same minute. */
    const collectedK = await settleRepo.collectedToDate(tx, businessId);
    if (
      collectedK >= GRADUATION_NUDGE_K &&
      (await paymentsHub.claimGraduationNudge(tx, businessId, PROVIDER))
    ) {
      await jobsRepo.enqueue(tx, {
        businessId,
        kind: 'graduation.nudge',
        payload: { collectedK },
        singletonKey: `graduation:${businessId}`,
      });
      log.log('a merchant crossed the graduation threshold; nudge queued');
    }

    log.log(`booked ${intent.reference} from the transfer poll: ${booked.reconciliation}`);
    return { state: 'booked' as const, receiptNumber: booked.receiptNumber };
  });
}

export interface MerchantTransferSweepDeps {
  /** `rekoda_worker` — lists live transfer intents across tenants. */
  workerDb: Db;
  /** `rekoda_app` — every verify and booking runs under a tenant pin. */
  appDb: Db;
  connectionKey: string;
  paystackBaseUrl: string;
}

const sweepLog = new Logger('MerchantTransferSweep');

/**
 * The reconciliation poll (ADR 0019: "never rely on webhooks alone").
 * Walks every live Pay-with-Transfer intent, verifies it on its merchant's
 * own key, and books what Paystack confirms — so a merchant who never
 * configures their webhook still gets every payment, just minutes later.
 */
export async function sweepMerchantTransfers(deps: MerchantTransferSweepDeps): Promise<number> {
  if (!deps.connectionKey) return 0;
  const live = await paymentsHub.liveTransferIntents(deps.workerDb);
  if (live.length === 0) return 0;

  const byBusiness = new Map<string, string[]>();
  for (const intent of live) {
    const refs = byBusiness.get(intent.businessId) ?? [];
    refs.push(intent.reference);
    byBusiness.set(intent.businessId, refs);
  }

  let booked = 0;
  for (const [businessId, references] of byBusiness) {
    const cipher = await withBusiness(deps.appDb, businessId, async (tx) => {
      await paymentsHub.expireOverdueIntents(tx, businessId);
      return paymentsHub.merchantKeyCipherFor(tx, businessId, PROVIDER);
    });
    if (!cipher) continue;
    const secretKey = decryptFacet(cipher, deps.connectionKey, `${businessId}:merchant_key`);

    for (const reference of references) {
      try {
        const outcome = await verifyAndBook(
          {
            appDb: deps.appDb,
            connectionKey: deps.connectionKey,
            paystackBaseUrl: deps.paystackBaseUrl,
          },
          businessId,
          reference,
          secretKey,
          sweepLog,
        );
        if (outcome.state === 'booked') booked += 1;
      } catch (error) {
        /* One merchant's dead key or poisoned intent must not stop the
         * sweep for everyone else. */
        sweepLog.warn(
          `transfer sweep skipped a reference: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
  }
  return booked;
}
