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

/** Rekoda's own reference shapes: a merchant payment, a subscription charge, a pack (with its
 * checkout-attempt suffix). Anything else in a payload is not recorded. */
const REKODA_REFERENCE = /^RKD-(PAY|SUB|PACK)-\d{8}-[0-9A-Z]{6}(-R\d{1,2})?$/;

/** A job payload's `reference`, when it is one of Rekoda's own references. */
export function referenceOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)['reference'];
  return typeof value === 'string' && REKODA_REFERENCE.test(value) ? value : null;
}

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
export async function recordDeath(
  tx: Tx,
  job: DyingJob,
  /** Enrolment of an unrecorded death: insert only, never reopen an existing record. */
  opts: { enrolOnly?: boolean } = {},
): Promise<void> {
  if (!isDeadJobKind(job.kind) || !UUID.test(job.businessId)) return;
  const kind = job.kind;
  const named = eventIdOf(job.payload);
  const reference = referenceOf(job.payload);

  /* The writes below are tenant rows: pin the job's tenant for the rest of this transaction. */
  await tx.execute(sql`SELECT set_config('app.business_id', ${job.businessId}, true)`);

  /* The event is bound only when it is this business's own: a payload naming another tenant's
   * event (a mis-enqueued job) records none, so neither a resolve nor the operator queue can ever
   * associate this job with that event. */
  const owned = named
    ? [
        ...(await tx.execute<{ yes: boolean }>(sql`
          SELECT EXISTS (SELECT 1 FROM external_events
                         WHERE id = ${named}::uuid AND business_id = ${job.businessId}::uuid) AS yes`)),
      ][0]?.yes === true
    : false;
  const eventId = owned ? named : null;

  const rows = await tx.execute<{ inserted: boolean; status: string }>(sql`
    INSERT INTO dead_job_exceptions
      (job_id, business_id, kind, event_id, reference, failure_category, summary, attempts)
    VALUES (${job.id}::uuid, ${job.businessId}::uuid, ${kind}, ${eventId}::uuid, ${reference},
            ${job.failureCategory}, ${SUMMARY[kind]}, ${job.attempts})
    ${
      opts.enrolOnly
        ? sql`ON CONFLICT (job_id) DO NOTHING`
        : sql`ON CONFLICT (job_id) DO UPDATE SET
      status = 'open',
      failure_category = EXCLUDED.failure_category,
      attempts = EXCLUDED.attempts,
      death_count = dead_job_exceptions.death_count + 1,
      last_died_at = now(),
      updated_at = now()
    WHERE dead_job_exceptions.status = 'recovering'`
    }
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
              reference,
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
  /** Rekoda's own reference from the job payload, when it carried one. */
  reference: string | null;
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
  reference: string | null;
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
  reference: r.reference,
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

const COLUMNS = sql`job_id, business_id, kind, event_id, reference, status, failure_category, summary,
  attempts, death_count, opened_at, last_died_at, recovery_requested_at, recovery_reference`;

/** A dead job as the operator queue shows it: the record, and the state it left things in. */
export interface DeadJobOpsRow extends DeadJobRow {
  /**
   * Current payment state for the reference, read now: the subscription charge's status for a
   * billing job, the payment intent's status for a payment job; null without a reference.
   */
  paymentState: string | null;
  /** The business's plan and paid-to date now (billing jobs only; null for a payment job). */
  currentPlan: string | null;
  currentPlanExpiresAt: Date | null;
}

/**
 * The operator queue: every open or recovering dead job, oldest first, with the current payment
 * and subscription state (OWN-76). A job with an event is shown on that event's flagged row; one
 * without is its own item (the caller splits them). Worker-credentialed; ids, statuses and
 * fixed text only.
 */
export async function opsQueue(
  db: Db,
  limit = 50,
  /** When given, exactly these jobs (still open or recovering), whatever their age. */
  jobIds?: readonly string[],
  /** Only records with no event (filtered in SQL, so event-bound ones cannot crowd them out). */
  eventless = false,
): Promise<DeadJobOpsRow[]> {
  const ids = jobIds?.filter((id) => UUID.test(id));
  if (ids && ids.length === 0) return [];
  const rows = await db.execute<
    RawDeadJob & {
      payment_state: string | null;
      current_plan: string | null;
      current_plan_expires_at: string | null;
    }
  >(sql`
    SELECT d.job_id, d.business_id, d.kind, d.event_id, d.reference, d.status,
           d.failure_category, d.summary, d.attempts, d.death_count, d.opened_at,
           d.last_died_at, d.recovery_requested_at, d.recovery_reference,
           CASE WHEN d.kind = 'billing.process' THEN
                  (SELECT c.status FROM subscription_charges c
                    WHERE c.business_id = d.business_id
                      AND c.reference = regexp_replace(d.reference, '-R[0-9]+$', ''))
                ELSE
                  (SELECT i.status FROM payment_intents i
                    WHERE i.business_id = d.business_id AND i.reference = d.reference)
           END AS payment_state,
           CASE WHEN d.kind = 'billing.process' THEN b.plan END AS current_plan,
           CASE WHEN d.kind = 'billing.process' THEN b.plan_expires_at END
             AS current_plan_expires_at
    FROM dead_job_exceptions d
    JOIN businesses b ON b.id = d.business_id
    WHERE d.status IN ('open', 'recovering')
      ${ids ? sql`AND d.job_id = ANY(${`{${ids.join(',')}}`}::uuid[])` : sql``}
      ${eventless ? sql`AND d.event_id IS NULL` : sql``}
    ORDER BY d.opened_at, d.job_id
    LIMIT ${ids ? ids.length : limit}
  `);
  return [...rows].map((r) => ({
    ...shape(r),
    paymentState: r.payment_state,
    currentPlan: r.current_plan,
    currentPlanExpiresAt: r.current_plan_expires_at ? new Date(r.current_plan_expires_at) : null,
  }));
}

/** The open (or recovering) dead job bound to an event, if any. Worker-credentialed, by event id. */
export async function openJobForEvent(db: Db, eventId: string): Promise<string | null> {
  if (!UUID.test(eventId)) return null;
  const rows = await db.execute<{ job_id: string }>(sql`
    SELECT job_id FROM dead_job_exceptions
    WHERE event_id = ${eventId}::uuid AND status IN ('open', 'recovering')
    LIMIT 1
  `);
  return [...rows][0]?.job_id ?? null;
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
