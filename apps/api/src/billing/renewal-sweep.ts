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
import { addMonth, planPriceK, subscriptionReference } from '@rekoda/core';
import { redactForLog } from '@rekoda/core/privacy';
import { subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';

export interface RenewalSweepDeps {
  /** `rekoda_worker` - "whose cycle ended" names no tenant, which is the point. */
  workerDb: Db;
  /** `rekoda_app` - the charge and the clock are written under a tenant pin. */
  appDb: Db;
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
  for (;;) {
    const before = result.raised + result.skipped;
    const due = await subscriptionsRepo.dueForRenewal(deps.workerDb, now, PAGE);
    for (const business of due) {
      /* The plan the NEXT cycle is on: a scheduled downgrade takes effect here,
       * which is exactly what ADR 0024 promised the merchant. */
      const plan = business.nextPlan;
      const amountK = planPriceK(plan);
      const anchorDay =
        business.renewalAnchorDay ?? new Date(business.renewsAt.getTime() + 3_600_000).getUTCDate();

      try {
        const opened = await withBusiness(deps.appDb, business.businessId, async (tx) => {
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
            periodStart: business.renewsAt,
            periodEnd: addMonth(business.renewsAt, anchorDay),
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
            Math.max(business.renewsAt.getTime(), Date.now() - 2 * 86_400_000),
          );
          await subscriptionsRepo.markRenewalFailed(tx, business.businessId, failedAt);
          return true;
        });

        if (opened) {
          result.raised += 1;
          log.log(`business ${business.businessId}: renewal raised for ${plan}`);
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
    if (due.length < PAGE || result.raised + result.skipped === before) break;
  }

  return result;
}
