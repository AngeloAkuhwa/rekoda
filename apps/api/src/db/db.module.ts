import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@rekoda/db';
import { CONFIG, loadConfig, type ApiConfig } from '../config.js';

export const DB = Symbol('Db');
/**
 * The `rekoda_worker` pool, or null in a process that was given no worker
 * credential. Cross-tenant reads live here and nowhere else.
 */
export const WORKER_DB = Symbol('WorkerDb');
const DB_HANDLE = Symbol('DbHandle');
const WORKER_DB_HANDLE = Symbol('WorkerDbHandle');

interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

/** Drains the pools on shutdown, holding them by injection rather than a global. */
@Injectable()
class DbLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    @Inject(WORKER_DB_HANDLE) private readonly worker: DbHandle | null,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
    await this.worker?.close();
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
     * Small on purpose. The runner claims with one statement and does the
     * work on the application connection; everything else here is a poll.
     */
    {
      provide: WORKER_DB_HANDLE,
      inject: [CONFIG],
      useFactory: (config: ApiConfig): DbHandle | null =>
        config.workerDatabaseUrl ? createDb(config.workerDatabaseUrl, { max: 3 }) : null,
    },
    {
      provide: WORKER_DB,
      inject: [WORKER_DB_HANDLE],
      useFactory: (handle: DbHandle | null): Db | null => handle?.db ?? null,
    },
    DbLifecycle,
  ],
  exports: [CONFIG, DB, WORKER_DB],
})
export class DbModule {}
