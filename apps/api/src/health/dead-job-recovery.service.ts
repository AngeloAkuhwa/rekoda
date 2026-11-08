/**
 * An operator recovers a payment or billing job that died (OWN-73, OWN-76).
 *
 * Never automatic: nothing here runs unless an operator holding `ops:payment` asks, with a reason.
 * Before anything moves, the job's own Paystack reference is read from its stored, signed event and
 * verified with Paystack server-side. Only a reference Paystack knows is recovered, and recovery is
 * one fresh, bounded attempt of the SAME job (`deadJobsRepo.beginRecovery`): the handler then does
 * what it always does, so the existing unique references and charge transitions stop a second
 * settlement or a second extension. A refusal, and an unreachable Paystack, change nothing and are
 * audited.
 *
 * A job that never had a Paystack reference (no event, or an event without a readable reference)
 * has nothing to verify and is not recoverable here: an operator closes it with `resolve` after
 * settling it by hand. A renewal blocked before it was ever initiated (OWN-70 case B) is NOT a dead
 * job and never reaches this path.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PAYMENT_REFERENCE_PATTERN, SUBSCRIPTION_REFERENCE_PATTERN } from '@rekoda/core';
import { paystackWebhookBody, summarisePaystackEvent } from '@rekoda/contracts';
import { deadJobsRepo, events, withBusiness, type Db } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB, WORKER_DB } from '../db/db.module.js';
import { openPayload } from '../privacy/payload-vault.js';
import { PAYMENT_PROVIDER, type PaymentProviderPort } from '../payments/provider.port.js';

export type RecoveryOutcome =
  | { outcome: 'recovering'; jobId: string }
  | {
      outcome:
        | 'not_found'
        | 'not_open'
        | 'no_reference'
        | 'invalid_reference'
        | 'verify_not_found'
        | 'verify_unavailable'
        | 'no_worker';
    };

@Injectable()
export class DeadJobRecoveryService {
  private readonly log = new Logger(DeadJobRecoveryService.name);

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(WORKER_DB) private readonly workerDb: Db | null,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderPort,
  ) {}

  async recover(jobId: string, actor: string, reason: string): Promise<RecoveryOutcome> {
    if (!this.workerDb) return { outcome: 'no_worker' };
    const record = await deadJobsRepo.findForOps(this.workerDb, jobId);
    if (!record) return { outcome: 'not_found' };
    const { businessId } = record;
    const refuse = async (outcome: Exclude<RecoveryOutcome['outcome'], 'recovering'>) => {
      await withBusiness(this.db, businessId, (tx) =>
        deadJobsRepo.recordRecoveryRefused(tx, { businessId, jobId, actor, reason, outcome }),
      );
      return { outcome } as RecoveryOutcome;
    };
    if (record.status !== 'open') return refuse('not_open');
    if (!record.eventId) return refuse('no_reference');

    const event = await withBusiness(this.db, businessId, (tx) =>
      events.eventForBusiness(tx, record.eventId!, businessId),
    );
    if (!event) return refuse('no_reference');
    const reference = this.referenceOf(event.payload, event.externalId);
    if (!reference) return refuse('no_reference');
    /* The reference must be the kind this job processes: a merchant's payment reference for a
     * payment job, a Rekoda subscription reference for a billing job. */
    const pattern =
      record.kind === 'payment.process'
        ? PAYMENT_REFERENCE_PATTERN
        : SUBSCRIPTION_REFERENCE_PATTERN;
    if (!pattern.test(reference)) return refuse('invalid_reference');
    /* The reference the job was queued with must be the one its signed event names. */
    if (record.reference !== null && record.reference !== reference) {
      return refuse('invalid_reference');
    }

    let verification: string;
    try {
      const verified = await this.provider.verifyTransaction(reference);
      if (!verified.found) return refuse('verify_not_found');
      /* Only what an operator needs: that Paystack knows it, and the status it reports. */
      verification = `found:${verified.transaction.providerStatus}`;
    } catch (error) {
      this.log.warn(
        `Paystack verify failed during a dead-job recovery: ${error instanceof Error ? error.name : 'error'}`,
      );
      return refuse('verify_unavailable');
    }

    const started = await withBusiness(this.db, businessId, (tx) =>
      deadJobsRepo.beginRecovery(tx, { businessId, jobId, actor, reason, reference, verification }),
    );
    if (!started) return refuse('not_open');
    return { outcome: 'recovering', jobId };
  }

  async resolve(jobId: string, actor: string, resolution: string) {
    if (!this.workerDb) return { outcome: 'no_worker' as const };
    const record = await deadJobsRepo.findForOps(this.workerDb, jobId);
    if (!record) return { outcome: 'not_found' as const };
    /* The record and its flagged event close together, in one tenant-pinned transaction, so the
     * event never stays on the operator list for a record that is closed (or the reverse). */
    const closed = await withBusiness(this.db, record.businessId, async (tx) => {
      const done = await deadJobsRepo.resolveByOperator(tx, {
        businessId: record.businessId,
        jobId,
        actor,
        resolution,
      });
      if (done && record.eventId)
        await events.resolveEvent(tx, record.eventId, resolution, actor, 'tenant');
      return done;
    });
    if (!closed) return { outcome: 'not_open' as const };
    return { outcome: 'resolved' as const };
  }

  private referenceOf(payload: unknown, externalId: string): string | null {
    let opened: unknown;
    try {
      opened = openPayload(payload, this.config.vaultKey, 'paystack', externalId);
    } catch {
      return null;
    }
    const parsed = paystackWebhookBody.safeParse(opened);
    return parsed.success ? (summarisePaystackEvent(parsed.data).reference ?? null) : null;
  }
}
