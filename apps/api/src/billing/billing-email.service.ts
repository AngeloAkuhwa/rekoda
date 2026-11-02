/**
 * Proving the billing email's mailbox (G-102 slice 2b, OWN-51).
 *
 * A live subscription payment goes to Paystack with an address the merchant typed,
 * and Paystack mails the receipt there. Before a LIVE charge starts, the owner
 * proves the mailbox by using a single-use, expiring link mailed to it.
 *
 *   - The token is 32 random bytes; only its SHA-256 is stored, so a database
 *     read cannot be turned into a working link.
 *   - The link carries the token in the URL FRAGMENT, which browsers never send
 *     to a server, so it stays out of access logs and referrer headers. The page
 *     reads it and POSTs it to /confirm, under the owner's session.
 *   - A link is bound to the address it was mailed to: changing the address
 *     voids every outstanding link and clears the proof.
 *   - The address is never written to logs or audit rows.
 *
 * Every write takes the business lock first, the order every billing path uses.
 *
 * Two limits apply to a request, both by the database clock and both decided before any link is
 * recorded: the business's own (five an hour, sixty seconds apart) and the address's across every
 * business (SUB-02a, OWN-58: the same figures per trimmed, lower-cased address). A refusal from
 * either has the same shape. The address limit counts a request whose send outcome is unknown; only
 * a definite provider refusal gives it back.
 */
import { EmailSuppressedError } from '../email/suppressing.sender.js';
import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BILLING_EMAIL_VERIFICATION,
  billingEmailConfirmationLink,
  checkBillingEmail,
  maskBillingEmail,
} from '@rekoda/core';
import { billingEmailAddressKeyFor, decryptFacet, encryptFacet } from '@rekoda/core/vault';
import type {
  BillingEmailConfirmResponse,
  BillingEmailStatusResponse,
  BillingEmailVerifyResponse,
} from '@rekoda/contracts';
import { subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import {
  EMAIL_SENDER,
  EmailDeliveryUncertainError,
  type EmailSender,
} from '../email/email.port.js';

const emailAad = (businessId: string): string => `billing-email:${businessId}`;
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

@Injectable()
export class BillingEmailService {
  private readonly log = new Logger(BillingEmailService.name);

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
  ) {}

  async status(businessId: string): Promise<BillingEmailStatusResponse> {
    const state = await withBusiness(this.db, businessId, (tx) =>
      subscriptionsRepo.billingEmailState(tx, businessId),
    );
    const link = state.verifiedAt
      ? null
      : await withBusiness(this.db, businessId, (tx) =>
          subscriptionsRepo.outstandingEmailLink(tx, businessId),
        );
    return {
      maskedEmail: state.sealed ? maskBillingEmail(this.open(businessId, state.sealed)) : null,
      verified: state.verifiedAt !== null,
      canSend: this.sender.available && this.config.webUrl !== null,
      outstandingLink: link
        ? { sentAt: link.sentAt.toISOString(), delivery: link.outcome ?? 'unknown' }
        : null,
    };
  }

  /** Mail a confirmation link, saving a new address first when one is given. */
  async requestVerification(
    businessId: string,
    billingEmail: string | undefined,
    now: Date = new Date(),
  ): Promise<BillingEmailVerifyResponse> {
    if (!this.sender.available || this.config.webUrl === null) {
      return { state: 'unavailable', reason: 'email_not_configured' };
    }
    let given: string | null = null;
    if (billingEmail !== undefined && billingEmail.trim() !== '') {
      const checked = checkBillingEmail(billingEmail);
      if (!checked.ok) return { state: 'invalid_billing_email', reason: checked.reason };
      given = checked.email;
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const prepared = await withBusiness(
      this.db,
      businessId,
      async (
        tx,
      ): Promise<
        BillingEmailVerifyResponse | { email: string; addressKey: string; addressRequestId: string }
      > => {
        await subscriptionsRepo.lockBusiness(tx, businessId);
        let state = await subscriptionsRepo.billingEmailState(tx, businessId);
        let email = state.sealed ? this.open(businessId, state.sealed) : null;
        if (given && given !== email) {
          await subscriptionsRepo.setBillingEmailSealed(
            tx,
            businessId,
            encryptFacet(given, this.config.vaultKey, emailAad(businessId)),
            now,
          );
          email = given;
          state = await subscriptionsRepo.billingEmailState(tx, businessId);
        }
        if (!email) return { state: 'requires_billing_email' };
        if (state.verifiedAt !== null) {
          return { state: 'already_verified', maskedEmail: maskBillingEmail(email) };
        }
        const recent = await subscriptionsRepo.recentEmailVerificationRequests(tx, businessId);
        const { cooldownMs, maxPerHour } = BILLING_EMAIL_VERIFICATION;
        const addressKey = billingEmailAddressKeyFor(email, this.config.matchKey);
        /* The hourly allowance first, so the retry guidance is never shorter than the real wait. */
        const businessWait =
          recent.lastHour >= maxPerHour
            ? 60 * 60
            : recent.sinceLatestMs !== null && recent.sinceLatestMs < cooldownMs
              ? Math.ceil((cooldownMs - recent.sinceLatestMs) / 1000)
              : 0;
        if (businessWait > 0) {
          /* The business is refusing. Report the longer of its wait and the address's, read
           * without counting a request, so the next try is not refused again for the other limit. */
          const addressWait = await subscriptionsRepo.billingEmailAddressWait(
            tx,
            addressKey,
            BILLING_EMAIL_VERIFICATION.perAddress,
          );
          return { state: 'rate_limited', retryAfterSeconds: Math.max(businessWait, addressWait) };
        }
        /* Same address, any business: decided under the address lock, counted in this transaction. */
        const claim = await subscriptionsRepo.claimBillingEmailAddress(
          tx,
          addressKey,
          BILLING_EMAIL_VERIFICATION.perAddress,
        );
        if (claim.requestId === null) {
          return { state: 'rate_limited', retryAfterSeconds: claim.retryAfterSeconds };
        }
        await subscriptionsRepo.issueEmailVerification(tx, {
          businessId,
          tokenHash,
          ttlMs: BILLING_EMAIL_VERIFICATION.ttlMs,
        });
        return { email, addressKey, addressRequestId: claim.requestId };
      },
    );
    if ('state' in prepared) return prepared;

    const message = {
      to: prepared.email,
      subject: 'Confirm your Rekoda billing email',
      text:
        'Confirm that this is your billing email by opening this link while signed in to Rekoda. ' +
        'It works once and expires in one hour.\n\n' +
        `${billingEmailConfirmationLink(this.config.webUrl, token)}\n\n` +
        'If you did not ask for this, ignore this message.',
      /* One logical message: a repeat with this key is dropped by the provider, never mailed twice. */
      idempotencyKey: `billing-email-verify:${tokenHash}`,
    };
    try {
      await this.sendWithOneSafeRetry(message);
    } catch (error) {
      if (error instanceof EmailDeliveryUncertainError) {
        /* The mail may have gone. The link stays valid and counted, for the business and for the
         * address (OWN-66); nothing is resent under a new token, and the merchant is told
         * the truth instead of "it failed". */
        this.log.warn(
          'a billing-email confirmation may or may not have been sent: outcome unknown',
        );
        await this.recordSendOutcome(businessId, tokenHash, 'uncertain');
        return {
          state: 'delivery_uncertain',
          maskedEmail: maskBillingEmail(prepared.email),
          retryAfterSeconds: Math.ceil(BILLING_EMAIL_VERIFICATION.cooldownMs / 1000),
        };
      }
      /* The address is not logged. A definite refusal gives the allowance back, the business's and
       * the address's, in one transaction. */
      const unusable = error instanceof EmailSuppressedError;
      this.log.warn(
        unusable
          ? 'a billing-email confirmation was not sent: the address is suppressed'
          : 'a billing-email confirmation could not be sent',
      );
      await withBusiness(this.db, businessId, async (tx) => {
        await subscriptionsRepo.voidEmailVerification(tx, businessId, tokenHash);
        await subscriptionsRepo.releaseBillingEmailAddress(
          tx,
          prepared.addressRequestId,
          prepared.addressKey,
        );
      });
      return { state: 'unavailable', reason: unusable ? 'address_unusable' : 'send_failed' };
    }
    await this.recordSendOutcome(businessId, tokenHash, 'accepted');
    return { state: 'sent', maskedEmail: maskBillingEmail(prepared.email) };
  }

  /**
   * The outcome is an annotation (a NULL column reads as unknown), so a failed write must not turn
   * a finished hand-over into an error. The failure is logged without the address.
   */
  private async recordSendOutcome(
    businessId: string,
    tokenHash: string,
    outcome: 'accepted' | 'uncertain',
  ): Promise<void> {
    try {
      await withBusiness(this.db, businessId, (tx) =>
        subscriptionsRepo.markEmailVerificationSend(tx, businessId, tokenHash, outcome),
      );
    } catch {
      this.log.warn('a billing-email send outcome could not be recorded');
    }
  }

  /**
   * Hand the message over. If the first attempt's outcome is unknown, ask once more with the SAME
   * idempotency key: the provider drops a repeat of a request it already took, so this cannot mail
   * twice. If that is also unknown, the error reaches the caller, which keeps the link and says so.
   * Any other failure is a definite refusal and is not retried.
   */
  private async sendWithOneSafeRetry(message: Parameters<EmailSender['send']>[0]): Promise<void> {
    try {
      await this.sender.send(message);
    } catch (error) {
      if (!(error instanceof EmailDeliveryUncertainError)) throw error;
      try {
        await this.sender.send(message);
      } catch {
        /* The first attempt may have been taken, so whatever the second says, it is not proof
         * that nothing was mailed. */
        throw new EmailDeliveryUncertainError(
          'billing email: outcome still unknown after one retry',
        );
      }
    }
  }

  async confirm(businessId: string, token: string): Promise<BillingEmailConfirmResponse> {
    const state = await withBusiness(this.db, businessId, async (tx) => {
      await subscriptionsRepo.lockBusiness(tx, businessId);
      return subscriptionsRepo.confirmEmailVerification(tx, businessId, hashToken(token));
    });
    return { state };
  }

  private open(businessId: string, sealed: string): string {
    return decryptFacet(sealed, this.config.vaultKey, emailAad(businessId));
  }
}
