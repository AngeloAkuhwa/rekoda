/**
 * The REQUIRED golden test of spec §22.2 (B1, PR-075) — mandatory and
 * blocking, per the build plan. The sentence under test:
 *
 *   > A bank credit proves account movement, not business purpose.
 *
 * ₦50,000 arrives with narration "DIRECT CREDIT", no invoice reference,
 * no expected payment, no known payer. The system records the FACT and
 * refuses every inference: no Payment, no revenue journal, an UNMATCHED
 * line queued for a person. The merchant then classifies it as owner
 * capital, and the books say DR Bank / CR Owner Equity — with Sales
 * Revenue unchanged and no Payment row for this money at any point.
 * Rekoda never makes that judgement silently (definition-of-done
 * invariant 11).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { postJournal } from '@rekoda/core';
import { createDb, withBusiness, type Db } from './client.js';
import { bankRepo, identity, issueRepo } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 4 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(): Promise<string> {
  const user = await identity.upsertUserByPhone(db, '+2348188000001');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Mama Chidi Stores',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** The whole ledger, by account code — the only witness that matters. */
async function ledgerByCode(businessId: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{ code: string; debit_k: string; credit_k: string }>(sql`
      SELECT acc.code, SUM(e.debit_k)::bigint AS debit_k, SUM(e.credit_k)::bigint AS credit_k
      FROM ledger_entries e JOIN accounts acc ON acc.id = e.account_id
      WHERE e.business_id = ${businessId}::uuid
      GROUP BY acc.code ORDER BY acc.code
    `),
  );
  return [...rows].map((r) => ({
    code: r.code,
    debitK: Number(r.debit_k),
    creditK: Number(r.credit_k),
  }));
}

const countOf = (businessId: string, table: 'payments' | 'ledger_entries') =>
  withBusiness(db, businessId, async (tx) => {
    const rows = await tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE business_id = ${businessId}::uuid`,
    );
    return [...rows][0]!.n;
  });

describe('§22.2: a bank credit is not revenue', () => {
  it('records the fact, refuses the inference, and books only what the merchant says it was', async () => {
    const businessId = await seedBusiness();

    /* GIVEN a bank feed line arrives: +5,000,000 kobo, "DIRECT CREDIT",
     * no invoice reference, no expected payment, no known payer. Through
     * the same connection-scoped door a real feed uses (PR-073). */
    await withBusiness(db, businessId, (tx) =>
      bankRepo.linkFeed(tx, {
        businessId,
        provider: 'mono',
        accountRef: 'acct_golden',
        bankName: 'GTBank',
        accountLast4: '4821',
        actor: 'owner',
      }),
    );
    const connection = await withBusiness(db, businessId, (tx) =>
      bankRepo.feedConnectionFor(tx, businessId),
    );
    const stored = await withBusiness(db, businessId, (tx) =>
      bankRepo.importStatementLines(tx, {
        businessId,
        lines: [
          {
            postedOn: '2026-08-25',
            amountK: 5_000_000,
            narration: 'DIRECT CREDIT',
            bankRef: null,
            externalTransactionId: 'mono_txn_9001',
            row: 1,
          },
        ],
        actor: 'system:bank-feed',
        connectionId: connection!.id,
      }),
    );

    /* THEN the financial transaction exists ... */
    expect(stored).toEqual({ imported: 1, duplicates: 0 });

    /* ... and NOTHING was inferred from it: no Payment, no journal of
     * any kind — not merely "no revenue journal", NO ledger entry. */
    expect(await countOf(businessId, 'payments')).toBe(0);
    expect(await countOf(businessId, 'ledger_entries')).toBe(0);

    /* ... and reconciliation queues it UNMATCHED for review rather than
     * deciding anything. */
    const first = await withBusiness(db, businessId, (tx) =>
      bankRepo.reconcile(tx, { businessId, commit: true }),
    );
    expect(first).toMatchObject({
      matched: 0,
      pairable: 0,
      suggested: 0,
      ambiguous: 0,
      unmatchedLines: 1,
      unmatchedLinesK: 5_000_000,
    });

    /* WHEN the merchant classifies it as owner capital — their
     * judgement, recorded with their reason, in one transaction. */
    const lines = await withBusiness(db, businessId, (tx) => bankRepo.bankLinesFor(tx, businessId));
    await withBusiness(db, businessId, async (tx) => {
      const transactionId = await issueRepo.writePosting(
        tx,
        businessId,
        postJournal({
          memo: 'Owner capital paid in',
          amountK: 5_000_000,
          intoAccount: 'BANK',
          outOfAccount: 'OWNERS_EQUITY',
        }),
        'journal',
        'golden-classification',
        { occurredAt: new Date('2026-08-25T12:00:00+01:00') },
      );
      const paired = await bankRepo.matchByHand(tx, {
        businessId,
        lineId: lines[0]!.id,
        transactionId,
        actor: 'user:owner',
        reason: 'Owner capital I transferred in myself',
      });
      expect(paired).toEqual({ outcome: 'matched' });
    });

    /* THEN the books say what the MERCHANT said and nothing more:
     * DR Bank 5,000,000 / CR Owner Equity 5,000,000. */
    expect(await ledgerByCode(businessId)).toEqual([
      { code: '1020', debitK: 5_000_000, creditK: 0 },
      { code: '3000', debitK: 0, creditK: 5_000_000 },
    ]);

    /* AND Sales Revenue is unchanged — no 4000 row exists at all — AND
     * no Payment row exists for this money at any point. */
    expect(await countOf(businessId, 'payments')).toBe(0);

    /* AND the pairing is recorded as the person's tier-4 decision. */
    const match = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ tier: number; decided_by: string; reason: string }>(
        sql`SELECT tier, decided_by, reason FROM bank_line_matches WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...match]).toEqual([
      {
        tier: 4,
        decided_by: 'manual',
        reason: 'Owner capital I transferred in myself',
      },
    ]);

    /* Nothing is left waiting: the statement and the books agree. */
    const after = await withBusiness(db, businessId, (tx) =>
      bankRepo.reconcile(tx, { businessId, commit: false }),
    );
    expect(after).toMatchObject({ matched: 1, unmatchedLines: 0, unmatchedMovements: 0 });
  });
});
