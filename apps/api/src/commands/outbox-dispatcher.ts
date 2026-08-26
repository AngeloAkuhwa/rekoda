/**
 * The outbox dispatcher (canonical spec §26; PR-020).
 *
 * The other half of the pattern: `append` made the event and the state
 * change one commit; this delivers the event AFTER that commit, at least
 * once, in arrival order, and never twice thanks to the lease. Handlers must
 * therefore be idempotent — "at least once" is the honest contract, and the
 * idempotency machinery of PR-019 is what makes it cheap to honour.
 *
 * The registry starts EMPTY on purpose. Event types arrive with the commands
 * that emit them (PR-021 onward), each registering its handler in the PR
 * that creates its type. An event whose type has no handler here FAILS and
 * retries rather than vanishing: during a rolling deploy an old worker may
 * meet a new type, and the retry hands it to a newer worker; an event that
 * stays unhandled goes visibly dead, which is an alarm rather than a loss.
 */
import { Logger } from '@nestjs/common';
import { outboxRepo, type Db } from '@rekoda/db';
import { redactForLog } from '@rekoda/core/privacy';

export type OutboxHandler = (event: outboxRepo.ClaimedEvent) => Promise<void>;

export class OutboxDispatcher {
  private readonly log = new Logger('OutboxDispatcher');
  private readonly handlers = new Map<string, OutboxHandler>();

  register(type: string, handler: OutboxHandler): void {
    if (this.handlers.has(type)) {
      /* Two handlers for one type is a fight over delivery order nobody can
       * referee. The second registration is the bug, and it is loud. */
      throw new Error(`outbox type ${type} already has a handler`);
    }
    this.handlers.set(type, handler);
  }

  /**
   * One pass: reclaim what a dead dispatcher held, claim a batch, deliver.
   * Failures are per event — one poisoned payload must not dam the queue
   * behind it.
   */
  async runOnce(worker: Db, batchSize = 25): Promise<{ delivered: number; failed: number }> {
    await outboxRepo.reclaimStalled(worker);
    const batch = await outboxRepo.claimBatch(worker, batchSize);
    let delivered = 0;
    let failed = 0;

    for (const event of batch) {
      const handler = this.handlers.get(event.type);
      if (!handler) {
        await outboxRepo.markFailed(worker, event.id, `no handler for ${event.type}`);
        failed += 1;
        continue;
      }
      try {
        await handler(event);
        await outboxRepo.markDispatched(worker, event.id);
        delivered += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await outboxRepo.markFailed(worker, event.id, reason);
        this.log.warn(`outbox ${event.type} failed: ${redactForLog(reason)}`);
        failed += 1;
      }
    }
    return { delivered, failed };
  }
}
