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
import {
  allowanceFor,
  templateUnitFor,
  usagePeriod,
  type TemplateCategory,
  type UsageUnit,
} from '@rekoda/core';
import { normaliseParticipant, InvalidPhoneError } from '@rekoda/core/identity';
import {
  decryptFacet,
  participantIndexFor,
  PARTICIPANT_INDEX_KEY_VERSION,
} from '@rekoda/core/vault';
import {
  conversationsRepo,
  entitlementsRepo,
  usageRepo,
  wabaRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
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

export type SendTemplateOutcome =
  | { outcome: 'sent'; unit: UsageUnit }
  | { outcome: 'not_entitled' }
  | { outcome: 'no_connection' }
  | { outcome: 'template_not_approved' }
  | { outcome: 'invalid_recipient' }
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

      const connection = await wabaRepo.wabaConnectionFor(tx, businessId);
      if (!connection || connection.status !== 'CONNECTED') {
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
        allowanceFor(plan, unit),
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
        return { outcome: 'sent', unit };
      } catch (error) {
        if (error instanceof SendFailed) {
          /* §4.3 rule 4: refunded on every path that does not deliver. The
           * recorded message keeps its empty provider id — a reply owed
           * and not delivered, findable as such. */
          await usageRepo.refundUnit(tx, businessId, period, unit);
          this.log.warn('template send failed; unit refunded');
          return { outcome: 'send_failed', unit };
        }
        throw error;
      }
    });
  }
}
