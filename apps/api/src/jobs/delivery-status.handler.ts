import { Logger } from '@nestjs/common';
import { conversationsRepo, events, jobsRepo } from '@rekoda/db';
import { redactForLog } from '@rekoda/core/privacy';
import { describeFailure, JobDeferred, type JobContext, type JobHandler } from './runner.js';

export interface DeliveryStatusDeps {
  /** Injected only by tests that need the write to fail; defaults to the repo. */
  markPreviewUndelivered?: typeof conversationsRepo.markPreviewUndelivered;
}

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
 * The order matters, both ways.
 *
 * Before: a preview is sent INSIDE the inbound job's transaction, which holds
 * this business's `inbound` conversation lock until it commits, so its
 * outbound row and wamid are invisible until then, and a fast failure receipt
 * can arrive first. So this job runs only under that same lock. It TRIES the
 * lock rather than waiting for it: a busy lock defers the job (no attempt
 * charged, back shortly) instead of parking a concurrency lane behind a
 * twenty-second model call. A wamid exists only once its inbound job has
 * sent it, which happens under the lock, so when the try succeeds that job
 * has committed or rolled back, and its reply row is visible (READ
 * COMMITTED, each statement a fresh snapshot). A wamid still not found is
 * therefore not ours to wait for (a reply rolled back, a customer-facing
 * message, a notice): marked processed, never retried.
 *
 * After: an inbound message that ARRIVED after this receipt (a "yes") defers
 * while this job is live (`hasEarlierLiveJob` with this kind), so it never
 * confirms a preview this job is about to mark unseen. This job never waits
 * for inbound jobs: the wait is one-way, so neither can starve the other.
 * A later inbound job that wins the lock first steps aside at once, and the
 * one that sent the preview holds it only until it commits.
 *
 * A job that keeps failing must not leave its receipt unprocessed forever
 * (the stale-backlog alert, G-26, with nothing on the exception queue). On
 * the last attempt the work runs in a savepoint; if it fails, the receipt is
 * marked processed WITH the failure, which puts it on the exception queue.
 *
 * Covers `previewed` and the link proposal only. A send that fails at send
 * time also undoes the continuations and re-asked holds that reply opened,
 * from the inbound job's in-memory outcome; a webhook arriving later cannot
 * rebuild that outcome, so those stay as the merchant was believed to have
 * seen them.
 */
export function deliveryStatusHandler(deps: DeliveryStatusDeps = {}): JobHandler {
  const log = new Logger('DeliveryStatusJob');
  const markPreviewUndelivered =
    deps.markPreviewUndelivered ?? conversationsRepo.markPreviewUndelivered;

  return async ({ tx, payload, businessId, attempt, maxAttempts }: JobContext): Promise<void> => {
    const eventId = typeof payload['eventId'] === 'string' ? payload['eventId'] : null;
    const outboundMessageId =
      typeof payload['outboundMessageId'] === 'string' ? payload['outboundMessageId'] : null;
    // Dies rather than retries: a payload missing either will not grow one.
    if (!eventId) throw new Error('delivery.status: payload is missing eventId');
    if (!outboundMessageId) {
      await events.markProcessed(tx, eventId, 'no outbound message id', businessId);
      return;
    }

    if (!(await jobsRepo.trySerializeBusiness(tx, businessId, 'inbound'))) {
      throw new JobDeferred();
    }

    const apply = async (q: typeof tx): Promise<void> => {
      const moved = await markPreviewUndelivered(q, businessId, outboundMessageId);
      if (moved > 0) log.log(`a preview failed after acceptance: ${moved} draft(s) marked unseen`);
      await events.markProcessed(q, eventId, null, businessId);
    };

    if (attempt < maxAttempts) {
      await apply(tx);
      return;
    }
    try {
      // A savepoint, so a failed statement does not abort the transaction
      // the failure is then recorded in.
      await tx.transaction((sp) => apply(sp));
    } catch (error) {
      const reason = redactForLog(describeFailure(error));
      log.error(`delivery.status could not be applied on its last attempt: ${reason}`);
      await events.markProcessed(tx, eventId, `delivery status not applied: ${reason}`, businessId);
    }
  };
}
