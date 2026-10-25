/**
 * Trial reminders (G-109, OWN-56): one WhatsApp utility template at 7, 2 and 1 days
 * before a 14-day trial ends.
 *
 * Core says which stage a trial has reached (`trialNoticeDue`); this sends it, claimed
 * through a conditional UPDATE so two overlapping passes produce one message. Three
 * rules from the owner:
 *
 *   - A message is never sent through an unapproved or unconfigured template. With no
 *     `META_TRIAL_TEMPLATE` the pass does nothing: it claims nothing, so approving the
 *     template later still reaches every trial that is still running.
 *   - A skipped message is never recorded or reported as delivered. A failed send gives
 *     its claim back; an opted-out owner is counted as opted out, not as sent.
 *   - Nothing is sent after the trial ends or once a plan has been bought (the claim
 *     itself requires `plan = 'trial'`).
 */
import { Logger } from '@nestjs/common';
import { TRIAL_NOTICE_DAYS_LEFT, trialNoticeDue } from '@rekoda/core';
import { redactForLog } from '@rekoda/core/privacy';
import { subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import { SendFailed, type MessageSender } from '../channels/sender.js';
import { recordMessageCost } from '../channels/message-cost.js';

export interface TrialNoticeSweepDeps {
  /** `rekoda_worker` — "which trials are ending" names no tenant. */
  workerDb: Db;
  /** `rekoda_app` — every write below runs under a tenant pin. */
  appDb: Db;
  sender: MessageSender;
  /** False when `META_TRIAL_TEMPLATE` is unset: the pass then does nothing at all. */
  templateConfigured: boolean;
  /** Planning FX, for pricing the utility template this sweep sends. */
  fxNairaPerUsd: number;
}

export interface TrialNoticeSweepResult {
  sent: number;
  optedOut: number;
  failed: number;
  /** True when the pass did not run because no template is configured. */
  disabled: boolean;
}

const log = new Logger('TrialNoticeSweep');

/** Lagos, so a merchant reads the date they would write on a form. */
function lagosDate(at: Date): string {
  const lagos = new Date(at.getTime() + 3_600_000);
  return `${String(lagos.getUTCDate()).padStart(2, '0')}/${String(lagos.getUTCMonth() + 1).padStart(2, '0')}/${lagos.getUTCFullYear()}`;
}

export async function sweepTrialNotices(
  deps: TrialNoticeSweepDeps,
  now: Date = new Date(),
): Promise<TrialNoticeSweepResult> {
  const result: TrialNoticeSweepResult = { sent: 0, optedOut: 0, failed: 0, disabled: false };
  if (!deps.templateConfigured) {
    result.disabled = true;
    return result;
  }

  const PAGE = 500;
  const firstMilestone = Math.max(...TRIAL_NOTICE_DAYS_LEFT);
  let after: string | null = null;
  for (;;) {
    const rows = await subscriptionsRepo.trialsEndingWithin(
      deps.workerDb,
      now,
      firstMilestone,
      PAGE,
      after,
    );
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.businessId;

    for (const row of rows) {
      const due = trialNoticeDue(row.trialEndsAt, now);
      if (due === null) continue;

      const claimed = await withBusiness(deps.appDb, row.businessId, (tx) =>
        subscriptionsRepo.claimTrialNotice(tx, row.businessId, due.stage),
      );
      if (!claimed) continue;

      /* STOP is a fact and is checked before every proactive send. The claim stands:
       * an opted-out merchant is not owed the same message on the next pass. */
      if (row.ownerOptedOut) {
        result.optedOut += 1;
        continue;
      }

      try {
        await deps.sender.sendTrialNotice({
          to: row.ownerPhone,
          daysLeft: String(due.daysLeft),
          endsOn: lagosDate(row.trialEndsAt),
        });
        await recordMessageCost(
          deps.appDb,
          row.businessId,
          'UTILITY_TEMPLATE',
          deps.fxNairaPerUsd,
          { template: 'trial' },
        );
        result.sent += 1;
      } catch (error) {
        /* The claim goes BACK, so the next hourly pass retries this stage and a
         * channel outage cannot silence a milestone for good. */
        await withBusiness(deps.appDb, row.businessId, (tx) =>
          subscriptionsRepo.releaseTrialNotice(tx, row.businessId, due.stage),
        );
        result.failed += 1;
        const reason = error instanceof SendFailed ? error.message : String(error);
        log.warn(
          `business ${row.businessId}: trial reminder not delivered: ${redactForLog(reason)}`,
        );
      }
    }
    if (rows.length < PAGE) break;
  }

  return result;
}
