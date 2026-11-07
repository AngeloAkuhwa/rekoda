/**
 * Trial reminders (G-109, OWN-56): one WhatsApp utility template at 7, 2 and 1 days
 * before a 14-day trial ends.
 *
 * Core says which stage a trial has reached (`trialNoticeDue`); this sends it, claimed
 * through a conditional UPDATE so two overlapping passes claim a stage once (at most one
 * message per stage; no exactly-once delivery is claimed). Three
 * rules from the owner:
 *
 *   - A message is never sent through an unconfigured template. With no
 *     `META_TRIAL_TEMPLATE` the pass does nothing: it claims nothing, so approving the
 *     template later still reaches every trial that is still running.
 *   - A skipped message is never recorded or reported as delivered. An opted-out owner is
 *     counted as opted out and nothing is claimed; a send Meta definitively refused gives
 *     its claim back; one whose outcome cannot be told (timeout, crash) is recorded as
 *     'unknown' and NOT resent; one Meta accepted and later reported as failed is marked
 *     'undelivered' by the `delivery.status` job (REM-01) and is NOT resent either. No
 *     exactly-once delivery is claimed (OWN-47).
 *   - Eligibility is checked twice: at the claim, and again by a final check immediately
 *     before the Meta request (plan, trial end against the current clock, consent). A
 *     message found ineligible there is recorded 'suppressed', never retried. No lock is
 *     held across the network call, so a STOP or purchase committing after that final
 *     check, while the request is in flight, cannot recall the message; the next pass
 *     honours it. No absolute prevention is claimed.
 */
import { Logger } from '@nestjs/common';
import { TRIAL_NOTICE_DAYS_LEFT, trialNoticeDue } from '@rekoda/core';
import { redactForLog } from '@rekoda/core/privacy';
import { subscriptionsRepo, withBusiness, type Db } from '@rekoda/db';
import { SendFailed, type MessageSender } from '../channels/sender.js';
import { recordMessageCost } from '../channels/message-cost.js';
import { billingPageUrl } from '../channels/template-slots.js';

/**
 * What the worker hands the trial sweep (OD-41(b), OWN-80): the template counts as configured only
 * when the billing page `{{3}}` can be built too, so a template set without a usable REKODA_WEB_URL
 * claims nothing and sends nothing.
 */
export function trialNoticeGate(config: {
  metaTrialTemplate: string | null;
  webUrl: string | null;
}): { templateConfigured: boolean; billingUrl: string | null } {
  const billingUrl = billingPageUrl(config.webUrl);
  return {
    templateConfigured: config.metaTrialTemplate !== null && billingUrl !== null,
    billingUrl,
  };
}

export interface TrialNoticeSweepDeps {
  /** `rekoda_worker` — "which trials are ending" names no tenant. */
  workerDb: Db;
  /** `rekoda_app` — every write below runs under a tenant pin. */
  appDb: Db;
  sender: MessageSender;
  /**
   * False when `META_TRIAL_TEMPLATE` is unset, or when there is no billing page to link to
   * (`billingUrl` null): the pass then does nothing at all, so nothing is claimed.
   */
  templateConfigured: boolean;
  /** The billing page the reminder links to (`{{3}}` of `rekoda_trial_ending`, OD-41(b)). */
  billingUrl: string | null;
  /** Planning FX, for pricing the utility template this sweep sends. */
  fxNairaPerUsd: number;
}

export interface TrialNoticeSweepResult {
  sent: number;
  optedOut: number;
  /** Claimed, then found ineligible by the final check just before dispatch; nothing sent. */
  suppressed: number;
  failed: number;
  /** Rejected with an error that will repeat identically; the stage is not retried. */
  refused: number;
  /** The pass stopped after repeated transient refusals (rate limit, token). */
  stoppedEarly: boolean;
  /** Attempts whose outcome cannot be told (timeout, dropped connection, worker death); never resent. */
  uncertain: number;
  /** True when the pass did not run because no template is configured. */
  disabled: boolean;
}

const log = new Logger('TrialNoticeSweep');

/** An attempt still 'sending' after this long was abandoned by a dead worker. */
const STALE_ATTEMPT_MS = 30 * 60_000;

/** Transient refusals in a row after which a pass gives up until the next hour. */
const TRANSIENT_FAILURES_BEFORE_STOP = 3;

/** Lagos, so a merchant reads the date they would write on a form. */
function lagosDate(at: Date): string {
  const lagos = new Date(at.getTime() + 3_600_000);
  return `${String(lagos.getUTCDate()).padStart(2, '0')}/${String(lagos.getUTCMonth() + 1).padStart(2, '0')}/${lagos.getUTCFullYear()}`;
}

export async function sweepTrialNotices(
  deps: TrialNoticeSweepDeps,
  at?: Date | (() => Date),
): Promise<TrialNoticeSweepResult> {
  /* A fixed time only in tests; in production every use reads the clock afresh, because a
   * pass over many pages takes minutes and eligibility is rechecked at each claim. */
  const clock = (): Date => (typeof at === 'function' ? at() : (at ?? new Date()));
  const now = clock();
  const result: TrialNoticeSweepResult = {
    sent: 0,
    optedOut: 0,
    suppressed: 0,
    failed: 0,
    refused: 0,
    stoppedEarly: false,
    uncertain: 0,
    disabled: false,
  };
  if (!deps.templateConfigured) {
    result.disabled = true;
    return result;
  }

  const PAGE = 500;
  let consecutiveTransient = 0;
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
            subscriptionsRepo.markTrialNoticeUnknown(
              tx,
              row.businessId,
              stage,
              new Date(now.getTime() - STALE_ATTEMPT_MS),
            ),
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

      const due = trialNoticeDue(row.trialEndsAt, clock());
      if (due === null) continue;
      /* The listing carries the latest attempt: a stage that is not newer than it has
       * already been handled (sent, unknown, undelivered, suppressed, refused or in flight).
       * Skipping it here saves a tenant transaction per business per hour for the rest of the window,
       * and keeps an opted-out owner from being counted again for a notice that is not
       * owed. The claim still guards the stage if this snapshot is stale. */
      if (row.attempt !== null && row.attempt.stage >= due.stage) continue;

      let claimed: 'claimed' | 'opted_out' | 'not_claimed';
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
      /* STOP is a fact: an opted-out owner claims nothing, so a skipped message is never
       * recorded as handled and a START later still owes the current milestone (OWN-56). */
      if (claimed === 'opted_out') {
        result.optedOut += 1;
        continue;
      }
      if (claimed !== 'claimed') continue;

      /* The final eligibility check, immediately before the Meta request (owner ruling,
       * 25 Oct 2026): plan, trial end and consent are read again, and the owner's phone is
       * read here, inside the tenant's scope, because the listing never carried it. No lock
       * is held across the request; once it begins an in-flight message cannot be recalled.
       * Nothing else happens between this statement's commit and the send. */
      let finalCheck: Awaited<ReturnType<typeof subscriptionsRepo.finalizeTrialNoticeDispatch>>;
      try {
        finalCheck = await withBusiness(deps.appDb, row.businessId, (tx) =>
          subscriptionsRepo.finalizeTrialNoticeDispatch(tx, row.businessId, due.stage, clock()),
        );
      } catch (finalError) {
        /* Nothing was sent, so the claim can safely go back for the next pass. */
        log.error(
          `business ${row.businessId}: trial stage ${due.stage} final check failed: ${redactForLog(String(finalError))}`,
        );
        try {
          await withBusiness(deps.appDb, row.businessId, (tx) =>
            subscriptionsRepo.releaseTrialNotice(tx, row.businessId, due.stage),
          );
        } catch (releaseError) {
          log.error(
            `business ${row.businessId}: trial stage ${due.stage} claim not released: ${redactForLog(String(releaseError))}`,
          );
        }
        continue;
      }
      if (finalCheck.outcome === 'suppressed') {
        /* The stage stays claimed as 'suppressed': it is never retried. */
        result.suppressed += 1;
        log.log(`business ${row.businessId}: trial stage ${due.stage} suppressed before dispatch`);
        continue;
      }
      if (finalCheck.outcome !== 'proceed') continue;

      let accepted: { providerMessageId: string | null };
      try {
        accepted = await deps.sender.sendTrialNotice({
          to: finalCheck.ownerPhone,
          daysLeft: String(due.daysLeft),
          endsOn: lagosDate(row.trialEndsAt),
          billingUrl: deps.billingUrl,
        });
      } catch (error) {
        const reason = error instanceof SendFailed ? error.message : String(error);
        if (error instanceof SendFailed && error.notSent && !error.transient) {
          /* Definitely not sent, and the refusal will repeat identically (a bad recipient,
           * a wrong template): the stage stays claimed as 'refused' instead of being
           * hammered at Meta every hour. The next milestone is still owed. */
          try {
            await withBusiness(deps.appDb, row.businessId, (tx) =>
              subscriptionsRepo.markTrialNoticeRefused(tx, row.businessId, due.stage),
            );
          } catch (refuseError) {
            log.error(
              `business ${row.businessId}: trial stage ${due.stage} refusal not recorded: ${redactForLog(String(refuseError))}`,
            );
          }
          consecutiveTransient = 0;
          result.refused += 1;
          log.error(
            `business ${row.businessId}: trial reminder refused by the provider, not retried: ${redactForLog(reason)}`,
          );
        } else if (error instanceof SendFailed && error.notSent) {
          /* Definitely not sent and likely to clear (rate limit, expired or revoked token):
           * the claim goes BACK so a later pass retries this stage. A release that itself
           * fails is logged and leaves the attempt 'sending', which the stale rule turns
           * into 'unknown' rather than aborting the pass for every other business. After
           * a few in a row the whole pass stops, so an outage costs a handful of Meta
           * requests per hour, not one per trial. */
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
          /* Only a refusal that says something about the whole sender counts toward
           * stopping the pass; a per-recipient throttle says nothing about the next
           * owner, and any answer that is not an outage clears the count. */
          consecutiveTransient = error.outage ? consecutiveTransient + 1 : 0;
          if (consecutiveTransient >= TRANSIENT_FAILURES_BEFORE_STOP) {
            result.stoppedEarly = true;
            log.error('trial reminder pass stopped early after repeated provider refusals');
            return result;
          }
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

      consecutiveTransient = 0;

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
        /* The attempt stays 'sending' and the stale rule will call it 'unknown' (never
         * resent). The provider's message id is deliberately not logged: WhatsApp ids can
         * encode the recipient, so an operator matches the message by time and business. */
        log.error(
          `business ${row.businessId}: trial stage ${due.stage} accepted by the provider but not recorded: ${redactForLog(String(markError))}`,
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
