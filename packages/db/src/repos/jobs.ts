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
import {
  LOCK_CLASS,
  withAdvisoryLock,
  withBusiness,
  type Db,
  type LockClient,
  type TenantDb,
} from '../client.js';
import { jobs } from '../schema/ops.js';
import * as deadJobs from './dead-jobs.js';

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
  /**
   * The job's `created_at`, from `stampInboundArrival`, so an inbound message's job and its
   * webhook event carry the one arrival instant taken under the ingress lock. Unset: `now()`.
   */
  arrivedAt?: string;
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
  /*
   * Work due now takes the DATABASE's clock, not the host's: claims compare run_at with the
   * database's now(), and the 0222 guard refuses a settlement job the application enqueues more
   * than a minute into the future, so an API host running a few minutes fast would otherwise have
   * every Paystack payment refused at the pump. A deliberate delay is still measured from the host.
   */
  const delayMs = input.delayMs ?? 0;
  const runAt = delayMs > 0 ? new Date(Date.now() + delayMs) : (sql`now()` as unknown as Date);
  const rows = await q
    .insert(jobs)
    .values({
      businessId: input.businessId,
      kind: input.kind,
      payload: (input.payload ?? {}) as never,
      singletonKey: input.singletonKey ?? null,
      runAt,
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
      ...(input.arrivedAt === undefined
        ? {}
        : { createdAt: sql`${input.arrivedAt}::timestamptz` as unknown as Date }),
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
 * Run one pass of a named sweep on exactly one replica.
 *
 * Every worker replica fires every sweep timer, and while the claims inside
 * each sweep are individually race-safe, N replicas doing identical passes
 * is N times the database load for one replica's worth of progress. A
 * transaction-scoped advisory lock elects a leader per sweep per pass; the
 * losers return without working and try again next tick, so a dead leader
 * is replaced by whoever fires next. Nothing to configure, nothing to clean
 * up: the lock dies with the transaction.
 */
export async function runExclusively(
  lock: LockClient,
  name: string,
  work: () => Promise<unknown>,
): Promise<void> {
  /**
   * Session-level lock on the DEDICATED lock pool, NOT a transaction wrapping
   * the whole body. The old shape held one working-pool connection idle inside
   * a transaction for the entire sweep while the sweep's own queries fought for
   * the remaining connections; four hourly sweeps firing in one tick against a
   * three-connection worker pool deadlocked silently about an hour after boot.
   * `withAdvisoryLock` keeps the lock on its own pool, so it never competes
   * with the work. The `sweep` class id keeps these keys from colliding with
   * the per-business locks below.
   */
  await withAdvisoryLock(lock, LOCK_CLASS.sweep, `sweep:${name}`, async () => {
    await work();
  });
}

/**
 * Has a job EVER been queued under this singleton key, in any state?
 *
 * The enqueue's own dedupe only covers pending and running, which is right
 * for its callers: a finished job should not block new work. The pump's
 * stranded-event lane needs the opposite question — "was this event ever
 * queued at all" — because re-queueing an event whose job already ran and
 * died would turn one poison payload into a permanent retry loop.
 */
/**
 * Serialize a body of work per business, held to the end of `tx`.
 *
 * A transaction-scoped advisory lock keyed on the business plus a scope
 * string: two transactions that take the same (business, scope) lock run one
 * after another, while different businesses never contend. The inbound
 * message handler takes `('inbound')` so the concurrency lanes cannot process
 * two messages for one conversation at once — the pending-draft read-then-
 * write assumes a single runner per business. Different businesses still run
 * in parallel across lanes.
 */
export async function serializeBusiness(
  tx: TenantDb,
  businessId: string,
  scope: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${LOCK_CLASS.business}, hashtext(${`${businessId}:${scope}`}))`,
  );
}

/**
 * The arrival instant of an inbound message, taken under its business's ingress lock (OWN-74).
 *
 * `hasEarlierLiveJobByArrival` can only defer an answer behind an earlier message it can SEE. With
 * arrival stamped as `now()`, the transaction's start, an ingress transaction that began first but
 * committed late was invisible to a later "yes" processed in between: it ordered earlier, yet the
 * "yes" confirmed the draft it may have cancelled, and if it then died nothing could retire that
 * draft (CodeRabbit on #428). So an ingress transaction first serializes on `(business, 'ingress')`
 * and only then reads `clock_timestamp()`. A message stamped earlier than another took the lock
 * first and so committed before the other was even stamped: by the time any job runs, every
 * message that arrived before it is visible. The lock is held only for the event and job inserts,
 * never across a handler, so it does not slow the webhook's answer to Meta.
 *
 * Returned as text and written back with `::timestamptz`, keeping PostgreSQL's microseconds (a
 * JavaScript `Date` would round to the millisecond and could tie two messages).
 *
 * The wait for the lock is bounded (`INGRESS_LOCK_TIMEOUT_MS`, CodeRabbit on `3fa1f4e`): each
 * waiting webhook holds a connection from the shared application pool, so an ingress that stalled
 * while holding the lock must not let one business's queued messages starve every other
 * business's webhooks. A wait past the bound fails with `lock_not_available`; the transaction rolls
 * back having written nothing, the controller answers Meta non-200, and Meta redelivers the
 * message, which is then stamped in its turn. Ordering is unchanged: a message is only ever stamped
 * while holding the lock. The bound applies to this one lock; it is reset before the inserts.
 */
export const INGRESS_LOCK_TIMEOUT_MS = 2_000;

export async function stampInboundArrival(
  tx: TenantDb,
  businessId: string,
  options: { lockTimeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.lockTimeoutMs ?? INGRESS_LOCK_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('stampInboundArrival: lockTimeoutMs must be a positive integer');
  }
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${timeoutMs}ms'`));
  await serializeBusiness(tx, businessId, 'ingress');
  await tx.execute(sql`SET LOCAL lock_timeout TO DEFAULT`);
  const rows = await tx.execute<{ at: string }>(sql`SELECT clock_timestamp()::text AS at`);
  const at = [...rows][0]?.at;
  if (!at) throw new Error('stampInboundArrival: no clock reading');
  return at;
}

/**
 * Is an older live job of the same kind still ahead of this one?
 *
 * The advisory lock above guarantees exclusion, not order: between claiming a
 * job and taking the lock there is a window, and a lane holding the LATER of
 * two messages can win the lock while the earlier message's lane is still on
 * its way. "Sold 3 wigs" then "yes" processed in the wrong order confirms
 * nothing and drops a record. So a handler that needs order calls this AFTER
 * taking the lock: an older sibling still `pending` or `running` means this
 * job is jumping the queue and should step back (see `deferClaimed`). Ordered
 * by the same (run_at, created_at) the claim query uses, with id as the
 * tiebreak, for a sibling that has been tried (`attempts > 0`: running, or
 * backing off after a failure, which a newer request may deliberately pass).
 * A sibling never tried (`attempts = 0`) is ordered by arrival (`created_at`,
 * id): the only thing that moved its `run_at` is `deferClaimed`, which
 * refunds the attempt, and a message that stepped back behind a failed
 * receipt must still count as older than one that arrived after it (G-20).
 *
 * `alsoKinds` names other kinds whose older live jobs also count, by arrival:
 * an inbound "yes" must not overtake an already-queued `delivery.status`
 * failure for a preview, even one backing off after a failed attempt.
 */
export async function hasEarlierLiveJob(
  tx: TenantDb,
  jobId: string,
  alsoKinds: readonly string[] = [],
): Promise<boolean> {
  const kinds = sql.join(
    alsoKinds.map((k) => sql`${k}`),
    sql`, `,
  );
  const rows = await tx.execute(sql`
    SELECT 1
    FROM jobs j, jobs me
    WHERE me.id = ${jobId}::uuid
      AND j.business_id = me.business_id
      AND j.id <> me.id
      AND j.state IN ('pending', 'running')
      AND (
        (j.kind = me.kind AND j.attempts > 0
           AND (j.run_at, j.created_at, j.id) < (me.run_at, me.created_at, me.id))
        OR ((j.kind = me.kind AND j.attempts = 0${alsoKinds.length > 0 ? sql` OR j.kind IN (${kinds})` : sql``})
           AND (j.created_at, j.id) < (me.created_at, me.id))
      )
    LIMIT 1
  `);
  return [...rows].length > 0;
}

/**
 * Whether an earlier job of the same kind and business, by arrival, is still `pending` or
 * `running`, INCLUDING one backing off after a failure (owner ruling OWN-74, 4 Nov 2026).
 *
 * `hasEarlierLiveJob` lets a newer message pass a sibling that is backing off, so a request is
 * not held up for the ~30 s a failing one retries. An answer must not pass it: if that sibling is
 * the merchant's "cancel" or a correction and it never succeeds, a "yes" sent during its backoff
 * would confirm the draft it was about. So the inbound handler defers a "yes", "no", "cancel" or
 * "yes?" while this is true; the sibling then either succeeds or dies, and a dead one is
 * reconciled (`reconcileDeadInboundMessages`) before the answer is read.
 *
 * "Arrival" is the job's `created_at`. For `inbound.message` that is the webhook event's arrival
 * instant exactly: the only producer (`MetaService`) stamps both rows with one
 * `stampInboundArrival` reading, taken under the business's ingress lock, in the transaction that
 * writes them. So a message stamped earlier is always committed, and visible here, before a later
 * one is even stamped; there is no window in which an earlier message's uncommitted ingress hides
 * it from this check. A new producer must stamp the same way (pinned in
 * `apps/api/src/channels/meta-webhook-ingress.integration.test.ts` and
 * `packages/db/src/channels/dead-inbound-reconcile.integration.test.ts`).
 */
export async function hasEarlierLiveJobByArrival(tx: TenantDb, jobId: string): Promise<boolean> {
  const rows = await tx.execute(sql`
    SELECT 1
    FROM jobs j, jobs me
    WHERE me.id = ${jobId}::uuid
      AND j.business_id = me.business_id
      AND j.kind = me.kind
      AND j.id <> me.id
      AND j.state IN ('pending', 'running')
      AND (j.created_at, j.id) < (me.created_at, me.id)
    LIMIT 1
  `);
  return [...rows].length > 0;
}

/**
 * Put a claimed job back in the queue without charging it an attempt.
 *
 * Stepping aside for an older sibling is not a failure: `markFailed` would
 * count it, and a message stuck behind a genuinely slow predecessor could
 * burn all five attempts waiting politely and die having done nothing wrong.
 * The claim already incremented `attempts`, so this hands the increment back.
 * The short delay keeps the retry from racing the very job it deferred to.
 */
export async function deferClaimed(
  db: Db,
  jobId: string,
  delayMs = 500,
  claimedBy?: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE jobs SET
      state      = 'pending',
      attempts   = greatest(attempts - 1, 0),
      run_at     = now() + make_interval(secs => ${delayMs / 1000}),
      locked_at  = NULL,
      locked_by  = NULL,
      updated_at = now()
    WHERE id = ${jobId}::uuid AND state = 'running'
      AND (${claimedBy ?? null}::text IS NULL OR locked_by = ${claimedBy ?? null})
  `);
}

/**
 * Whether a job has EVER been enqueued under this singleton key, in ANY
 * state — deliberately, not an oversight. The one caller is the pump's
 * stranded-event lane, where "a job exists, even failed" means the event
 * was queued once and is the handler's story now: filtering to live states
 * would resurrect a job that already died five attempts, turning one poison
 * payload into a permanent retry loop.
 */
export async function hasJobForSingleton(
  q: Queryable,
  businessId: string,
  kind: string,
  singletonKey: string,
): Promise<boolean> {
  const rows = await q
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.businessId, businessId),
        eq(jobs.kind, kind),
        eq(jobs.singletonKey, singletonKey),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The job kinds that settle a Rekoda charge (OD-51.2, migration 0217): a provider-verified payment
 * (`billing.process`) and a zero-priced upgrade (`billing.apply_no_charge`). They are claimed and
 * run only by the dedicated settlement process, on the `rekoda_settlement` credential; the general
 * worker's claim excludes them, and the database refuses its credential any claim or completion of
 * one. The same two names are in the queue policies of migration 0217.
 */
export const SETTLEMENT_JOB_KINDS = ['billing.process', 'billing.apply_no_charge'] as const;

/** Which kinds a claim may take: only these, or anything but these. Absent means any kind. */
export interface ClaimFilter {
  only?: readonly string[];
  except?: readonly string[];
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
export async function claimNext(
  db: Db,
  workerId: string,
  filter: ClaimFilter = {},
): Promise<ClaimedJob | null> {
  const kinds = (list: readonly string[]) =>
    sql.join(
      list.map((kind) => sql`${kind}`),
      sql`, `,
    );
  const onlyThese =
    filter.only && filter.only.length > 0 ? sql`AND kind IN (${kinds(filter.only)})` : sql``;
  const notThese =
    filter.except && filter.except.length > 0
      ? sql`AND kind NOT IN (${kinds(filter.except)})`
      : sql``;
  const rows = await db.execute<{
    id: string;
    business_id: string;
    kind: string;
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
        ${onlyThese}
        ${notThese}
      ORDER BY run_at, created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, business_id, kind, attempts, max_attempts
  `);

  const row = [...rows][0];
  if (!row) return null;
  /* The claim crosses tenants for coordination columns only; the payload is read under the job's
   * own pin, through the one function the database allows for it (0228). */
  const payload = await withBusiness(db, row.business_id, (tx) =>
    pinnedPayload(tx, row.id, row.business_id),
  );
  return {
    id: row.id,
    businessId: row.business_id,
    kind: row.kind,
    payload: (payload as Record<string, unknown> | null) ?? {},
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
export async function markDone(tx: TenantDb, id: string, claimedBy?: string): Promise<void> {
  const rows = await tx
    .update(jobs)
    .set({ state: 'done', lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(
      claimedBy === undefined
        ? eq(jobs.id, id)
        : and(eq(jobs.id, id), eq(jobs.state, 'running'), eq(jobs.lockedBy, claimedBy)),
    )
    .returning({ id: jobs.id, kind: jobs.kind });
  /* Fenced completion (G-10): when the caller names its claim and the row is
   * no longer held under it (reclaimed and claimed again while this attempt
   * was still running), committing would let two attempts both finish their
   * effects. Throwing rolls the handler's transaction back with it. */
  if (claimedBy !== undefined && rows.length === 0) throw new JobLeaseLost(id);
  /* A recovered payment or billing job closes its dead-job record in the same commit as its
   * work (OWN-73, OWN-76). Other kinds never have one. */
  const kind = rows[0]?.kind;
  if (kind !== undefined && deadJobs.isDeadJobKind(kind)) await deadJobs.noteJobDone(tx, id);
}

/** This attempt no longer owns the job; its work must not commit. */
export class JobLeaseLost extends Error {
  constructor(readonly jobId: string) {
    super(`job ${jobId} was reclaimed while this attempt was still running`);
  }
}

/**
 * Renew a running job's lease (G-10).
 *
 * `reclaimStalled` treats `locked_at` as "this worker was last seen working on
 * it". Without a renewal, a handler that legitimately runs longer than the
 * stall window (a slow upload, a slow model call) looks identical to a
 * crashed worker and is handed to a second worker while the first is still
 * going. The runner calls this on a timer while a handler runs. Guarded by
 * `locked_by` and `state` so a job that already finished, failed or was
 * reclaimed is never resurrected.
 */
export async function touch(tx: TenantDb, id: string, claimedBy: string): Promise<void> {
  await tx.execute(sql`
    UPDATE jobs SET locked_at = now(), updated_at = now()
    WHERE id = ${id}::uuid AND state = 'running' AND locked_by = ${claimedBy}
  `);
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
  claimedBy?: string,
): Promise<{ state: 'pending' | 'dead' | 'lost' }> {
  const exhausted = job.attempts >= job.maxAttempts;
  const state = exhausted ? 'dead' : 'pending';
  /* One transaction: a payment or billing job that dies here writes its dead-job record in the
   * same commit as the transition (OWN-73, OWN-76), so neither can exist without the other. */
  const updated = await db.transaction(async (tx) => {
    const rows = await tx.execute<ReclaimedRow>(sql`
      UPDATE jobs SET
        state      = ${state},
        run_at     = ${exhausted ? sql`run_at` : sql`now() + make_interval(secs => ${delayMs / 1000})`},
        locked_at  = NULL,
        locked_by  = NULL,
        last_error = ${error},
        failure_category = 'handler_error',
        updated_at = now()
      WHERE id = ${job.id}::uuid
        AND (${claimedBy ?? null}::text IS NULL OR locked_by = ${claimedBy ?? null})
      RETURNING id, business_id, kind, attempts, state, failure_category
    `);
    const row = [...rows][0];
    if (row?.state === 'dead' && deadJobs.isDeadJobKind(row.kind) && row.business_id) {
      const payload = await pinnedPayload(tx, row.id, row.business_id);
      await deadJobs.recordDeath(tx, dyingJob({ ...row, payload }));
    }
    return row;
  });
  /* A fenced update that matched nothing means another claim owns the job:
   * report it rather than a retry or exhaustion that never happened. */
  if (claimedBy !== undefined && !updated) return { state: 'lost' };
  return { state };
}

/**
 * A dying job's payload, read under its own business's pin and only where that business owns it
 * (final review of PR #432): the reclaim crosses tenants to move coordination columns, never to
 * read what a tenant's job carries. Pins the transaction (savepoint) it runs in.
 */
async function pinnedPayload(tx: Queryable, jobId: string, businessId: string): Promise<unknown> {
  const [pin] = await tx.execute<{ via_function: boolean }>(sql`
    SELECT set_config('app.business_id', ${businessId}, true) IS NOT NULL
       AND has_function_privilege('public.job_payload(uuid)', 'EXECUTE') AS via_function`);
  /* The worker holds no SELECT on the column (0228): it reads through `job_payload`, which returns
   * the payload only where the job's business is the pinned one. Settlement may not execute that
   * definer function (0231, R01): it reads the column itself, and its RLS (0217) shows it only its
   * own two kinds, so any other job's payload is simply not there for it. */
  const rows = pin?.via_function
    ? await tx.execute<{ payload: unknown }>(sql`
        SELECT job_payload(${jobId}::uuid) AS payload`)
    : await tx.execute<{ payload: unknown }>(sql`
        SELECT j.payload FROM jobs j
        WHERE j.id = ${jobId}::uuid
          AND j.business_id = nullif(current_setting('app.business_id', true), '')::uuid`);
  return [...rows][0]?.payload ?? null;
}

interface ReclaimedRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  kind: string;
  attempts: number;
  state: string;
  failure_category: string | null;
}

interface DyingRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  state: string;
  failure_category: string | null;
}

const dyingJob = (row: DyingRow): deadJobs.DyingJob => ({
  id: row.id,
  businessId: row.business_id,
  kind: row.kind,
  payload: row.payload,
  attempts: Number(row.attempts),
  failureCategory: row.failure_category,
});

/**
 * Return jobs whose worker died mid-run to the queue.
 *
 * A crashed process leaves its row `running` forever, and nothing else will
 * ever touch it — the claim query only looks at `pending`. The attempt has
 * already been counted at the claim. A handler that crashes its process every
 * time never reaches `markFailed`, so without a bound here it would be
 * reclaimed for ever, repeating any provider call it made before dying.
 *
 * The bound is one run past `max_attempts`: a job whose last attempt died with
 * its worker gets exactly one more run, which sees `attempt >= maxAttempts` and
 * takes the handler's last-attempt path (the payment-event handler turns an
 * unread refund or dispute into a merchant exception there, never a silent dead
 * job). Only if that run dies too does the job go `dead` here.
 */
export async function reclaimStalled(
  db: Db,
  olderThanMs = 300_000,
  options: { onUnrecorded?: (count: number) => void } = {},
): Promise<number> {
  /* An operator's recovery (OWN-73, OWN-76) is ONE attempt: its run already took the
   * last-attempt path, so a crash during it goes straight back to dead (reopening the record)
   * instead of taking the ordinary one-more-run crash allowance without a fresh operator ask. */
  const exhausted = sql`(attempts > max_attempts OR (attempts >= max_attempts AND dead_job_is_recovering(jobs.id)))`;
  const stale = sql`locked_at < now() - make_interval(secs => ${olderThanMs / 1000})`;
  /* Each stalled job moves in its own savepoint, together with its dead-job record when it dies
   * (OWN-73, OWN-76): both commit or neither does. One whose record cannot be written stays
   * `running` with its expired lease, so the next pass retries both, and no other business's
   * reclaim waits on it (G2-1: one failure used to roll back the whole cross-tenant pass; I1: a
   * death committed without its record could leave a `recovering` record stuck for good). */
  return db.transaction(async (tx) => {
    const stalled = await tx.execute<{ id: string }>(sql`
      SELECT id FROM jobs WHERE state = 'running' AND ${stale}
      ORDER BY locked_at, id
      FOR UPDATE SKIP LOCKED
    `);
    let reclaimed = 0;
    let unrecorded = 0;
    for (const { id } of stalled) {
      try {
        const moved = await tx.transaction(async (savepoint) => {
          const rows = await savepoint.execute<ReclaimedRow>(sql`
            UPDATE jobs SET
              state      = CASE WHEN ${exhausted} THEN 'dead' ELSE 'pending' END,
              locked_at  = NULL,
              locked_by  = NULL,
              -- An expired lease says the worker stopped answering, not why, so the message is
              -- neutral. A dead job's error is fixed text (owner ruling, 4 Nov 2026): no earlier
              -- attempt's error text is carried into it. That an earlier attempt's handler failed
              -- survives only as the sanitised category beside it.
              last_error = CASE WHEN ${exhausted}
                             THEN 'reclaimed past the last attempt: its lease expired'
                             ELSE coalesce(last_error, 'reclaimed: lease expired before the worker finished') END,
              failure_category = CASE WHEN failure_category IN ('handler_error', 'lease_expired_after_handler_error')
                                      THEN 'lease_expired_after_handler_error'
                                      ELSE 'lease_expired' END,
              updated_at = now()
            WHERE id = ${id}::uuid AND state = 'running' AND ${stale}
            -- Coordination columns only: what a job carries is read below, under its own pin.
            RETURNING id, business_id, kind, attempts, state, failure_category
          `);
          const row = [...rows][0];
          if (!row) return false;
          if (row.state === 'dead' && deadJobs.isDeadJobKind(row.kind) && row.business_id) {
            const payload = await pinnedPayload(savepoint, row.id, row.business_id);
            await deadJobs.recordDeath(savepoint, dyingJob({ ...row, payload }));
          }
          return true;
        });
        if (moved) reclaimed += 1;
      } catch {
        unrecorded += 1;
      }
    }
    options.onUnrecorded?.(unrecorded);
    return reclaimed;
  });
}

/**
 * Enrol dead payment and billing jobs that have no dead-job record (OWN-73, OWN-76 cutover).
 *
 * A job that died before migration 0194, or under a worker still running the old code during a
 * rollout, has no record, so it would sit dead with no merchant notice, no operator item and no
 * recovery. This pass, run beside the reclaim, gives each one the same record a death writes now.
 *
 * It crosses tenants only to DISCOVER ids (`dead_job_unrecorded_candidates`, 0225: worker-only,
 * job id and business id, nothing else; ADR 0035 Amendment 1). Each candidate is then re-read,
 * re-checked and recorded by `enrolDeath` in its own transaction under its own business's pin, so
 * a payload is never read outside the tenant that owns it and one business's failure rolls back
 * that job alone. The failures are reported together after every other candidate has been tried.
 * `recordDeath` is idempotent per job, and a job an operator already closed has a row, so it is
 * never enrolled twice. Bounded per pass.
 */
export async function enrolUnrecordedDeaths(db: Db, limit = 100): Promise<number> {
  const pass = await enrolUnrecordedDeathsPage(db, { limit });
  throwIfEnrolmentFailed(pass);
  return pass.enrolled;
}

/** Where the next enrolment pass continues: the last candidate job the previous pass saw (0236). */
export type EnrolmentCursor = string | null;

export interface EnrolmentPass {
  enrolled: number;
  /** Candidates whose enrolment failed; each failure was recorded (it backs off, 0229)... */
  failed: number;
  /** ...except these: the failure itself could not be recorded (R08). By SQLSTATE, never a message. */
  untracked: { jobId: string; sqlstate: string | null }[];
  /** The cursor for the next pass; null when this page was the last (the next pass starts over). */
  next: EnrolmentCursor;
}

/**
 * One page of the cutover enrolment, continuing after `after` (R08, migration 0236). The runner
 * carries `next` from pass to pass, so a page full of candidates that fail, even ones whose failure
 * cannot be recorded, never stops later candidates from being reached. Nothing is thrown for a
 * candidate's failure: the caller reports the pass.
 */
export async function enrolUnrecordedDeathsPage(
  db: Db,
  options: { limit?: number; after?: EnrolmentCursor } = {},
): Promise<EnrolmentPass> {
  const limit = options.limit ?? 100;
  const after = options.after && UUID_TEXT.test(options.after) ? options.after : null;
  const candidates = [
    ...(await db.execute<{ job_id: string; business_id: string }>(
      sql`SELECT job_id, business_id FROM dead_job_unrecorded_candidates(${limit}::int, ${after}::uuid)`,
    )),
  ];
  let enrolled = 0;
  let failed = 0;
  const untracked: EnrolmentPass['untracked'] = [];
  for (const candidate of candidates) {
    try {
      if (await enrolDeath(db, candidate.job_id, candidate.business_id)) enrolled += 1;
    } catch (error) {
      /* The other businesses' candidates still run. Nothing about the failure (its message may
       * quote a row) is carried out of here but the count and its SQLSTATE. The database applies
       * the retry policy and dead-letters a candidate whose attempts are spent (0229). */
      failed += 1;
      try {
        await noteEnrolmentFailure(db, candidate.job_id, candidate.business_id, error);
      } catch (trackingError) {
        /* R08: the failure could not be recorded either, so this candidate has no backoff. It is
         * reported (not swallowed), and the cursor below still moves past it. */
        untracked.push({ jobId: candidate.job_id, sqlstate: sqlstateOf(trackingError) });
      }
    }
  }
  const last = candidates.at(-1);
  return {
    enrolled,
    failed,
    untracked,
    next: candidates.length === limit && last ? last.job_id : null,
  };
}

/** The pass as one error, when anything in it failed: counts and SQLSTATEs only. */
export function throwIfEnrolmentFailed(pass: EnrolmentPass): void {
  if (pass.failed === 0) return;
  const untracked =
    pass.untracked.length > 0
      ? `; the failure of ${pass.untracked.length} could not be recorded (SQLSTATE ${[
          ...new Set(pass.untracked.map((u) => u.sqlstate ?? 'unknown')),
        ].join(', ')})`
      : '';
  throw new Error(
    `dead-job enrolment failed for ${pass.failed} dead job(s); ${pass.enrolled} enrolled${untracked}`,
  );
}

/**
 * Enrol one unrecorded death, under its own business's pin. False (and nothing read or written)
 * when either id is not a UUID, or when the job is not, under that pin, a dead payment or billing
 * job without a record (another pass or a recovery took it, or it is another business's job).
 */
export async function enrolDeath(db: Db, jobId: string, businessId: string): Promise<boolean> {
  if (!UUID_TEXT.test(jobId) || !UUID_TEXT.test(businessId)) return false;
  return withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<DyingRow>(sql`
      SELECT j.id, j.business_id, j.kind, job_payload(j.id) AS payload, j.attempts, j.state,
             j.failure_category
      FROM jobs j
      WHERE j.id = ${jobId}::uuid
        AND j.business_id = nullif(current_setting('app.business_id', true), '')::uuid
        AND j.state = 'dead' AND j.kind IN ('payment.process', 'billing.process')
        AND NOT dead_job_has_record(j.id)
      -- Held until this job's record commits: a recovery requeueing it waits, a second pass skips it.
      FOR UPDATE OF j SKIP LOCKED
    `);
    const row = [...rows][0];
    if (!row) return false;
    /* Insert only: a record that already exists is never reopened by a stale candidate. */
    await deadJobs.recordDeath(tx, dyingJob(row), { enrolOnly: true });
    return true;
  });
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The SQLSTATE behind a failed query, when there is one: a code, never a message. */
function sqlstateOf(error: unknown): string | null {
  const code =
    (error as { cause?: { code?: unknown }; code?: unknown } | null)?.cause?.code ??
    (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/** Record one failed enrolment of a candidate, under its own business's pin (0229). */
async function noteEnrolmentFailure(
  db: Db,
  jobId: string,
  businessId: string,
  error: unknown,
): Promise<void> {
  if (!UUID_TEXT.test(jobId) || !UUID_TEXT.test(businessId)) return;
  await withBusiness(db, businessId, (tx) =>
    tx.execute(sql`SELECT dead_job_enrolment_failed(${businessId}::uuid, ${jobId}::uuid,
                                                    ${sqlstateOf(error)}::text)`),
  );
}

export interface EnrolmentDeadLetter {
  jobId: string;
  businessId: string;
  kind: string;
  attempts: number;
  lastSqlstate: string | null;
  lastFailedAt: Date | null;
  deadLetteredAt: Date;
  requeueCount: number;
}

/** The dead-lettered enrolment candidates, for the operator (worker credential, 0229). */
export async function enrolmentDeadLetters(
  db: Db,
  options: { limit?: number; jobId?: string } = {},
): Promise<EnrolmentDeadLetter[]> {
  const jobId = options.jobId && UUID_TEXT.test(options.jobId) ? options.jobId : null;
  if (options.jobId !== undefined && jobId === null) return [];
  const rows = await db.execute<{
    job_id: string;
    business_id: string;
    kind: string;
    attempts: number;
    last_sqlstate: string | null;
    last_failed_at: string | null;
    dead_lettered_at: string;
    requeue_count: number;
  }>(
    sql`SELECT * FROM dead_job_enrolment_dead_letters(${options.limit ?? 200}::int, ${jobId}::uuid)`,
  );
  return [...rows].map((r) => ({
    jobId: r.job_id,
    businessId: r.business_id,
    kind: r.kind,
    attempts: r.attempts,
    lastSqlstate: r.last_sqlstate,
    lastFailedAt: r.last_failed_at ? new Date(r.last_failed_at) : null,
    deadLetteredAt: new Date(r.dead_lettered_at),
    requeueCount: r.requeue_count,
  }));
}

/** An operator's requeue of a dead-lettered candidate, audited (0229). False when it is not one. */
export async function requeueEnrolment(
  tx: TenantDb,
  input: { businessId: string; jobId: string; actor: string; reason: string },
): Promise<boolean> {
  const rows = await tx.execute<{ requeued: boolean }>(sql`
    SELECT dead_job_enrolment_requeue(${input.businessId}::uuid, ${input.jobId}::uuid,
                                      ${input.actor}, ${input.reason}) AS requeued`);
  return [...rows][0]?.requeued === true;
}

export interface JobRow {
  id: string;
  kind: string;
  state: string;
  attempts: number;
  lastError: string | null;
  /** The latest failure's fixed category (migration 0190), never error text. */
  failureCategory: string | null;
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
      failureCategory: jobs.failureCategory,
    })
    .from(jobs)
    .where(where)
    .orderBy(jobs.createdAt);
}

export interface QueueHealth {
  /** Jobs that exhausted their retries. Nothing retries these again, and nothing moves them out of `dead`. */
  dead: number;
  /** Jobs that died in the last 24 hours: what an alert can act on (G-26). */
  deadRecent: number;
  /** Waiting to run. A number that only grows means the worker is not. */
  pending: number;
  /** Seconds the OLDEST job that is DUE has waited. The worker-not-keeping-up alarm. */
  oldestPendingSeconds: number;
  /**
   * Seconds since the oldest still-pending job was QUEUED, due or not (G-63).
   * `oldestPendingSeconds` counts from `run_at`, which every retry pushes
   * forward, so a backlog that keeps being rescheduled reads as healthy.
   * `created_at` does not move.
   */
  oldestQueuedSeconds: number;
  running: number;
}

/**
 * The queue, in a handful of numbers (MASTER-PLAN §6.4). An approved
 * operational-monitoring aggregate (OWN-36, ADR 0035): counts and ages only,
 * never a business id or payload, read-only.
 *
 * Cross-tenant by construction and therefore worker-credentialed: "is
 * anything stuck" is a question about the platform, not about a business.
 * Dead jobs have been marked since the runner shipped and nothing has ever
 * been able to read them back, which is how a dead-letter queue becomes a
 * silence rather than an alert.
 */
export async function queueHealth(db: Db): Promise<QueueHealth> {
  const rows = await db.execute<{
    dead: number;
    dead_recent: number;
    pending: number;
    running: number;
    oldest_seconds: number | null;
    oldest_queued_seconds: number | null;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE state = 'dead')::int    AS dead,
      count(*) FILTER (WHERE state = 'dead'
                         AND updated_at > now() - interval '24 hours')::int AS dead_recent,
      count(*) FILTER (WHERE state = 'pending')::int AS pending,
      count(*) FILTER (WHERE state = 'running')::int AS running,
      EXTRACT(EPOCH FROM (now() - min(run_at) FILTER (WHERE state = 'pending')))::int
        AS oldest_seconds,
      EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE state = 'pending')))::int
        AS oldest_queued_seconds
    FROM jobs
  `);
  const row = [...rows][0];
  return {
    dead: row?.dead ?? 0,
    deadRecent: row?.dead_recent ?? 0,
    pending: row?.pending ?? 0,
    running: row?.running ?? 0,
    oldestPendingSeconds: Math.max(0, row?.oldest_seconds ?? 0),
    oldestQueuedSeconds: Math.max(0, row?.oldest_queued_seconds ?? 0),
  };
}
