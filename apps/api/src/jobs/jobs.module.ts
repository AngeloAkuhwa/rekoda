import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { createDb, type Db } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { JobQueue, JobKind } from './queue.service.js';
import { JobRunner } from './runner.js';
import { inboundMessageHandler, type InboundMessageDeps } from './inbound-message.handler.js';

export const JOB_RUNNER = Symbol('JobRunner');

/**
 * Builds the runner and its handler registry.
 *
 * Exported so integration tests can construct exactly what production runs
 * rather than a parallel arrangement that drifts from it — a test registry
 * missing a handler is a test that proves nothing about the deploy.
 */
export function buildRunner(
  workerDb: Db,
  appDb: Db,
  deps: InboundMessageDeps,
  options?: { idleMs?: number },
): JobRunner {
  const runner = new JobRunner(workerDb, appDb, options);
  runner.register(JobKind.InboundMessage, inboundMessageHandler(deps));
  return runner;
}

/**
 * Starts the runner only when this process is meant to be a worker.
 *
 * One image, two roles, chosen by environment: the API and the worker deploy
 * from the same build, so a handler cannot be present in one and missing from
 * the other. In development a single process does both (`REKODA_WORKER=1`);
 * in production they scale apart.
 */
@Injectable()
class JobRunnerLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(JobRunnerLifecycle.name);
  private runner: JobRunner | null = null;
  private closeWorkerDb: (() => Promise<void>) | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly appDb: Db,
    @Inject(PrivacyGateway) private readonly gateway: PrivacyGateway,
  ) {}

  onModuleInit(): void {
    if (!this.config.workerEnabled || !this.config.workerDatabaseUrl) {
      this.log.log('job runner disabled for this process (REKODA_WORKER is not 1)');
      return;
    }
    // A small pool: the claim query is one statement and the work happens on
    // the application connection.
    const handle = createDb(this.config.workerDatabaseUrl, { max: 2 });
    this.closeWorkerDb = handle.close;
    this.runner = buildRunner(handle.db, this.appDb, {
      gateway: this.gateway,
      config: this.config,
    });
    this.runner.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.runner?.stop();
    await this.closeWorkerDb?.();
  }
}

@Module({
  providers: [JobQueue, JobRunnerLifecycle, PrivacyGateway],
  exports: [JobQueue, PrivacyGateway],
})
export class JobsModule {}
