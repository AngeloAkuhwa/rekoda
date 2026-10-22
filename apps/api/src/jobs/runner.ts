/**
 * The job runner (MASTER-PLAN 4.4 #3: "jobs must run inside `withBusiness`").
 *
 * The one idea worth understanding here is in `JobHandler`: a handler is
 * handed a `TenantDb` and nothing else. It has no route to the pool, so there
 * is no version of a handler that reads across tenants by forgetting
 * something. The runner does the pinning once, in one place, and the type
 * system carries the guarantee the rest of the way.
 *
 * Claiming and running use two different connections. The claim
 * connection holds the `rekoda_worker` credential, which is allowed to see any
 * tenant's job row because it must be — you cannot pin the tenant of a job you
 * have not read. Everything after the claim runs through the ordinary
 * application role under a tenant pin, so a handler is exactly as constrained
 * as a request.
 */
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { jobsRepo, withBusiness, type Db, type TenantDb } from '@rekoda/db';
import { redactForLog } from '@rekoda/core/privacy';

export interface JobContext {
  /** Already pinned to this job's tenant. The only database handle a handler gets. */
  tx: TenantDb;
  /** This job's queue row — what `JobDeferred` puts back. */
  jobId: string;
  businessId: string;
  payload: Record<string, unknown>;
  /** 1 on the first run. Handlers that talk to a provider use it to decide how loud to be. */
  attempt: number;
  /** The queue's ceiling for this job: a handler on its last attempt can
   * choose to record an outcome rather than die. */
  maxAttempts: number;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

/**
 * Thrown by a handler that found itself ahead of an older sibling it must not
 * overtake (see `jobsRepo.hasEarlierLiveJob`). Not a failure: the runner rolls
 * the transaction back, returns the job to the queue WITHOUT charging an
 * attempt, and lets the older job go first.
 */
export class JobDeferred extends Error {
  constructor(readonly delayMs = 500) {
    super('deferred behind an earlier job for this business');
  }
}

export interface RunnerOptions {
  /** Milliseconds to wait after finding an empty queue. */
  idleMs?: number;
  /** A `running` job untouched for this long is assumed orphaned and requeued. */
  stalledAfterMs?: number;
  /** Identifies which process holds a claim, in `locked_by`. */
  workerId?: string;
  /**
   * Claim loops running side by side in this process. `claimNext` is
   * `FOR UPDATE SKIP LOCKED`, so N loops take N different jobs by
   * construction; what this buys is that one twenty-second model call no
   * longer stalls every document delivery behind it. Bounded well under the
   * worker connection pool, because each in-flight job holds a claim
   * connection AND a pinned handler transaction.
   */
  concurrency?: number;
}

/**
 * Unknown job kinds are NOT errors to retry.
 *
 * A kind with no handler means a deploy removed one, or a rename went out in
 * the wrong order. Retrying cannot fix either, and five attempts of backoff
 * only delays the moment someone notices. It dies on the first attempt with a
 * message that names the kind.
 */
export class UnknownJobKind extends Error {
  constructor(readonly kind: string) {
    super(`no handler registered for job kind "${kind}"`);
  }
}

export class JobRunner {
  private readonly log = new Logger(JobRunner.name);
  private readonly handlers = new Map<string, JobHandler>();
  private readonly idleMs: number;
  private readonly stalledAfterMs: number;
  private readonly workerId: string;
  private reclaimTimer: NodeJS.Timeout | null = null;
  private readonly concurrency: number;
  private running = false;
  private loops: Promise<void>[] = [];

  constructor(
    /** `rekoda_worker` — the claim connection. */
    private readonly workerDb: Db,
    /** `rekoda_app` — where handlers actually run, pinned. */
    private readonly appDb: Db,
    options: RunnerOptions = {},
  ) {
    this.idleMs = options.idleMs ?? 1_000;
    this.stalledAfterMs = options.stalledAfterMs ?? 300_000;
    this.workerId = options.workerId ?? `worker-${process.pid}`;
    this.concurrency = Math.max(1, options.concurrency ?? 1);
  }

  register(kind: string, handler: JobHandler): this {
    if (this.handlers.has(kind)) throw new Error(`job kind "${kind}" is already registered`);
    this.handlers.set(kind, handler);
    return this;
  }

  /**
   * Run one job if one is due. Returns false when the queue was empty.
   *
   * Exposed rather than kept private because it is what the tests drive: a
   * polling loop tested through timers is a test of the timers.
   */
  async runOnce(): Promise<boolean> {
    /* One token per claim, not per process: every lane shares `workerId`, and a
     * reclaimed job claimed again must be told apart from the attempt that
     * lost it (G-10). The lease heartbeat and the completion both name it. */
    const claimedBy = `${this.workerId}:${randomUUID()}`;
    const job = await jobsRepo.claimNext(this.workerDb, claimedBy);
    if (!job) return false;

    const handler = this.handlers.get(job.kind);
    if (!handler) {
      await jobsRepo.markFailed(
        this.workerDb,
        { ...job, attempts: job.maxAttempts },
        new UnknownJobKind(job.kind).message,
        undefined,
        claimedBy,
      );
      this.log.error(`no handler for job kind "${job.kind}" — marked dead`);
      return true;
    }

    /* Renew the lease while the handler runs, so a long-running job is not
     * mistaken for one a crashed worker abandoned (G-10). A third of the
     * stall window leaves room for two missed beats. It runs on the worker
     * pool, tenant-pinned: handlers hold application-pool connections, and a
     * heartbeat queued behind them would stop beating exactly when handlers
     * are busiest. */
    const heartbeat = setInterval(
      () => {
        withBusiness(this.workerDb, job.businessId, (tx) =>
          jobsRepo.touch(tx, job.id, claimedBy),
        ).catch((error: unknown) => {
          this.log.warn(`job lease renewal failed: ${redactForLog(describeFailure(error))}`);
        });
      },
      Math.max(10, Math.floor(this.stalledAfterMs / 3)),
    );
    heartbeat.unref();
    try {
      try {
        /**
         * The handler's writes and the job's completion are one transaction.
         *
         * Split into two, a worker that dies in between leaves a job that
         * already did its work looking claimable — and the second run would
         * issue a second document, send a second WhatsApp message, or post a
         * second set of ledger entries. Committing them together makes "did this
         * job run?" a question the database answers.
         */
        await withBusiness(this.appDb, job.businessId, async (tx) => {
          await handler({
            tx,
            jobId: job.id,
            businessId: job.businessId,
            payload: job.payload,
            attempt: job.attempts,
            maxAttempts: job.maxAttempts,
          });
          await jobsRepo.markDone(tx, job.id, claimedBy);
        });
      } catch (error) {
        if (error instanceof jobsRepo.JobLeaseLost) {
          /* Another claim owns the job and this attempt's transaction already
           * rolled back, so nothing it wrote survives. Recording a failure here
           * would be a no-op under the fence and a false "will retry" in the
           * logs; it is simply discarded (G-10). */
          this.log.warn(`job ${job.kind} ${job.id} lost its lease; attempt discarded`);
          return true;
        }
        if (error instanceof JobDeferred) {
          // Stepping aside, not failing: back in the queue, attempt refunded.
          await jobsRepo.deferClaimed(this.workerDb, job.id, error.delayMs, claimedBy);
          return true;
        }
        // The transaction above rolled back, so nothing the handler wrote
        // survives. Recording the failure therefore has to happen on a
        // connection that is still usable — the worker's.
        const message = redactForLog(describeFailure(error));
        const outcome = await jobsRepo.markFailed(
          this.workerDb,
          job,
          message,
          undefined,
          claimedBy,
        );
        if (outcome.state === 'lost') {
          this.log.warn(`job ${job.kind} ${job.id} lost its lease; attempt discarded`);
          return true;
        }
        if (outcome.state === 'dead') {
          this.log.error(`job ${job.kind} exhausted ${job.maxAttempts} attempts: ${message}`);
        } else {
          this.log.warn(
            `job ${job.kind} failed on attempt ${job.attempts}, will retry: ${message}`,
          );
        }
      }
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  /** Requeue jobs whose worker died mid-run. */
  async reclaim(): Promise<number> {
    const n = await jobsRepo.reclaimStalled(this.workerDb, this.stalledAfterMs);
    if (n > 0) this.log.warn(`reclaimed ${n} stalled job(s)`);
    return n;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loops = Array.from({ length: this.concurrency }, () => this.poll());
    /* Reclaim has its own clock (G-10). Hung off a processing lane, it stopped
     * the moment that lane sat in a slow handler, and never ran at all while
     * the queue stayed busy. One timer per runner, so N lanes do not multiply
     * the sweeps. */
    const reclaimPass = (): void => {
      this.reclaim().catch((error: unknown) => {
        this.log.warn(`job reclaim failed: ${redactForLog(describeFailure(error))}`);
      });
    };
    /* Once at start too: a worker restarted more often than the stall window
     * would otherwise never reclaim what its predecessor left behind. */
    reclaimPass();
    this.reclaimTimer = setInterval(reclaimPass, this.stalledAfterMs);
    this.reclaimTimer.unref();
    this.log.log(
      `job runner started as ${this.workerId}` +
        (this.concurrency > 1 ? ` with ${this.concurrency} lanes` : ''),
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reclaimTimer) clearInterval(this.reclaimTimer);
    this.reclaimTimer = null;
    await Promise.all(this.loops);
    this.loops = [];
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        // Drains what is due before sleeping, so a burst is not paced at one
        // job per idle interval.
        const worked = await this.runOnce();
        if (!worked) await sleep(this.idleMs);
      } catch (error) {
        /**
         * The loop outlives its errors. A failure here is the queue itself
         * being unreachable — a database restart, a network blip — and a
         * runner that exits on one is a runner that stops delivering documents
         * until someone notices. Back off and try again.
         */
        this.log.error(`job runner loop error: ${redactForLog(describeFailure(error))}`);
        await sleep(this.idleMs * 5);
      }
    }
  }
}

/**
 * The reason a job failed, without the statement that failed.
 *
 * drizzle wraps every rejected query in a `DrizzleQueryError` whose message is
 * `Failed query: <the whole SQL>\nparams: <every bound value>`, with the
 * database's actual complaint demoted to `.cause`. Storing that verbatim is
 * wrong twice over: it names the statement rather than the reason, so
 * `last_error` reads "insert into products…" for a permissions problem, a
 * constraint violation and a dead connection alike — and the params are the
 * row we were trying to write. For a handler carrying a merchant's message
 * that is customer data, written in plaintext to a column the vault does not
 * cover and the privacy gateway never sees.
 *
 * So: walk the chain, skip the wrapper, keep what PostgreSQL said.
 */
export function describeFailure(error: unknown): string {
  const reasons: string[] = [];
  for (let current: unknown = error, depth = 0; current && depth < 10; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    if (!message.startsWith('Failed query:')) reasons.push(message);
    if (!(current instanceof Error)) break;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return reasons.join(' | ') || 'unknown error';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Unref'd so a sleeping runner never keeps the process alive at shutdown.
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  });
}
