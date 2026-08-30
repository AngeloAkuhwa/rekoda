/**
 * Keeping the published retention schedule (ADR 0024, /privacy#retention).
 *
 * The schedule states maximums, and a maximum is a promise about a date. This
 * is what keeps it: two stages, sixty days apart, and neither of them can run
 * without the other having run first.
 *
 *   warn  - a trial that ended `RETENTION_NOTICE_DAYS` ago, whose owner has
 *           never paid us anything, is told when their records will go
 *   delete - thirty days after that warning, they go
 *
 * Three things stop this reaching a merchant it must not:
 *
 *   1. Anyone who ever completed a subscription charge is excluded from every
 *      query, because their books are subject to the financial retention
 *      period instead.
 *   2. The warning must have been SENT. A send that failed leaves
 *      `retention_notified_at` unset, so the deletion stage never sees them:
 *      a schedule that promises notice cannot delete somebody it could not
 *      reach.
 *   3. The deletion itself re-checks the whole predicate inside the database,
 *      in a SECURITY DEFINER function the worker may execute and nothing
 *      more. A merchant who started paying between the query and the call is
 *      refused, and the refusal is the system working.
 */
import { Logger } from '@nestjs/common';
import {
  RETENTION,
  RETENTION_NOTICE_DAYS,
  objectDeletionRetryAt,
  retentionCutoff,
} from '@rekoda/core';
import { redactForLog } from '@rekoda/core/privacy';
import {
  evidenceRetentionRepo,
  objectDeletionsRepo,
  retentionRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { SendFailed, type MessageSender } from '../channels/sender.js';
import { recordMessageCost } from '../channels/message-cost.js';
import type { DocumentStorage } from '../documents/storage.js';

export interface RetentionSweepDeps {
  /** `rekoda_worker` - "who is due" names no tenant, and the delete function
   * is granted to this role alone. */
  workerDb: Db;
  /** `rekoda_app` - the warning claim runs under a tenant pin. */
  appDb: Db;
  sender: MessageSender;
  /** Planning FX, for pricing the utility template this sweep sends. */
  fxNairaPerUsd: number;
}

export interface RetentionSweepResult {
  warned: number;
  deleted: number;
  /** Rows removed across every deletion, so an empty sweep is distinguishable. */
  rowsRemoved: number;
}

const log = new Logger('RetentionSweep');

/** Lagos, so a merchant reads the date they would write on a form. */
function lagosDate(at: Date): string {
  const lagos = new Date(at.getTime() + 3_600_000);
  return `${String(lagos.getUTCDate()).padStart(2, '0')}/${String(lagos.getUTCMonth() + 1).padStart(2, '0')}/${lagos.getUTCFullYear()}`;
}

export async function sweepRetention(
  deps: RetentionSweepDeps,
  now: Date = new Date(),
): Promise<RetentionSweepResult> {
  const result: RetentionSweepResult = { warned: 0, deleted: 0, rowsRemoved: 0 };

  await warn(deps, now, result);
  await erase(deps, now, result);
  return result;
}

async function warn(
  deps: RetentionSweepDeps,
  now: Date,
  result: RetentionSweepResult,
): Promise<void> {
  /* Pages until drained: claiming removes a row from the set, so a repeat
   * with no progress (every candidate unreachable) is the stop signal. */
  const PAGE = 200;
  for (;;) {
    const before = result.warned;
    const candidates = await retentionRepo.dueForNotice(
      deps.workerDb,
      retentionCutoff(now, RETENTION_NOTICE_DAYS),
      PAGE,
    );
    for (const candidate of candidates) {
      const deletesOn = new Date(
        candidate.endedAt.getTime() + RETENTION.abandonedTrialDays * 86_400_000,
      );

      /* No phone, or STOP. Both mean we cannot warn them, and neither is a
       * reason to delete anyway: the claim is not taken, so the deletion stage
       * never sees this business and their records stay. A merchant who asked
       * for silence did not ask to be forgotten. */
      if (!candidate.ownerPhone || candidate.ownerOptedOut) continue;

      try {
        await deps.sender.sendRetentionNotice({
          to: candidate.ownerPhone,
          daysLeft: String(
            Math.max(0, Math.ceil((deletesOn.getTime() - now.getTime()) / 86_400_000)),
          ),
          deletesOn: lagosDate(deletesOn),
        });
        /* A UTILITY template, and one Rekoda pays Meta for. Recorded after
         * the send, never before: a warning that did not arrive is a warning
         * nobody was billed for. */
        await recordMessageCost(
          deps.appDb,
          candidate.businessId,
          'UTILITY_TEMPLATE',
          deps.fxNairaPerUsd,
          { template: 'retention' },
        );
      } catch (error) {
        /* Unreached means not warned means not deleted. The claim below is
         * skipped on purpose, so the next pass tries again. */
        const reason = error instanceof SendFailed ? error.message : String(error);
        log.warn(
          `business ${candidate.businessId}: retention notice not delivered, not claiming: ${redactForLog(reason)}`,
        );
        continue;
      }

      const claimed = await withBusiness(deps.appDb, candidate.businessId, (tx) =>
        retentionRepo.claimRetentionNotice(tx, candidate.businessId, now),
      );
      if (claimed) result.warned += 1;
    }
    if (candidates.length < PAGE || result.warned === before) break;
  }
}

async function erase(
  deps: RetentionSweepDeps,
  now: Date,
  result: RetentionSweepResult,
): Promise<void> {
  const endedBefore = retentionCutoff(now, RETENTION.abandonedTrialDays);
  const notifiedBefore = retentionCutoff(now, RETENTION.noticeDays);

  /* 50 per BITE, not per six hours: the old single bite made 200 deletions
   * a day the compliance ceiling, and a backlog past it simply grew. */
  const PAGE = 50;
  for (;;) {
    const before = result.deleted;
    const candidates = await retentionRepo.dueForDeletion(
      deps.workerDb,
      endedBefore,
      notifiedBefore,
      PAGE,
    );
    for (const candidate of candidates) {
      let removed: number;
      try {
        removed = await retentionRepo.deleteForRetention(
          deps.workerDb,
          candidate.businessId,
          endedBefore,
        );
      } catch (error) {
        /* A foreign key nobody expected. The whole deletion rolled back, so
         * nothing is half-gone, and this is the one failure here worth waking
         * somebody for: the schedule is now being missed. */
        log.error(
          `business ${candidate.businessId}: retention deletion failed and rolled back: ${redactForLog(String(error))}`,
        );
        continue;
      }

      if (removed < 0) {
        /* The function's own predicate refused. Somebody paid us between the
         * query and the call, which is the best possible reason to stop. */
        log.log(`business ${candidate.businessId}: no longer due for deletion, skipped`);
        continue;
      }
      result.deleted += 1;
      result.rowsRemoved += removed;
      log.log(`business ${candidate.businessId}: deleted on schedule, ${removed} rows`);
    }
    if (candidates.length < PAGE || result.deleted === before) break;
  }
}

/* ── the evidence clocks (spec §23; PR-011) ─────────────────────────────── */

export interface EvidenceSweepResult {
  expired: number;
  purged: number;
  /** Raw refs whose objects the storage port should now delete. */
  purgedRefs: string[];
}

/**
 * Expire the abandoned claims and purge the raw media that outlived its
 * countdown. The worker discovers, the app credential mutates under a tenant
 * pin, and every pinned WHERE re-checks what discovery saw — so a legal hold
 * placed between the two is honoured.
 *
 * The purged refs are QUEUED for deletion in the same transaction that nulls
 * the pointer (PR-136), not deleted here. Two reasons, and both matter. The
 * pointer must go first, because an orphaned object is re-findable while a
 * pointer to a deleted object is a claim that lies. And once the pointer is
 * gone nothing else in the estate knows the key, so a delete attempted here
 * and failing would lose it: `drainObjectDeletions` performs the deletion
 * afterwards, from a promise that survives the attempt failing.
 *
 * `purgedRefs` is still returned, for the caller's log and the tests.
 */
export async function sweepEvidence(
  deps: { workerDb: Db; appDb: Db },
  now = new Date(),
): Promise<EvidenceSweepResult> {
  const result: EvidenceSweepResult = { expired: 0, purged: 0, purgedRefs: [] };

  const byBusiness = (rows: { businessId: string; evidenceId: string }[]) => {
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      groups.set(row.businessId, [...(groups.get(row.businessId) ?? []), row.evidenceId]);
    }
    return groups;
  };

  for (const [businessId, ids] of byBusiness(
    await evidenceRetentionRepo.dueForExpiry(deps.workerDb, now),
  )) {
    result.expired += await withBusiness(deps.appDb, businessId, (tx) =>
      evidenceRetentionRepo.expireEvidence(tx, businessId, ids, now),
    );
  }

  const cutoff = retentionCutoff(now, RETENTION.evidenceRawDays);
  for (const [businessId, ids] of byBusiness(
    await evidenceRetentionRepo.dueForPurge(deps.workerDb, cutoff),
  )) {
    const refs = await withBusiness(deps.appDb, businessId, async (tx) => {
      const purged = await evidenceRetentionRepo.purgeRaw(tx, businessId, ids, cutoff, now);
      /* Same transaction as the nulling above: the promise to delete the
       * object and the loss of the only pointer to it commit together, or
       * neither happens. */
      await objectDeletionsRepo.enqueueObjectDeletions(tx, businessId, purged, 'evidence_purged');
      return purged;
    });
    result.purged += refs.length;
    result.purgedRefs.push(...refs);
  }

  return result;
}

/* ── keeping the other half of the promise (PR-136) ─────────────────────── */

export interface ObjectDrainResult {
  /** Objects actually gone from the store on this pass. */
  deleted: number;
  /** Attempts the provider refused; each stays queued with its reason. */
  failed: number;
  /** Still owed after this pass, including what was not yet due. */
  outstanding: number;
}

/**
 * Delete the objects the estate has already promised to delete.
 *
 * The queue is written by whatever orphaned the object, inside that same
 * transaction; this reads it AFTER those transactions have committed and
 * performs the deletions the database can no longer describe. Row first,
 * object second, always: the reverse order can leave a row pointing at
 * nothing, and this order can at worst leave an object nobody points at,
 * which is exactly what this queue remembers.
 *
 * A refusal is never a reason to drop the job. The row stays with its
 * attempt count and the provider's own words, and comes back on the schedule
 * in `objectDeletionRetryAt` until the object is really gone. `outstanding`
 * is the number an operator should expect to be zero.
 *
 * One bite of `PAGE` per pass, on the worker credential: these objects
 * mostly belonged to businesses that no longer exist, so there is no tenant
 * to pin and no policy that could match one.
 */
export async function drainObjectDeletions(
  deps: { workerDb: Db; storage: DocumentStorage },
  now = new Date(),
): Promise<ObjectDrainResult> {
  const PAGE = 200;
  const result: ObjectDrainResult = { deleted: 0, failed: 0, outstanding: 0 };

  const due = await objectDeletionsRepo.dueObjectDeletions(deps.workerDb, now, PAGE);
  for (const job of due) {
    try {
      await deps.storage.delete(job.storageKey);
      await objectDeletionsRepo.objectDeleted(deps.workerDb, job.id);
      result.deleted += 1;
    } catch (error: unknown) {
      /* The key is not logged. It is an unguessable capability for as long
       * as the object exists, and this line is the one place a failing
       * deletion would otherwise print one into an ordinary log file. */
      const reason = redactForLog(String(error));
      log.warn(`object deletion refused, still queued: ${reason}`);
      await objectDeletionsRepo.objectDeletionFailed(
        deps.workerDb,
        job.id,
        reason,
        objectDeletionRetryAt(job.attempts, now),
      );
      result.failed += 1;
    }
  }

  result.outstanding = await objectDeletionsRepo.pendingObjectDeletionCount(deps.workerDb);
  if (result.outstanding > 0) {
    log.log(`${result.outstanding} object deletions still owed`);
  }
  return result;
}
