/**
 * The ledger commands (spec §25; PR-024), proved on the two shapes of
 * refusal the module deliberately keeps apart: `ClosePeriod` refuses in
 * OUTCOMES that write nothing (so the claim completes and replays), while
 * `PostJournal` THROWS `PeriodClosed` — the journal number is minted before
 * the period gate, and only a rollback keeps the numbering dense. The test
 * for the throw asserts the whole transaction vanished: no posting, no
 * event, no idempotency claim.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRepo, createDb, identity, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { CommandBus } from './command-bus.service.js';
import { RiskPolicyService } from '../risk/risk-policy.service.js';
import {
  closePeriodWork,
  postJournalWork,
  type ClosePeriodInput,
  type PostJournalInput,
} from './ledger-commands.js';
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

const journalInput = (businessId: string, clientRef = 'jform-1'): PostJournalInput => ({
  businessId,
  memo: 'till to bank',
  amountK: 300_000,
  intoAccount: 'BANK',
  outOfAccount: 'CASH',
  actor: 'user:test',
  clientRef,
});

describe('PostJournal through the bus', () => {
  it('posts once, announces, and the replay writes nothing', async () => {
    const businessId = await seedBusiness();
    const input = journalInput(businessId);
    const envelope = {
      businessId,
      command: 'PostJournal' as const,
      payload: input,
      actor: 'user:test',
      ingress: 'DASHBOARD' as const,
      idempotencyKey: 'journal:jform-1',
    };

    const first = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => postJournalWork(tx, input)),
    );
    expect(first.outcome).toBe('done');
    if (first.outcome !== 'done') return;
    expect(first.result.journalNumber).toMatch(/^JNL-/);

    const replay = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => postJournalWork(tx, input)),
    );
    expect(replay.outcome).toBe('done');
    if (replay.outcome !== 'done') return;
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);

    expect(await count(businessId, 'ledger_transactions')).toBe(1);
    expect(await count(businessId, 'outbox_events', "AND type = 'journal.posted'")).toBe(1);
  });

  it('a journal aimed at a closed month rolls back whole: no posting, no event, no claim', async () => {
    const businessId = await seedBusiness();
    await withBusiness(appDb, businessId, (tx) =>
      closeRepo.closeBooks(tx, { businessId, through: '2026-07', actor: 'user:test' }),
    );

    const input: PostJournalInput = {
      ...journalInput(businessId, 'jform-closed'),
      occurredAt: new Date('2026-07-15T11:00:00Z'),
    };

    await expect(
      withBusiness(appDb, businessId, (tx) =>
        bus.run(
          tx,
          {
            businessId,
            command: 'PostJournal',
            payload: input,
            actor: 'user:test',
            ingress: 'DASHBOARD',
            idempotencyKey: 'journal:jform-closed',
          },
          () => postJournalWork(tx, input),
        ),
      ),
    ).rejects.toThrow(closeRepo.PeriodClosed);

    /* The whole transaction vanished — which is what keeps the journal
     * numbering dense and the claim table free of a key that answered
     * nothing. */
    expect(await count(businessId, 'ledger_transactions')).toBe(0);
    expect(await count(businessId, 'outbox_events')).toBe(0);
    expect(await count(businessId, 'idempotency_records')).toBe(0);
  });
});

describe('ClosePeriod through the bus', () => {
  it('closes, announces, and a repeat answers already_closed writing nothing new', async () => {
    const businessId = await seedBusiness();
    const input: ClosePeriodInput = { businessId, through: '2026-07', actor: 'user:test' };
    const envelope = {
      businessId,
      command: 'ClosePeriod' as const,
      payload: input,
      actor: 'user:test',
      ingress: 'DASHBOARD' as const,
    };

    const first = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => closePeriodWork(tx, input)),
    );
    expect(first.outcome).toBe('done');
    if (first.outcome !== 'done') return;
    expect(first.result).toEqual({ outcome: 'closed', through: '2026-07' });

    const again = await withBusiness(appDb, businessId, (tx) =>
      bus.run(tx, envelope, () => closePeriodWork(tx, input)),
    );
    expect(again.outcome).toBe('done');
    if (again.outcome !== 'done') return;
    expect(again.result).toEqual({ outcome: 'already_closed', through: '2026-07' });

    /* One close, one announcement: the truthful replay wrote no second
     * event. */
    expect(await count(businessId, 'outbox_events', "AND type = 'period.closed'")).toBe(1);
  });

  it('refuses to close the month still receiving entries, writing nothing', async () => {
    const businessId = await seedBusiness();
    const current = new Date().toISOString().slice(0, 7);
    const refused = await withBusiness(appDb, businessId, (tx) =>
      closePeriodWork(tx, { businessId, through: current, actor: 'user:test' }),
    );
    expect(refused).toEqual({ outcome: 'not_ended' });
    expect(await count(businessId, 'outbox_events')).toBe(0);
  });
});

describe('the announcements reach the production dispatcher', () => {
  it('ledger events are types the dispatcher handles', async () => {
    const businessId = await seedBusiness();
    await withBusiness(appDb, businessId, async (tx) => {
      await postJournalWork(tx, journalInput(businessId, 'jform-d'));
      await closePeriodWork(tx, { businessId, through: '2026-06', actor: 'user:test' });
    });

    const pass = await buildOutboxDispatcher().runOnce(workerDb);
    expect(pass.failed).toBe(0);
    expect(pass.delivered).toBe(2);
  });
});
