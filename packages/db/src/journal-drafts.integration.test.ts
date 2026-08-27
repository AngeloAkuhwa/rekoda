/**
 * The editable pair and the posting act (spec §9.1, §9.2; PR-041): a draft
 * is a proposal that may be edited and refused without consequence; posting
 * is validate → one atomic INSERT → immutable forever, exactly once per
 * draft — and the dashboard's one-step journal leaves a posted draft
 * behind, so the approval trail exists for every hand-made entry.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  accountsRepo,
  createDb,
  identity,
  journalDraftsRepo,
  journalRepo,
  sql,
  withBusiness,
  type Db,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481810${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function accountId(businessId: string, code: string): Promise<string> {
  const all = await withBusiness(db, businessId, (tx) => accountsRepo.accountsFor(tx, businessId));
  const found = all.find((a) => a.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

describe('the draft lifecycle (§9.1)', () => {
  it('creates, revises and posts once; the second post reports itself', async () => {
    const businessId = await seedBusiness();
    const cash = await accountId(businessId, '1000');
    const revenue = await accountId(businessId, '4000');
    const bank = await accountId(businessId, '1020');

    const { id } = await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.createJournalDraft(tx, {
        businessId,
        memo: 'cash sale, hand entered',
        createdBy: 'user:ada',
        lines: [
          { accountId: cash, debitK: 100_000, creditK: 0 },
          { accountId: revenue, debitK: 0, creditK: 100_000 },
        ],
      }),
    );

    /* Editable means editable: the money moves to the bank instead. */
    await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.reviseJournalDraft(tx, {
        businessId,
        draftId: id,
        lines: [
          { accountId: bank, debitK: 100_000, creditK: 0 },
          { accountId: revenue, debitK: 0, creditK: 100_000 },
        ],
      }),
    );

    const posted = await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.postJournalDraft(tx, { businessId, draftId: id, actor: 'user:ada' }),
    );
    expect(posted.outcome).toBe('posted');
    if (posted.outcome !== 'posted') return;

    /* The books hold the REVISED lines, atomically. */
    const entries = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ account_id: string; debit_k: string; credit_k: string }>(sql`
        SELECT account_id, debit_k::bigint AS debit_k, credit_k::bigint AS credit_k
        FROM ledger_entries WHERE transaction_id = ${posted.ledgerTransactionId}::uuid
      `),
    );
    const byAccount = new Map([...entries].map((e) => [e.account_id, e]));
    expect(Number(byAccount.get(bank)?.debit_k)).toBe(100_000);
    expect(Number(byAccount.get(revenue)?.credit_k)).toBe(100_000);
    expect(byAccount.has(cash)).toBe(false);

    const again = await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.postJournalDraft(tx, { businessId, draftId: id, actor: 'user:ada' }),
    );
    expect(again).toEqual({
      outcome: 'already_posted',
      ledgerTransactionId: posted.ledgerTransactionId,
    });
  });

  it('refuses an unbalanced draft without writing, and the draft stays editable', async () => {
    const businessId = await seedBusiness();
    const cash = await accountId(businessId, '1000');
    const revenue = await accountId(businessId, '4000');
    const { id } = await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.createJournalDraft(tx, {
        businessId,
        memo: 'off by ten',
        createdBy: 'user:ada',
        lines: [
          { accountId: cash, debitK: 100_000, creditK: 0 },
          { accountId: revenue, debitK: 0, creditK: 90_000 },
        ],
      }),
    );
    const out = await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.postJournalDraft(tx, { businessId, draftId: id, actor: 'user:ada' }),
    );
    expect(out).toMatchObject({ outcome: 'invalid', reason: expect.stringContaining('match') });
    const draft = await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.journalDraftById(tx, businessId, id),
    );
    expect(draft!.postedJournalId).toBeNull();
  });

  it('a single-line draft is invalid before it is a database error', async () => {
    const businessId = await seedBusiness();
    const cash = await accountId(businessId, '1000');
    const { id } = await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.createJournalDraft(tx, {
        businessId,
        memo: 'half a thought',
        createdBy: 'user:ada',
        lines: [{ accountId: cash, debitK: 100_000, creditK: 0 }],
      }),
    );
    const out = await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.postJournalDraft(tx, { businessId, draftId: id, actor: 'user:ada' }),
    );
    expect(out).toMatchObject({ outcome: 'invalid', reason: expect.stringContaining('two') });
  });

  it("a draft line cannot cite another tenant's account", async () => {
    const ada = await seedBusiness();
    const bola = await seedBusiness();
    const bolaCash = await accountId(bola, '1000');
    await expect(
      withBusiness(db, ada, (tx) =>
        journalDraftsRepo.createJournalDraft(tx, {
          businessId: ada,
          memo: 'fk probe',
          createdBy: 'user:ada',
          lines: [
            { accountId: bolaCash, debitK: 100, creditK: 0 },
            { accountId: bolaCash, debitK: 0, creditK: 100 },
          ],
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('the one-step form leaves a trail (§9.5 rationale)', () => {
  it('recordJournal leaves a posted draft whose lines mirror the books', async () => {
    const businessId = await seedBusiness();
    const recorded = await withBusiness(db, businessId, (tx) =>
      journalRepo.recordJournal(tx, {
        businessId,
        memo: 'till to bank',
        amountK: 250_000,
        intoAccount: 'BANK',
        outOfAccount: 'CASH',
        actor: 'user:ada',
      }),
    );
    const drafts = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ id: string; posted_journal_id: string | null; memo: string }>(
        sql`SELECT id, posted_journal_id, memo FROM journal_drafts
            WHERE business_id = ${businessId}::uuid`,
      ),
    );
    const rows = [...drafts];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.posted_journal_id).toBe(recorded.ledgerTransactionId);
    expect(rows[0]!.memo).toContain(recorded.journalNumber);

    const draft = await withBusiness(db, businessId, (tx) =>
      journalDraftsRepo.journalDraftById(tx, businessId, rows[0]!.id),
    );
    const bank = await accountId(businessId, '1020');
    expect(draft!.lines.find((l) => l.accountId === bank)?.debitK).toBe(250_000);
  });
});
