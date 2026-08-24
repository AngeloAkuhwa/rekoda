import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, createLockClient, type Db, type LockClient } from '@rekoda/db';
import { CONFIG, loadConfig, type ApiConfig } from '../config.js';

export const DB = Symbol('Db');
/**
 * The `rekoda_worker` pool, or null in a process that was given no worker
 * credential. Cross-tenant reads live here and nowhere else.
 */
export const WORKER_DB = Symbol('WorkerDb');
/**
 * A dedicated pool that holds background-sweep advisory locks and nothing
 * else, on the worker credential. Kept apart from WORKER_DB so a held lock
 * never competes with the query it guards for a connection (see
 * `withAdvisoryLock`). Null without a worker credential.
 */
export const WORKER_LOCK = Symbol('WorkerLock');
const DB_HANDLE = Symbol('DbHandle');
const WORKER_DB_HANDLE = Symbol('WorkerDbHandle');
const WORKER_LOCK_HANDLE = Symbol('WorkerLockHandle');

interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

interface LockHandle {
  client: LockClient;
  close: () => Promise<void>;
}

/** Drains the pools on shutdown, holding them by injection rather than a global. */
@Injectable()
class DbLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    @Inject(WORKER_DB_HANDLE) private readonly worker: DbHandle | null,
    @Inject(WORKER_LOCK_HANDLE) private readonly lock: LockHandle | null,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
    await this.worker?.close();
    await this.lock?.close();
  }
}

/**
 * The one place a connection pool is created.
 *
 * Everything else receives `Db` by injection and reaches the database only
 * through `@rekoda/db` repositories, which are the only code allowed to pin a
 * tenant. The ESLint `no-restricted-imports` rule in the root config is what
 * keeps that true (MASTER-PLAN 4.4 #1) — without it `withBusiness` is a
 * convention rather than a guarantee.
 */
@Global()
@Module({
  providers: [
    { provide: CONFIG, useFactory: (): ApiConfig => loadConfig() },
    {
      provide: DB_HANDLE,
      inject: [CONFIG],
      useFactory: (config: ApiConfig): DbHandle => createDb(config.databaseUrl),
    },
    {
      provide: DB,
      inject: [DB_HANDLE],
      useFactory: (handle: DbHandle): Db => handle.db,
    },
    /**
     * Opened whenever the credential exists, not only when this process runs
     * jobs: reading the queue and answering "is anything stuck" needs the
     * cross-tenant role even in a process that never claims a job.
     *
     * The runner claims with one statement and does the work on the
     * application connection; most of what runs here is a poll. But each
     * live sweep now reserves ONE connection to hold its session-level
     * advisory lock (see `withAdvisoryLock`) while its body reads on other
     * connections from this same pool, and several sweeps share the hourly
     * clock. Sized above that concurrency so the leader-elected passes run
     * in parallel instead of queueing on `reserve()`; still small enough to
     * stay well within a managed Postgres connection budget per replica.
     */
    {
      provide: WORKER_DB_HANDLE,
      inject: [CONFIG],
      useFactory: (config: ApiConfig): DbHandle | null =>
        config.workerDatabaseUrl ? createDb(config.workerDatabaseUrl, { max: 8 }) : null,
    },
    {
      provide: WORKER_DB,
      inject: [WORKER_DB_HANDLE],
      useFactory: (handle: DbHandle | null): Db | null => handle?.db ?? null,
    },
    {
      /**
       * A small pool: it only ever holds sweep locks, one connection per
       * concurrently-running sweep, and there are a handful of sweeps. Kept
       * off the working pool so a lock can never starve the query it guards.
       */
      provide: WORKER_LOCK_HANDLE,
      inject: [CONFIG],
      useFactory: (config: ApiConfig): LockHandle | null =>
        config.workerDatabaseUrl ? createLockClient(config.workerDatabaseUrl, 4) : null,
    },
    {
      provide: WORKER_LOCK,
      inject: [WORKER_LOCK_HANDLE],
      useFactory: (handle: LockHandle | null): LockClient | null => handle?.client ?? null,
    },
    DbLifecycle,
  ],
  exports: [CONFIG, DB, WORKER_DB, WORKER_LOCK],
})
export class DbModule {}
