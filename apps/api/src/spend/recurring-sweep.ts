/**
 * Raising the costs that repeat (MASTER-PLAN §5.3.7).
 *
 * Rent, salaries, the generator contract. A merchant sets the schedule once
 * and this is what makes it happen every month afterwards, which is the whole
 * difference between a books that describe a shop and a books that describe
 * the months a shop remembered to talk about its costs.
 *
 * ── why it does not send a message ──────────────────────────────────────────
 *
 * Telling a merchant on WhatsApp that their rent was recorded would need a
 * Meta-approved template, because it is Rekoda starting the conversation
 * rather than answering one, and those templates are still waiting for
 * approval. It would also cost a message every month per schedule, forever,
 * to say something the merchant already decided. The register is where a
 * schedule's entries show up, marked "Repeating", and that is enough.
 *
 * ── why it catches up rather than skipping ─────────────────────────────────
 *
 * A schedule that fell due while nothing was running is still a cost that was
 * really paid. Each raise advances the schedule ONE month from the date it
 * was due, not from today, so an outage produces the months it missed rather
 * than collapsing them into a single entry with the wrong figure.
 */
import { Logger } from '@nestjs/common';
import { lagosDay, lagosNoon, nextDueAfter } from '@rekoda/core';
import { redactForLog } from '@rekoda/core/privacy';
import { recurringRepo, spendRepo, withBusiness, type Db } from '@rekoda/db';

export interface RecurringSweepDeps {
  /** `rekoda_worker` - "whose rent is due" names no tenant. SELECT only. */
  workerDb: Db;
  /** `rekoda_app` - the claim and the expense are written under a tenant pin. */
  appDb: Db;
}

export interface RecurringSweepResult {
  raised: number;
  /** Schedules another sweep had already claimed for today. Not an error. */
  skipped: number;
}

/**
 * A year's worth, per schedule, per run. A bound rather than a limit anybody
 * should reach: twelve is already an outage measured in months, and a runaway
 * loop writing expenses into a merchant's books is a worse failure than a
 * catch-up that finishes on the next pass.
 */
const MAX_CATCHUP = 12;

const log = new Logger('RecurringSweep');

export async function sweepRecurring(
  deps: RecurringSweepDeps,
  now: Date = new Date(),
): Promise<RecurringSweepResult> {
  const today = lagosDay(now);
  const due = await recurringRepo.dueSchedules(deps.workerDb, today);
  const result: RecurringSweepResult = { raised: 0, skipped: 0 };

  for (const schedule of due) {
    let dueOn = schedule.nextDueOn;

    for (let raise = 0; raise < MAX_CATCHUP && dueOn <= today; raise += 1) {
      const nextDueOn = nextDueAfter(dueOn, schedule.anchorDay);
      try {
        const raised = await withBusiness(deps.appDb, schedule.businessId, async (tx) => {
          /* Claim FIRST. The row read a moment ago settles nothing: two
           * sweeps both see the same due date before either writes, and only
           * this UPDATE decides which of them may record an expense. */
          const claimed = await recurringRepo.claimDue(
            tx,
            schedule.businessId,
            schedule.id,
            today,
            nextDueOn,
          );
          if (!claimed) return false;

          await spendRepo.recordExpense(tx, {
            businessId: schedule.businessId,
            description: schedule.description,
            category: schedule.category,
            amountK: schedule.amountK,
            method: schedule.method === 'transfer' ? 'transfer' : 'cash',
            sourceType: 'recurring',
            /* The schedule and the month it was raised for. Unique per raise,
             * so a catch-up's entries are told apart by the thing that makes
             * them different rather than by the order they were written. */
            sourceId: `${schedule.id}:${dueOn}`,
            /* The day it fell DUE, not the day the sweep noticed. September's
             * rent belongs in September's profit and loss whatever month it
             * was raised in, and a catch-up that stamped today would put a
             * quarter of rent into one month and none into the two before. */
            recordedAt: lagosNoon(dueOn),
          });
          return true;
        });

        if (raised) result.raised += 1;
        else {
          result.skipped += 1;
          break;
        }
      } catch (error: unknown) {
        /* One schedule's failure is not the sweep's. The claim rolled back
         * with the entry, so the next pass finds this row exactly as it was. */
        log.warn(
          `schedule ${schedule.id}: entry could not be raised: ${redactForLog(String(error))}`,
        );
        break;
      }

      dueOn = nextDueOn;
    }
  }

  return result;
}
