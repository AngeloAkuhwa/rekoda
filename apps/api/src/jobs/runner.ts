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
import { Logger } from '@nestjs/common';
import { jobsRepo, withBusiness, type Db, type TenantDb } from '@rekoda/db';
import { redactForLog } from '@rekoda/core/privacy';

export interface JobContext {
  /** Already pinned to this job's tenant. The only database handle a handler gets. */
  tx: TenantDb;
  businessId: string;
  payload: Record<string, unknown>;
  /** 1 on the first run. Handlers that talk to a provider use it to decide how loud to be. */
  attempt: number;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export interface RunnerOptions {
  /** Milliseconds to wait after finding an empty queue. */
  idleMs?: number;
  /** A `running` job untouched for this long is assumed orphaned and requeued. */
  stalledAfterMs?: number;
  /** Identifies which process holds a claim, in `locked_by`. */
  workerId?: string;
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
  private running = false;
  private loop: Promise<void> | null = null;

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
    const job = await jobsRepo.claimNext(this.workerDb, this.workerId);
    if (!job) return false;

    const handler = this.handlers.get(job.kind);
    if (!handler) {
      await jobsRepo.markFailed(
        this.workerDb,
        { ...job, attempts: job.maxAttempts },
        new UnknownJobKind(job.kind).message,
      );
      this.log.error(`no handler for job kind "${job.kind}" — marked dead`);
      return true;
    }

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
          businessId: job.businessId,
          payload: job.payload,
          attempt: job.attempts,
        });
        await jobsRepo.markDone(tx, job.id);
      });
    } catch (error) {
      // The transaction above rolled back, so nothing the handler wrote
      // survives. Recording the failure therefore has to happen on a
      // connection that is still usable — the worker's.
      const message = redactForLog(describeFailure(error));
      const outcome = await jobsRepo.markFailed(this.workerDb, job, message);
      if (outcome.state === 'dead') {
        this.log.error(`job ${job.kind} exhausted ${job.maxAttempts} attempts: ${message}`);
      } else {
        this.log.warn(`job ${job.kind} failed on attempt ${job.attempts}, will retry: ${message}`);
      }
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
    this.loop = this.poll();
    this.log.log(`job runner started as ${this.workerId}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    this.loop = null;
  }

  private async poll(): Promise<void> {
    let sinceReclaim = 0;
    while (this.running) {
      try {
        // Drains what is due before sleeping, so a burst is not paced at one
        // job per idle interval.
        const worked = await this.runOnce();
        if (!worked) {
          sinceReclaim += this.idleMs;
          if (sinceReclaim >= this.stalledAfterMs) {
            sinceReclaim = 0;
            await this.reclaim();
          }
          await sleep(this.idleMs);
        }
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
