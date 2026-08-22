/**
 * The bank's half of a reconciliation.
 *
 * Rekoda's books are built from what a merchant told it. A bank statement is
 * what actually moved, according to somebody with no reason to agree, and
 * putting the two side by side is the only way a merchant finds out that a
 * payment they were sure arrived never did.
 *
 * Nothing here matches anything yet. This slice gets the statement in and
 * shows the two figures apart; matching is its own problem and its own
 * mistake to make.
 */
import { and, eq, sql } from 'drizzle-orm';
import { fingerprintLines, matchStatement, type BankStatementLine } from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { bankLineMatches, bankStatementLines } from '../schema/finance.js';
import { auditEvents } from '../schema/ops.js';

export interface ImportedStatement {
  /** Lines the merchant did not already have. */
  imported: number;
  /** Lines already present, which is the ordinary case on a re-upload. */
  duplicates: number;
}

/**
 * Store what a statement said, once.
 *
 * `ON CONFLICT DO NOTHING` against the fingerprint index rather than a read
 * then a write: two uploads of the same file arriving together would both
 * read nothing and both insert, and the merchant would end up holding every
 * line twice. The index decides, which is the same reason opening balances
 * lean on one.
 */
export async function importStatementLines(
  tx: TenantDb,
  input: {
    businessId: string;
    lines: readonly BankStatementLine[];
    actor: string;
  },
): Promise<ImportedStatement> {
  const keyed = fingerprintLines(input.lines);
  if (keyed.length === 0) return { imported: 0, duplicates: 0 };

  const inserted = await tx
    .insert(bankStatementLines)
    .values(
      keyed.map((line) => ({
        businessId: input.businessId,
        postedOn: line.postedOn,
        amountK: line.amountK,
        narration: line.narration,
        bankRef: line.bankRef,
        fingerprint: line.fingerprint,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: bankStatementLines.id });

  const imported = inserted.length;
  const duplicates = keyed.length - imported;

  /* Only when something actually landed. An audit trail that recorded every
   * accidental re-upload of the same file would bury the imports that
   * changed something. */
  if (imported > 0) {
    await tx.insert(auditEvents).values({
      businessId: input.businessId,
      actor: input.actor,
      entity: 'bank_statement',
      entityId: `${keyed[0]!.postedOn}..${keyed[keyed.length - 1]!.postedOn}`,
      action: 'imported',
      newValue: { imported, duplicates } as never,
      sourceType: 'dashboard',
    });
  }

  return { imported, duplicates };
}

export interface BankLine {
  id: string;
  postedOn: string;
  amountK: number;
  narration: string;
  bankRef: string | null;
}

export interface BankPosition {
  /** What the ledger's BANK account says, all time. */
  ledgerK: number;
  /** What the imported statement lines add up to, all time. */
  statementK: number;
  /** statementK - ledgerK. Non-zero is the thing to explain. */
  differenceK: number;
  /** How many lines have been imported at all. */
  lines: number;
  /** The most recent day any imported line was posted, or null. */
  latestOn: string | null;
}

/**
 * Both figures, from the two places they live.
 *
 * One statement rather than two round trips, for the same reason the stock
 * take reads its pair together: the whole instrument is a comparison, and a
 * page that fetched the halves separately could show two moments.
 *
 * The statement total is only meaningful once a merchant has imported from
 * the beginning, which almost nobody does. So the difference is offered as
 * something to explain rather than as a verdict, and the surface says so.
 */
export async function bankPositionFor(tx: TenantDb, businessId: string): Promise<BankPosition> {
  const rows = await tx.execute<{
    ledger_k: string;
    statement_k: string;
    lines: number;
    latest_on: string | null;
  }>(sql`
    SELECT
      (SELECT COALESCE(SUM(e.debit_k) - SUM(e.credit_k), 0)
         FROM ledger_entries e
        WHERE e.business_id = ${businessId}::uuid AND e.account = 'BANK')::bigint AS ledger_k,
      (SELECT COALESCE(SUM(l.amount_k), 0)
         FROM bank_statement_lines l
        WHERE l.business_id = ${businessId}::uuid)::bigint AS statement_k,
      (SELECT COUNT(*) FROM bank_statement_lines l
        WHERE l.business_id = ${businessId}::uuid)::int AS lines,
      (SELECT MAX(l.posted_on)::text FROM bank_statement_lines l
        WHERE l.business_id = ${businessId}::uuid) AS latest_on
  `);
  const row = [...rows][0];
  const ledgerK = row ? Number(row.ledger_k) : 0;
  const statementK = row ? Number(row.statement_k) : 0;
  return {
    ledgerK,
    statementK,
    differenceK: statementK - ledgerK,
    lines: row?.lines ?? 0,
    latestOn: row?.latest_on ?? null,
  };
}

/** The most recent lines, newest first. */
export async function bankLinesFor(
  tx: TenantDb,
  businessId: string,
  limit = 100,
): Promise<BankLine[]> {
  const rows = await tx.execute<{
    id: string;
    posted_on: string;
    amount_k: string;
    narration: string;
    bank_ref: string | null;
  }>(sql`
    SELECT id, posted_on::text AS posted_on, amount_k, narration, bank_ref
    FROM bank_statement_lines
    WHERE business_id = ${businessId}::uuid
    ORDER BY posted_on DESC, imported_at DESC
    LIMIT ${limit}
  `);
  return [...rows].map((r) => ({
    id: r.id,
    postedOn: r.posted_on,
    amountK: Number(r.amount_k),
    narration: r.narration,
    bankRef: r.bank_ref,
  }));
}

/**
 * Take an import back out.
 *
 * A merchant who uploaded the wrong account's statement has to be able to
 * undo it, and there is no honest way to edit a line into being right. The
 * whole day range goes, because that is the unit a person can picture.
 */
export async function forgetStatementDay(
  tx: TenantDb,
  input: { businessId: string; postedOn: string; actor: string },
): Promise<number> {
  const removed = await tx
    .delete(bankStatementLines)
    .where(
      and(
        eq(bankStatementLines.businessId, input.businessId),
        eq(bankStatementLines.postedOn, input.postedOn),
      ),
    )
    .returning({ id: bankStatementLines.id });

  if (removed.length > 0) {
    await tx.insert(auditEvents).values({
      businessId: input.businessId,
      actor: input.actor,
      entity: 'bank_statement',
      entityId: input.postedOn,
      action: 'forgotten',
      newValue: { removed: removed.length } as never,
      sourceType: 'dashboard',
    });
  }
  return removed.length;
}

export interface Reconciliation {
  /** Lines paired with a posting, stored. */
  matched: number;
  /**
   * Lines the rule can pair right now and has not.
   *
   * Read separately from `matched` because a page load deliberately decides
   * nothing: this is the offer, and `matched` is what has been accepted. It
   * is what the button counts, and counting anything else would offer to
   * pair the lines that provably cannot be.
   */
  pairable: number;
  /** Lines more than one posting fits, waiting on a person. */
  ambiguous: number;
  /** Lines nothing in the books explains: money nobody recorded. */
  unmatchedLines: number;
  /** Postings nothing on the statement explains: money the bank never saw. */
  unmatchedMovements: number;
  /** What the unexplained lines add up to, so the gap has a figure. */
  unmatchedLinesK: number;
  unmatchedMovementsK: number;
}

/**
 * Movement on the merchant's own bank account, one figure per posting.
 *
 * Grouped by transaction rather than listed by entry, because a posting is
 * the thing a statement line corresponds to: a sale paid by transfer moves
 * the bank once and the receivable once, and only the first has anything to
 * do with the bank's version of events.
 *
 * The settlement account is deliberately absent (ADR 0025). It has its own
 * statement behind it, and mixing the two would compare a merchant's bank
 * against money that has not reached it yet.
 */
async function bankMovements(
  tx: TenantDb,
  businessId: string,
): Promise<{ transactionId: string; occurredOn: string; amountK: number }[]> {
  const rows = await tx.execute<{
    transaction_id: string;
    occurred_on: string;
    amount_k: string;
  }>(sql`
    SELECT e.transaction_id,
           (e.created_at AT TIME ZONE 'Africa/Lagos')::date::text AS occurred_on,
           (SUM(e.debit_k) - SUM(e.credit_k))::bigint AS amount_k
    FROM ledger_entries e
    WHERE e.business_id = ${businessId}::uuid AND e.account = 'BANK'
    GROUP BY e.transaction_id, (e.created_at AT TIME ZONE 'Africa/Lagos')::date
    HAVING SUM(e.debit_k) - SUM(e.credit_k) <> 0
  `);
  return [...rows].map((r) => ({
    transactionId: r.transaction_id,
    occurredOn: r.occurred_on,
    amountK: Number(r.amount_k),
  }));
}

/**
 * Pair what can only be paired one way, and count what is left.
 *
 * Already-matched lines and postings are taken out before the rule runs, so
 * a second pass never reconsiders a decision a merchant made by hand. The
 * rule itself is pure and lives in @rekoda/core, where its timidity can be
 * argued with in a test.
 */
export async function reconcile(
  tx: TenantDb,
  input: { businessId: string; commit: boolean },
): Promise<Reconciliation> {
  const [lines, movements, existing] = await Promise.all([
    bankLinesFor(tx, input.businessId, 5_000),
    bankMovements(tx, input.businessId),
    tx
      .select({
        lineId: bankLineMatches.lineId,
        transactionId: bankLineMatches.transactionId,
      })
      .from(bankLineMatches)
      .where(eq(bankLineMatches.businessId, input.businessId)),
  ]);

  const matchedLines = new Set(existing.map((m) => m.lineId));
  const matchedTx = new Set(existing.map((m) => m.transactionId));
  const open = lines.filter((l) => !matchedLines.has(l.id));
  const openMovements = movements.filter((m) => !matchedTx.has(m.transactionId));

  const result = matchStatement(
    open.map((l) => ({ id: l.id, postedOn: l.postedOn, amountK: l.amountK })),
    openMovements,
  );

  let claimed = 0;
  if (input.commit && result.matched.length > 0) {
    /* ON CONFLICT rather than a check: two reconcile calls arriving together
     * both read the same open set and both try to claim it, and only the two
     * unique indexes decide. RETURNING is what makes the count honest — the
     * loser of that race inserted fewer rows than it proposed, and reporting
     * the proposal would tell a merchant a pairing was made twice. */
    const inserted = await tx
      .insert(bankLineMatches)
      .values(
        result.matched.map((m) => ({
          businessId: input.businessId,
          lineId: m.lineId,
          transactionId: m.transactionId,
          decidedBy: 'auto',
        })),
      )
      .onConflictDoNothing()
      .returning({ lineId: bankLineMatches.lineId });
    claimed = inserted.length;
  }

  const byId = new Map(open.map((l) => [l.id, l]));
  const movementById = new Map(openMovements.map((m) => [m.transactionId, m]));
  const sum = (ids: readonly string[], pick: (id: string) => number) =>
    ids.reduce((n, id) => n + pick(id), 0);

  return {
    matched: existing.length + claimed,
    pairable: result.matched.length - claimed,
    ambiguous: result.ambiguous.length,
    unmatchedLines: result.unmatchedLines.length,
    unmatchedMovements: result.unmatchedMovements.length,
    unmatchedLinesK: sum(result.unmatchedLines, (id) => byId.get(id)?.amountK ?? 0),
    unmatchedMovementsK: sum(result.unmatchedMovements, (id) => movementById.get(id)?.amountK ?? 0),
  };
}
