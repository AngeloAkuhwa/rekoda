/**
 * Scheduled and bulk payment reminders (REM-05, OWN-43): preview, explicit confirmation, schedule,
 * cancel, and the worker's dispatch.
 *
 * A batch never sends anything itself. Each recipient goes through `ReminderService.send`, the one
 * path every reminder takes, with a deterministic key per recipient (`batch:<batch>:<item>`), so:
 *   - the invoice, balance, contact, opt-out (per channel, OWN-69), attestation and, on WhatsApp,
 *     STOP, the 24-hour window, the entitlement and the allowance are all re-read immediately before
 *     that recipient's send, not when the batch was confirmed;
 *   - a retry after a worker restart reuses the key, so a recipient already attempted is reported,
 *     never sent again (an unknown provider outcome stays `uncertain`, OWN-47);
 *   - the dispatch guard runs inside the transaction that writes the recipient's `sending` row, so
 *     a cancellation, or the scheduler losing the right to send, that commits first is honoured.
 * No reminder creates a sale, invoice, payment or ledger row.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactForLog } from '@rekoda/core/privacy';
import {
  REMINDER_BATCH_MAX,
  type CancelReminderBatchResponse,
  type CreateReminderBatchRequest,
  type ReminderBatchListResponse,
  type ReminderBatchPreviewRequest,
  type ReminderBatchPreviewResponse,
  type ReminderBatchResponse,
  type ReminderBatchSummary,
} from '@rekoda/contracts';
import { reminderBatchesRepo, withBusiness, type Db } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import { ReminderInvoiceNotFound, ReminderService, ReminderWithdrawn } from './reminder.service.js';

/**
 * Engineering defaults (OD-43, reversible, not owner-ruled): how far ahead a batch may be
 * scheduled, how many sends one worker pass makes, and when a pass stops on repeated failures.
 */
export const REMINDER_BATCH_LIMITS = {
  maxRecipients: REMINDER_BATCH_MAX,
  maxScheduleAheadMs: 30 * 24 * 3_600_000,
  sendsPerPass: 60,
  failuresBeforePause: 3,
  /** A recipient claimed this long ago with no finish belonged to a worker that died. */
  staleClaimMs: 15 * 60_000,
  /** How long a paused batch waits before its next recipient is claimed. */
  pauseMs: 10 * 60_000,
  /** Claims of one recipient after which an unexpected repeated error skips it (never a send). */
  maxAttempts: 3,
} as const;

export class BatchUnknownInvoices extends Error {
  constructor(readonly invoiceNumbers: string[]) {
    super('invoice_not_found');
  }
}

export class BatchScheduleOutOfRange extends Error {
  constructor() {
    super('scheduled_for_out_of_range');
  }
}

export class BatchKeyReused extends Error {
  constructor() {
    super('idempotency_key_reused');
  }
}

/** Customer reminders are not released on this deployment (`REKODA_CUSTOMER_REMINDERS`). */
export class BatchRemindersNotReleased extends Error {
  constructor() {
    super('reminders_not_released');
  }
}

export class BatchNotFound extends Error {
  constructor() {
    super('batch_not_found');
  }
}

type Channels = CreateReminderBatchRequest['channels'];

/** The stored channel plan for a request's channels. */
const toStored = (channels: Channels): reminderBatchesRepo.BatchChannels => {
  if (channels === 'auto') return 'auto';
  const set = new Set(channels);
  if (set.has('whatsapp') && set.has('email')) return 'both';
  return set.has('email') ? 'email' : 'whatsapp';
};

/** The request form of a stored channel plan. */
const fromStored = (stored: reminderBatchesRepo.BatchChannels): Channels => {
  if (stored === 'auto') return 'auto';
  if (stored === 'both') return ['whatsapp', 'email'];
  return [stored];
};

/** Distinct by the case-insensitive invoice key, keeping the first spelling. */
const distinct = (numbers: string[]): string[] => {
  const seen = new Set<string>();
  return numbers.filter((n) => {
    const k = reminderBatchesRepo.invoiceKey(n);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

@Injectable()
export class ReminderBatchService {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(ReminderService) private readonly reminders: ReminderService,
  ) {}

  /** What a batch would do now; reads and decides, writes and sends nothing. */
  preview(
    businessId: string,
    input: ReminderBatchPreviewRequest,
  ): Promise<ReminderBatchPreviewResponse> {
    return this.reminders.preview(businessId, input);
  }

  /**
   * The merchant's confirmation. Writes the batch and its distinct invoices; sends nothing. An
   * unknown invoice number refuses the whole batch (nothing is guessed or silently dropped). A
   * time in the past means now. Idempotent on the merchant's key.
   */
  async create(
    businessId: string,
    userId: string,
    input: CreateReminderBatchRequest,
    now: Date = new Date(),
  ): Promise<ReminderBatchResponse> {
    if (!this.config.customerReminders) throw new BatchRemindersNotReleased();
    let scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : now;
    if (scheduledFor.getTime() > now.getTime() + REMINDER_BATCH_LIMITS.maxScheduleAheadMs) {
      throw new BatchScheduleOutOfRange();
    }
    if (scheduledFor.getTime() < now.getTime()) scheduledFor = now;
    const numbers = distinct(input.invoiceNumbers);
    const channels = toStored(input.channels);

    const { id, created } = await withBusiness(this.db, businessId, async (tx) => {
      const prior = await reminderBatchesRepo.batchByKey(tx, businessId, input.idempotencyKey);
      if (prior) return { id: prior.id, created: false };
      const ids = await reminderBatchesRepo.invoiceIdsByNumber(tx, businessId, numbers);
      const unknown = numbers.filter((n) => !ids.has(reminderBatchesRepo.invoiceKey(n)));
      if (unknown.length > 0) throw new BatchUnknownInvoices(unknown);
      const made = await reminderBatchesRepo.createBatch(tx, {
        businessId,
        channels,
        attest: input.attest === true,
        scheduledFor,
        idempotencyKey: input.idempotencyKey,
        createdBy: userId,
        invoiceIds: numbers.map((n) => ids.get(reminderBatchesRepo.invoiceKey(n))!.id),
      });
      /* The attestation is the merchant's act at confirmation, bound to the addresses on file now,
       * written in the same transaction as the batch (OWN-62(A), OWN-65). */
      if (made.created && input.attest === true && channels !== 'whatsapp') {
        await this.reminders.attestForBatch(tx, businessId, userId, numbers);
      }
      return made;
    });
    const batch = await this.get(businessId, id);
    if (!created) {
      /* A replay must be the same request; a different list under the same key is refused. */
      const stored = await withBusiness(this.db, businessId, (tx) =>
        reminderBatchesRepo.batchById(tx, businessId, id),
      );
      const same =
        batch.items.length === numbers.length &&
        batch.items.every(
          (item, i) =>
            reminderBatchesRepo.invoiceKey(item.invoiceNumber) ===
            reminderBatchesRepo.invoiceKey(numbers[i]!),
        ) &&
        stored!.channels === channels &&
        stored!.attest === (input.attest === true) &&
        (input.scheduledFor === undefined ||
          stored!.scheduledFor.getTime() === scheduledFor.getTime() ||
          scheduledFor.getTime() === now.getTime());
      if (!same) throw new BatchKeyReused();
      return { ...batch, replayed: true };
    }
    return batch;
  }

  /** One batch with its recipients and per-channel outcomes. */
  async get(businessId: string, batchId: string): Promise<ReminderBatchResponse> {
    return withBusiness(this.db, businessId, async (tx) => {
      const batch = await reminderBatchesRepo.batchById(tx, businessId, batchId);
      if (!batch) throw new BatchNotFound();
      const counts = await reminderBatchesRepo.batchCounts(tx, businessId, [batch.id]);
      const items = await reminderBatchesRepo.batchItems(tx, businessId, batch.id);
      return {
        ...summary(batch, counts.get(batch.id)),
        items: items.map((item) => ({
          invoiceNumber: item.invoiceNumber,
          state: item.state,
          reasonCode: item.reasonCode,
          reminders: item.reminders.map((r) => ({
            channel: r.channel,
            status: r.status,
            reasonCode: r.reasonCode,
            sentAt: r.sentAt ? r.sentAt.toISOString() : null,
          })),
        })),
      };
    });
  }

  /** The business's recent batches with their counts. */
  async list(businessId: string): Promise<ReminderBatchListResponse> {
    return withBusiness(this.db, businessId, async (tx) => {
      const batches = await reminderBatchesRepo.recentBatches(tx, businessId, 50);
      const counts = await reminderBatchesRepo.batchCounts(
        tx,
        businessId,
        batches.map((b) => b.id),
      );
      return { batches: batches.map((b) => summary(b, counts.get(b.id))) };
    });
  }

  /** Stop a scheduled batch: recipients not yet dispatched are cancelled. */
  async cancel(
    businessId: string,
    userId: string,
    batchId: string,
    now: Date = new Date(),
  ): Promise<CancelReminderBatchResponse> {
    const result = await withBusiness(this.db, businessId, (tx) =>
      reminderBatchesRepo.cancelBatch(
        tx,
        businessId,
        batchId,
        userId,
        now,
        new Date(now.getTime() - REMINDER_BATCH_LIMITS.staleClaimMs),
      ),
    );
    if (!result) throw new BatchNotFound();
    const batch = await this.get(businessId, batchId);
    const { items: _items, replayed: _replayed, ...rest } = batch;
    return {
      outcome: result.outcome,
      cancelledCount: result.outcome === 'cancelled' ? result.cancelledCount : 0,
      batch: rest,
    };
  }
}

/** The wire summary of a batch and its SQL counts. */
function summary(
  batch: reminderBatchesRepo.BatchRow,
  counts: reminderBatchesRepo.BatchCounts | undefined,
): ReminderBatchSummary {
  return {
    id: batch.id,
    state: batch.state,
    channels: fromStored(batch.channels),
    scheduledFor: batch.scheduledFor.toISOString(),
    createdAt: batch.createdAt.toISOString(),
    cancelledAt: batch.cancelledAt ? batch.cancelledAt.toISOString() : null,
    completedAt: batch.completedAt ? batch.completedAt.toISOString() : null,
    itemCount: batch.itemCount,
    counts: counts ?? { pending: 0, sent: 0, notSent: 0, uncertain: 0, cancelled: 0 },
  };
}

/* ─────────────────────────────── the worker's dispatch ─────────────────────────────── */

export interface ReminderBatchSweepDeps {
  /** `rekoda_worker`: only to ask which batches are due (ID-only discovery). */
  workerDb: Db;
  /** `rekoda_app`: every claim and finish runs under a tenant pin. */
  appDb: Db;
  reminders: ReminderService;
  /**
   * `REKODA_CUSTOMER_REMINDERS`. While false the pass claims nothing, so a batch scheduled before
   * reminders were switched off is kept, not consumed as refusals, and goes once they are back on.
   */
  released: boolean;
}

export interface ReminderBatchSweepResult {
  /** Recipients whose send was attempted this pass (whatever the outcome). */
  dispatched: number;
  /** Recipients stopped by the guard: the batch was cancelled or the scheduler can no longer send. */
  withdrawn: number;
  /** Batches that finished this pass. */
  completed: number;
  /** Batches paused after repeated undelivered sends; their remaining recipients wait `pauseMs`. */
  paused: number;
  /** Recipients left claimed after an unexpected error; reclaimed later with the same key. */
  errored: number;
}

const log = new Logger('ReminderBatchSweep');

/**
 * One pass: every due batch, recipients in order, one send at a time, at most `sendsPerPass`
 * sends. Safe to run on several replicas and to overlap with itself: discovery is read-only, each
 * recipient is claimed with `SKIP LOCKED`, and the reminder key makes a repeat a replay.
 */
export async function sweepReminderBatches(
  deps: ReminderBatchSweepDeps,
  at?: Date | (() => Date),
): Promise<ReminderBatchSweepResult> {
  const clock = (): Date => (typeof at === 'function' ? at() : (at ?? new Date()));
  const result: ReminderBatchSweepResult = {
    dispatched: 0,
    withdrawn: 0,
    completed: 0,
    paused: 0,
    errored: 0,
  };
  if (!deps.released) return result;
  let budget: number = REMINDER_BATCH_LIMITS.sendsPerPass;
  let after: { scheduledFor: Date; batchId: string } | null = null;

  for (;;) {
    if (budget <= 0) break;
    const due = await reminderBatchesRepo.dueBatches(deps.workerDb, clock(), 200, after);
    if (due.length === 0) break;
    const last = due[due.length - 1]!;
    after = { scheduledFor: last.scheduledFor, batchId: last.batchId };

    for (const { batchId, businessId } of due) {
      let failuresInARow = 0;
      for (;;) {
        if (budget <= 0) break;
        const now = clock();
        let claimed: reminderBatchesRepo.ClaimedItem | null;
        try {
          claimed = await withBusiness(deps.appDb, businessId, (tx) =>
            reminderBatchesRepo.claimNextItem(
              tx,
              businessId,
              batchId,
              now,
              new Date(now.getTime() - REMINDER_BATCH_LIMITS.staleClaimMs),
            ),
          );
        } catch (error) {
          log.warn(`batch ${batchId}: claim failed: ${redactForLog(errorClass(error))}`);
          break;
        }
        if (!claimed) {
          try {
            const done = await withBusiness(deps.appDb, businessId, (tx) =>
              reminderBatchesRepo.completeIfDrained(tx, businessId, batchId, clock()),
            );
            if (done) result.completed += 1;
          } catch (error) {
            log.warn(`batch ${batchId}: completion not recorded: ${errorClass(error)}`);
          }
          break;
        }

        const { itemId, invoiceNumber, batch } = claimed;
        if (claimed.attempts > REMINDER_BATCH_LIMITS.maxAttempts) {
          /* The same unexpected error keeps stopping this recipient (for example a contact that
           * cannot be opened). It is skipped with a reason, never sent, so the batch can finish.
           * Its send replays a reminder row if an earlier attempt wrote one. */
          try {
            await withBusiness(deps.appDb, businessId, (tx) =>
              reminderBatchesRepo.finishItem(
                tx,
                businessId,
                itemId,
                'skipped',
                'dispatch_error',
                clock(),
              ),
            );
          } catch (error) {
            log.warn(`batch ${batchId}: recipient skip not recorded: ${errorClass(error)}`);
            break;
          }
          continue;
        }
        let finish: { state: 'done' | 'skipped' | 'cancelled'; reason: string | null };
        let allFailed = false;
        try {
          const sent = await deps.reminders.send(
            businessId,
            batch.createdBy,
            {
              invoiceNumber,
              channels: fromStored(batch.channels),
              idempotencyKey: reminderBatchesRepo.batchItemKey(batchId, itemId),
              /* No attestation here: the batch's was recorded at confirmation for the addresses
               * then on file, and `prepare` finds it; a changed address has none and is refused. */
            },
            clock(),
            {
              guard: async (tx) => {
                const allowed = await reminderBatchesRepo.dispatchAllowed(
                  tx,
                  businessId,
                  batchId,
                  batch.createdBy,
                );
                return allowed === 'ok' ? null : allowed;
              },
            },
          );
          finish = { state: 'done', reason: null };
          /* Not delivered on any channel because the provider refused or could not confirm it (a
           * rate limit, an outage, a timeout). A named refusal (opted out, paid) is not a failure. */
          allFailed =
            sent.results.length > 0 &&
            sent.results.every(
              (r) => r.reminder.status === 'failed' || r.reminder.status === 'uncertain',
            );
          result.dispatched += 1;
        } catch (error) {
          if (error instanceof ReminderWithdrawn) {
            finish = {
              state: error.reason === 'batch_cancelled' ? 'cancelled' : 'skipped',
              reason: error.reason,
            };
            result.withdrawn += 1;
          } else if (error instanceof ReminderInvoiceNotFound) {
            finish = { state: 'done', reason: 'invoice_not_found' };
          } else {
            /* Unknown: the item stays `dispatching` and is reclaimed after `staleClaimMs` with the
             * same key, which replays whatever was recorded and sends only what never started. */
            log.warn(`batch ${batchId}: recipient not finished: ${errorClass(error)}`);
            result.errored += 1;
            break;
          }
        }
        budget -= 1;
        try {
          await withBusiness(deps.appDb, businessId, (tx) =>
            reminderBatchesRepo.finishItem(
              tx,
              businessId,
              itemId,
              finish.state,
              finish.reason,
              clock(),
            ),
          );
        } catch (error) {
          /* The reminder row is the truth; the item is reclaimed later and its send replays. */
          log.warn(`batch ${batchId}: recipient finish not recorded: ${errorClass(error)}`);
          break;
        }
        failuresInARow = allFailed ? failuresInARow + 1 : 0;
        if (failuresInARow >= REMINDER_BATCH_LIMITS.failuresBeforePause) {
          /* The provider keeps refusing (a rate limit, an outage): stop this batch until the next
           * pass rather than spend every remaining recipient on the same refusal. */
          result.paused += 1;
          log.warn(`batch ${batchId}: paused after ${failuresInARow} undelivered sends in a row`);
          try {
            await withBusiness(deps.appDb, businessId, (tx) =>
              reminderBatchesRepo.pauseBatch(
                tx,
                businessId,
                batchId,
                new Date(clock().getTime() + REMINDER_BATCH_LIMITS.pauseMs),
              ),
            );
          } catch (error) {
            log.warn(`batch ${batchId}: pause not recorded: ${errorClass(error)}`);
          }
          break;
        }
      }
    }
  }
  return result;
}

/** The class name only: a message could carry an address or query text. */
function errorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : 'unknown';
}
