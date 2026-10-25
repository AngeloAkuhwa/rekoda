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
 *   - A skipped message is never recorded or reported as delivered. An opted-out owner is
 *     counted as opted out and nothing is claimed; a send Meta definitively refused gives
 *     its claim back; one whose outcome cannot be told (timeout, crash) is recorded as
 *     'unknown' and NOT resent. No exactly-once delivery is claimed (OWN-47).
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
  /** Attempts whose outcome cannot be told (timeout, dropped connection, worker death); never resent. */
  uncertain: number;
  /** True when the pass did not run because no template is configured. */
  disabled: boolean;
}

const log = new Logger('TrialNoticeSweep');

/** An attempt still 'sending' after this long was abandoned by a dead worker. */
const STALE_ATTEMPT_MS = 30 * 60_000;

/** Lagos, so a merchant reads the date they would write on a form. */
function lagosDate(at: Date): string {
  const lagos = new Date(at.getTime() + 3_600_000);
  return `${String(lagos.getUTCDate()).padStart(2, '0')}/${String(lagos.getUTCMonth() + 1).padStart(2, '0')}/${lagos.getUTCFullYear()}`;
}

export async function sweepTrialNotices(
  deps: TrialNoticeSweepDeps,
  at?: Date,
): Promise<TrialNoticeSweepResult> {
  /* A fixed time only in tests; in production every use reads the clock afresh, because a
   * pass over many pages takes minutes and eligibility is rechecked at each claim. */
  const clock = (): Date => at ?? new Date();
  const now = clock();
  const result: TrialNoticeSweepResult = {
    sent: 0,
    optedOut: 0,
    failed: 0,
    uncertain: 0,
    disabled: false,
  };
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
      /* An attempt still 'sending' long after it started belongs to a worker that died
       * mid-send: the message may or may not have left. It is recorded as unknown and
       * never resent (OWN-47: no exactly-once claim). */
      if (
        row.attempt?.state === 'sending' &&
        now.getTime() - row.attempt.at.getTime() > STALE_ATTEMPT_MS
      ) {
        const stage = row.attempt.stage;
        let marked = false;
        try {
          marked = await withBusiness(deps.appDb, row.businessId, (tx) =>
            subscriptionsRepo.markTrialNoticeUnknown(tx, row.businessId, stage),
          );
        } catch (markError) {
          /* Safe to retry on the next pass; one business never stops the others. */
          log.error(
            `business ${row.businessId}: stale trial stage ${stage} not recorded: ${redactForLog(String(markError))}`,
          );
        }
        if (marked) {
          result.uncertain += 1;
          log.warn(`business ${row.businessId}: trial reminder stage ${stage} outcome unknown`);
        }
      }

      const due = trialNoticeDue(row.trialEndsAt, now);
      if (due === null) continue;

      /* STOP is a fact and is checked before every proactive send, and BEFORE the claim:
       * a skipped message is never recorded as handled, so an owner who sends START again
       * is still owed the milestone if it is current (OWN-56). */
      if (row.ownerOptedOut) {
        result.optedOut += 1;
        continue;
      }

      let claimed: boolean;
      try {
        claimed = await withBusiness(deps.appDb, row.businessId, (tx) =>
          subscriptionsRepo.claimTrialNotice(tx, row.businessId, due.stage, clock()),
        );
      } catch (claimError) {
        /* Nothing was sent; the next pass tries again. */
        log.error(
          `business ${row.businessId}: trial stage ${due.stage} not claimed: ${redactForLog(String(claimError))}`,
        );
        continue;
      }
      if (!claimed) continue;

      let accepted: { providerMessageId: string | null };
      try {
        accepted = await deps.sender.sendTrialNotice({
          to: row.ownerPhone,
          daysLeft: String(due.daysLeft),
          endsOn: lagosDate(row.trialEndsAt),
        });
      } catch (error) {
        const reason = error instanceof SendFailed ? error.message : String(error);
        if (error instanceof SendFailed && error.notSent) {
          /* Definitely not sent: the claim goes BACK so the next hourly pass retries
           * this stage. A release that itself fails is logged and leaves the attempt
           * 'sending', which the stale rule above turns into 'unknown' rather than
           * aborting the pass for every other business. */
          try {
            await withBusiness(deps.appDb, row.businessId, (tx) =>
              subscriptionsRepo.releaseTrialNotice(tx, row.businessId, due.stage),
            );
          } catch (releaseError) {
            log.error(
              `business ${row.businessId}: trial stage ${due.stage} claim not released: ${redactForLog(String(releaseError))}`,
            );
          }
          result.failed += 1;
          log.warn(
            `business ${row.businessId}: trial reminder not delivered: ${redactForLog(reason)}`,
          );
        } else {
          /* A timeout or dropped connection: Meta may have accepted it. Keep the claim,
           * record the attempt as unknown and do not resend. */
          try {
            await withBusiness(deps.appDb, row.businessId, (tx) =>
              subscriptionsRepo.markTrialNoticeUnknown(tx, row.businessId, due.stage),
            );
          } catch (markError) {
            log.error(
              `business ${row.businessId}: trial stage ${due.stage} attempt not recorded: ${redactForLog(String(markError))}`,
            );
          }
          result.uncertain += 1;
          log.warn(
            `business ${row.businessId}: trial reminder outcome unknown, not resent: ${redactForLog(reason)}`,
          );
        }
        continue;
      }

      /* Accepted. Everything after this point is bookkeeping and can never put the
       * claim back: a failed ledger write must not become a second reminder. */
      result.sent += 1;
      try {
        await withBusiness(deps.appDb, row.businessId, (tx) =>
          subscriptionsRepo.markTrialNoticeSent(
            tx,
            row.businessId,
            due.stage,
            accepted.providerMessageId,
          ),
        );
      } catch (markError) {
        /* The attempt stays 'sending' and the stale rule will call it 'unknown'; the
         * provider's id is kept in the log so an operator can tell it was accepted. */
        log.error(
          `business ${row.businessId}: trial stage ${due.stage} accepted by the provider (${accepted.providerMessageId ?? 'no message id'}) but not recorded: ${redactForLog(String(markError))}`,
        );
      }
      /* Cost attribution is independent of the local acknowledgement above. */
      try {
        await recordMessageCost(
          deps.appDb,
          row.businessId,
          'UTILITY_TEMPLATE',
          deps.fxNairaPerUsd,
          { template: 'trial' },
        );
      } catch (costError) {
        log.error(
          `business ${row.businessId}: trial reminder cost not recorded: ${redactForLog(String(costError))}`,
        );
      }
    }
    if (rows.length < PAGE) break;
  }

  return result;
}
