import { Inject, Injectable, Logger } from '@nestjs/common';
import { billingPeriod, messageCostK, replies, type Reply } from '@rekoda/core';
import { redactForLog, rehydrate } from '@rekoda/core/privacy';
import { conversationsRepo, quotaRepo, type TenantDb } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { MESSAGE_SENDER } from '../channels/sender.tokens.js';
import { SendFailed, type MessageSender } from '../channels/sender.js';

export interface SendReplyInput {
  businessId: string;
  /** E.164 recipient. */
  to: string;
  reply: Reply;
  /**
   * token → real value, for this conversation. Empty when the reply was built
   * without touching a customer, which is most of them.
   */
  tokens?: ReadonlyMap<string, string>;
}

/**
 * The authorised output layer (ADR 0005).
 *
 * This is the ONLY place `rehydrate` is called. That is the whole reason the
 * function is held back from `@rekoda/core`'s barrel: it is one of two
 * functions that can undo the privacy gateway, and an explicit
 * `@rekoda/core/privacy` import is a thing a reviewer notices.
 *
 * The ordering below is the rule made mechanical:
 *
 *   1. store the reply TOKENISED, so the conversation history holds no names
 *   2. rehydrate into a local, for the length of one HTTP request
 *   3. send
 *
 * A real customer name therefore exists outside the vault only in the argument
 * to `send`, and never in a row or a log line.
 */
@Injectable()
export class ReplySender {
  private readonly log = new Logger(ReplySender.name);

  /**
   * No `Db` here. Everything this class writes goes through the
   * caller's `tx`, so it cannot open a transaction of its own and cannot write
   * outside the tenant pin the caller established.
   */
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(MESSAGE_SENDER) private readonly sender: MessageSender,
  ) {}

  /**
   * Runs inside the caller's tenant transaction, so the outbound record and
   * whatever prompted it commit together — there is no state where a merchant
   * was answered about a draft that does not exist.
   *
   * The SEND is outside that guarantee and cannot be inside it: an HTTP call
   * cannot be rolled back. So the record is written first and the send is
   * allowed to fail after it. A reply nobody received but that we know we owed
   * is recoverable; a reply sent about a rolled-back draft is not.
   */
  async send(tx: TenantDb, input: SendReplyInput): Promise<{ delivered: boolean }> {
    const safe = replies.truncateForSending(input.reply);
    if (!replies.isSendable(safe)) {
      this.log.error('refused to send an empty reply');
      return { delivered: false };
    }

    const recorded = await conversationsRepo.recordOutbound(
      tx,
      {
        businessId: input.businessId,
        channel: 'meta',
        kind: 'text',
        body: safe.text,
      },
      /* The thread identity, stated rather than assumed (Appendix F.2):
       * a reply to the merchant belongs on the merchant's thread. */
      { kind: 'MERCHANT', businessId: input.businessId, channel: 'meta' },
    );

    // The one moment. A local, not a field, not a log line, not a row.
    const forHuman = input.tokens?.size ? rehydrate(safe.text, input.tokens) : safe.text;

    try {
      const result = await this.sender.send({ to: input.to, text: forHuman });
      await conversationsRepo.markOutboundSent(tx, recorded.id, result.providerMessageId);
      await this.recordMessageCost(tx, input.businessId);
      return { delivered: true };
    } catch (error) {
      if (error instanceof SendFailed) {
        /**
         * Not rethrown. The merchant's message is recorded and their draft
         * exists; failing the job over an undelivered reply would roll both
         * back and re-read the message from scratch on the retry — paying for
         * the model twice to fix a delivery problem.
         */
        this.log.warn(`reply not delivered: ${redactForLog(error.message)}`);
        return { delivered: false };
      }
      throw error;
    }
  }

  /**
   * One `usage_events` row per message sent, under its Meta category.
   *
   * The category used to be `message_out` for every outbound message, which
   * put a ₦0 service reply and a ₦21 sign-in code in one bucket and made the
   * eightfold utility-to-marketing spread spec §24 calls the largest variable
   * in plan margin the one thing the margin view could not see.
   *
   * Zero cost today: a service reply inside the 24-hour window is currently
   * free Meta-side. It becomes chargeable on 1 October 2026, and the row that
   * matters then is the one being written now — a count that starts on the day
   * the price does is a count with no baseline to compare against.
   */
  private async recordMessageCost(tx: TenantDb, businessId: string): Promise<void> {
    await quotaRepo.recordUsage(tx, {
      businessId,
      provider: 'meta',
      usageType: 'SERVICE_MESSAGE',
      quantity: 1,
      providerCostMicros: this.config.metaServiceReplyCostMicros,
      nairaEquivalentK: messageCostK(
        this.config.metaServiceReplyCostMicros,
        this.config.planningFxNairaPerUsd,
      ),
      billingPeriod: billingPeriod(new Date()),
      meta: { window: 'service' },
    });
  }
}
