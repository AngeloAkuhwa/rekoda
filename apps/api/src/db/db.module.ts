import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@rekoda/db';
import { CONFIG, loadConfig, type ApiConfig } from '../config.js';

export const DB = Symbol('Db');
const DB_HANDLE = Symbol('DbHandle');

interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

/** Drains the pool on shutdown, holding it by injection rather than a global. */
@Injectable()
class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
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
    DbLifecycle,
  ],
  exports: [CONFIG, DB],
})
export class DbModule {}
