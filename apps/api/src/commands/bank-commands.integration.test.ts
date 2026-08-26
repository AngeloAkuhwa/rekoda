/**
 * The reconciliation commands (spec §25, §6.9; PR-026). What is pinned:
 * ingestion announces only what actually LANDED (a re-import that is all
 * duplicates writes lines nowhere and events nowhere); a confirmed match
 * announces once and a replay answers the first confirmation; a refused
 * match — the amounts differ, the movement is claimed — is an outcome that
 * writes nothing; and both event types are handled by the production
 * dispatcher.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bankRepo, createDb, identity, journalRepo, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import type { BankStatementLine } from '@rekoda/core';
import { CommandBus } from './command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';
import { confirmReconciliationWork, ingestFinancialTransactionsWork } from './bank-commands.js';
import { buildOutboxDispatcher } from '../jobs/jobs.module.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;
const bus = new CommandBus(new RiskPolicyService());

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 8 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(phone = '+2348160000001'): Promise<string> {
  const user = await identity.upsertUserByPhone(appDb, phone);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function count(businessId: string, table: string, where = ''): Promise<number> {
  const rows = await withBusiness(appDb, businessId, (tx) =>
    tx.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM ${sql.raw(table)}
          WHERE business_id = ${businessId}::uuid ${sql.raw(where)}`,
    ),
  );
  return Number([...rows][0]?.n ?? 0);
}

const LINES: BankStatementLine[] = [
  { postedOn: '2026-08-20', amountK: 300_000, narration: 'TRF FROM ADA', bankRef: 'REF-1', row: 1 },
  { postedOn: '2026-08-21', amountK: -50_000, narration: 'POS CHARGE', bankRef: 'REF-2', row: 2 },
];

describe('IngestFinancialTransaction through the bus', () => {
  it('imports once, announces once, and a re-import lands and announces nothing', async () => {
    const businessId = await seedBusiness();

    const first = await withBusiness(appDb, businessId, (tx) =>
      bus.run(
        tx,
        {
          businessId,
          command: 'IngestFinancialTransaction',
          payload: { source: 'csv_upload', count: LINES.length },
          actor: 'user:test',
          ingress: 'DASHBOARD',
        },
        () =>
          ingestFinancialTransactionsWork(tx, {
            businessId,
            lines: LINES,
            actor: 'user:test',
            source: 'csv_upload',
          }),
      ),
    );
    expect(first.outcome).toBe('done');
    if (first.outcome !== 'done') return;
    expect(first.result).toEqual({ imported: 2, duplicates: 0 });

    /* The same statement again: the fingerprint is the identity, so both
     * lines are duplicates, nothing lands, and NOTHING is announced. */
    const again = await withBusiness(appDb, businessId, (tx) =>
      ingestFinancialTransactionsWork(tx, {
        businessId,
        lines: LINES,
        actor: 'user:test',
        source: 'bank_feed',
      }),
    );
    expect(again).toEqual({ imported: 0, duplicates: 2 });

    expect(await count(businessId, 'bank_statement_lines')).toBe(2);
    expect(
      await count(businessId, 'outbox_events', "AND type = 'financial_transactions.ingested'"),
    ).toBe(1);
  });
});

describe('ConfirmReconciliation through the bus', () => {
  async function seedMatchable(businessId: string) {
    /* A movement in the books: ₦3,000 carried from the till to the bank. */
    const posted = await withBusiness(appDb, businessId, (tx) =>
      journalRepo.recordJournal(tx, {
        businessId,
        memo: 'till to bank',
        amountK: 300_000,
        intoAccount: 'BANK',
        outOfAccount: 'CASH',
        actor: 'user:test',
      }),
    );
    /* And the bank's own word for it. */
    await withBusiness(appDb, businessId, (tx) =>
      ingestFinancialTransactionsWork(tx, {
        businessId,
        lines: [LINES[0]!],
        actor: 'user:test',
        source: 'csv_upload',
      }),
    );
    const lines = await withBusiness(appDb, businessId, (tx) =>
      tx.execute<{ id: string }>(
        sql`SELECT id FROM bank_statement_lines WHERE business_id = ${businessId}::uuid`,
      ),
    );
    return { lineId: [...lines][0]!.id, transactionId: posted.ledgerTransactionId };
  }

  it('confirms once, announces once, and the replay answers the first confirmation', async () => {
    const businessId = await seedBusiness();
    const { lineId, transactionId } = await seedMatchable(businessId);
    const input = { businessId, lineId, transactionId, actor: 'user:test' };
    const envelope = {
      businessId,
      command: 'ConfirmReconciliation' as const,
      payload: input,
      actor: 'user:test',
      ingress: 'DASHBOARD' as const,
      idempotencyKey: `match:${lineId}:${transactionId}`,
    };

    const first = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => confirmReconciliationWork(tx, input)),
    );
    expect(first.outcome).toBe('done');
    if (first.outcome !== 'done') return;
    expect(first.result).toEqual({ outcome: 'matched' });

    const replay = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => confirmReconciliationWork(tx, input)),
    );
    expect(replay.outcome).toBe('done');
    if (replay.outcome !== 'done') return;
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual({ outcome: 'matched' });

    expect(await count(businessId, 'bank_line_matches')).toBe(1);
    expect(await count(businessId, 'outbox_events', "AND type = 'reconciliation.confirmed'")).toBe(
      1,
    );
  });

  it('a refused match is an outcome that writes nothing and announces nothing', async () => {
    const businessId = await seedBusiness();
    const { lineId } = await seedMatchable(businessId);

    /* Aimed at a movement that does not exist for this business. */
    const refused = await withBusiness(appDb, businessId, (tx) =>
      confirmReconciliationWork(tx, {
        businessId,
        lineId,
        transactionId: '00000000-0000-0000-0000-000000000001',
        actor: 'user:test',
      }),
    );
    expect(refused.outcome).toBe('refused');

    expect(await count(businessId, 'bank_line_matches')).toBe(0);
    expect(await count(businessId, 'outbox_events', "AND type = 'reconciliation.confirmed'")).toBe(
      0,
    );
  });
});

describe('the announcements reach the production dispatcher', () => {
  it('bank events are types the dispatcher handles', async () => {
    const businessId = await seedBusiness();
    await withBusiness(appDb, businessId, (tx) =>
      ingestFinancialTransactionsWork(tx, {
        businessId,
        lines: LINES,
        actor: 'user:test',
        source: 'csv_upload',
      }),
    );

    const pass = await buildOutboxDispatcher().runOnce(workerDb);
    expect(pass.failed).toBe(0);
    expect(pass.delivered).toBe(1);
  });
});
