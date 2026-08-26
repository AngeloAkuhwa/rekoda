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
import { RETENTION, RETENTION_NOTICE_DAYS, retentionCutoff } from '@rekoda/core';
import { redactForLog } from '@rekoda/core/privacy';
import { evidenceRetentionRepo, retentionRepo, withBusiness, type Db } from '@rekoda/db';
import { SendFailed, type MessageSender } from '../channels/sender.js';
import { recordMessageCost } from '../channels/message-cost.js';

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
 * Returns the purged media refs rather than deleting objects itself: today no
 * writer stores evidence media yet (the writers arrive with PR-022), so the
 * pointer is the whole of the truth; the day objects exist, the caller hands
 * these refs to the storage port AFTER this commits. An orphaned object is
 * re-findable; a pointer to a deleted object is a claim that lies.
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
    const refs = await withBusiness(deps.appDb, businessId, (tx) =>
      evidenceRetentionRepo.purgeRaw(tx, businessId, ids, cutoff, now),
    );
    result.purged += refs.length;
    result.purgedRefs.push(...refs);
  }

  return result;
}
