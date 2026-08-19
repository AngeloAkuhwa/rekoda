/**
 * The queue's SQL. Rules live in the runner; this file only knows how to move
 * a row between four states without two workers disagreeing about who owns it.
 *
 * Claiming is the only operation here that crosses tenants, and it is the only
 * one that requires the `rekoda_worker` role (migration 0004). Everything else
 * takes a `TenantDb` — a handle that is already pinned — so completing a job
 * happens under the same policy as the work it completes.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';
import { jobs } from '../schema/ops.js';

export type Queryable = Db | TenantDb;

export interface EnqueueInput {
  businessId: string;
  kind: string;
  payload?: Record<string, unknown>;
  /** At most one un-finished job per (business, kind, key). */
  singletonKey?: string | null;
  /** Delay before the job first becomes claimable. */
  delayMs?: number;
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: string;
  businessId: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/**
 * Enqueue, honouring the singleton index.
 *
 * Returns null when an un-finished job with the same key already exists — the
 * caller asked for work that is already queued, which is a success, not a
 * collision. `ON CONFLICT DO NOTHING` names the index explicitly so a genuine
 * unique violation elsewhere still surfaces as an error.
 */
export async function enqueue(q: Queryable, input: EnqueueInput): Promise<{ id: string } | null> {
  const runAt = new Date(Date.now() + (input.delayMs ?? 0));
  const rows = await q
    .insert(jobs)
    .values({
      businessId: input.businessId,
      kind: input.kind,
      payload: (input.payload ?? {}) as never,
      singletonKey: input.singletonKey ?? null,
      runAt,
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    })
    /**
     * The conflict target has to name the index PREDICATE as well as its
     * columns, or PostgreSQL cannot tell which index is meant and raises
     * "there is no unique or exclusion constraint matching the ON CONFLICT
     * specification" — at runtime, on the first duplicate, which is exactly
     * the path nobody exercises by hand.
     */
    .onConflictDoNothing({
      target: [jobs.businessId, jobs.kind, jobs.singletonKey],
      where: sql`${jobs.singletonKey} IS NOT NULL AND ${jobs.state} IN ('pending', 'running')`,
    })
    .returning({ id: jobs.id });
  return rows[0] ?? null;
}

/**
 * Take the next due job, exactly once across every worker.
 *
 * `FOR UPDATE SKIP LOCKED` inside the sub-select is the whole concurrency
 * story: a row another worker is already claiming is skipped rather than
 * waited on, so N workers make progress on N different jobs instead of
 * queueing behind the same one. Without SKIP LOCKED this is a lock convoy;
 * without FOR UPDATE it is a double-run.
 *
 * Requires the `rekoda_worker` role. Called with `rekoda_app`'s credentials it
 * returns nothing at all — `tenant_isolation` is the only policy that applies,
 * and an unpinned transaction matches no rows. That is the intended failure:
 * silent and empty rather than cross-tenant.
 */
export async function claimNext(db: Db, workerId: string): Promise<ClaimedJob | null> {
  const rows = await db.execute<{
    id: string;
    business_id: string;
    kind: string;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
  }>(sql`
    UPDATE jobs SET
      state      = 'running',
      attempts   = attempts + 1,
      locked_at  = now(),
      locked_by  = ${workerId},
      updated_at = now()
    WHERE id = (
      SELECT id FROM jobs
      WHERE state = 'pending' AND run_at <= now()
      ORDER BY run_at, created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, business_id, kind, payload, attempts, max_attempts
  `);

  const row = [...rows][0];
  if (!row) return null;
  return {
    id: row.id,
    businessId: row.business_id,
    kind: row.kind,
    payload: row.payload ?? {},
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

/**
 * Mark a job done — deliberately typed to `TenantDb`, not `Db`.
 *
 * The runner calls this inside the same tenant-pinned transaction as the
 * handler, so the job's completion and the job's effects commit or roll back
 * together. A worker that dies between "wrote the ledger entries" and "marked
 * it done" would otherwise re-run the handler on a job that already succeeded.
 */
export async function markDone(tx: TenantDb, id: string): Promise<void> {
  await tx
    .update(jobs)
    .set({ state: 'done', lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(eq(jobs.id, id));
}

/** Exponential, capped. Attempt 1 waits ~2s, attempt 5 ~32s. */
export function backoffMs(attempts: number, baseMs = 1_000, capMs = 300_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(1, attempts));
}

/**
 * Record a failure and decide whether the job gets another go.
 *
 * Runs on the worker connection, not the handler's transaction — that one has
 * been rolled back, which is the point: a failed job leaves nothing behind
 * except the record that it failed.
 */
export async function markFailed(
  db: Db,
  job: Pick<ClaimedJob, 'id' | 'attempts' | 'maxAttempts'>,
  error: string,
  delayMs = backoffMs(job.attempts),
): Promise<{ state: 'pending' | 'dead' }> {
  const exhausted = job.attempts >= job.maxAttempts;
  const state = exhausted ? 'dead' : 'pending';
  await db.execute(sql`
    UPDATE jobs SET
      state      = ${state},
      run_at     = ${exhausted ? sql`run_at` : sql`now() + make_interval(secs => ${delayMs / 1000})`},
      locked_at  = NULL,
      locked_by  = NULL,
      last_error = ${error},
      updated_at = now()
    WHERE id = ${job.id}::uuid
  `);
  return { state };
}

/**
 * Return jobs whose worker died mid-run to the queue.
 *
 * A crashed process leaves its row `running` forever, and nothing else will
 * ever touch it — the claim query only looks at `pending`. The attempt has
 * already been counted, so a job that reliably kills its worker still reaches
 * `dead` rather than looping.
 */
export async function reclaimStalled(db: Db, olderThanMs = 300_000): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE jobs SET
      state      = 'pending',
      locked_at  = NULL,
      locked_by  = NULL,
      last_error = coalesce(last_error, 'reclaimed: worker did not finish'),
      updated_at = now()
    WHERE state = 'running'
      AND locked_at < now() - make_interval(secs => ${olderThanMs / 1000})
    RETURNING id
  `);
  return [...rows].length;
}

export interface JobRow {
  id: string;
  kind: string;
  state: string;
  attempts: number;
  lastError: string | null;
}

/** A tenant's own view of its queue — for the dashboard and for tests. */
export async function jobsForBusiness(tx: TenantDb, kind?: string): Promise<JobRow[]> {
  const where = kind ? and(eq(jobs.kind, kind)) : undefined;
  return tx
    .select({
      id: jobs.id,
      kind: jobs.kind,
      state: jobs.state,
      attempts: jobs.attempts,
      lastError: jobs.lastError,
    })
    .from(jobs)
    .where(where)
    .orderBy(jobs.createdAt);
}
