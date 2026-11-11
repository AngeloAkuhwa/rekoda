/**
 * The end of a paid cycle (ADR 0024).
 *
 * `dueForRenewal` has existed since the storage landed with nothing calling
 * it, which meant a paid cycle ended and nothing happened: the merchant kept
 * every paid feature indefinitely and no charge was ever raised. This is the
 * sweep that closes it.
 *
 * ── why it does not take money ──────────────────────────────────────────────
 *
 * Charging a card automatically needs an authorization saved from a previous
 * payment, and there has been no previous payment: spec §47 keeps live
 * Paystack behind a written confirmation, so no merchant can be on a paid
 * plan yet at all. Building a recurring-charge path now would mean shipping
 * code against a provider nobody can exercise, for a gate that is closed.
 *
 * What it does instead is the part that is true regardless of how the money
 * arrives: RAISE THE CHARGE and start the clock. The merchant owes a month,
 * the reference exists so a payment can be matched to it, and the grace
 * period that already works takes over from there - reminders on days 1 and
 * 5, read-only on day 7. Paying at any point in that window settles the
 * charge, and `applySettledCharge` restores everything in one transaction.
 *
 * Card-on-file is the optimisation, not the mechanism. Adding it later means
 * settling this same charge from a webhook instead of from a payment link,
 * and nothing in this file changes.
 */
import { Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { addInterval, subscriptionReference } from '@rekoda/core';
import { redactForLog } from '@rekoda/core/privacy';
import { jobsRepo, subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import { JobKind } from '../jobs/queue.service.js';
import { planPriceKFor, pricingSourceOf, type PlanTermsConfig } from './plan-terms.js';
import { chargeGate } from './paystack-key.js';

export interface RenewalSweepDeps {
  /** `rekoda_worker` - "whose cycle ended" names no tenant, which is the point. */
  workerDb: Db;
  /** `rekoda_app` - closing a renewal block the gate no longer holds, and a cancelled cycle's
   * lapse, under a tenant pin. The renewal itself (its charge, clock and block) runs on settlement. */
  appDb: Db;
  /** `rekoda_settlement` - the only role that opens a charge, so it prices the renewal (OD-37). */
  settlementDb: Db;
  /** The catalogue flag: a renewal is priced by the merchant's PINNED version. The Paystack key
   * and the §47 confirmation decide whether the renewal can be paid at all (OWN-70). */
  config: PlanTermsConfig & { paystackSecretKey: string; paystackPlatformConfirmed: boolean };
  /** Blocked renewals listed per page when closing them (default 200; a test sets it small). */
  blockPageSize?: number;
  /** Pages listed per closing pass (default 20; a test lowers it to simulate an interrupted pass). */
  maxBlockPages?: number;
}

export interface RenewalSweepResult {
  raised: number;
  /** Businesses already carrying a charge for this cycle. Not an error. */
  skipped: number;
}

const log = new Logger('RenewalSweep');

export async function sweepRenewals(
  deps: RenewalSweepDeps,
  now: Date = new Date(),
): Promise<RenewalSweepResult> {
  const result: RenewalSweepResult = { raised: 0, skipped: 0 };

  /* Raising a charge starts the grace clock and takes the row OUT of the due
   * set, so repeating until a short page drains everything due rather than
   * capping the hour at one bite. */
  const PAGE = 200;
  /* A business is worked at most once per pass. One that cannot progress (its
   * charge could not be opened) would otherwise be read again on every page and
   * keep a full page from ever looking drained. */
  const seen = new Set<string>();
  for (;;) {
    const before = result.raised + result.skipped;
    const page = await subscriptionsRepo.dueForRenewal(deps.workerDb, now, PAGE);
    const due = page.filter((business) => !seen.has(business.businessId));
    for (const business of due) {
      seen.add(business.businessId);
      /* The plan the NEXT cycle is on: a scheduled downgrade takes effect here,
       * which is exactly what ADR 0024 promised the merchant. */
      const plan = business.nextPlan;

      /* A cancellation is a downgrade whose destination is nothing (fix-plan
       * 5, H2a). No charge is raised and no grace clock starts: the merchant
       * asked for exactly this, and dunning somebody for a month they
       * declined would be the bill the cancel button promised away. The
       * expiry is race-safe in the repo: a payment landing between the read
       * and the write keeps its plan. */
      if (plan === 'expired') {
        try {
          await withBusiness(deps.appDb, business.businessId, (tx) =>
            subscriptionsRepo.expireSubscription(
              tx,
              business.businessId,
              'system:renewal_sweep',
              'cancelled',
            ),
          );
          result.skipped += 1;
        } catch (error) {
          log.error(
            `cancel apply failed for ${business.businessId}: ${redactForLog(String(error))}`,
          );
          result.skipped += 1;
        }
        continue;
      }

      try {
        /* On the settlement principal, the worker's own (OD-37, 0209): the renewal sweep opens a
         * renewal and starts its grace clock in one transaction. */
        const opened = await withBusiness(deps.settlementDb, business.businessId, async (tx) => {
          /* G-104: lock first, so an operator move cannot slip between pricing
           * this renewal and opening its charge. */
          await subscriptionsRepo.lockBusiness(tx, business.businessId);
          /* A renewal left pending across an operator change on the same cycle
           * would otherwise collide with the replacement on the cycle index and
           * leave the merchant without a payable renewal. */
          await subscriptionsRepo.retireStalePending(tx, business.businessId);
          /* ...and RE-READ under it: `business` came from a read taken before
           * the lock, and a move or cancellation may have committed since. */
          const fresh = await subscriptionsRepo.dueForRenewalLocked(tx, business.businessId, now);
          if (!fresh) return false;
          if (fresh.nextPlan === 'expired') {
            /* A cancellation that committed after the due read: apply it now, in
             * this pass, rather than leave an already-cancelled paid plan active
             * until the next scheduled sweep. */
            await subscriptionsRepo.expireSubscription(
              tx,
              business.businessId,
              'system:renewal_sweep',
              'cancelled',
            );
            return false;
          }
          const plan = fresh.nextPlan;
          const anchorDay =
            fresh.renewalAnchorDay ?? new Date(fresh.renewsAt.getTime() + 3_600_000).getUTCDate();
          /* The pinned version's price, which is the grandfathering promise
           * kept where it matters: a launch merchant renews at launch
           * pricing after a repricing, because their pin still points at
           * the version whose price rows never changed. A scheduled
           * downgrade is a different plan, so the stale-pin rule prices it
           * at the version on sale today. */
          /* Priced at its own moment, not the pass's start: the database bounds a charge's pricing
           * time to within five minutes of its opening (0209), and a long pass must not age it. */
          const pricedAt = new Date();
          const amountK = await planPriceKFor(
            deps.config,
            tx,
            business.businessId,
            plan,
            pricedAt,
            fresh.nextInterval,
          );
          const reference = subscriptionReference(now, randomBytes);
          const id = await subscriptionsRepo.openCharge(tx, {
            businessId: business.businessId,
            kind: 'renewal',
            plan,
            amountK,
            reference,
            /* The cycle this buys STARTS when the last one ended, not when the
             * sweep happened to run. A sweep an hour late must not sell the
             * merchant fifty-nine minutes less month. */
            periodStart: fresh.renewsAt,
            periodEnd: addInterval(fresh.renewsAt, fresh.nextInterval, anchorDay),
            billingInterval: fresh.nextInterval,
            /* The instant settlement re-prices it at (OD-51). */
            pricedAt,
            pricingSource: pricingSourceOf(deps.config),
          });
          if (!id) return false;

          /**
           * The clock starts at the RENEWAL DATE, not at now.
           *
           * A sweep that ran two days late would otherwise hand the merchant
           * two extra days of grace, and a sweep that ran late twice would
           * hand out four. The seven days are counted from the moment the
           * cycle actually ended, whatever time anybody noticed.
           */
          /**
           * The grace clock starts at the renewal date, deliberately: a sweep
           * two hours late must not gift two extra grace days. But floored at
           * two days ago, because after a LONG outage the backdated clock
           * would already be past day seven, and the very next grace pass
           * would cut a paying merchant off with zero reminders delivered.
           * The floor guarantees the dunning ladder gets at least five days.
           */
          const failedAt = new Date(
            Math.max(fresh.renewsAt.getTime(), Date.now() - 2 * 86_400_000),
          );
          await subscriptionsRepo.markRenewalFailed(tx, business.businessId, failedAt);

          /* OWN-70: the same gate that refuses a live-key charge without the §47 confirmation.
           * The renewal row and the grace clock above are kept exactly as ADR 0024 describes
           * (OD-44 is open: no resume, no other expiry policy). What changes is that a renewal
           * nobody can pay is RECORDED: stamped on the charge, audited, listed for an operator and
           * alerted on. It is never marked paid and no Paystack reference or event is invented. */
          const gate = chargeGate(deps.config);
          if (!gate.ok) {
            await subscriptionsRepo.markRenewalBlocked(
              tx,
              business.businessId,
              reference,
              gate.reason,
            );
            return 'blocked' as const;
          }
          return true;
        });

        if (opened) {
          result.raised += 1;
          if (opened === 'blocked') {
            log.warn(
              `business ${business.businessId}: renewal raised but cannot be paid yet (OWN-70)`,
            );
          }
          log.log(`business ${business.businessId}: renewal raised`);
        } else {
          result.skipped += 1;
        }
      } catch (error) {
        /* One merchant's renewal failing must not stop the rest of the estate
         * renewing. Nothing partial survives: the charge and the clock are one
         * transaction. */
        log.warn(
          `business ${business.businessId}: renewal could not be raised: ${redactForLog(String(error))}`,
        );
      }
    }
    /* A short page means the set is drained; zero progress on a full page
     * means every row is erroring, and spinning on them helps nobody. */
    if (page.length < PAGE || due.length === 0 || result.raised + result.skipped === before) break;
  }

  /* OWN-70: once the gate is open (the §47 confirmation recorded, or a usable key set), a renewal
   * stamped blocked can be paid like any other, so its block is closed here, audited, and the
   * alert clears without an operator closing each one by hand. It runs AFTER the due renewals have
   * been raised: housekeeping, however long a pass of failing blocks takes, never delays a renewal.
   * A pass that stops on an error is logged and resumed by the next pass from the durable cursor. */
  if (chargeGate(deps.config).ok) {
    try {
      await closeBlocksTheGateNoLongerHolds(deps, deps.blockPageSize, deps.maxBlockPages);
    } catch (error) {
      /* The cursor keeps its last durable position; the next pass resumes from it. */
      log.error(`blocked-renewal close pass stopped: ${redactForLog(String(error))}`);
    }
  }

  return result;
}

/** Blocks listed per page, and pages per pass, when closing them after the gate opens. */
const BLOCK_PAGE = 200;
const BLOCK_PAGES = 20;
/** How long a pass holds the cursor lease without advancing before another runner may take it. */
const BLOCK_LEASE_SECONDS = 900;

/** What one close pass did; returned for the caller and the tests. */
export interface BlockClosePassResult {
  /** False when another runner held the cursor lease, so this pass did nothing. */
  ran: boolean;
  closed: number;
  /** Blocks that could not be closed this pass (each logged with its reference). */
  failed: number;
  /** The pass reached the end of the list and moved the cursor back to the start. */
  wrapped: boolean;
}

/**
 * Close the blocks the open gate no longer holds, bounded per pass, from a DURABLE cursor
 * (migration 0199).
 *
 * The pass walks open blocks in keyset order (blocked_at, reference): `blocked_at` never changes
 * once set and `reference` is unique, so the order is total and stable whatever is closed, added
 * or removed meanwhile. The position lives in the database, not in this process:
 *
 *  - The pass first claims the cursor lease; if another runner holds it, this pass does nothing.
 *  - Each batch is processed, THEN the cursor is advanced to the batch's last key (a
 *    compare-and-set on the lease). A crash before the advance replays that batch next time,
 *    which is safe: a close is conditional on the block still being open, and the failure stamp
 *    is a plain timestamp. A failed advance (lease lost, database error) stops the pass; the batch
 *    is not reported as durably processed.
 *  - A block whose close fails is logged and passed over, whether or not its failure stamp could
 *    be written, so a block that fails both cannot hold the pass at its place; a restart resumes
 *    after it, not at the start.
 *  - Reaching the end of the list wraps the cursor to the start: blocks that failed are retried and
 *    blocks with an earlier key are reached on the next pass.
 *  - On an unexpected error the lease is released and the position kept; it is never reset here.
 *    If the release itself fails, that is logged as an alert, the lease expires unreleased (the
 *    ops alert reports a stalled pass) and the next claim records the abandoned pass's counts.
 */
export async function closeBlocksTheGateNoLongerHolds(
  /* Closing a block opens no charge, so it needs no settlement pool. */
  deps: Omit<RenewalSweepDeps, 'settlementDb'>,
  pageSize = BLOCK_PAGE,
  maxPages = BLOCK_PAGES,
  leaseSeconds = BLOCK_LEASE_SECONDS,
): Promise<BlockClosePassResult> {
  const owner = randomUUID();
  const result: BlockClosePassResult = { ran: false, closed: 0, failed: 0, wrapped: false };
  if (!(await subscriptionsRepo.claimBlockCloseCursor(deps.workerDb, owner, leaseSeconds))) {
    log.log('blocked-renewal close pass skipped: another runner holds the close cursor');
    return result;
  }
  result.ran = true;
  let unrecordedFailed = 0;
  try {
    for (let page = 0; page < maxPages; page += 1) {
      const batch = await subscriptionsRepo.blockedRenewalsCloseBatch(deps.workerDb, pageSize);
      if (batch.length === 0) {
        result.wrapped = true;
        break;
      }
      let closed = 0;
      let failed = 0;
      for (const blocked of batch) {
        /* Heartbeat (0201): renew the lease before each close, so a slow but healthy batch keeps
         * it and no second runner takes over while this one is still working. A runner that lost
         * the lease (it stalled past it and another took over) stops here: it closes nothing more
         * and saves nothing. Progress drives the renewal, not a timer, so a hung runner still lets
         * its lease expire. */
        /* The batch's counts are kept current before the call, so a heartbeat that throws (a
         * database error, not a lost lease) still reports the failures this batch already saw. */
        unrecordedFailed = failed;
        let renewed: boolean;
        try {
          renewed = await subscriptionsRepo.heartbeatBlockCloseCursor(
            deps.workerDb,
            owner,
            leaseSeconds,
          );
        } catch (error) {
          result.closed += closed;
          throw error;
        }
        if (!renewed) {
          result.closed += closed;
          throw new Error(
            'the close cursor lease was lost mid-batch; this runner stops without saving',
          );
        }
        try {
          const closedNow = await withBusiness(deps.appDb, blocked.businessId, async (tx) => {
            const closedHere = await subscriptionsRepo.resolveBlockedRenewal(
              tx,
              blocked.businessId,
              blocked.reference,
              'the payment gate is open: the renewal can now be paid',
              'system:gate_open',
              'system',
            );
            /* OD-44: the block was raised before any payment existed, so there is nothing to
             * resume. A fresh payment is started for it by its own job, enqueued in the same
             * transaction as the close (one per charge), so a close that commits always has its
             * initiation queued and a close that rolls back has none. */
            if (closedHere) {
              await jobsRepo.enqueue(tx, {
                businessId: blocked.businessId,
                kind: JobKind.InitiateBlockedRenewal,
                payload: { reference: blocked.reference },
                singletonKey: `renewal-initiate:${blocked.reference}`,
              });
            }
            return closedHere;
          });
          // False when a concurrent runner (or an operator) already closed it: not ours to count.
          if (closedNow) closed += 1;
        } catch (error) {
          failed += 1;
          let stamped = false;
          try {
            stamped = await withBusiness(deps.appDb, blocked.businessId, (tx) =>
              subscriptionsRepo.noteBlockCloseFailed(tx, blocked.businessId, blocked.reference),
            );
          } catch {
            stamped = false;
          }
          /* Safe identifiers only: the charge reference, the business id and the block reason. */
          log.warn(
            `renewal_block_close_failed business=${blocked.businessId} reference=${blocked.reference} ` +
              `reason=${blocked.reason} stamped=${stamped} error=${redactForLog(String(error))}`,
          );
        }
      }
      /* Counted for the alert even if the advance below fails: these failures happened. */
      unrecordedFailed = failed;
      const last = batch[batch.length - 1]!;
      const advanced = await subscriptionsRepo.advanceBlockCloseCursor(
        deps.workerDb,
        owner,
        { blockedAtUs: last.blockedAtUs, reference: last.reference },
        { closed, failed },
        leaseSeconds,
      );
      if (!advanced) {
        throw new Error('the close cursor lease was lost; this batch is not recorded as processed');
      }
      result.closed += closed;
      result.failed += failed;
      unrecordedFailed = 0;
      if (batch.length < pageSize) {
        result.wrapped = true;
        break;
      }
    }
    if (!(await subscriptionsRepo.finishBlockClosePass(deps.workerDb, owner, result.wrapped))) {
      throw new Error('the close cursor lease was lost before the pass could be finished');
    }
  } catch (error) {
    /* A release that fails is never silent: the lease then expires unreleased, the ops alert
     * reports the pass as stalled, and the next claim records what this pass saved. */
    await subscriptionsRepo
      .releaseBlockCloseCursor(deps.workerDb, owner, unrecordedFailed)
      .then((released) => {
        if (!released) {
          log.warn(
            'renewal_block_close_release_lost: the close cursor lease was already taken over',
          );
        }
      })
      .catch((releaseError: unknown) => {
        log.error(
          `ALERT renewal_block_close_release_failed unrecorded_failed=${unrecordedFailed} ` +
            `error=${redactForLog(String(releaseError))}`,
        );
      });
    const failedThisPass = result.failed + unrecordedFailed;
    if (failedThisPass > 0) {
      /* A pass that stopped still says so: the failures it saw happened, saved or not. */
      log.error(
        `ALERT renewal_block_close_pass failed=${failedThisPass} closed=${result.closed} stopped=true`,
      );
    }
    throw error;
  }
  if (result.failed > 0) {
    /* Every affected pass says so, whatever the alerting cadence: the ops alert
     * (billing.renewal_block_close_failing) reads the same count from the cursor. */
    log.error(
      `ALERT renewal_block_close_pass failed=${result.failed} closed=${result.closed} wrapped=${result.wrapped}`,
    );
  }
  return result;
}
