/**
 * The seven days after a renewal payment fails (ADR 0024).
 *
 * Access does not stop on the day a card declines. A merchant whose bank has
 * a bad Sunday should not lose the ability to invoice on Monday, and seven
 * more days of service costs far less than a merchant who leaves because the
 * product punished them for somebody else's problem.
 *
 * One pass does two things and decides neither of them:
 *
 *   - `billingState` in core says which day a reminder falls on. This sends
 *     one, claimed through a conditional UPDATE so two overlapping passes
 *     produce one message.
 *   - On day seven it stops the subscription, explicitly. `planFor` never
 *     expires a paid plan on a date comparison, precisely so a late job
 *     cannot cut somebody off; the consequence is that the transition must be
 *     an act, recorded in the audit trail, and this is where it happens.
 *
 * Nothing is deleted, ever. An expired account is read-only: the dashboard
 * opens, the books are readable and the exports still work.
 */
import { Logger } from '@nestjs/common';
import { billingState, GRACE_DAYS } from '@rekoda/core';
import { redactForLog } from '@rekoda/core/privacy';
import { subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import { SendFailed, type MessageSender } from '../channels/sender.js';
import { recordMessageCost } from '../channels/message-cost.js';

export interface GraceSweepDeps {
  /** `rekoda_worker` — "who is in grace" names no tenant, which is the point. */
  workerDb: Db;
  /** `rekoda_app` — every write below runs under a tenant pin. */
  appDb: Db;
  sender: MessageSender;
  /** Planning FX, for pricing the utility template this sweep sends. */
  fxNairaPerUsd: number;
}

export interface GraceSweepResult {
  reminded: number;
  expired: number;
}

const log = new Logger('GraceSweep');

/** Lagos, so a merchant reads the date they would write on a form. */
function lagosDate(at: Date): string {
  const lagos = new Date(at.getTime() + 3_600_000);
  return `${String(lagos.getUTCDate()).padStart(2, '0')}/${String(lagos.getUTCMonth() + 1).padStart(2, '0')}/${lagos.getUTCFullYear()}`;
}

export async function sweepGracePeriods(
  deps: GraceSweepDeps,
  now: Date = new Date(),
): Promise<GraceSweepResult> {
  const result: GraceSweepResult = { reminded: 0, expired: 0 };

  /* Pages until the whole grace population has been walked. One fixed bite
   * per hour meant tenant 501 and beyond never heard from us at all. */
  const PAGE = 500;
  let after: string | null = null;
  for (;;) {
    const rows = await subscriptionsRepo.inGrace(deps.workerDb, PAGE, after);
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.businessId;

    for (const row of rows) {
      if (!row.paymentFailedAt) continue;
      const state = billingState({
        renewsAt: row.renewsAt,
        failedAt: row.paymentFailedAt,
        now,
      });

      if (state.state === 'expired') {
        const previous = await withBusiness(deps.appDb, row.businessId, (tx) =>
          subscriptionsRepo.expireSubscription(tx, row.businessId, 'system:grace-sweep'),
        );
        if (previous) {
          result.expired += 1;
          log.log(
            `business ${row.businessId}: ${previous} expired after ${GRACE_DAYS} days of grace`,
          );
        }
        continue;
      }

      if (state.state !== 'grace' || state.reminderDue === null) continue;

      /* The day number is what the claim is keyed on, and it comes from core
       * rather than from a counter here: the sweep must not have its own
       * opinion about which days carry a reminder. Core answers with the
       * latest reminder day REACHED, not just the day itself, so an outage
       * across a reminder day delays that warning to the next pass instead
       * of cancelling it; the claim keeps it to one send. */
      const day = state.reminderDue;
      const claimed = await withBusiness(deps.appDb, row.businessId, (tx) =>
        subscriptionsRepo.claimGraceReminder(tx, row.businessId, day),
      );
      if (!claimed) continue;

      /* STOP is a fact and it is checked before every proactive send. The claim
       * still stands: an opted-out merchant is not owed the same message
       * tomorrow, and the dashboard tells them where they stand. */
      if (row.ownerOptedOut) {
        result.reminded += 1;
        continue;
      }

      try {
        await deps.sender.sendBillingNotice({
          to: row.ownerPhone,
          daysLeft: String(state.daysLeft),
          endsOn: lagosDate(state.endsAt),
        });
        /* A UTILITY template, and one Rekoda pays Meta for. It was
         * invisible to the margin view until now: the sweep sent it and
         * recorded nothing. */
        await recordMessageCost(
          deps.appDb,
          row.businessId,
          'UTILITY_TEMPLATE',
          deps.fxNairaPerUsd,
          {
            template: 'billing',
          },
        );
        result.reminded += 1;
      } catch (error) {
        /* The claim goes BACK. Burning it on a failed send meant a Meta outage
         * on day five silenced that day's warning forever, and the merchant's
         * last memory of Rekoda before the day-seven cutoff was silence. The
         * next hourly pass re-claims the day, so the reminder lands as soon as
         * the channel recovers; a still-missing template costs one warn line
         * per business per pass, which is the log doing its job. */
        await withBusiness(deps.appDb, row.businessId, (tx) =>
          subscriptionsRepo.releaseGraceReminder(tx, row.businessId, day),
        );
        const reason = error instanceof SendFailed ? error.message : String(error);
        log.warn(
          `business ${row.businessId}: grace reminder not delivered: ${redactForLog(reason)}`,
        );
      }
    }
    if (rows.length < PAGE) break;
  }

  return result;
}
