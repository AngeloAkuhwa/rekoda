/**
 * A payment or billing job that died leaves a record (OWN-73, OWN-76; migration 0194).
 *
 * `recordDeath` runs inside the transaction that moved the job to `dead`, on the worker
 * connection, pinned to the job's tenant (`jobsRepo.markFailed`, `jobsRepo.reclaimStalled`).
 * It writes:
 *   - one `dead_job_exceptions` row, keyed on the job (a second death after a recovery reopens it);
 *   - for a payment job, a merchant reconciliation exception (`payment_processing_stopped`);
 *     a billing job is NEVER a merchant reconciliation exception (OWN-76: billing is not the
 *     merchant's books), and shows on the billing page instead;
 *   - a flag on the attributed event (`error` set, `processed_at` left null, so it stays
 *     recoverable and on the operator's flagged list);
 *   - an audit event.
 * It books nothing: no payment, intent, invoice, ledger row, charge or plan changes. It never
 * copies the job's error text or payload.
 *
 * Recovery is operator-only and verified (`beginRecovery`): it moves an OPEN row to `recovering`
 * and requeues the job for exactly one more attempt. Its success closes the row (`jobsRepo.markDone`
 * calls `noteJobDone`); its death reopens it.
 */
import { sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';

/** The job kinds whose death is a work item. Anything else dies as before. */
export const DEAD_JOB_EXCEPTION_KINDS = ['payment.process', 'billing.process'] as const;
export type DeadJobKind = (typeof DEAD_JOB_EXCEPTION_KINDS)[number];

export const isDeadJobKind = (kind: string): kind is DeadJobKind =>
  (DEAD_JOB_EXCEPTION_KINDS as readonly string[]).includes(kind);

/** The merchant-side reconciliation reason for a payment job that died. */
export const PAYMENT_JOB_DEAD_REASON = 'payment_processing_stopped';

/** The fixed flag set on the attributed event, per kind. Never error text. */
const EVENT_FLAG: Record<DeadJobKind, string> = {
  'payment.process': 'payment_job_dead',
  'billing.process': 'billing_job_dead',
};

/** Fixed, safe text per kind. Nothing a payload or an error message could reach. */
const SUMMARY: Record<DeadJobKind, string> = {
  'payment.process':
    'Payment processing stopped after its last permitted attempt; nothing was booked.',
  'billing.process':
    'Subscription payment processing stopped after its last permitted attempt; nothing was applied.',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A job payload's `eventId`, when it names a valid one. A malformed payload names none. */
export function eventIdOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)['eventId'];
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

/** Anything that can run SQL inside the dying job's transaction. */
type Tx = Pick<TenantDb, 'execute'>;

export interface DyingJob {
  id: string;
  businessId: string;
  kind: string;
  payload: unknown;
  attempts: number;
  failureCategory: string | null;
}

/**
 * Record a job's death. Call inside the transaction that set `state = 'dead'`. Idempotent per
 * job: an open row is left as it is; a row a recovery had moved on is reopened, the same row.
 */
export async function recordDeath(tx: Tx, job: DyingJob): Promise<void> {
  if (!isDeadJobKind(job.kind) || !UUID.test(job.businessId)) return;
  const kind = job.kind;
  const eventId = eventIdOf(job.payload);

  /* The writes below are tenant rows: pin the job's tenant for the rest of this transaction. */
  await tx.execute(sql`SELECT set_config('app.business_id', ${job.businessId}, true)`);

  const rows = await tx.execute<{ inserted: boolean; status: string }>(sql`
    INSERT INTO dead_job_exceptions
      (job_id, business_id, kind, event_id, failure_category, summary, attempts)
    VALUES (${job.id}::uuid, ${job.businessId}::uuid, ${kind}, ${eventId}::uuid,
            ${job.failureCategory}, ${SUMMARY[kind]}, ${job.attempts})
    ON CONFLICT (job_id) DO UPDATE SET
      status = 'open',
      failure_category = EXCLUDED.failure_category,
      attempts = EXCLUDED.attempts,
      death_count = dead_job_exceptions.death_count + 1,
      last_died_at = now(),
      updated_at = now()
    WHERE dead_job_exceptions.status = 'recovering'
    RETURNING (xmax = 0) AS inserted, status
  `);
  const row = [...rows][0];
  /* No row back: already open (a repeated pass), or closed by an operator. Nothing to do. */
  if (!row) return;

  if (kind === 'payment.process') {
    /* One unresolved merchant exception per dead job. A merchant who dismissed the first one
     * sees a fresh one when the job dies again after a recovery. */
    await tx.execute(sql`
      INSERT INTO reconciliations
        (business_id, status, reason, expectation_kind, expectation_id, payment_id, amount_k,
         outstanding_k)
      SELECT ${job.businessId}::uuid, 'EXCEPTION', ${PAYMENT_JOB_DEAD_REASON}, 'dead_job',
             ${job.id}, NULL, NULL, NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM reconciliations
        WHERE business_id = ${job.businessId}::uuid AND status = 'EXCEPTION'
          AND expectation_kind = 'dead_job' AND expectation_id = ${job.id}
          AND resolved_at IS NULL)
    `);
  }

  if (eventId) {
    /* Flag the event for the operator's list and leave it unprocessed, so it stays recoverable.
     * An existing flag is never overwritten. */
    await tx.execute(sql`
      UPDATE external_events SET error = COALESCE(error, ${EVENT_FLAG[kind]})
      WHERE id = ${eventId}::uuid AND business_id = ${job.businessId}::uuid
        AND processed_at IS NULL AND resolved_at IS NULL
    `);
  }

  await tx.execute(sql`
    INSERT INTO audit_events
      (business_id, actor, entity, entity_id, action, new_value, source_type)
    VALUES (${job.businessId}::uuid, 'system:jobs', 'job', ${job.id},
            ${row.inserted ? 'dead_job_exception_opened' : 'dead_job_exception_reopened'},
            ${JSON.stringify({
              kind,
              eventId,
              attempts: job.attempts,
              failureCategory: job.failureCategory,
            })}::jsonb,
            'system')
  `);
}

/**
 * A job finished. If it was a recovery attempt, close its record and the merchant's exception.
 * Called by `jobsRepo.markDone` inside the handler's tenant transaction, so the close commits
 * with the work it records.
 */
export async function noteJobDone(tx: TenantDb, jobId: string): Promise<void> {
  const rows = await tx.execute<{ business_id: string; kind: string }>(sql`
    UPDATE dead_job_exceptions
    SET status = 'recovered', closed_at = now(), closed_by = 'system:recovery',
        resolution = 'the recovery attempt finished', updated_at = now()
    WHERE job_id = ${jobId}::uuid AND status = 'recovering'
    RETURNING business_id, kind
  `);
  const row = [...rows][0];
  if (!row) return;
  if (row.kind === 'payment.process') {
    await tx.execute(sql`
      UPDATE reconciliations SET resolved_at = now(), resolved_by = 'system:recovery'
      WHERE business_id = ${row.business_id}::uuid AND status = 'EXCEPTION'
        AND expectation_kind = 'dead_job' AND expectation_id = ${jobId} AND resolved_at IS NULL
    `);
  }
  await audit(tx, row.business_id, jobId, 'dead_job_recovered', 'system:recovery', 'system', {
    kind: row.kind,
  });
}

export interface DeadJobRow {
  jobId: string;
  businessId: string;
  kind: DeadJobKind;
  eventId: string | null;
  status: 'open' | 'recovering' | 'recovered' | 'resolved';
  failureCategory: string | null;
  summary: string;
  attempts: number;
  deathCount: number;
  openedAt: Date;
  lastDiedAt: Date;
  recoveryRequestedAt: Date | null;
  recoveryReference: string | null;
}

interface RawDeadJob extends Record<string, unknown> {
  job_id: string;
  business_id: string;
  kind: DeadJobKind;
  event_id: string | null;
  status: DeadJobRow['status'];
  failure_category: string | null;
  summary: string;
  attempts: number;
  death_count: number;
  opened_at: string;
  last_died_at: string;
  recovery_requested_at: string | null;
  recovery_reference: string | null;
}

const shape = (r: RawDeadJob): DeadJobRow => ({
  jobId: r.job_id,
  businessId: r.business_id,
  kind: r.kind,
  eventId: r.event_id,
  status: r.status,
  failureCategory: r.failure_category,
  summary: r.summary,
  attempts: Number(r.attempts),
  deathCount: Number(r.death_count),
  openedAt: new Date(r.opened_at),
  lastDiedAt: new Date(r.last_died_at),
  recoveryRequestedAt: r.recovery_requested_at ? new Date(r.recovery_requested_at) : null,
  recoveryReference: r.recovery_reference,
});

const COLUMNS = sql`job_id, business_id, kind, event_id, status, failure_category, summary,
  attempts, death_count, opened_at, last_died_at, recovery_requested_at, recovery_reference`;

/**
 * The operator queue's job-keyed items: open or recovering dead jobs with NO event. A dead job
 * with an event is already on the flagged-event list, carrying its job id
 * (`events.exceptionQueue`), so listing it here too would queue it twice. Worker-credentialed.
 */
export async function opsQueueWithoutEvent(db: Db, limit = 50): Promise<DeadJobRow[]> {
  const rows = await db.execute<RawDeadJob>(sql`
    SELECT ${COLUMNS} FROM dead_job_exceptions
    WHERE status IN ('open', 'recovering') AND event_id IS NULL
    ORDER BY opened_at, job_id
    LIMIT ${limit}
  `);
  return [...rows].map(shape);
}

/** One record by job id, across tenants, for the operator routes. Worker-credentialed. */
export async function findForOps(db: Db, jobId: string): Promise<DeadJobRow | null> {
  if (!UUID.test(jobId)) return null;
  const rows = await db.execute<RawDeadJob>(sql`
    SELECT ${COLUMNS} FROM dead_job_exceptions WHERE job_id = ${jobId}::uuid
  `);
  const row = [...rows][0];
  return row ? shape(row) : null;
}

/** A business's own open records, under its pin (the billing notice reads this). */
export async function openForBusiness(
  tx: TenantDb,
  businessId: string,
  kind?: DeadJobKind,
): Promise<DeadJobRow[]> {
  const rows = await tx.execute<RawDeadJob>(sql`
    SELECT ${COLUMNS} FROM dead_job_exceptions
    WHERE business_id = ${businessId}::uuid AND status IN ('open', 'recovering')
      ${kind ? sql`AND kind = ${kind}` : sql``}
    ORDER BY opened_at
  `);
  return [...rows].map(shape);
}

/**
 * Start an operator's recovery: OPEN -> recovering, and requeue the dead job for exactly one
 * more attempt (its `max_attempts` becomes the attempts it has used plus one, so the poison bound
 * holds). Conditional on the record still being open and the job still dead, so two operators
 * produce one recovery. The caller has already verified the reference with Paystack.
 */
export async function beginRecovery(
  tx: TenantDb,
  input: {
    businessId: string;
    jobId: string;
    actor: string;
    reason: string;
    reference: string;
    verification: string;
  },
): Promise<boolean> {
  const moved = await tx.execute<{ job_id: string }>(sql`
    UPDATE dead_job_exceptions SET
      status = 'recovering', recovery_requested_at = now(),
      recovery_requested_by = ${input.actor}, recovery_reason = ${input.reason},
      recovery_reference = ${input.reference}, recovery_verification = ${input.verification},
      updated_at = now()
    WHERE job_id = ${input.jobId}::uuid AND business_id = ${input.businessId}::uuid
      AND status = 'open'
    RETURNING job_id
  `);
  if ([...moved].length !== 1) return false;
  const requeued = await tx.execute<{ id: string }>(sql`
    UPDATE jobs SET state = 'pending', max_attempts = attempts + 1, run_at = now(),
                    locked_at = NULL, locked_by = NULL, updated_at = now()
    WHERE id = ${input.jobId}::uuid AND business_id = ${input.businessId}::uuid
      AND state = 'dead'
    RETURNING id
  `);
  /* A record whose job is not dead (it cannot be, but a hand edit could make it so) must not be
   * marked recovering with nothing running: throwing rolls the status change back. */
  if ([...requeued].length !== 1) throw new Error('dead job record has no dead job to requeue');
  await audit(
    tx,
    input.businessId,
    input.jobId,
    'dead_job_recovery_started',
    input.actor,
    'operator',
    {
      reason: input.reason,
      reference: input.reference,
      verification: input.verification,
    },
  );
  return true;
}

/** Record a recovery the operator asked for but that was refused or could not run. */
export async function recordRecoveryRefused(
  tx: TenantDb,
  input: { businessId: string; jobId: string; actor: string; reason: string; outcome: string },
): Promise<void> {
  await audit(
    tx,
    input.businessId,
    input.jobId,
    'dead_job_recovery_refused',
    input.actor,
    'operator',
    {
      reason: input.reason,
      outcome: input.outcome,
    },
  );
}

/**
 * An operator closes a record without recovering it (they settled it by hand, or decided nothing
 * is owed). Conditional on it being open. Closes the merchant's exception for a payment job.
 */
export async function resolveByOperator(
  tx: TenantDb,
  input: { businessId: string; jobId: string; actor: string; resolution: string },
): Promise<boolean> {
  const rows = await tx.execute<{ kind: string }>(sql`
    UPDATE dead_job_exceptions SET status = 'resolved', closed_at = now(),
      closed_by = ${input.actor}, resolution = ${input.resolution}, updated_at = now()
    WHERE job_id = ${input.jobId}::uuid AND business_id = ${input.businessId}::uuid
      AND status = 'open'
    RETURNING kind
  `);
  const row = [...rows][0];
  if (!row) return false;
  if (row.kind === 'payment.process') {
    await tx.execute(sql`
      UPDATE reconciliations SET resolved_at = now(), resolved_by = ${input.actor}
      WHERE business_id = ${input.businessId}::uuid AND status = 'EXCEPTION'
        AND expectation_kind = 'dead_job' AND expectation_id = ${input.jobId}
        AND resolved_at IS NULL
    `);
  }
  await audit(tx, input.businessId, input.jobId, 'dead_job_resolved', input.actor, 'operator', {
    resolution: input.resolution,
  });
  return true;
}

async function audit(
  tx: Tx,
  businessId: string,
  jobId: string,
  action: string,
  actor: string,
  sourceType: string,
  value: Record<string, unknown>,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO audit_events (business_id, actor, entity, entity_id, action, new_value, source_type)
    VALUES (${businessId}::uuid, ${actor}, 'job', ${jobId}, ${action},
            ${JSON.stringify(value)}::jsonb, ${sourceType})
  `);
}
