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
import { SendFailed, type MessageSender, type OutboundConnectionText } from './sender.js';

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
  /* `providerIdUnrecorded`: Meta accepted the message (it is sent, and the unit stays spent) but
   * writing the provider message id onto the outbound row failed, so a later delivery report
   * cannot be matched to it. Still `sent`, never a failure and never a reason to send again; a
   * caller that keeps a history says the id is missing. */
  | { outcome: 'sent'; unit: 'SERVICE_MESSAGE'; providerIdUnrecorded?: true }
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
  /* `unknown`: the provider may have accepted the message (a timeout or a dropped connection),
   * so a caller that would warn about or retry a proactive message must not assume it was not
   * delivered. */
  | { outcome: 'send_failed'; unit: 'SERVICE_MESSAGE'; unknown?: boolean }
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
      const spent = await usageRepo.reserveUnit(
        tx,
        businessId,
        period,
        unit,
        await meterAllowance(this.config, tx, businessId, plan, unit),
      );
      /* §4.3 rule 4: the refusal consumed nothing — the atomic consume
       * writes no row when it refuses. */
      if (!spent.granted) return { outcome: 'allowance_exhausted', unit };

      const token = connection.accessTokenCipher
        ? decryptFacet(
            connection.accessTokenCipher,
            this.config.connectionKey,
            `${businessId}:waba_token`,
          )
        : null;
      if (!token) {
        await usageRepo.refundUnit(tx, businessId, spent.meter, unit);
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
          await usageRepo.refundUnit(tx, businessId, spent.meter, unit);
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
   *
   * Standalone (no `outerTx`), it is three steps so that no database
   * transaction or row lock is held while Meta is called (REM-02):
   *   1. a short transaction checks, reserves the unit and records the
   *      outbound message, and commits;
   *   2. the provider call, with no transaction open;
   *   3. a short transaction marks it sent (and the connection healthy), or
   *      refunds the unit (and records why the connection is unhealthy).
   * A process that dies between 1 and 3 leaves the unit spent and the
   * outbound row without a provider id: a visible, undelivered message,
   * never a silent free send. An error that is not a definite provider
   * refusal (`SendFailed`) is an unknown outcome and refunds nothing.
   */
  async sendCustomerText(
    businessId: string,
    input: SendCustomerTextInput,
    outerTx?: TenantDb,
  ): Promise<SendCustomerTextOutcome> {
    if (!this.config.connectionKey) {
      return { outcome: 'unavailable', reason: 'connection_key_missing' };
    }

    /* A caller mid-transaction (the customer-message job, PR-090, and the
     * chat payment-details delivery) passes its own tx so the window its OWN
     * uncommitted touch opened is visible; everything this method writes
     * then commits or rolls back with the caller's work. That shape cannot
     * release the caller's transaction around the provider call, so it keeps
     * the original single-transaction sequence: the lock is the caller's,
     * held for the length of its own job. */
    if (outerTx) return this.customerTextWithin(outerTx, businessId, input);

    const reserved = await withBusiness(this.db, businessId, (tx) =>
      this.reserveCustomerText(tx, businessId, input),
    );
    if (reserved.kind === 'refused') return reserved.outcome;

    let providerMessageId: string | null;
    try {
      ({ providerMessageId } = await this.sender.sendOnConnection(reserved.message));
    } catch (error) {
      if (!(error instanceof SendFailed)) {
        /* Not a provider answer: the sender can fail after the request has gone (for example while
         * reading Meta's reply), so the message may have been accepted. The unit stays spent and the
         * outbound row stays without a provider id: a visible, possibly delivered message, never a
         * free send and never a refund for something that may have left. The error is rethrown for
         * the caller to treat as an unknown outcome. */
        this.log.warn(
          `customer text outcome unknown; unit kept (outbound ${reserved.recordedId}, ${errorClass(error)})`,
        );
        throw error;
      }
      await withBusiness(this.db, businessId, (tx) =>
        this.customerTextFailed(tx, businessId, reserved, error),
      );
      return failedOutcome(error);
    }
    try {
      await withBusiness(this.db, businessId, (tx) =>
        this.customerTextSent(tx, businessId, reserved, providerMessageId),
      );
    } catch (error) {
      /* Meta accepted it: the message went and the unit stays spent. Only the
       * bookkeeping after it failed, and the outbound row keeps its empty
       * provider id, so a caller is not told to send it again. The warning names the row (an
       * opaque id) and the error class only: never the text, a number or the error message. */
      this.log.warn(
        `customer text sent; recording its provider id failed (outbound ${reserved.recordedId}, ${errorClass(error)})`,
      );
      return { outcome: 'sent', unit: 'SERVICE_MESSAGE', providerIdUnrecorded: true };
    }
    return { outcome: 'sent', unit: 'SERVICE_MESSAGE' };
  }

  /** The original shape, inside a caller's transaction (see `sendCustomerText`). */
  private async customerTextWithin(
    tx: TenantDb,
    businessId: string,
    input: SendCustomerTextInput,
  ): Promise<SendCustomerTextOutcome> {
    const reserved = await this.reserveCustomerText(tx, businessId, input);
    if (reserved.kind === 'refused') return reserved.outcome;
    try {
      const result = await this.sender.sendOnConnection(reserved.message);
      await this.customerTextSent(tx, businessId, reserved, result.providerMessageId);
      return { outcome: 'sent', unit: 'SERVICE_MESSAGE' };
    } catch (error) {
      if (error instanceof SendFailed) {
        await this.customerTextFailed(tx, businessId, reserved, error);
        return failedOutcome(error);
      }
      throw error;
    }
  }

  /**
   * Every check and the one consumption, in the §4.3 order: entitlement,
   * connection, recipient, consent, window, meter, token. A refusal consumes
   * nothing. On success the unit is reserved and the outbound message is
   * recorded (tokenised), ready for the provider call.
   */
  private async reserveCustomerText(
    tx: TenantDb,
    businessId: string,
    input: SendCustomerTextInput,
  ): Promise<ReservedCustomerText | { kind: 'refused'; outcome: SendCustomerTextOutcome }> {
    const refuse = (outcome: SendCustomerTextOutcome) => ({ kind: 'refused' as const, outcome });

    if (await entitlementsRepo.requireEntitlement(tx, businessId, 'REKODA_INTEGRATE')) {
      return refuse({ outcome: 'not_entitled' });
    }

    /* UNHEALTHY still sends, deliberately: the send IS the health
     * check, and a connection that could only recover through a send
     * the gate refuses would be down forever after one bad minute.
     * PENDING_SIGNUP and REVOKED refuse, as they do at the ingress. */
    const connection = await wabaRepo.wabaConnectionFor(tx, businessId);
    if (!connection || (connection.status !== 'CONNECTED' && connection.status !== 'UNHEALTHY')) {
      return refuse({ outcome: 'no_connection' });
    }

    let to: string;
    try {
      to = normaliseParticipant(input.to);
    } catch (error) {
      if (error instanceof InvalidPhoneError) return refuse({ outcome: 'invalid_recipient' });
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
      return refuse({ outcome: 'suppressed' });
    }

    /* The selection itself: the window answers BEFORE the meter moves.
     * A closed window consumed nothing (§4.3 rule 4) — it redirects. */
    const open = await wabaRepo.serviceWindowOpen(tx, {
      businessId,
      wabaConnectionId: connection.id,
      customerHash: blindIndex,
    });
    if (!open) return refuse({ outcome: 'window_closed' });

    const unit = 'SERVICE_MESSAGE' as const;
    const plan = await usageRepo.planFor(tx, businessId);
    const period = usagePeriod(new Date());
    const spent = await usageRepo.reserveUnit(
      tx,
      businessId,
      period,
      unit,
      await meterAllowance(this.config, tx, businessId, plan, unit),
    );
    if (!spent.granted) return refuse({ outcome: 'allowance_exhausted', unit });

    const token = connection.accessTokenCipher
      ? decryptFacet(
          connection.accessTokenCipher,
          this.config.connectionKey,
          `${businessId}:waba_token`,
        )
      : null;
    if (!token) {
      await usageRepo.refundUnit(tx, businessId, spent.meter, unit);
      return refuse({ outcome: 'unavailable', reason: 'token_missing' });
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

    return {
      kind: 'reserved',
      meter: spent.meter,
      recordedId: recorded.id,
      connectionId: connection.id,
      message: {
        to,
        phoneNumberId: connection.phoneNumberId,
        accessToken: token,
        text: input.text,
      },
    };
  }

  private async customerTextSent(
    tx: TenantDb,
    businessId: string,
    reserved: ReservedCustomerText,
    providerMessageId: string | null,
  ): Promise<void> {
    await conversationsRepo.markOutboundSent(tx, reserved.recordedId, providerMessageId);
    await wabaRepo.markWabaHealthy(tx, { businessId, connectionId: reserved.connectionId });
  }

  /**
   * §4.3 rule 4: refunded on every path that does not deliver. A SendFailed
   * is also health signal (its message carries status codes, never content).
   */
  private async customerTextFailed(
    tx: TenantDb,
    businessId: string,
    reserved: ReservedCustomerText,
    error: unknown,
  ): Promise<void> {
    if (error instanceof SendFailed) {
      /* Refund only a definite non-send (`notSent`). After a timeout or a dropped connection the
       * message may have left, so the unit stays spent: a free send is never granted on a guess. */
      if (error.notSent) {
        await usageRepo.refundUnit(tx, businessId, reserved.meter, 'SERVICE_MESSAGE');
      }
      await wabaRepo.markWabaUnhealthy(tx, {
        businessId,
        connectionId: reserved.connectionId,
        reason: error.message,
      });
      this.log.warn(
        error.notSent
          ? 'customer text send failed; unit refunded'
          : `customer text outcome unknown; unit kept (outbound ${reserved.recordedId})`,
      );
      return;
    }
    await usageRepo.refundUnit(tx, businessId, reserved.meter, 'SERVICE_MESSAGE');
  }
}

/** A customer text whose unit is reserved and whose outbound row is recorded, not yet sent. */
interface ReservedCustomerText {
  kind: 'reserved';
  meter: Awaited<ReturnType<typeof usageRepo.reserveUnit>>['meter'];
  recordedId: string;
  connectionId: string;
  /** Alive only for the send: carries the raw number, the text and the merchant's token. */
  message: OutboundConnectionText;
}

function failedOutcome(error: SendFailed): SendCustomerTextOutcome {
  return {
    outcome: 'send_failed',
    unit: 'SERVICE_MESSAGE',
    ...(error.notSent ? {} : { unknown: true }),
  };
}

/** The class name of a thrown value, for a log line that must not carry its message. */
function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : 'non-Error';
}
