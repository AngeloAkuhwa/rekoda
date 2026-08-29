/**
 * Reconciliation tiers one to four over real rows (spec §22.1; B1,
 * PR-074). The claims: the stored match says WHICH tier decided it;
 * tier 1 cuts through what tier 2 must refuse; a suggestion is never
 * applied; a manual match records its reason or does not exist; and a
 * tier-3 match row is unrepresentable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { parseBankStatement, postJournal } from '@rekoda/core';
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

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481870${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Mama Chidi Stores',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const REF = 'RKD-PAY-20260820-K7M2P4';

function importCsv(businessId: string, csv: string) {
  const parsed = parseBankStatement(csv);
  if (!parsed.ok) throw new Error(`expected a parse, got ${parsed.reason}`);
  return withBusiness(db, businessId, (tx) =>
    bankRepo.importStatementLines(tx, { businessId, lines: parsed.lines, actor: 'user:1' }),
  );
}

const bankPosting = (businessId: string, day: string, amountK: number, memo: string, ref: string) =>
  withBusiness(db, businessId, (tx) =>
    issueRepo.writePosting(
      tx,
      businessId,
      postJournal({
        memo,
        amountK,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
      }),
      'journal',
      ref,
      { occurredAt: new Date(`${day}T12:00:00+01:00`) },
    ),
  );

const reconcile = (businessId: string) =>
  withBusiness(db, businessId, (tx) => bankRepo.reconcile(tx, { businessId, commit: true }));

const storedMatches = (businessId: string) =>
  withBusiness(db, businessId, (tx) =>
    tx.execute<{ decided_by: string; tier: number; reason: string | null }>(
      sql`SELECT decided_by, tier, reason FROM bank_line_matches WHERE business_id = ${businessId}::uuid ORDER BY tier`,
    ),
  );

describe('the auto tiers, stored (§22.1)', () => {
  it('tier 1 cuts through the twin postings tier 2 must refuse', async () => {
    const businessId = await seedBusiness();
    /* Two identical ₦50,000 credits on the same day. One posting's memo
     * carries the reference; one line's narration does too. */
    await bankPosting(businessId, '2026-08-20', 5_000_000, `Payment ${REF} → INV-0001`, 'J1');
    await bankPosting(businessId, '2026-08-20', 5_000_000, 'Money in', 'J2');
    await importCsv(
      businessId,
      `Date,Description,Amount\n20/08/2026,TRF ${REF} ADEBAYO,50000.00\n20/08/2026,DIRECT CREDIT,50000.00\n`,
    );

    const outcome = await reconcile(businessId);
    expect(outcome).toMatchObject({ matched: 2, ambiguous: 0, suggested: 0 });
    expect([...(await storedMatches(businessId))]).toEqual([
      { decided_by: 'auto', tier: 1, reason: null },
      { decided_by: 'auto', tier: 2, reason: null },
    ]);
  });

  it('a reference whose amounts disagree is a SUGGESTION: proposed, stored nowhere', async () => {
    const businessId = await seedBusiness();
    await bankPosting(businessId, '2026-08-20', 5_000_000, `Payment ${REF} → INV-0001`, 'J1');
    /* The bank shows ₦49,900 for the ₦50,000 reference. */
    await importCsv(
      businessId,
      `Date,Description,Amount\n20/08/2026,TRF ${REF} ADEBAYO,49900.00\n`,
    );

    const outcome = await reconcile(businessId);
    expect(outcome).toMatchObject({ matched: 0, suggested: 1, unmatchedLines: 1 });
    expect([...(await storedMatches(businessId))]).toEqual([]);
  });
});

describe('tier 4: a person decides, with a reason recorded (§22.1)', () => {
  it('matchByHand stores the tier and the sentence', async () => {
    const businessId = await seedBusiness();
    const transactionId = await bankPosting(businessId, '2026-08-10', 2_000_000, 'Money in', 'J1');
    await importCsv(businessId, `Date,Description,Amount\n12/08/2026,DIRECT CREDIT,20000.00\n`);
    const lines = await withBusiness(db, businessId, (tx) => bankRepo.bankLinesFor(tx, businessId));

    const outcome = await withBusiness(db, businessId, (tx) =>
      bankRepo.matchByHand(tx, {
        businessId,
        lineId: lines[0]!.id,
        transactionId,
        actor: 'user:1',
        reason: 'Adaeze paid in two days late; this is that transfer',
      }),
    );
    expect(outcome).toEqual({ outcome: 'matched' });
    expect([...(await storedMatches(businessId))]).toEqual([
      {
        decided_by: 'manual',
        tier: 4,
        reason: 'Adaeze paid in two days late; this is that transfer',
      },
    ]);
  });

  it('a manual match without its reason, or a tier-3 match, is unrepresentable', async () => {
    const businessId = await seedBusiness();
    const transactionId = await bankPosting(businessId, '2026-08-10', 2_000_000, 'Money in', 'J1');
    await importCsv(businessId, `Date,Description,Amount\n12/08/2026,DIRECT CREDIT,20000.00\n`);
    const lines = await withBusiness(db, businessId, (tx) => bankRepo.bankLinesFor(tx, businessId));
    const raw = (tier: number, decidedBy: string, reason: string | null) =>
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO bank_line_matches (business_id, line_id, transaction_id, decided_by, tier, reason)
          VALUES (${businessId}::uuid, ${lines[0]!.id}::uuid, ${transactionId}::uuid,
                  ${decidedBy}, ${tier}, ${reason})
        `),
      );

    await expect(raw(4, 'manual', null)).rejects.toThrow();
    await expect(raw(3, 'auto', null)).rejects.toThrow();
    /* An auto match carrying a person's sentence is refused too. */
    await expect(raw(2, 'auto', 'the computer felt sure')).rejects.toThrow();
  });
});
