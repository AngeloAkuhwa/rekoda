import {
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { type Db, type LockClient, jobsRepo } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB, WORKER_DB, WORKER_LOCK } from '../db/db.module.js';
import { AiModule } from '../ai/ai.module.js';
import { RepliesModule } from '../replies/replies.module.js';
import { ReplySender } from '../replies/reply.service.js';
import { Interpreter } from '../ai/interpreter.service.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { redactForLog } from '@rekoda/core/privacy';
import { JobQueue, JobKind } from './queue.service.js';
import { JobRunner, describeFailure } from './runner.js';
import { inboundMessageHandler, type InboundMessageDeps } from './inbound-message.handler.js';
import { customerMessageHandler } from './customer-message.handler.js';
import { renderDocumentHandler } from './render-document.handler.js';
import { deliverDocumentHandler } from './deliver-document.handler.js';
import { paymentLinkHandler } from './payment-link.handler.js';
import { graduationNudgeHandler } from './graduation-nudge.handler.js';
import { processPaymentEventHandler } from './process-payment-event.handler.js';
import { processBillingChargeHandler } from './process-billing-charge.handler.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PaymentIntentsService } from '../payments/payment-intents.service.js';
import { PAYMENT_PROVIDER, type PaymentProviderPort } from '../payments/provider.port.js';
import { pumpPaystackEvents } from '../payments/paystack-pump.js';
import { sweepSettlements } from '../payments/settlement-sweep.js';
import { sweepMerchantTransfers } from '../payments/merchant-transfer.service.js';
import { BankModule } from '../bank/bank.module.js';
import { BANK_FEED, type BankFeedPort } from '../bank/feed.port.js';
import { sweepBankFeeds } from '../bank/feed-sync.js';
import { sweepUnknownSenders } from '../channels/stranger-sweep.js';
import { sweepGracePeriods } from '../billing/grace-sweep.js';
import { AUDIO_METADATA_PROBE, type AudioMetadataProbe } from '../ai/audio-duration.js';
import { sweepRenewals } from '../billing/renewal-sweep.js';
import { sweepEvidence, sweepRetention } from '../privacy/retention-sweep.js';
import { sweepRecurring } from '../spend/recurring-sweep.js';
import { sweepDepreciation } from '../spend/depreciation-sweep.js';
import { OutboxDispatcher } from '../commands/outbox-dispatcher.js';
import { webhookFanOut, type OutboxFanOut } from '../webhooks/fan-out.js';
import { deliverWebhooks } from '../webhooks/delivery.sweep.js';
import { HttpWebhookSender } from '../webhooks/sender.js';
import { CommandsModule } from '../commands/commands.module.js';
import { CommandBus } from '../commands/command-bus.service.js';
import { MESSAGE_SENDER } from '../channels/sender.tokens.js';
import { WabaTemplateService } from '../channels/waba-templates.service.js';
import { CustomerThreadRouter } from '../channels/customer-route.service.js';
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
export interface RunnerDeps extends Omit<
  InboundMessageDeps,
  'db' | 'customerRoute' | 'customerTexts'
> {
  storage: DocumentStorage;
  sender: MessageSender;
  paymentProvider: PaymentProviderPort;
}

export function buildRunner(
  workerDb: Db,
  appDb: Db,
  deps: RunnerDeps,
  options?: { idleMs?: number; concurrency?: number },
): JobRunner {
  const runner = new JobRunner(workerDb, appDb, options);
  /* Constructed here rather than injected: buildRunner already holds every
   * dependency the service needs, and threading it through RunnerDeps would
   * make each test re-declare what this line derives. */
  const customerTexts = new WabaTemplateService(appDb, deps.config, deps.sender, deps.gateway);
  const customerRoute = new CustomerThreadRouter(deps.config);
  runner.register(
    JobKind.InboundMessage,
    inboundMessageHandler({ ...deps, db: appDb, customerTexts, customerRoute }),
  );
  runner.register(
    JobKind.CustomerMessage,
    customerMessageHandler({
      config: deps.config,
      gateway: deps.gateway,
      commandBus: deps.commandBus,
      commandPlaceOrder: deps.config.commandPlaceOrder,
      customerTexts,
      replySender: deps.replySender,
      db: appDb,
    }),
  );
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
    processPaymentEventHandler({
      provider: deps.paymentProvider,
      config: deps.config,
      commandBus: deps.commandBus,
    }),
  );
  runner.register(
    JobKind.ProcessBillingCharge,
    processBillingChargeHandler({ provider: deps.paymentProvider, config: deps.config }),
  );
  runner.register(
    JobKind.PaymentLink,
    paymentLinkHandler({
      paymentIntents: deps.paymentIntents,
      replySender: deps.replySender,
      customerTexts,
      customerRoute,
      db: appDb,
      config: deps.config,
    }),
  );
  runner.register(
    JobKind.GraduationNudge,
    graduationNudgeHandler({ replySender: deps.replySender, db: appDb }),
  );
  return runner;
}

/**
 * Builds the outbox dispatcher with every handler production registers.
 *
 * Exported for the same reason as `buildRunner`: the integration test runs
 * this function, not a parallel registry, so a handler present in one and
 * missing from the other cannot happen. Event types arrive with the commands
 * that emit them, each PR adding its `register` call here.
 */
export function buildOutboxDispatcher(fanOut: OutboxFanOut = async () => {}): OutboxDispatcher {
  const dispatcher = new OutboxDispatcher();

  /* Since PR-112 every handler is the SAME function: fan-out to whatever
   * the merchant subscribed. What differs between `sale.recorded` and
   * `period.closed` is the payload the command already wrote, not how it
   * reaches a subscriber, so a handler per type would be nineteen copies of
   * one idea. The registry stays explicit because it is also the LIST — an
   * event type absent from it fails and retries rather than vanishing.
   *
   * The default is the old empty body: a caller that passes no fan-out
   * delivers to nobody, which is what every command suite wants and what
   * production did before this PR. */
  dispatcher.register('sale.recorded', fanOut);
  dispatcher.register('invoice.issued', fanOut);

  /* PR-022's facts. */
  dispatcher.register('payment.recorded', fanOut);
  dispatcher.register('payment.confirmed', fanOut);

  /* PR-023's facts. */
  dispatcher.register('expense.recorded', fanOut);
  dispatcher.register('purchase.recorded', fanOut);

  /* PR-024's facts. */
  dispatcher.register('journal.posted', fanOut);
  dispatcher.register('period.closed', fanOut);

  /* PR-083's fact. */
  dispatcher.register('books.opened', fanOut);

  /* PR-088's facts: what validation decided, either way. */
  dispatcher.register('order.validated', fanOut);
  dispatcher.register('order.rejected', fanOut);

  /* PR-025's fact. */
  dispatcher.register('order.placed', fanOut);

  /* PR-026's facts. */
  dispatcher.register('financial_transactions.ingested', fanOut);
  dispatcher.register('reconciliation.confirmed', fanOut);

  /* PR-027's facts. */
  dispatcher.register('inventory.adjusted', fanOut);
  dispatcher.register('data.erased', fanOut);

  /* PR-028's facts. */
  dispatcher.register('invoice.voided', fanOut);
  dispatcher.register('period.reopened', fanOut);

  return dispatcher;
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
  private transferTimer: NodeJS.Timeout | null = null;
  private sweepingTransfers = false;
  private feedTimer: NodeJS.Timeout | null = null;
  private sweepingFeeds = false;
  private strangerTimer: NodeJS.Timeout | null = null;
  private greeting = false;
  private graceTimer: NodeJS.Timeout | null = null;
  private sweepingGrace = false;
  private renewalTimer: NodeJS.Timeout | null = null;
  private sweepingRenewals = false;
  private recurringTimer: NodeJS.Timeout | null = null;
  private sweepingRecurring = false;
  private depreciationTimer: NodeJS.Timeout | null = null;
  private sweepingDepreciation = false;
  private retentionTimer: NodeJS.Timeout | null = null;
  private sweepingRetention = false;
  private outboxTimer: NodeJS.Timeout | null = null;
  private dispatchingOutbox = false;
  private webhookTimer: NodeJS.Timeout | null = null;
  private sendingWebhooks = false;

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly appDb: Db,
    @Inject(WORKER_DB) private readonly workerDb: Db | null,
    @Inject(WORKER_LOCK) private readonly workerLock: LockClient | null,
    @Inject(PrivacyGateway) private readonly gateway: PrivacyGateway,
    @Inject(Interpreter) private readonly interpreter: Interpreter,
    @Inject(ReplySender) private readonly replySender: ReplySender,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    @Inject(MESSAGE_SENDER) private readonly sender: MessageSender,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProviderPort,
    @Inject(PaymentIntentsService) private readonly paymentIntents: PaymentIntentsService,
    @Inject(BANK_FEED) private readonly bankFeed: BankFeedPort,
    @Inject(SPEECH_TO_TEXT) private readonly stt: SpeechToText,
    @Inject(TEXT_EXTRACTION) private readonly ocr: TextExtraction,
    @Inject(AUDIO_METADATA_PROBE) private readonly audioProbe: AudioMetadataProbe,
    @Inject(CommandBus) private readonly commandBus: CommandBus,
  ) {}

  onModuleInit(): void {
    if (!this.config.workerEnabled || !this.workerDb) {
      this.log.log('job runner disabled for this process (REKODA_WORKER is not 1)');
      return;
    }
    const workerDb = this.workerDb;
    this.runner = buildRunner(
      workerDb,
      this.appDb,
      {
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
        audioProbe: this.audioProbe,
        commandBus: this.commandBus,
      },
      { concurrency: this.config.workerConcurrency },
    );
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
      this.exclusively('pump', () =>
        pumpPaystackEvents({ workerDb, appDb: this.appDb, vaultKey: this.config.vaultKey }),
      )
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
      this.exclusively('settlement', () =>
        sweepSettlements({ workerDb, appDb: this.appDb, provider: this.paymentProvider }),
      )
        .catch((error: unknown) => {
          this.log.warn(`settlement sweep failed: ${redactForLog(describeFailure(error))}`);
        })
        .finally(() => {
          this.sweeping = false;
        });
    }, 600_000);
    this.sweepTimer.unref();

    /**
     * The Pay-with-Transfer reconciliation poll (ADR 0019: never rely on
     * webhooks alone). Two minutes, because the person waiting on it is a
     * customer standing at a checkout, not a ledger: the on-demand status
     * check answers them in seconds and this sweep is the net underneath.
     * Live transfer intents are rare and short-lived, so most passes read
     * one worker query and stop.
     */
    this.transferTimer = setInterval(() => {
      if (this.sweepingTransfers) return;
      this.sweepingTransfers = true;
      this.exclusively('merchant-transfers', () =>
        sweepMerchantTransfers({
          workerDb,
          appDb: this.appDb,
          connectionKey: this.config.connectionKey,
          paystackBaseUrl: this.config.paystackBaseUrl,
          commandBus: this.commandBus,
          commandConfirmPayment: this.config.commandConfirmPayment,
        }),
      )
        .catch((error: unknown) => {
          this.log.warn(`transfer sweep failed: ${redactForLog(describeFailure(error))}`);
        })
        .finally(() => {
          this.sweepingTransfers = false;
        });
    }, 120_000);
    this.transferTimer.unref();

    /**
     * The bank-feed pull, every thirty minutes. Banks post in minutes but
     * reconciliation is a daily habit, so half an hour keeps the bank
     * column current without hammering the aggregator; the dashboard's
     * "pull now" button stays for the merchant who cannot wait. Skipped
     * entirely on a deployment with no aggregator key.
     */
    this.feedTimer = setInterval(() => {
      if (this.sweepingFeeds) return;
      this.sweepingFeeds = true;
      this.exclusively('bank-feeds', () =>
        sweepBankFeeds({
          workerDb,
          appDb: this.appDb,
          feed: this.bankFeed,
          commandBus: this.commandBus,
          commandIngestFinancialTransaction: this.config.commandIngestFinancialTransaction,
        }),
      )
        .catch((error: unknown) => {
          this.log.warn(`bank feed sweep failed: ${redactForLog(describeFailure(error))}`);
        })
        .finally(() => {
          this.sweepingFeeds = false;
        });
    }, 1_800_000);
    this.feedTimer.unref();

    /**
     * Answering strangers rides the same worker on a middle clock: fast
     * enough that someone who just messaged the number is not left waiting,
     * slow enough that it is not competing with the attribution pump for the
     * same small pool.
     */
    this.strangerTimer = setInterval(() => {
      if (this.greeting) return;
      this.greeting = true;
      this.exclusively('stranger', () =>
        sweepUnknownSenders({
          workerDb,
          sender: this.sender,
          vaultKey: this.config.vaultKey,
          matchKey: this.config.matchKey,
          metaPhoneNumberId: this.config.metaPhoneNumberId,
        }),
      )
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
      this.exclusively('grace', () =>
        sweepGracePeriods({
          workerDb,
          appDb: this.appDb,
          sender: this.sender,
          fxNairaPerUsd: this.config.planningFxNairaPerUsd,
        }),
      )
        .catch((error: unknown) => {
          this.log.warn(`grace sweep failed: ${redactForLog(describeFailure(error))}`);
        })
        .finally(() => {
          this.sweepingGrace = false;
        });
    }, 3_600_000);
    this.graceTimer.unref();

    /**
     * Renewals ride the same hourly clock as grace, and for the same reason:
     * a cycle ends at a moment, and a merchant should not keep paid features
     * for most of a day after theirs did.
     */
    this.renewalTimer = setInterval(() => {
      if (this.sweepingRenewals) return;
      this.sweepingRenewals = true;
      this.exclusively('renewal', () =>
        sweepRenewals({ workerDb, appDb: this.appDb, config: this.config }),
      )
        .catch((error: unknown) => {
          this.log.warn(`renewal sweep failed: ${redactForLog(describeFailure(error))}`);
        })
        .finally(() => {
          this.sweepingRenewals = false;
        });
    }, 3_600_000);
    this.renewalTimer.unref();

    /**
     * Retention runs slowest of all, because its unit is a month. Six hours
     * is far more often than the answer can change and still means a record
     * never outlives its schedule by more than a fraction of a day.
     */
    this.retentionTimer = setInterval(() => {
      if (this.sweepingRetention) return;
      this.sweepingRetention = true;
      this.exclusively('retention', () =>
        sweepRetention({
          workerDb,
          appDb: this.appDb,
          sender: this.sender,
          fxNairaPerUsd: this.config.planningFxNairaPerUsd,
        }).then(async (swept) => {
          /* The evidence clocks ride the same timer: one schedule, one
           * heartbeat, and the page that publishes both periods is describing
           * one sweep pass rather than two that can drift apart. */
          await sweepEvidence({ workerDb, appDb: this.appDb });
          return swept;
        }),
      )
        .catch((error: unknown) => {
          this.log.warn(`retention sweep failed: ${redactForLog(describeFailure(error))}`);
        })
        .finally(() => {
          this.sweepingRetention = false;
        });
    }, 21_600_000);
    this.retentionTimer.unref();

    /**
     * Repeating costs share the hourly clock with grace and renewals, and for
     * a different reason: their unit is a DAY, so hourly is already far more
     * often than the answer can change. What it buys is the first hour of the
     * Lagos day rather than whenever a nightly job happened to be scheduled,
     * so a merchant who opens the dashboard on the 1st sees their rent.
     */
    this.recurringTimer = setInterval(() => {
      if (this.sweepingRecurring) return;
      this.sweepingRecurring = true;
      this.exclusively('recurring', () =>
        sweepRecurring({
          workerDb,
          appDb: this.appDb,
          commandBus: this.commandBus,
          commandRecordExpense: this.config.commandRecordExpense,
        }),
      )
        .catch((error: unknown) => {
          this.log.warn(`recurring sweep failed: ${redactForLog(describeFailure(error))}`);
        })
        .finally(() => {
          this.sweepingRecurring = false;
        });
    }, 3_600_000);
    this.recurringTimer.unref();

    /**
     * Wear on the equipment, on the same hourly clock and for the same
     * reason: the unit is a MONTH, so hourly is far more often than the
     * answer can change, and what it buys is that a merchant opening the
     * dashboard sees the charge rather than waiting for a nightly job.
     *
     * Without this the balance sheet would hold a generator at its full price
     * forever, which is a new misstatement in place of the old one.
     */
    this.depreciationTimer = setInterval(() => {
      if (this.sweepingDepreciation) return;
      this.sweepingDepreciation = true;
      this.exclusively('depreciation', () => sweepDepreciation({ workerDb, appDb: this.appDb }))
        .catch((error: unknown) => {
          this.log.warn(`depreciation sweep failed: ${redactForLog(describeFailure(error))}`);
        })
        .finally(() => {
          this.sweepingDepreciation = false;
        });
    }, 3_600_000);
    this.depreciationTimer.unref();

    /**
     * The outbox rides the pump's fast clock, because what it carries is a
     * consequence somebody committed and is now waiting on. The lease
     * (`FOR UPDATE SKIP LOCKED` plus `reclaimStalled`) already makes
     * concurrent dispatchers safe, so no advisory lock here: every replica
     * drains, and adding workers speeds delivery instead of wasting passes —
     * the batch claim is one query when the table is empty, which is almost
     * always.
     */
    const dispatcher = buildOutboxDispatcher(webhookFanOut(workerDb));
    this.outboxTimer = setInterval(() => {
      if (this.dispatchingOutbox) return;
      this.dispatchingOutbox = true;
      dispatcher
        .runOnce(workerDb)
        .catch((error: unknown) => {
          this.log.warn(`outbox pass failed: ${redactForLog(describeFailure(error))}`);
        })
        .finally(() => {
          this.dispatchingOutbox = false;
        });
    }, 2_000);
    this.outboxTimer.unref();

    /**
     * Sending what fan-out queued (PR-112).
     *
     * Its own timer rather than a step inside the dispatcher, because the
     * send is a request to an address a merchant chose: a slow endpoint
     * inside the outbox pass would dam every other merchant's facts behind
     * one merchant's outage. Five seconds, and no advisory lock for the
     * same reason the outbox has none — the lease makes concurrent senders
     * safe, so extra replicas speed delivery instead of wasting passes.
     */
    const webhookSender = new HttpWebhookSender();
    this.webhookTimer = setInterval(() => {
      if (this.sendingWebhooks) return;
      this.sendingWebhooks = true;
      deliverWebhooks({
        worker: workerDb,
        vaultKey: this.config.vaultKey,
        sender: webhookSender,
        planCatalogueReads: this.config.planCatalogueReads,
      })
        .catch((error: unknown) => {
          this.log.warn(`webhook pass failed: ${redactForLog(describeFailure(error))}`);
        })
        .finally(() => {
          this.sendingWebhooks = false;
        });
    }, 5_000);
    this.webhookTimer.unref();
  }

  /**
   * One replica runs a given sweep at a time.
   *
   * Every timer below fires on every worker replica, and while the claims
   * inside each sweep are individually race-safe, N replicas doing identical
   * passes is N times the database load for exactly one replica's worth of
   * progress — and adding workers to speed the queue up multiplied the waste.
   * A transaction-scoped advisory lock elects a leader per sweep per pass;
   * the losers skip and try again next tick, so a dead leader is replaced by
   * whoever fires next. No configuration and nothing to clean up.
   */
  private async exclusively(name: string, work: () => Promise<unknown>): Promise<void> {
    const lock = this.workerLock;
    if (!lock) return;
    await jobsRepo.runExclusively(lock, name, work);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    if (this.graceTimer) clearInterval(this.graceTimer);
    if (this.renewalTimer) clearInterval(this.renewalTimer);
    if (this.recurringTimer) clearInterval(this.recurringTimer);
    if (this.depreciationTimer) clearInterval(this.depreciationTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.transferTimer) clearInterval(this.transferTimer);
    if (this.feedTimer) clearInterval(this.feedTimer);
    if (this.strangerTimer) clearInterval(this.strangerTimer);
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    if (this.webhookTimer) clearInterval(this.webhookTimer);
    await this.runner?.stop();
  }
}

@Module({
  imports: [AiModule, RepliesModule, DocumentsModule, PaymentsModule, BankModule, CommandsModule],
  providers: [JobQueue, JobRunnerLifecycle, PrivacyGateway],
  exports: [JobQueue, PrivacyGateway],
})
export class JobsModule {}
