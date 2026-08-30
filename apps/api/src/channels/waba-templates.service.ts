/**
 * Sending a merchant's own template on their own WABA (spec §24, §4.2/§4.3;
 * PR-060).
 *
 * The §4.3 ordering rules ARE this file's structure, in their canonical
 * order: entitlement before meter, entitlement before avoidable provider
 * cost, no paid external processing before authorisation, and a refused
 * request consumes nothing. Every refusal below happens before the step it
 * guards, and the one consumption that precedes the dispatch is refunded on
 * the path that does not deliver.
 *
 * Metering and cost attribution are INDEPENDENT axes (ADR 0029): this
 * meters usage per business regardless of who Meta bills. Whether a metered
 * template also produces a PlatformCostEvent is `MetaBillingMode`'s
 * decision, and that mode is UNCONFIRMED until W0 — so nothing here writes
 * a cost event, and turning that on later is a data decision, not a branch
 * added to this file.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { templateUnitFor, usagePeriod, type TemplateCategory, type UsageUnit } from '@rekoda/core';
import { normaliseParticipant, InvalidPhoneError } from '@rekoda/core/identity';
import {
  decryptFacet,
  participantIndexFor,
  PARTICIPANT_INDEX_KEY_VERSION,
} from '@rekoda/core/vault';
import {
  conversationsRepo,
  customerConsentRepo,
  entitlementsRepo,
  usageRepo,
  wabaRepo,
  withBusiness,
  type Db,
  type TenantDb,
} from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { meterAllowance } from '../billing/plan-terms.js';
import { DB } from '../db/db.module.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { MESSAGE_SENDER } from './sender.tokens.js';
import { SendFailed, type MessageSender } from './sender.js';

export interface SendTemplateInput {
  to: string;
  name: string;
  language?: string;
  /** Body placeholder values, in order. May carry a customer's name — they
   * are handed to the sender and NEVER stored (the recorded message body is
   * the template's name, not its rendering). */
  parameters?: string[];
}

export interface SendCustomerTextInput {
  to: string;
  /** Rehydrated free-form text, alive for the send; stored TOKENISED. */
  text: string;
}

export type SendCustomerTextOutcome =
  | { outcome: 'sent'; unit: 'SERVICE_MESSAGE' }
  | { outcome: 'not_entitled' }
  | { outcome: 'no_connection' }
  | { outcome: 'invalid_recipient' }
  /** Not a failure — an instruction: outside the 24-hour window only a
   * template can reach this customer. The caller selects one and goes
   * through `sendTemplate`, which is the send-time category selection. */
  | { outcome: 'window_closed' }
  /* The customer asked this shop to stop. Not a failure and not a
   * redirect: there is no template, no window and no retry that makes it
   * sendable, and nothing is metered for a message nobody may receive. */
  | { outcome: 'suppressed' }
  | { outcome: 'allowance_exhausted'; unit: 'SERVICE_MESSAGE' }
  | { outcome: 'send_failed'; unit: 'SERVICE_MESSAGE' }
  | { outcome: 'unavailable'; reason: 'connection_key_missing' | 'token_missing' };

export type SendTemplateOutcome =
  | { outcome: 'sent'; unit: UsageUnit }
  | { outcome: 'not_entitled' }
  | { outcome: 'no_connection' }
  | { outcome: 'template_not_approved' }
  | { outcome: 'invalid_recipient' }
  /* As above: a template is precisely the thing that reaches OUTSIDE the
   * window, so this is the one that most needs the check. */
  | { outcome: 'suppressed' }
  | { outcome: 'allowance_exhausted'; unit: UsageUnit }
  | { outcome: 'send_failed'; unit: UsageUnit }
  | { outcome: 'unavailable'; reason: 'connection_key_missing' | 'token_missing' };

@Injectable()
export class WabaTemplateService {
  private readonly log = new Logger(WabaTemplateService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(MESSAGE_SENDER) private readonly sender: MessageSender,
    @Inject(PrivacyGateway) private readonly gateway: PrivacyGateway,
  ) {}

  async sendTemplate(businessId: string, input: SendTemplateInput): Promise<SendTemplateOutcome> {
    /* A deployment that cannot decrypt the merchant's token cannot send.
     * Refused before anything is read or consumed. */
    if (!this.config.connectionKey) {
      return { outcome: 'unavailable', reason: 'connection_key_missing' };
    }

    return withBusiness(this.db, businessId, async (tx): Promise<SendTemplateOutcome> => {
      /* §4.3 rule 1: entitlement before meter. Sending on a merchant WABA
       * is Integrate's capability, whatever the template says. */
      if (await entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_INTEGRATE')) {
        return { outcome: 'not_entitled' };
      }

      /* UNHEALTHY still sends, deliberately: the send IS the health
       * check, and a connection that could only recover through a send
       * the gate refuses would be down forever after one bad minute.
       * PENDING_SIGNUP and REVOKED refuse, as they do at the ingress. */
      const connection = await wabaRepo.wabaConnectionFor(tx, businessId);
      if (!connection || (connection.status !== 'CONNECTED' && connection.status !== 'UNHEALTHY')) {
        return { outcome: 'no_connection' };
      }

      /* An unapproved template would bounce at Meta AFTER costing the
       * merchant a unit; the registry answers before anything is spent. */
      const template = await wabaRepo.approvedTemplate(tx, {
        businessId,
        wabaConnectionId: connection.id,
        name: input.name,
        ...(input.language ? { language: input.language } : {}),
      });
      if (!template) return { outcome: 'template_not_approved' };

      let to: string;
      try {
        to = normaliseParticipant(input.to);
      } catch (error) {
        if (error instanceof InvalidPhoneError) return { outcome: 'invalid_recipient' };
        throw error;
      }

      /* Consent before the meter (PR-135). A template is precisely the
       * thing that reaches a customer OUTSIDE the 24-hour window, so a
       * customer who said STOP must be refused here above all. */
      if (
        await customerConsentRepo.customerOptedOut(tx, {
          businessId,
          channelAccountId: connection.phoneNumberId,
          customerHash: participantIndexFor(this.config.matchKey, {
            businessId,
            channelAccountId: connection.phoneNumberId,
            keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
            normalisedParticipant: to,
          }),
          indexKeyVersion: PARTICIPANT_INDEX_KEY_VERSION,
        })
      ) {
        return { outcome: 'suppressed' };
      }

      /* The §4.2 unit, DERIVED at send time from the registry's category
       * and the destination — an authentication code to London is not
       * priced like one to Lagos, and storing the unit on the row would
       * freeze exactly the decision that must be made per send. */
      const unit = templateUnitFor(template.category as TemplateCategory, to);
      const plan = await usageRepo.planFor(tx, businessId);
      const period = usagePeriod(new Date());
      const allowed = await usageRepo.consumeUnit(
        tx,
        businessId,
        period,
        unit,
        await meterAllowance(this.config, tx, businessId, plan, unit),
      );
      /* §4.3 rule 4: the refusal consumed nothing — the atomic consume
       * writes no row when it refuses. */
      if (!allowed) return { outcome: 'allowance_exhausted', unit };

      const token = connection.accessTokenCipher
        ? decryptFacet(
            connection.accessTokenCipher,
            this.config.connectionKey,
            `${businessId}:waba_token`,
          )
        : null;
      if (!token) {
        await usageRepo.refundUnit(tx, businessId, period, unit);
        return { outcome: 'unavailable', reason: 'token_missing' };
      }

      /* Recorded BEFORE the send, on the CUSTOMER'S OWN thread (F.2), so
       * an undelivered template is a visible debt rather than a mystery.
       * The body is the template's NAME: the rendered parameters can carry
       * a customer's name, and the conversation history must not. */
      const recorded = await conversationsRepo.recordOutbound(
        tx,
        { businessId, channel: 'meta', kind: 'text', body: `[template ${template.name}]` },
        {
          kind: 'CUSTOMER',
          businessId,
          channel: 'meta',
          channelAccountId: connection.phoneNumberId,
          participantBlindIndex: participantIndexFor(this.config.matchKey, {
            businessId,
            channelAccountId: connection.phoneNumberId,
            keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
            normalisedParticipant: to,
          }),
          participantIndexKeyVersion: PARTICIPANT_INDEX_KEY_VERSION,
        },
      );

      try {
        const result = await this.sender.sendTemplate({
          to,
          phoneNumberId: connection.phoneNumberId,
          accessToken: token,
          name: template.name,
          language: template.language,
          parameters: input.parameters ?? [],
        });
        await conversationsRepo.markOutboundSent(tx, recorded.id, result.providerMessageId);
        /* The send IS the health check (PR-062): success touches the
         * watermark and recovers an UNHEALTHY connection. */
        await wabaRepo.markWabaHealthy(tx, { businessId, connectionId: connection.id });
        return { outcome: 'sent', unit };
      } catch (error) {
        if (error instanceof SendFailed) {
          /* §4.3 rule 4: refunded on every path that does not deliver. The
           * recorded message keeps its empty provider id — a reply owed
           * and not delivered, findable as such. */
          await usageRepo.refundUnit(tx, businessId, period, unit);
          /* And the failure is health signal: UNHEALTHY plus WHY, so the
           * dashboard has something the merchant can act on. SendFailed
           * messages carry status codes, never message content. */
          await wabaRepo.markWabaUnhealthy(tx, {
            businessId,
            connectionId: connection.id,
            reason: error.message,
          });
          this.log.warn('template send failed; unit refunded');
          return { outcome: 'send_failed', unit };
        }
        throw error;
      }
    });
  }

  /**
   * A free-form reply to a customer, selected by the WINDOW (spec §24;
   * PR-061): inside the 24 hours their last message opened, free-form text
   * goes as a SERVICE_MESSAGE; outside it, Meta rejects free-form (131047)
   * and the refusal here says so BEFORE anything is consumed — choosing a
   * template instead is the caller's next move, priced by its own unit.
   */
  async sendCustomerText(
    businessId: string,
    input: SendCustomerTextInput,
    outerTx?: TenantDb,
  ): Promise<SendCustomerTextOutcome> {
    if (!this.config.connectionKey) {
      return { outcome: 'unavailable', reason: 'connection_key_missing' };
    }

    /* A caller mid-transaction (the customer-message job, PR-090) passes
     * its own tx so the window its OWN uncommitted touch opened is
     * visible; everything this method writes then commits or rolls back
     * with the caller's work. Standalone callers keep the managed shape. */
    const work = async (tx: TenantDb): Promise<SendCustomerTextOutcome> => {
      if (await entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_INTEGRATE')) {
        return { outcome: 'not_entitled' };
      }

      /* UNHEALTHY still sends, deliberately: the send IS the health
       * check, and a connection that could only recover through a send
       * the gate refuses would be down forever after one bad minute.
       * PENDING_SIGNUP and REVOKED refuse, as they do at the ingress. */
      const connection = await wabaRepo.wabaConnectionFor(tx, businessId);
      if (!connection || (connection.status !== 'CONNECTED' && connection.status !== 'UNHEALTHY')) {
        return { outcome: 'no_connection' };
      }

      let to: string;
      try {
        to = normaliseParticipant(input.to);
      } catch (error) {
        if (error instanceof InvalidPhoneError) return { outcome: 'invalid_recipient' };
        throw error;
      }

      const blindIndex = participantIndexFor(this.config.matchKey, {
        businessId,
        channelAccountId: connection.phoneNumberId,
        keyVersion: PARTICIPANT_INDEX_KEY_VERSION,
        normalisedParticipant: to,
      });

      /* Consent first, before the window and before the meter (PR-135).
       * A customer who said STOP is not reachable by any route, so asking
       * about windows or spending a unit on them would both be wrong. */
      if (
        await customerConsentRepo.customerOptedOut(tx, {
          businessId,
          channelAccountId: connection.phoneNumberId,
          customerHash: blindIndex,
          indexKeyVersion: PARTICIPANT_INDEX_KEY_VERSION,
        })
      ) {
        return { outcome: 'suppressed' };
      }

      /* The selection itself: the window answers BEFORE the meter moves.
       * A closed window consumed nothing (§4.3 rule 4) — it redirects. */
      const open = await wabaRepo.serviceWindowOpen(tx, {
        businessId,
        wabaConnectionId: connection.id,
        customerHash: blindIndex,
      });
      if (!open) return { outcome: 'window_closed' };

      const unit = 'SERVICE_MESSAGE' as const;
      const plan = await usageRepo.planFor(tx, businessId);
      const period = usagePeriod(new Date());
      const allowed = await usageRepo.consumeUnit(
        tx,
        businessId,
        period,
        unit,
        await meterAllowance(this.config, tx, businessId, plan, unit),
      );
      if (!allowed) return { outcome: 'allowance_exhausted', unit };

      const token = connection.accessTokenCipher
        ? decryptFacet(
            connection.accessTokenCipher,
            this.config.connectionKey,
            `${businessId}:waba_token`,
          )
        : null;
      if (!token) {
        await usageRepo.refundUnit(tx, businessId, period, unit);
        return { outcome: 'unavailable', reason: 'token_missing' };
      }

      /* Stored TOKENISED, before the send — same two disciplines as every
       * message in the estate: the history never holds a real name, and an
       * undelivered reply is a visible debt. */
      const tokenised = await this.gateway.tokenise(businessId, input.text);
      const recorded = await conversationsRepo.recordOutbound(
        tx,
        { businessId, channel: 'meta', kind: 'text', body: tokenised.text },
        {
          kind: 'CUSTOMER',
          businessId,
          channel: 'meta',
          channelAccountId: connection.phoneNumberId,
          participantBlindIndex: blindIndex,
          participantIndexKeyVersion: PARTICIPANT_INDEX_KEY_VERSION,
        },
      );

      try {
        const result = await this.sender.sendOnConnection({
          to,
          phoneNumberId: connection.phoneNumberId,
          accessToken: token,
          text: input.text,
        });
        await conversationsRepo.markOutboundSent(tx, recorded.id, result.providerMessageId);
        await wabaRepo.markWabaHealthy(tx, { businessId, connectionId: connection.id });
        return { outcome: 'sent', unit };
      } catch (error) {
        if (error instanceof SendFailed) {
          await usageRepo.refundUnit(tx, businessId, period, unit);
          await wabaRepo.markWabaUnhealthy(tx, {
            businessId,
            connectionId: connection.id,
            reason: error.message,
          });
          this.log.warn('customer text send failed; unit refunded');
          return { outcome: 'send_failed', unit };
        }
        throw error;
      }
    };
    return outerTx ? work(outerTx) : withBusiness(this.db, businessId, work);
  }
}
