/**
 * Charging equipment against the months it is used (ADR 0026).
 *
 * Without this the fixed-asset feature would be a NEW misstatement replacing
 * the old one: a generator would sit on the balance sheet at its full price
 * forever, overstating what the business owns by more every month, and the
 * page promising "a slice of the cost is charged each month" would be
 * promising something nothing does.
 *
 * ── why it catches up rather than skipping ─────────────────────────────────
 *
 * The same reason the recurring sweep does. A month that passed while nothing
 * was running is still a month the business used the generator. Each pass
 * charges ONE month and advances the count by one, so an outage produces the
 * months it missed rather than collapsing them into a single figure that
 * belongs to no month.
 *
 * ── why the count is claimed before the posting ────────────────────────────
 *
 * `chargeOneMonth` takes the count it expects and updates conditionally, so
 * two sweeps running together cannot both charge the same month: whichever
 * loses updates nothing and stops. Depreciation is the one charge a merchant
 * would never notice being doubled, which is exactly why it must not be.
 */
import { Logger } from '@nestjs/common';
import { lagosDay } from '@rekoda/core';
import { redactForLog } from '@rekoda/core/privacy';
import { assetsRepo, withBusiness, type Db } from '@rekoda/db';

export interface DepreciationSweepDeps {
  /** `rekoda_worker` — "whose equipment is due" names no tenant. SELECT only. */
  workerDb: Db;
  /** `rekoda_app` — the claim and the posting are written under a tenant pin. */
  appDb: Db;
}

export interface DepreciationSweepResult {
  charged: number;
  chargedK: number;
  /** Months another sweep had already claimed. Not an error. */
  skipped: number;
}

/**
 * A year's worth per asset per run. A bound rather than a limit anybody
 * should reach: twelve months behind is an outage measured in a year, and a
 * runaway loop writing charges into a merchant's books is a worse failure
 * than a catch-up that finishes on the next pass.
 */
const MAX_CATCHUP = 12;

const log = new Logger('DepreciationSweep');

export async function sweepDepreciation(
  deps: DepreciationSweepDeps,
  now: Date = new Date(),
): Promise<DepreciationSweepResult> {
  const today = lagosDay(now);
  const due = await assetsRepo.assetsDue(deps.workerDb, today);
  const result: DepreciationSweepResult = { charged: 0, chargedK: 0, skipped: 0 };

  for (const asset of due) {
    const elapsed = assetsRepo.monthsElapsed(asset.boughtOn, today);
    const owed = Math.min(
      elapsed - asset.monthsCharged,
      asset.usefulLifeMonths - asset.monthsCharged,
      MAX_CATCHUP,
    );
    if (owed <= 0) continue;

    for (let i = 0; i < owed; i++) {
      const expect = asset.monthsCharged + i;
      try {
        const outcome = await withBusiness(deps.appDb, asset.businessId, (tx) =>
          assetsRepo.chargeOneMonth(tx, {
            businessId: asset.businessId,
            assetId: asset.assetId,
            expectMonthsCharged: expect,
            at: now,
          }),
        );
        if (!outcome.charged) {
          result.skipped += 1;
          break;
        }
        result.charged += 1;
        result.chargedK += outcome.amountK;
      } catch (error) {
        /* One asset failing must not stop the rest. A closed period refuses
         * the posting (migration 0034), which is correct and not an outage:
         * the month is filed and its figures may not change. */
        log.warn(`depreciation for one asset failed: ${redactForLog(String(error))}`);
        break;
      }
    }
  }

  if (result.charged > 0) {
    log.log(`charged ${result.charged} month(s) of wear across ${due.length} item(s)`);
  }
  return result;
}
