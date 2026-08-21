import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { type Db } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB, WORKER_DB } from '../db/db.module.js';
import { AiModule } from '../ai/ai.module.js';
import { RepliesModule } from '../replies/replies.module.js';
import { ReplySender } from '../replies/reply.service.js';
import { Interpreter } from '../ai/interpreter.service.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { redactForLog } from '@rekoda/core/privacy';
import { JobQueue, JobKind } from './queue.service.js';
import { JobRunner, describeFailure } from './runner.js';
import { inboundMessageHandler, type InboundMessageDeps } from './inbound-message.handler.js';
import { renderDocumentHandler } from './render-document.handler.js';
import { deliverDocumentHandler } from './deliver-document.handler.js';
import { processPaymentEventHandler } from './process-payment-event.handler.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PaymentIntentsService } from '../payments/payment-intents.service.js';
import { PAYMENT_PROVIDER, type PaymentProviderPort } from '../payments/provider.port.js';
import { pumpPaystackEvents } from '../payments/paystack-pump.js';
import { sweepSettlements } from '../payments/settlement-sweep.js';
import { sweepUnknownSenders } from '../channels/stranger-sweep.js';
import { sweepGracePeriods } from '../billing/grace-sweep.js';
import { sweepRetention } from '../privacy/retention-sweep.js';
import { MESSAGE_SENDER } from '../channels/sender.tokens.js';
import { SPEECH_TO_TEXT, type SpeechToText } from '../ai/stt.js';
import { TEXT_EXTRACTION, type TextExtraction } from '../ai/ocr.js';
import type { MessageSender } from '../channels/sender.js';
import { DocumentsModule, DOCUMENT_STORAGE } from '../documents/documents.module.js';
import type { DocumentStorage } from '../documents/storage.js';

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
export interface RunnerDeps extends Omit<InboundMessageDeps, 'db'> {
  storage: DocumentStorage;
  sender: MessageSender;
  paymentProvider: PaymentProviderPort;
}

export function buildRunner(
  workerDb: Db,
  appDb: Db,
  deps: RunnerDeps,
  options?: { idleMs?: number },
): JobRunner {
  const runner = new JobRunner(workerDb, appDb, options);
  runner.register(JobKind.InboundMessage, inboundMessageHandler({ ...deps, db: appDb }));
  runner.register(
    JobKind.RenderDocument,
    renderDocumentHandler({ storage: deps.storage, db: appDb }),
  );
  runner.register(
    JobKind.DeliverDocument,
    deliverDocumentHandler({
      storage: deps.storage,
      sender: deps.sender,
      db: appDb,
      config: deps.config,
    }),
  );
  runner.register(
    JobKind.ProcessPaymentEvent,
    processPaymentEventHandler({ provider: deps.paymentProvider, config: deps.config }),
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
  private pumpTimer: NodeJS.Timeout | null = null;
  private pumping = false;
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private strangerTimer: NodeJS.Timeout | null = null;
  private greeting = false;
  private graceTimer: NodeJS.Timeout | null = null;
  private sweepingGrace = false;
  private retentionTimer: NodeJS.Timeout | null = null;
  private sweepingRetention = false;

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly appDb: Db,
    @Inject(WORKER_DB) private readonly workerDb: Db | null,
    @Inject(PrivacyGateway) private readonly gateway: PrivacyGateway,
    @Inject(Interpreter) private readonly interpreter: Interpreter,
    @Inject(ReplySender) private readonly replySender: ReplySender,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    @Inject(MESSAGE_SENDER) private readonly sender: MessageSender,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProviderPort,
    @Inject(PaymentIntentsService) private readonly paymentIntents: PaymentIntentsService,
    @Inject(SPEECH_TO_TEXT) private readonly stt: SpeechToText,
    @Inject(TEXT_EXTRACTION) private readonly ocr: TextExtraction,
  ) {}

  onModuleInit(): void {
    if (!this.config.workerEnabled || !this.workerDb) {
      this.log.log('job runner disabled for this process (REKODA_WORKER is not 1)');
      return;
    }
    const workerDb = this.workerDb;
    this.runner = buildRunner(workerDb, this.appDb, {
      gateway: this.gateway,
      interpreter: this.interpreter,
      replySender: this.replySender,
      storage: this.storage,
      sender: this.sender,
      config: this.config,
      paymentProvider: this.paymentProvider,
      paymentIntents: this.paymentIntents,
      stt: this.stt,
      ocr: this.ocr,
    });
    this.runner.start();

    /**
     * The attribution pump rides the same worker credential on its own small
     * interval. `pumping` makes passes non-overlapping — a slow database must
     * never stack pump runs — and the timer is unref'd so a shutting-down
     * process is not held open by attribution nobody will act on.
     */
    this.pumpTimer = setInterval(() => {
      if (this.pumping) return;
      this.pumping = true;
      pumpPaystackEvents({ workerDb, appDb: this.appDb, vaultKey: this.config.vaultKey })
        .catch((error: unknown) => {
          // Same discipline as the runner: the reason, never the statement
          // or its bound values, and redacted like everything else logged.
          this.log.warn(`paystack pump pass failed: ${redactForLog(describeFailure(error))}`);
        })
        .finally(() => {
          this.pumping = false;
        });
    }, 2_000);
    this.pumpTimer.unref();

    /**
     * The settlement sweep rides the same credentials on a much slower
     * clock: Paystack settles in daily batches, so ten minutes is prompt
     * without hammering GET /settlement. Same non-overlap guard, same
     * unref, same log discipline as the pump.
     */
    this.sweepTimer = setInterval(() => {
      if (this.sweeping) return;
      this.sweeping = true;
      sweepSettlements({ workerDb, appDb: this.appDb, provider: this.paymentProvider })
        .catch((error: unknown) => {
          this.log.warn(`settlement sweep failed: ${redactForLog(describeFailure(error))}`);
        })
        .finally(() => {
          this.sweeping = false;
        });
    }, 600_000);
    this.sweepTimer.unref();

    /**
     * Answering strangers rides the same worker on a middle clock: fast
     * enough that someone who just messaged the number is not left waiting,
     * slow enough that it is not competing with the attribution pump for the
     * same small pool.
     */
    this.strangerTimer = setInterval(() => {
      if (this.greeting) return;
      this.greeting = true;
      sweepUnknownSenders({
        workerDb,
        sender: this.sender,
        vaultKey: this.config.vaultKey,
        matchKey: this.config.matchKey,
      })
        .catch((error: unknown) => {
          this.log.warn(`stranger sweep failed: ${redactForLog(describeFailure(error))}`);
        })
        .finally(() => {
          this.greeting = false;
        });
    }, 20_000);
    this.strangerTimer.unref();

    /**
     * Grace runs on the slowest clock of the four. Its unit is a DAY, so
     * asking hourly is already far more often than the answer can change,
     * and a merchant whose card failed at 3am is reminded that morning
     * rather than the following one.
     */
    this.graceTimer = setInterval(() => {
      if (this.sweepingGrace) return;
      this.sweepingGrace = true;
      sweepGracePeriods({ workerDb, appDb: this.appDb, sender: this.sender })
        .catch((error: unknown) => {
          this.log.warn(`grace sweep failed: ${redactForLog(describeFailure(error))}`);
        })
        .finally(() => {
          this.sweepingGrace = false;
        });
    }, 3_600_000);
    this.graceTimer.unref();

    /**
     * Retention runs slowest of all, because its unit is a month. Six hours
     * is far more often than the answer can change and still means a record
     * never outlives its schedule by more than a fraction of a day.
     */
    this.retentionTimer = setInterval(() => {
      if (this.sweepingRetention) return;
      this.sweepingRetention = true;
      sweepRetention({ workerDb, appDb: this.appDb, sender: this.sender })
        .catch((error: unknown) => {
          this.log.warn(`retention sweep failed: ${redactForLog(describeFailure(error))}`);
        })
        .finally(() => {
          this.sweepingRetention = false;
        });
    }, 21_600_000);
    this.retentionTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    if (this.graceTimer) clearInterval(this.graceTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.strangerTimer) clearInterval(this.strangerTimer);
    await this.runner?.stop();
  }
}

@Module({
  imports: [AiModule, RepliesModule, DocumentsModule, PaymentsModule],
  providers: [JobQueue, JobRunnerLifecycle, PrivacyGateway],
  exports: [JobQueue, PrivacyGateway],
})
export class JobsModule {}
