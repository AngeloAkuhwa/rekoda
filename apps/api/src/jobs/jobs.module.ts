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
import { AiModule } from '../ai/ai.module.js';
import { RepliesModule } from '../replies/replies.module.js';
import { ReplySender } from '../replies/reply.service.js';
import { Interpreter } from '../ai/interpreter.service.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { JobQueue, JobKind } from './queue.service.js';
import { JobRunner } from './runner.js';
import { inboundMessageHandler, type InboundMessageDeps } from './inbound-message.handler.js';
import { renderDocumentHandler } from './render-document.handler.js';
import { deliverDocumentHandler } from './deliver-document.handler.js';
import { MESSAGE_SENDER } from '../channels/sender.tokens.js';
import type { MessageSender } from '../channels/sender.js';
import { DocumentsModule, DOCUMENT_STORAGE } from '../documents/documents.module.js';
import type { DocumentStorage } from '../documents/storage.js';

export const JOB_RUNNER = Symbol('JobRunner');

/**
 * Builds the runner and its handler registry.
 *
 * Exported so integration tests can construct exactly what production runs
 * rather than a parallel arrangement that drifts from it — a test registry
 * missing a handler is a test that proves nothing about the deploy.
 */
/**
 * Everything the registry's handlers need, in one type.
 *
 * Named rather than inlined so tests declare the same thing production does —
 * a test whose deps type drifts from `buildRunner`'s is a test that stops
 * covering a handler the moment one is added.
 */
export interface RunnerDeps extends InboundMessageDeps {
  storage: DocumentStorage;
  sender: MessageSender;
}

export function buildRunner(
  workerDb: Db,
  appDb: Db,
  deps: RunnerDeps,
  options?: { idleMs?: number },
): JobRunner {
  const runner = new JobRunner(workerDb, appDb, options);
  runner.register(JobKind.InboundMessage, inboundMessageHandler(deps));
  runner.register(
    JobKind.RenderDocument,
    renderDocumentHandler({ storage: deps.storage, db: appDb }),
  );
  runner.register(
    JobKind.DeliverDocument,
    deliverDocumentHandler({ storage: deps.storage, sender: deps.sender, db: appDb }),
  );
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
    @Inject(Interpreter) private readonly interpreter: Interpreter,
    @Inject(ReplySender) private readonly replySender: ReplySender,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    @Inject(MESSAGE_SENDER) private readonly sender: MessageSender,
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
      interpreter: this.interpreter,
      replySender: this.replySender,
      storage: this.storage,
      sender: this.sender,
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
  imports: [AiModule, RepliesModule, DocumentsModule],
  providers: [JobQueue, JobRunnerLifecycle, PrivacyGateway],
  exports: [JobQueue, PrivacyGateway],
})
export class JobsModule {}
