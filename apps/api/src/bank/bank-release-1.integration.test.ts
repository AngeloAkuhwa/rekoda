/**
 * The bank surface, end to end.
 *
 * The parsing is proven in packages/core/src/bank-statement.test.ts and the
 * storage in packages/db/src/bank/bank.integration.test.ts. What this pins is the
 * border: that a stranger is refused, that an unreadable file arrives as an
 * outcome the page can explain rather than a status code, and that a
 * merchant's lines reach that merchant and nobody else.
 */
// The bank surface, end to end. Split by concern across bank*.integration.test.ts; the shared setup is in
// bank.fixtures.ts.
import { describe, expect, it } from 'vitest';
import { KEY_BY_CODE } from '@rekoda/core';
import { bankRepo, sql, withBusiness } from '@rekoda/db';
import { CLASSIFICATIONS, prepareClassification } from '../commands/bank-commands.js';
import {
  CREDIT_AND_DEBIT,
  classify,
  db,
  holdOpen,
  matchedTo,
  nets,
  position,
  post,
  postings,
  release,
  releaseAudits,
  setUp,
  stillWaiting,
  useBankHarness,
} from './bank.fixtures.js';

useBankHarness();

/**
 * Releasing a classification (G-95, OD-24 Option A).
 *
 * A classification is not a pairing of two facts that existed apart: the
 * journal exists BECAUSE the merchant said what this line was. Releasing it
 * used to unpair the line and leave that journal standing, so classifying
 * the line again booked the same money a second time. These tests assert
 * the money, not the number of journals.
 */
describe('releasing a classification (G-95)', () => {
  it('books one bank credit once after it is classified, released and classified again', async () => {
    const { businessId, auth, line } = await setUp('+2348177000201');
    expect(await nets(businessId)).toEqual({});

    expect(await classify(auth, line.id)).toMatchObject({ outcome: 'classified' });
    const first = (await matchedTo(auth, line.id))!;
    expect(await nets(businessId)).toEqual({ BANK: 15_000_000, OWNERS_EQUITY: -15_000_000 });

    expect((await post('/v1/bank/unmatch', { lineId: line.id }, auth)).json()).toMatchObject({
      released: 1,
    });
    expect(await matchedTo(auth, line.id)).toBeNull();

    expect(await classify(auth, line.id)).toMatchObject({ outcome: 'classified' });
    const second = (await matchedTo(auth, line.id))!;
    expect(second.transactionId).not.toBe(first.transactionId);

    /* One ₦150,000 credit: the bank went up ₦150,000 and the owner put in
     * ₦150,000. Not ₦300,000 of either. */
    expect(await nets(businessId)).toEqual({ BANK: 15_000_000, OWNERS_EQUITY: -15_000_000 });

    /* Structurally: the first journal, its reversal, and the second. Both
     * classifications carry the line's day; the reversal is today's. */
    const rows = await postings(businessId);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.transactionId, reverses_id: null }),
        expect.objectContaining({ reverses_id: first.transactionId }),
        expect.objectContaining({ id: second.transactionId, reverses_id: null }),
      ]),
    );
  });

  /* B */
  it('reverses the journal it wrote, exactly, and leaves the line unmatched', async () => {
    const { businessId, auth, line } = await setUp('+2348177000202');
    expect(await classify(auth, line.id)).toEqual({
      outcome: 'classified',
      journalNumber: 'JNL-2026-000001',
    });
    const original = (await matchedTo(auth, line.id))!;

    expect(await release(auth, line.id)).toEqual({
      outcome: 'released_classification',
      released: 1,
    });
    expect(await matchedTo(auth, line.id)).toBeNull();
    /* Back to the books before the classification: nothing, net. */
    expect(await nets(businessId)).toEqual({});

    const [kept, reversal] = await postings(businessId);
    /* The classification is the line's own, by provenance, not by memo. */
    expect(kept).toMatchObject({
      id: original.transactionId,
      source_type: 'bank_classification',
      source_id: line.id,
      reverses_id: null,
      month: '2026-08',
    });
    expect(reversal).toMatchObject({
      source_type: 'bank_classification',
      source_id: line.id,
      reverses_id: original.transactionId,
    });

    /* The original is untouched: its own two lines, still there. */
    const entries = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ transaction_id: string; code: string; debit_k: string; credit_k: string }>(sql`
        SELECT e.transaction_id, a.code, e.debit_k, e.credit_k
        FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid ORDER BY e.transaction_id, a.code
      `),
    );
    const of = (id: string) =>
      [...entries]
        .filter((e) => e.transaction_id === id)
        .map((e) => [KEY_BY_CODE[e.code], Number(e.debit_k), Number(e.credit_k)]);
    expect(of(original.transactionId)).toEqual(
      expect.arrayContaining([
        ['BANK', 15_000_000, 0],
        ['OWNERS_EQUITY', 0, 15_000_000],
      ]),
    );
    expect(of(reversal!.id)).toEqual(
      expect.arrayContaining([
        ['BANK', 0, 15_000_000],
        ['OWNERS_EQUITY', 15_000_000, 0],
      ]),
    );

    /* The journal number is still minted, still on the memo and the draft. */
    const draft = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ memo: string; created_by: string; lines: number }>(sql`
        SELECT d.memo, d.created_by,
               (SELECT count(*)::int FROM journal_draft_lines l WHERE l.draft_id = d.id) AS lines
        FROM journal_drafts d
        WHERE d.business_id = ${businessId}::uuid AND d.posted_journal_id = ${original.transactionId}::uuid
      `),
    );
    expect([...draft]).toEqual([
      {
        memo: 'JNL-2026-000001: Owner capital',
        created_by: expect.stringMatching(/^user:/),
        lines: 2,
      },
    ]);

    /* And the trail names both postings, so the release can be traced. */
    expect(await releaseAudits(businessId)).toEqual([
      {
        action: 'classification_released',
        old_value: { transactionId: original.transactionId },
        new_value: {
          lineId: line.id,
          originalLedgerTransactionId: original.transactionId,
          reversalLedgerTransactionId: reversal!.id,
        },
      },
    ]);
  });

  /* A */
  it('releases an ordinary match without touching the posting', async () => {
    const { businessId, auth, line } = await setUp('+2348177000203');
    await post(
      '/v1/reports/journal',
      {
        /* Written to look like a classification. Identity is the ledger's
         * provenance, never the words, so this is still an ordinary entry. */
        memo: 'Owner capital',
        amountK: 15_000_000,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
        occurredOn: '2026-08-03',
      },
      auth,
    );
    const [entry] = await postings(businessId);
    /* A journal somebody wrote keeps the journal's own provenance. */
    expect(entry).toMatchObject({ source_type: 'journal', source_id: 'JNL-2026-000001' });
    expect(
      (await post('/v1/bank/match', { lineId: line.id, transactionId: entry!.id }, auth)).json(),
    ).toEqual({ outcome: 'matched' });
    const before = await nets(businessId);

    expect(await release(auth, line.id)).toEqual({ outcome: 'released_match', released: 1 });
    expect(await matchedTo(auth, line.id)).toBeNull();
    expect(await nets(businessId)).toEqual(before);
    expect(await postings(businessId)).toEqual([entry]);
    expect(await releaseAudits(businessId)).toEqual([
      { action: 'released', old_value: { transactionId: entry!.id }, new_value: null },
    ]);
    /* Still there to be matched again, because it is still a real entry. */
    expect((await position(auth)).openMovements.map((m) => m.transactionId)).toContain(entry!.id);
  });

  /* The provenance is the server's: a merchant cannot send it. */
  it('does not let the journal form claim to be a classification', async () => {
    const { businessId, auth, line } = await setUp('+2348177000204');
    await post(
      '/v1/reports/journal',
      {
        memo: 'Pretending',
        amountK: 15_000_000,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
        occurredOn: '2026-08-03',
        origin: { kind: 'bank_classification', lineId: line.id },
        sourceType: 'bank_classification',
        sourceId: line.id,
      },
      auth,
    );
    const [entry] = await postings(businessId);
    expect(entry).toMatchObject({ source_type: 'journal', source_id: 'JNL-2026-000001' });

    await post('/v1/bank/match', { lineId: line.id, transactionId: entry!.id }, auth);
    expect(await release(auth, line.id)).toMatchObject({ outcome: 'released_match' });
    expect(await postings(businessId)).toHaveLength(1);
  });

  /* B, C, D, E: every classification, both directions. The expected journal
   * comes from the classify door's own builder, never from this test. */
  it.each([
    ['OWNER_CAPITAL', 15_000_000],
    ['SUPPLIER_REFUND', 15_000_000],
    ['INTERNAL_TRANSFER', 15_000_000],
    ['OWNER_CAPITAL', -2_000_000],
    ['SUPPLIER_REFUND', -2_000_000],
    ['INTERNAL_TRANSFER', -2_000_000],
  ] as const)(
    'reverses a %s classification of a %i kobo line exactly, and classifies it again once',
    async (classification, amountK) => {
      const phone = `+23481770003${String(Object.keys(CLASSIFICATIONS).indexOf(classification))}${amountK > 0 ? 1 : 2}`;
      const { businessId, auth, line } = await setUp(phone, CREDIT_AND_DEBIT, amountK);

      const prepared = await withBusiness(db, businessId, (tx) =>
        prepareClassification(tx, { businessId, lineId: line.id, classification, actor: 'test' }),
      );
      if (prepared.outcome !== 'ready') throw new Error(prepared.outcome);
      const once = {
        [prepared.journal.intoAccount]: prepared.journal.amountK,
        [prepared.journal.outOfAccount]: -prepared.journal.amountK,
      };
      /* The sign is the line's: a debit line moves money OUT of the bank. */
      expect(once['BANK']).toBe(amountK);

      expect(await classify(auth, line.id, classification)).toMatchObject({
        outcome: 'classified',
      });
      expect(await nets(businessId)).toEqual(once);

      expect(await release(auth, line.id)).toMatchObject({
        outcome: 'released_classification',
      });
      expect(await nets(businessId)).toEqual({});

      expect(await classify(auth, line.id, classification)).toMatchObject({
        outcome: 'classified',
      });
      expect(await nets(businessId)).toEqual(once);
    },
  );

  /* F */
  it('reverses once however many times it is released', async () => {
    const { businessId, auth, line } = await setUp('+2348177000205');
    await classify(auth, line.id);
    expect(await release(auth, line.id)).toMatchObject({ outcome: 'released_classification' });
    expect(await release(auth, line.id)).toEqual({ outcome: 'not_matched', released: 0 });
    expect(await release(auth, line.id)).toEqual({ outcome: 'not_matched', released: 0 });
    expect((await postings(businessId)).filter((p) => p.reverses_id !== null)).toHaveLength(1);
    expect(await nets(businessId)).toEqual({});
  });

  /* G */
  it('reverses once when two releases arrive together', async () => {
    const { businessId, auth, line } = await setUp('+2348177000206');
    await classify(auth, line.id);

    const first = holdOpen(businessId, (tx) =>
      bankRepo.releaseLine(tx, { businessId, lineId: line.id, actor: 'user:first' }),
    );
    expect(await first.ready).toMatchObject({ outcome: 'released_classification' });
    /* The second, through the real door, waits on the first's claim. */
    const second = release(auth, line.id);
    expect(await stillWaiting(second)).toBe(true);
    await first.commit();

    expect(await second).toEqual({ outcome: 'not_matched', released: 0 });
    expect((await postings(businessId)).filter((p) => p.reverses_id !== null)).toHaveLength(1);
    expect(await nets(businessId)).toEqual({});
  });

  /* H */
  it('does not classify a line again while its release is still in flight', async () => {
    const { businessId, auth, line } = await setUp('+2348177000207');
    await classify(auth, line.id);

    const releasing = holdOpen(businessId, (tx) =>
      bankRepo.releaseLine(tx, { businessId, lineId: line.id, actor: 'user:first' }),
    );
    await releasing.ready;
    /* A classification takes turns with the release (G-97 put every pairing
     * under one lock): it waits rather than reading a line mid-release. */
    const classifying = classify(auth, line.id);
    expect(await stillWaiting(classifying)).toBe(true);
    await releasing.commit();

    /* Once the release has committed, the classification is one journal. */
    expect(await classifying).toMatchObject({ outcome: 'classified' });
    expect(await nets(businessId)).toEqual({ BANK: 15_000_000, OWNERS_EQUITY: -15_000_000 });
    expect((await postings(businessId)).filter((p) => p.reverses_id !== null)).toHaveLength(1);
  });

  /* I */
  it('ends with one pairing when a hand match races the release', async () => {
    const { businessId, auth, line } = await setUp('+2348177000209');
    await post(
      '/v1/reports/journal',
      {
        memo: 'What it really was',
        amountK: 15_000_000,
        intoAccount: 'BANK',
        outOfAccount: 'OWNERS_EQUITY',
        occurredOn: '2026-08-03',
      },
      auth,
    );
    const [written] = await postings(businessId);
    await classify(auth, line.id);

    const releasing = holdOpen(businessId, (tx) =>
      bankRepo.releaseLine(tx, { businessId, lineId: line.id, actor: 'user:first' }),
    );
    await releasing.ready;
    const matching = post('/v1/bank/match', { lineId: line.id, transactionId: written!.id }, auth);
    expect(await stillWaiting(matching)).toBe(true);
    await releasing.commit();

    expect((await matching).json()).toEqual({ outcome: 'matched' });
    expect((await matchedTo(auth, line.id))!.transactionId).toBe(written!.id);
    /* The classification is reversed; the hand-written entry is what explains
     * the line now. One ₦150,000 of each, not two. */
    expect(await nets(businessId)).toEqual({ BANK: 15_000_000, OWNERS_EQUITY: -15_000_000 });
  });
});
