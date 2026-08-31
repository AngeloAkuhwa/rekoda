/**
 * The bank's half of a reconciliation.
 *
 * Its own surface rather than another few methods on the reports controller,
 * because it answers a different question. Reports say what Rekoda's books
 * believe; this says what a merchant's bank says happened, and the value of
 * holding both is that they sometimes disagree.
 *
 * Thin, like the reports controller: the parsing is pure and lives in
 * @rekoda/core, the storage is one repo call, and `businessId` comes from the
 * session and never from a body.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { lagosDay, parseBankStatement } from '@rekoda/core';
import {
  bankPositionResponse,
  connectBankFeedRequest,
  forgetStatementDayRequest,
  importStatementRequest,
  type BankFeedStateResponse,
  type BankPositionResponse,
  type ConnectBankFeedResponse,
  type ForgetStatementDayResponse,
  type ImportStatementResponse,
  type ReconcileResponse,
  type SyncBankFeedResponse,
  matchLineRequest,
  unmatchLineRequest,
  classifyLineRequest,
  classifyLineResponse,
  type ClassifyLineResponse,
  type MatchLineResponse,
  type UnmatchLineResponse,
} from '@rekoda/contracts';
import { bankRepo, withBusiness, type Db } from '@rekoda/db';
import { SessionGuard, type AuthedRequest } from '../auth/session.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import { DB } from '../db/db.module.js';
import { CONFIG, type ApiConfig } from '../config.js';
import { BANK_FEED, type BankFeedPort } from './feed.port.js';
import { MonoApiError } from './mono.provider.js';
import { syncFeedOnce } from './feed-sync.js';
import { CommandBus } from '../commands/command-bus.service.js';
import {
  ClassificationRaced,
  confirmReconciliationWork,
  ingestFinancialTransactionsWork,
  prepareClassification,
  type ConfirmReconciliationInput,
  type IngestFinancialTransactionsInput,
} from '../commands/bank-commands.js';
import { postJournalWork } from '../commands/ledger-commands.js';

/**
 * How much of the statement the page carries.
 *
 * Not a display nicety: this page exists so a merchant can pair lines by
 * hand, and a line that is not in this response cannot be paired at all. It
 * was a hundred, which left a shop importing a hundred and thirty lines with
 * thirty they could not reach, and ordering alone does not save them: on a
 * first reconciliation every line is unmatched and there is nothing settled
 * to drop. Five hundred covers a year of moderate trading, and the rule
 * behind the automatic button already reads five thousand.
 */
const STATEMENT_ROWS = 500;

@Controller('v1/bank')
@UseGuards(SessionGuard, RolesGuard)
export class BankController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BANK_FEED) private readonly feed: BankFeedPort,
    @Inject(CONFIG) private readonly config: ApiConfig,
    private readonly commandBus: CommandBus,
  ) {}

  /** What the books say against what the bank says, and the lines behind it. */
  @Get('position')
  async position(@Req() request: AuthedRequest): Promise<BankPositionResponse> {
    const businessId = request.auth!.businessId;
    const { position, lines, reconciliation, openMovements, matches } = await withBusiness(
      this.db,
      businessId,
      async (tx) => {
        /* Unmatched first as well, which is what keeps the cap sane once a
         * merchant HAS settled some: work ahead of history. */
        const statementLines = await bankRepo.bankLinesFor(tx, businessId, STATEMENT_ROWS, {
          unmatchedFirst: true,
        });
        return {
          position: await bankRepo.bankPositionFor(tx, businessId),
          lines: statementLines,
          /* Read without committing. Opening a page must not decide anything,
           * and pairing is a decision the merchant asks for. */
          reconciliation: await bankRepo.reconcile(tx, { businessId, commit: false }),
          /* Only the amounts these lines could pair with. The page narrows
           * candidates to a line's exact amount, and asking for a page of
           * movements and filtering it left a merchant with no candidate at
           * all whenever the entry they wanted sat outside that page. */
          openMovements: await bankRepo.openMovements(tx, businessId, {
            amounts: statementLines.map((l) => l.amountK),
          }),
          matches: await bankRepo.matchesFor(
            tx,
            businessId,
            statementLines.map((l) => l.id),
          ),
        };
      },
    );
    const matchedBy = new Map(matches.map((m) => [m.lineId, m]));
    /* Parsed on the way out as well as on the way in. The contract is the
     * border that says which fields may cross at all, and it is the reason
     * a reader that started handing back the bank's words again would fail
     * here rather than on somebody's screen. */
    return bankPositionResponse.parse({
      position,
      reconciliation,
      openMovements,
      lines: lines.map((line) => {
        const match = matchedBy.get(line.id);
        return {
          ...line,
          matchedTo: match
            ? {
                transactionId: match.transactionId,
                memo: match.memo,
                decidedBy: match.decidedBy,
                tier: match.tier,
                reason: match.reason,
              }
            : null,
        };
      }),
    });
  }

  /**
   * Read a statement and keep what it said.
   *
   * The file arrives as text: the web tier already has the bytes when a
   * merchant picks a file, so converting them there keeps this a JSON
   * surface with no multipart parser and no temporary files.
   *
   * A file that cannot be read is an outcome rather than a 400. There are
   * six different ways a statement can be unreadable and the merchant needs
   * to be told which, not handed a status code.
   */
  /* Reconciliation is accountant work: importing, pairing and unpairing
   annotate the statement without moving money, so both roles may do it.
   Forgetting a day DELETES rows, and deletions are the owner's. */
  @Post('statement')
  @Roles('owner', 'accountant')
  @HttpCode(200)
  async importStatement(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<ImportStatementResponse> {
    const parsed = importStatementRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('the statement file, as text');

    const statement = parseBankStatement(parsed.data.csv);
    if (!statement.ok) return { outcome: 'unreadable', reason: statement.reason };

    const businessId = request.auth!.businessId;
    const input: IngestFinancialTransactionsInput = {
      businessId,
      lines: statement.lines,
      actor: `user:${request.auth!.userId}`,
      source: 'csv_upload',
    };
    /* The A1 rollout seam (spec §25). No idempotency key — the fingerprint
     * dedupe IS the import's identity, and a re-upload counts duplicates. */
    const stored = await withBusiness(this.db, businessId, async (tx) => {
      if (this.config.commandIngestFinancialTransaction) {
        const run = await this.commandBus.run(
          tx,
          {
            businessId,
            command: 'IngestFinancialTransaction',
            payload: { source: input.source, count: input.lines.length },
            actor: input.actor,
            ingress: 'DASHBOARD',
          },
          () => ingestFinancialTransactionsWork(tx, input),
        );
        if (run.outcome !== 'done') {
          throw new Error(`IngestFinancialTransaction refused unexpectedly: ${run.outcome}`);
        }
        return run.result;
      }
      return ingestFinancialTransactionsWork(tx, input);
    });
    return {
      outcome: 'imported',
      imported: stored.imported,
      duplicates: stored.duplicates,
      skipped: statement.skipped.length,
    };
  }

  /**
   * Pair what can only be paired one way.
   *
   * A write, and asked for rather than done on a page load. The rule itself
   * is timid on purpose: exact amounts, a few days either side, and nothing
   * paired where two postings fit. A wrong match reports agreement between
   * books and bank that does not exist, which is the failure this whole
   * surface was built to catch.
   */
  @Post('reconcile')
  @Roles('owner', 'accountant')
  @HttpCode(200)
  async reconcile(@Req() request: AuthedRequest): Promise<ReconcileResponse> {
    const businessId = request.auth!.businessId;
    return withBusiness(this.db, businessId, (tx) =>
      bankRepo.reconcile(tx, { businessId, commit: true }),
    );
  }

  /**
   * A merchant deciding what the rule would not.
   *
   * Two of the rule's conditions are lifted: which of two identical
   * transfers this one is, and how long ago it happened, are things a person
   * knows and a rule cannot. The amount is not lifted. Two figures a bank
   * charge apart are two facts, and the refusal says so rather than papering
   * over the charge inside a match.
   */
  @Post('match')
  @Roles('owner', 'accountant')
  @HttpCode(200)
  async match(@Req() request: AuthedRequest, @Body() body: unknown): Promise<MatchLineResponse> {
    const parsed = matchLineRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('a line and an entry to pair it with');

    const businessId = request.auth!.businessId;
    const input: ConfirmReconciliationInput = {
      businessId,
      lineId: parsed.data.lineId,
      transactionId: parsed.data.transactionId,
      actor: `user:${request.auth!.userId}`,
      /* §22.1 tier 4: a reason is always recorded. Until the screen grows
       * the field (PR-076), the door itself is the honest sentence. */
      reason: parsed.data.reason || 'Paired by hand on the reconciliation screen',
    };
    /* The A1 rollout seam (spec §25). STANDARD, and stays STANDARD: this
     * door only pairs what the rule left open — `matchByHand` refuses any
     * line or movement a match already claims, so nothing deterministic is
     * ever overruled here (Appendix D.2's override row has no ingress until
     * PR-028's confirmation UI). Refusals are outcomes that write nothing. */
    return withBusiness(this.db, businessId, async (tx) => {
      if (this.config.commandConfirmReconciliation) {
        const run = await this.commandBus.run(
          tx,
          {
            businessId,
            command: 'ConfirmReconciliation',
            payload: input,
            actor: input.actor,
            ingress: 'DASHBOARD',
            idempotencyKey: `match:${input.lineId}:${input.transactionId}`,
          },
          () => confirmReconciliationWork(tx, input),
        );
        if (run.outcome !== 'done') {
          throw new Error(`ConfirmReconciliation refused unexpectedly: ${run.outcome}`);
        }
        return run.result;
      }
      return confirmReconciliationWork(tx, input);
    });
  }

  /**
   * Release a pairing.
   *
   * An automatic match on the wrong posting has to be undoable, or the rule's
   * timidity is the only protection a merchant has. Releasing changes neither
   * the line nor the posting: neither was ever altered by being matched.
   */
  @Post('unmatch')
  @Roles('owner', 'accountant')
  @HttpCode(200)
  async unmatch(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<UnmatchLineResponse> {
    const parsed = unmatchLineRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('the line to release');

    const businessId = request.auth!.businessId;
    const released = await withBusiness(this.db, businessId, (tx) =>
      bankRepo.unmatchLine(tx, {
        businessId,
        lineId: parsed.data.lineId,
        actor: `user:${request.auth!.userId}`,
      }),
    );
    return { released };
  }

  /**
   * The live feed's standing state, for the card the bank page renders
   * (fix-plan 4, G5). A read that decides nothing, like `position`.
   */
  /**
   * §22.2's WHEN: "the merchant classifies it as owner capital" — or a
   * supplier refund, or their own cash moving. ONE transaction posts the
   * journal that judgement implies (dated the day the bank says the money
   * moved) and pairs it with the line, through the same two §25 commands a
   * person doing it stepwise would use, so the audit trail reads
   * identically. A race after the pre-check rolls the WHOLE thing back: a
   * journal existing without its line would be a silent judgement.
   */
  @Post('classify')
  @Roles('owner', 'accountant')
  @HttpCode(200)
  async classify(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<ClassifyLineResponse> {
    const parsed = classifyLineRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('a line and what that money was');

    const businessId = request.auth!.businessId;
    const actor = `user:${request.auth!.userId}`;
    try {
      return await withBusiness(this.db, businessId, async (tx) => {
        const prepared = await prepareClassification(tx, {
          businessId,
          lineId: parsed.data.lineId,
          classification: parsed.data.classification,
          note: parsed.data.note ?? null,
          actor,
        });
        if (prepared.outcome === 'refused') return classifyLineResponse.parse(prepared);

        const posted = this.config.commandPostJournal
          ? await this.runCommand(
              tx,
              businessId,
              'PostJournal',
              `classify-journal:${parsed.data.lineId}`,
              actor,
              { lineId: parsed.data.lineId, classification: parsed.data.classification },
              () => postJournalWork(tx, prepared.journal),
            )
          : await postJournalWork(tx, prepared.journal);

        const matchInput: ConfirmReconciliationInput = {
          businessId,
          lineId: parsed.data.lineId,
          transactionId: posted.ledgerTransactionId,
          actor,
          reason: prepared.reason,
        };
        const paired = this.config.commandConfirmReconciliation
          ? await this.runCommand(
              tx,
              businessId,
              'ConfirmReconciliation',
              `classify-match:${parsed.data.lineId}`,
              actor,
              matchInput,
              () => confirmReconciliationWork(tx, matchInput),
            )
          : await confirmReconciliationWork(tx, matchInput);
        if (paired.outcome !== 'matched') throw new ClassificationRaced(paired.reason);

        return classifyLineResponse.parse({
          outcome: 'classified',
          journalNumber: posted.journalNumber,
        });
      });
    } catch (error) {
      if (error instanceof ClassificationRaced) {
        return classifyLineResponse.parse({
          outcome: 'refused',
          reason: 'line_already_matched',
        });
      }
      throw error;
    }
  }

  /** The §25 seam, once: run one command through the bus inside the open
   * transaction, refusing loudly if the bus refuses. */
  private async runCommand<T>(
    tx: Parameters<typeof confirmReconciliationWork>[0],
    businessId: string,
    command: 'PostJournal' | 'ConfirmReconciliation',
    idempotencyKey: string,
    actor: string,
    payload: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    const run = await this.commandBus.run(
      tx,
      { businessId, command, payload, actor, ingress: 'DASHBOARD', idempotencyKey },
      work,
    );
    if (run.outcome !== 'done') {
      throw new Error(`${command} refused unexpectedly: ${run.outcome}`);
    }
    return run.result;
  }

  @Get('feed')
  async feedState(@Req() request: AuthedRequest): Promise<BankFeedStateResponse> {
    if (!this.feed.configured) return { state: 'not_configured' };
    const businessId = request.auth!.businessId;
    const connection = await withBusiness(this.db, businessId, (tx) =>
      bankRepo.feedConnectionFor(tx, businessId),
    );
    if (!connection) return { state: 'not_linked' };
    if (connection.status !== 'linked') {
      return {
        state: 'lapsed',
        bankName: connection.bankName,
        accountLast4: connection.accountLast4,
      };
    }
    return {
      state: 'linked',
      bankName: connection.bankName,
      accountLast4: connection.accountLast4,
      lastSyncedOn: connection.lastSyncedOn,
    };
  }

  /**
   * Exchange the aggregator's one-time code for a standing link.
   *
   * The owner's act, like every connection to an outside service: the code
   * came out of a consent flow the MERCHANT completed at their own bank, and
   * Rekoda never saw credentials. Re-linking after a lapse is the same call.
   */
  @Post('feed/connect')
  @Roles('owner')
  @HttpCode(200)
  async connectFeed(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<ConnectBankFeedResponse> {
    const parsed = connectBankFeedRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('the code the bank widget handed back');
    if (!this.feed.configured) return { outcome: 'not_configured' };

    let linked;
    try {
      linked = await this.feed.linkAccount(parsed.data.exchangeCode);
    } catch (error) {
      if (error instanceof MonoApiError) {
        throw new ServiceUnavailableException(
          'The bank connection service did not answer. Try again shortly.',
        );
      }
      throw error;
    }
    if (linked.state === 'rejected') return { outcome: 'rejected', reason: linked.reason };

    const businessId = request.auth!.businessId;
    await withBusiness(this.db, businessId, (tx) =>
      bankRepo.linkFeed(tx, {
        businessId,
        provider: this.feed.providerType,
        accountRef: linked.accountRef,
        bankName: linked.bankName,
        accountLast4: linked.accountLast4,
        actor: `user:${request.auth!.userId}`,
      }),
    );
    return { outcome: 'linked', bankName: linked.bankName, accountLast4: linked.accountLast4 };
  }

  /**
   * Pull what moved since the cursor, through the SAME import the CSV upload
   * uses: same fingerprint, same dedupe, same reconciliation afterwards.
   * Nothing downstream knows which door a line came through, which is the
   * whole design.
   *
   * The fetch runs BEFORE the transaction opens: a slow aggregator must
   * never hold a database transaction hostage. The overlap between syncs is
   * deliberate and free — see SYNC_OVERLAP_DAYS.
   */
  @Post('feed/sync')
  @Roles('owner', 'accountant')
  @HttpCode(200)
  async syncFeed(@Req() request: AuthedRequest): Promise<SyncBankFeedResponse> {
    const outcome = await syncFeedOnce(
      {
        db: this.db,
        feed: this.feed,
        commandBus: this.commandBus,
        commandIngestFinancialTransaction: this.config.commandIngestFinancialTransaction,
      },
      request.auth!.businessId,
      `user:${request.auth!.userId}`,
      'DASHBOARD',
    );
    if (outcome.outcome === 'provider_down') {
      throw new ServiceUnavailableException(
        'The bank connection service did not answer. Try again shortly.',
      );
    }
    return outcome;
  }

  /**
   * Take a day back out.
   *
   * A merchant who uploaded the wrong account's statement has to be able to
   * undo it, and there is no honest way to edit a line into being right: a
   * statement line is what the bank said.
   */
  @Post('statement/forget')
  @Roles('owner')
  @HttpCode(200)
  async forgetDay(
    @Req() request: AuthedRequest,
    @Body() body: unknown,
  ): Promise<ForgetStatementDayResponse> {
    const parsed = forgetStatementDayRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException('the day to forget');

    const businessId = request.auth!.businessId;
    const removed = await withBusiness(this.db, businessId, (tx) =>
      bankRepo.forgetStatementDay(tx, {
        businessId,
        postedOn: parsed.data.postedOn,
        actor: `user:${request.auth!.userId}`,
      }),
    );
    return { removed };
  }
}
