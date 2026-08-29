/**
 * One feed sync, callable from two places (fix-plan 4 G5 follow-through).
 *
 * The dashboard button and the background sweep are the same operation and
 * must stay one code path: same cursor arithmetic, same overlap, same
 * import through the CSV door, same honest outcomes. The controller shapes
 * these outcomes into HTTP; the sweep just counts them.
 */
import { Logger } from '@nestjs/common';
import { lagosDay } from '@rekoda/core';
import { bankRepo, withBusiness, type Db } from '@rekoda/db';
import type { Ingress } from '@rekoda/core';
import { MonoApiError } from './mono.provider.js';
import type { BankFeedPort } from './feed.port.js';
import type { CommandBus } from '../commands/command-bus.service.js';
import {
  ingestFinancialTransactionsWork,
  type IngestFinancialTransactionsInput,
} from '../commands/bank-commands.js';

/**
 * How far back the FIRST sync reaches. Ninety days is what aggregators
 * reliably hold and what a merchant starting to reconcile actually wants;
 * further history arrives the way it always has, by statement upload.
 */
const FIRST_SYNC_DAYS = 90;
/**
 * How far behind the cursor each later sync re-covers. Banks post late and
 * clocks disagree; the fingerprint dedupe makes the overlap free, so the
 * safe direction costs nothing.
 */
const SYNC_OVERLAP_DAYS = 5;

export type FeedSyncOutcome =
  | { outcome: 'not_configured' }
  | { outcome: 'not_linked' }
  /** Access lapsed provider-side; the row is marked and the page explains. */
  | { outcome: 'unlinked' }
  /** The aggregator would not answer. Nothing changed; try again later. */
  | { outcome: 'provider_down' }
  | { outcome: 'synced'; imported: number; duplicates: number; since: string };

/**
 * Pull what moved since the cursor, through the SAME import the CSV upload
 * uses: same fingerprint, same dedupe, same reconciliation afterwards.
 * Nothing downstream knows which door a line came through.
 *
 * The fetch runs OUTSIDE any transaction: a slow aggregator must never hold
 * a database transaction hostage. The overlap between syncs is deliberate
 * and free — see SYNC_OVERLAP_DAYS.
 */
export async function syncFeedOnce(
  deps: {
    db: Db;
    feed: BankFeedPort;
    /** The one bus every ingress converges on (spec §25). */
    commandBus: CommandBus;
    /** The A1 rollout flag for `IngestFinancialTransaction`. */
    commandIngestFinancialTransaction: boolean;
  },
  businessId: string,
  actor: string,
  /** Which door asked: the dashboard button or the background sweep. */
  ingress: Ingress = 'AUTOMATION',
): Promise<FeedSyncOutcome> {
  if (!deps.feed.configured) return { outcome: 'not_configured' };

  const connection = await withBusiness(deps.db, businessId, (tx) =>
    bankRepo.feedConnectionFor(tx, businessId),
  );
  if (!connection || connection.status !== 'linked') return { outcome: 'not_linked' };

  const today = lagosDay(new Date());
  const since = connection.lastSyncedOn
    ? lagosDay(new Date(Date.parse(connection.lastSyncedOn) - SYNC_OVERLAP_DAYS * 86_400_000))
    : lagosDay(new Date(Date.now() - FIRST_SYNC_DAYS * 86_400_000));

  let fetched;
  try {
    fetched = await deps.feed.fetchTransactions(connection.accountRef, since);
  } catch (error) {
    if (error instanceof MonoApiError) return { outcome: 'provider_down' };
    throw error;
  }
  if (fetched.state === 'unlinked') {
    await withBusiness(deps.db, businessId, (tx) =>
      bankRepo.markFeedUnlinked(tx, businessId, actor),
    );
    return { outcome: 'unlinked' };
  }

  const stored = await withBusiness(deps.db, businessId, async (tx) => {
    const input: IngestFinancialTransactionsInput = {
      businessId,
      /* `row` exists so a CSV's skipped row can be named; a feed has no
       * rows, so the position in the fetch stands in. It is not part of
       * the fingerprint, so it can never split a duplicate. */
      lines: fetched.transactions.map((t, i) => ({ ...t, row: i + 1 })),
      actor,
      source: 'bank_feed',
      /* §22.3: the lines carry the identity of the connection that
       * produced them. */
      connectionId: connection.id,
    };
    /* The A1 rollout seam (spec §25): the same import the CSV door takes,
     * through the same command. No idempotency key — the fingerprint dedupe
     * IS the import's identity, and a retried pull counts duplicates. */
    let result: Awaited<ReturnType<typeof ingestFinancialTransactionsWork>>;
    if (deps.commandIngestFinancialTransaction) {
      const run = await deps.commandBus.run(
        tx,
        {
          businessId,
          command: 'IngestFinancialTransaction',
          payload: { source: input.source, count: input.lines.length },
          actor,
          ingress,
        },
        () => ingestFinancialTransactionsWork(tx, input),
      );
      if (run.outcome !== 'done') {
        throw new Error(`IngestFinancialTransaction refused unexpectedly: ${run.outcome}`);
      }
      result = run.result;
    } else {
      result = await ingestFinancialTransactionsWork(tx, input);
    }
    await bankRepo.markFeedSynced(tx, businessId, today);
    return result;
  });
  return { outcome: 'synced', imported: stored.imported, duplicates: stored.duplicates, since };
}

export interface FeedSweepDeps {
  /** `rekoda_worker` — lists linked feeds across tenants, nothing else. */
  workerDb: Db;
  /** `rekoda_app` — every sync runs under a tenant pin. */
  appDb: Db;
  feed: BankFeedPort;
  /** The one bus every ingress converges on (spec §25). */
  commandBus: CommandBus;
  /** The A1 rollout flag for `IngestFinancialTransaction`. */
  commandIngestFinancialTransaction: boolean;
}

const sweepLog = new Logger('BankFeedSweep');

/**
 * The background pull. Statement lines should arrive because time passed,
 * not because somebody remembered a button: reconciliation is only honest
 * against a bank column that is actually current. The button stays for the
 * merchant who wants NOW; this sweep is the floor under it.
 */
export async function sweepBankFeeds(deps: FeedSweepDeps): Promise<number> {
  if (!deps.feed.configured) return 0;
  const linked = await bankRepo.linkedFeedBusinesses(deps.workerDb);
  let imported = 0;
  for (const { businessId } of linked) {
    try {
      const outcome = await syncFeedOnce(
        {
          db: deps.appDb,
          feed: deps.feed,
          commandBus: deps.commandBus,
          commandIngestFinancialTransaction: deps.commandIngestFinancialTransaction,
        },
        businessId,
        'system:bank-feed',
        'AUTOMATION',
      );
      if (outcome.outcome === 'synced') imported += outcome.imported;
      /* `unlinked` marks its own row inside syncFeedOnce; the page tells
       * the merchant. `provider_down` waits for the next pass. */
    } catch (error) {
      /* One business's poisoned feed must not stop the sweep for the rest. */
      sweepLog.warn(
        `feed sweep skipped a business: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
  return imported;
}
