import { Logger } from '@nestjs/common';
import { conversationsRepo, events, jobsRepo, remindersRepo, subscriptionsRepo } from '@rekoda/db';
import type { JobContext, JobHandler } from './runner.js';

/**
 * A `failed` delivery status for one of our outbound messages (G-20).
 *
 * "Previewed" is set when WhatsApp ACCEPTS a preview (G-23). A delivery that
 * fails after acceptance is reported later, by a status webhook naming the
 * outbound wamid, and until now nothing read it: the draft stayed
 * `previewed`, so a lapsed "yes" was told "that request has expired" about a
 * preview the merchant never received. This marks that preview unseen, as a
 * send that failed outright already is (`markDraftUnseen`).
 *
 * The order matters. A preview is sent INSIDE the inbound job's transaction,
 * which holds this business's `inbound` conversation lock until it commits,
 * so its outbound row and wamid are invisible until then, and a fast failure
 * receipt can arrive first. Taking the same lock here waits for that job to
 * commit; by the time it is held the reply row is visible (READ COMMITTED,
 * each statement a fresh snapshot). A wamid still not found is therefore
 * not ours to wait for (a reply rolled back, a customer-facing message, a
 * notice): marked processed, never retried.
 *
 * It also closes the continuation (a "Which period?" question) the reply
 * opened, found through the same reply-to link. Re-asked identity holds a
 * send-time failure restores depend on the inbound job's in-memory outcome,
 * which a later webhook does not have.
 *
 * If this job exhausts its retries it is dead and this never runs; the
 * inbound handler then applies the dead receipt itself, under the same lock,
 * before it reads any "yes" (`reconcileDeadReceipts`), and `claimDraft` still
 * refuses a draft that is not previewed.
 *
 * The same receipt may instead name a trial reminder (REM-01, G-109): the sweep sends it from
 * Rekoda's own number to the owner, so the receipt is attributed to this business when the
 * owner's phone has exactly one membership (`resolveBusiness`; otherwise it is stored with no
 * business and no job runs), and its wamid is the one recorded when Meta accepted it. That
 * reminder is marked 'undelivered' in the same transaction; the stage is not resent. If this job
 * dies, `reconcileDeadReceipts` applies the same update the next time that owner writes in (an
 * owner who never writes back keeps 'sent'). A failure that arrives before the sweep
 * has recorded the wamid matches nothing and is not retried: the reminder stays 'sent'.
 *
 * Or a reminder-reply notice (OWN-83), sent from Rekoda's number to the owner and attributed the
 * same way (an owner with several businesses gets no attribution, so no retry). It is marked
 * undelivered, so the customer's next message tells the business again; the business's
 * reply-notice lock, which the sending job holds to commit, makes a fast receipt wait for the
 * notice's row. A dead job is applied by `reconcileDeadReceipts` as above.
 */
export function deliveryStatusHandler(): JobHandler {
  const log = new Logger('DeliveryStatusJob');

  return async ({ tx, payload, businessId }: JobContext): Promise<void> => {
    const eventId = typeof payload['eventId'] === 'string' ? payload['eventId'] : null;
    const outboundMessageId =
      typeof payload['outboundMessageId'] === 'string' ? payload['outboundMessageId'] : null;
    // Dies rather than retries: a payload missing either will not grow one.
    if (!eventId) throw new Error('delivery.status: payload is missing eventId');
    if (!outboundMessageId) {
      await events.markProcessed(tx, eventId, 'no outbound message id', businessId);
      return;
    }

    await jobsRepo.serializeBusiness(tx, businessId, 'inbound');

    const moved = await conversationsRepo.markPreviewUndelivered(tx, businessId, outboundMessageId);
    if (moved.drafts > 0 || moved.continuations > 0) {
      log.log(
        `a preview failed after acceptance: ${moved.drafts} draft(s) retired, ` +
          `${moved.continuations} question(s) closed`,
      );
    }
    const reminders = await subscriptionsRepo.markTrialNoticeUndelivered(
      tx,
      businessId,
      outboundMessageId,
      new Date(),
    );
    if (reminders > 0) {
      log.log(`a trial reminder failed after acceptance: ${reminders} marked undelivered`);
    }
    /* A reminder-reply notice (OWN-83) Meta accepted and then failed: due again, so the customer's
     * next message tells the business once more. This waits for a customer job still recording
     * that notice (its business-wide notice lock), holding the inbound lock meanwhile: bounded by
     * that job's Meta send. */
    const replyNotices = await remindersRepo.markReminderReplyNoticeUndelivered(
      tx,
      businessId,
      outboundMessageId,
    );
    if (replyNotices > 0) {
      log.log('a reminder-reply notice failed after acceptance: it will be tried again');
    }
    await events.markProcessed(tx, eventId, null, businessId);
  };
}
