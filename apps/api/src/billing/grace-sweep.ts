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
          subscriptionsRepo.expireSubscription(tx, row.businessId, 'system:grace-sweep', 'grace'),
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
      /* The claim and the final eligibility read share ONE transaction. The page was read
       * earlier, so a cycle paid, a plan expired or a STOP received since then makes this
       * notice stale; that outcome keeps the claim (nothing is retried). If the read itself
       * throws, the transaction rolls the claim back with it, so a failed read can neither
       * lose the reminder day nor leave a claim stranded. The claim commits before the Meta
       * call, and no lock is held across it. */
      let outcome: 'skipped' | 'opted-out' | 'ineligible' | 'send';
      try {
        outcome = await withBusiness(deps.appDb, row.businessId, async (tx) => {
          if (!(await subscriptionsRepo.claimGraceReminder(tx, row.businessId, day))) {
            return 'skipped';
          }
          /* STOP/START is read fresh here, not from the page: an opted-out merchant keeps the
           * claimed day (not owed the same message tomorrow), and one who has since opted back in
           * is not skipped on a stale flag. */
          return subscriptionsRepo.graceReminderEligibility(tx, row.businessId);
        });
      } catch (claimError) {
        log.warn(
          `business ${row.businessId}: grace claim rolled back, will retry: ${redactForLog(String(claimError))}`,
        );
        continue;
      }
      if (outcome === 'opted-out') result.reminded += 1;
      if (outcome !== 'send') continue;

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
        const reason = error instanceof SendFailed ? error.message : String(error);
        if (error instanceof SendFailed && error.notSent) {
          /* The message DEFINITELY did not leave (no template configured, or Meta refused
           * it), so the claim goes BACK and the next hourly pass retries that day. */
          try {
            await withBusiness(deps.appDb, row.businessId, (tx) =>
              subscriptionsRepo.releaseGraceReminder(tx, row.businessId, day),
            );
          } catch (releaseError) {
            /* Logged, not thrown: one failed release must not abort the pass for the merchants
             * after this one. That reminder day then stays claimed (a missed reminder, never a
             * duplicate); recovering it durably would need a separate reconciliation job. */
            log.warn(
              `business ${row.businessId}: grace claim not released: ${redactForLog(String(releaseError))}`,
            );
          }
          log.warn(
            `business ${row.businessId}: grace reminder not delivered: ${redactForLog(reason)}`,
          );
        } else {
          /* Unknown outcome (timeout, dropped connection, or a failure after the send): the
           * notice may have been delivered. The claim STAYS, so it is never sent twice
           * (OWN-47). A LATER reminder day still goes out, but the day itself is not retried:
           * for the day-5 reminder that means no further warning before the day-7 expiry, an
           * accepted consequence of the no-resend rule. No exactly-once claim is made. */
          log.warn(
            `business ${row.businessId}: grace reminder day ${day} outcome unknown, not resent: ${redactForLog(reason)}`,
          );
        }
      }
    }
    if (rows.length < PAGE) break;
  }

  return result;
}
