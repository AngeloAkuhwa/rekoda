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
import { randomBytes } from 'node:crypto';
import { addInterval, subscriptionReference } from '@rekoda/core';
import { redactForLog } from '@rekoda/core/privacy';
import { subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import { planPriceKFor, type PlanTermsConfig } from './plan-terms.js';
import { chargeGate } from './paystack-key.js';

export interface RenewalSweepDeps {
  /** `rekoda_worker` - "whose cycle ended" names no tenant, which is the point. */
  workerDb: Db;
  /** `rekoda_app` - the charge and the clock are written under a tenant pin. */
  appDb: Db;
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
        const opened = await withBusiness(deps.appDb, business.businessId, async (tx) => {
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
          const amountK = await planPriceKFor(
            deps.config,
            tx,
            business.businessId,
            plan,
            now,
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
   * A failing listing is logged and retried by the next pass. */
  if (chargeGate(deps.config).ok) {
    try {
      await closeBlocksTheGateNoLongerHolds(deps, deps.blockPageSize, deps.maxBlockPages);
    } catch (error) {
      log.warn(`blocked renewals could not be listed for closing: ${redactForLog(String(error))}`);
    }
  }

  return result;
}

/** Blocks listed per page, and pages per pass, when closing them after the gate opens. */
const BLOCK_PAGE = 200;
const BLOCK_PAGES = 20;

/* Where the fallback skip (blocks whose close AND stamp both failed) stopped when the last pass ran
 * out of pages. The next pass starts there instead of at the same failing head, and it wraps to 0
 * once the list is exhausted, so a full pass of blocks that cannot be stamped does not by itself
 * starve the blocks behind them. It assumes the first rows of the next pass are the same unstampable
 * blocks; if the head changes (an operator closes one, a new block is raised) a few healthy blocks
 * may be skipped until the offset wraps, which needs the rest of the list to fit in a pass (PR B
 * plan, post-MVP).
 *
 * Held in memory, so a restart begins again at 0. Known limit (PR B plan, post-MVP): if more than a
 * whole pass of blocks refuse both writes AND the process restarts after every pass, each pass
 * starts over at 0 and the blocks behind them wait; closing that needs the offset persisted outside
 * those rows. */
let carriedUnstamped = 0;

/** Test-only: forget the carried fallback offset between test cases. */
export function resetBlockCloseCarryForTests(): void {
  carriedUnstamped = 0;
}

/**
 * Close the blocks the open gate no longer holds, bounded per pass.
 *
 * The cursor is persisted on each block (migration 0198, `blocked_close_failed_at`): candidates come
 * least-recently-attempted first and only those not attempted since this pass began. A block whose
 * close fails is stamped, drops behind every block not yet tried, and is not retried in this pass,
 * so a block that fails persistently cannot keep later blocks waiting: the next pass reaches them
 * first, however many fail. A restart loses nothing (the order is data); two sweeps at once may try
 * the same block, and the close is conditional on the block still being open.
 */
async function closeBlocksTheGateNoLongerHolds(
  deps: RenewalSweepDeps,
  pageSize = BLOCK_PAGE,
  maxPages = BLOCK_PAGES,
): Promise<void> {
  const passStart = await subscriptionsRepo.databaseNow(deps.workerDb);
  /* A block whose close failed and whose stamp also failed stays eligible, at its place in the
   * order. Candidates are taken strictly in that order, so every row that is still listed ahead of
   * the first untried one is exactly such a block: skipping that many rows moves past them and
   * only them (a concurrent sweep removing rows can make the skip land a few rows late, and the
   * next pass picks those up). The stamp is the normal way past a failure; this is its fallback. */
  let unstamped = carriedUnstamped;
  carriedUnstamped = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const open = await subscriptionsRepo.blockedRenewals(
      deps.workerDb,
      pageSize,
      unstamped,
      passStart,
    );
    if (open.length === 0) return;
    for (const blocked of open) {
      try {
        await withBusiness(deps.appDb, blocked.businessId, (tx) =>
          subscriptionsRepo.resolveBlockedRenewal(
            tx,
            blocked.businessId,
            blocked.reference,
            'the payment gate is open: the renewal can now be paid',
            'system:gate_open',
            'system',
          ),
        );
      } catch (error) {
        log.warn(
          `business ${blocked.businessId}: blocked renewal not closed: ${redactForLog(String(error))}`,
        );
        try {
          await withBusiness(deps.appDb, blocked.businessId, (tx) =>
            subscriptionsRepo.noteBlockCloseFailed(tx, blocked.businessId, blocked.reference),
          );
        } catch {
          unstamped += 1;
        }
      }
    }
    if (open.length < pageSize) return;
  }
  // Out of pages before the list ran out: the next pass resumes past the unstampable blocks.
  carriedUnstamped = unstamped;
}
