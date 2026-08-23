/**
 * The bank's half of a reconciliation.
 *
 * Rekoda's books are built from what a merchant told it. A bank statement is
 * what actually moved, according to somebody with no reason to agree, and
 * putting the two side by side is the only way a merchant finds out that a
 * payment they were sure arrived never did.
 *
 * Matching is the other half, and it is the half that can lie. A wrong
 * pairing reports agreement between books and bank that does not exist, so
 * the rule here refuses far more than it accepts and hands the rest to a
 * person. What a person then decides is stored as their decision, not the
 * rule's.
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

/**
 * The statement, newest first, with the lines still needing a decision ahead
 * of the ones already settled when the caller asks for that.
 *
 * The page is where that matters. A merchant pairs by hand out of the rows in
 * front of them, so a line that is not on the page cannot be paired at all,
 * and what the page drops has to be settled history rather than work. By date
 * alone it dropped the OLDEST, which is exactly where an unreconciled line
 * lives. Same principle as the asset register putting what is still owned
 * ahead of what has been sold.
 *
 * Off by default, and the reconciliation rule leaves it off deliberately.
 * `matchStatement` pairs a list against a list, and reordering its input
 * changes which pairing wins when two are equally good. The rule also has no
 * use for it: it consumes its whole input rather than a visible prefix, so
 * which end the open lines sit at changes nothing. Only the page, which shows
 * a prefix and lets a merchant act on it, needs them at the front.
 *
 * The predicate is an index lookup, not a scan: `bank_match_line_ux` is
 * unique on exactly (business_id, line_id).
 */
export async function bankLinesFor(
  tx: TenantDb,
  businessId: string,
  limit = 100,
  options: { unmatchedFirst?: boolean } = {},
): Promise<BankLine[]> {
  const order = options.unmatchedFirst
    ? sql`ORDER BY (NOT EXISTS (
            SELECT 1 FROM bank_line_matches m
             WHERE m.business_id = l.business_id AND m.line_id = l.id
          )) DESC, l.posted_on DESC, l.imported_at DESC`
    : sql`ORDER BY l.posted_on DESC, l.imported_at DESC`;
  const rows = await tx.execute<{
    id: string;
    posted_on: string;
    amount_k: string;
    narration: string;
    bank_ref: string | null;
  }>(sql`
    SELECT l.id, l.posted_on::text AS posted_on, l.amount_k, l.narration, l.bank_ref
    FROM bank_statement_lines l
    WHERE l.business_id = ${businessId}::uuid
    ${order}
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
  /**
   * Postings nothing on the statement explains: money the bank never saw,
   * which is the serious direction. A posting that one of the ambiguous
   * lines might be is `undecidedMovements`, not this.
   */
  unmatchedMovements: number;
  /** Candidates for a line with more than one, waiting on a person. */
  undecidedMovements: number;
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
    undecidedMovements: result.undecidedMovements.length,
    unmatchedLinesK: sum(result.unmatchedLines, (id) => byId.get(id)?.amountK ?? 0),
    unmatchedMovementsK: sum(result.unmatchedMovements, (id) => movementById.get(id)?.amountK ?? 0),
  };
}

/** A posting on the bank account a merchant could point a line at. */
export interface OpenMovement {
  transactionId: string;
  occurredOn: string;
  amountK: number;
  /**
   * What the merchant called it. Invoice numbers, expense descriptions,
   * payment references: the merchant's own words about their own books,
   * behind their own session. No customer or supplier name reaches here,
   * and none may be added to a memo later.
   */
  memo: string;
}

/**
 * Postings on the bank the statement has not yet explained.
 *
 * The candidate pool a merchant picks from, so it excludes anything already
 * matched. `bankMovements` is the shape of this query without the memo and
 * without the exclusion; they are separate because the rule needs neither,
 * and giving the rule a memo would invite somebody to match on it.
 */
export async function openMovements(
  tx: TenantDb,
  businessId: string,
  options: { limit?: number; amounts?: readonly number[]; ids?: readonly string[] } = {},
): Promise<OpenMovement[]> {
  const limit = options.limit ?? 200;
  /**
   * Narrowed to the amounts somebody is actually going to match against.
   *
   * The page filters candidates to a line's exact amount anyway, and it used
   * to do that over a page of two hundred movements ordered by date. A
   * merchant reconciling for the first time after six months has more open
   * entries than that, and the ones outside the page are the oldest: their
   * statement line showed NO candidate at all, for an entry sitting in their
   * own books. Asking for the amounts on the lines being shown is bounded by
   * the lines, and it puts the cap out of reach of the case that hit it.
   */
  const amounts = options.amounts ? [...new Set(options.amounts)] : null;
  if (amounts !== null && amounts.length === 0) return [];
  const onlyAmounts =
    amounts === null
      ? sql``
      : sql` AND (SUM(e.debit_k) - SUM(e.credit_k)) IN (${sql.join(
          amounts.map((a) => sql`${a}`),
          sql`, `,
        )})`;

  /* And by id, for the caller that already knows which one it means.
   * `matchByHand` used to read five thousand movements to look for a single
   * transaction it had been handed, which is a wrong refusal waiting for the
   * business that crosses that number: the entry is open, and the merchant
   * is told it does not exist. */
  const ids = options.ids ? [...new Set(options.ids)] : null;
  if (ids !== null && ids.length === 0) return [];
  const onlyIds =
    ids === null
      ? sql``
      : sql` AND e.transaction_id IN (${sql.join(
          ids.map((i) => sql`${i}::uuid`),
          sql`, `,
        )})`;
  const rows = await tx.execute<{
    transaction_id: string;
    occurred_on: string;
    amount_k: string;
    memo: string;
  }>(sql`
    SELECT e.transaction_id,
           (e.created_at AT TIME ZONE 'Africa/Lagos')::date::text AS occurred_on,
           (SUM(e.debit_k) - SUM(e.credit_k))::bigint AS amount_k,
           MIN(t.memo) AS memo
    FROM ledger_entries e
    JOIN ledger_transactions t ON t.id = e.transaction_id
    WHERE e.business_id = ${businessId}::uuid
      AND e.account = 'BANK'${onlyIds}
      AND NOT EXISTS (
        SELECT 1 FROM bank_line_matches m
         WHERE m.business_id = ${businessId}::uuid
           AND m.transaction_id = e.transaction_id
      )
    GROUP BY e.transaction_id, t.memo, (e.created_at AT TIME ZONE 'Africa/Lagos')::date
    HAVING SUM(e.debit_k) - SUM(e.credit_k) <> 0${onlyAmounts}
    ORDER BY 2 DESC
    LIMIT ${limit}
  `);
  return [...rows].map((r) => ({
    transactionId: r.transaction_id,
    occurredOn: r.occurred_on,
    amountK: Number(r.amount_k),
    memo: r.memo,
  }));
}

/** Which line is already spoken for, and by what. */
export async function matchesFor(
  tx: TenantDb,
  businessId: string,
): Promise<{ lineId: string; transactionId: string; decidedBy: string; memo: string }[]> {
  const rows = await tx.execute<{
    line_id: string;
    transaction_id: string;
    decided_by: string;
    memo: string;
  }>(sql`
    SELECT m.line_id, m.transaction_id, m.decided_by, t.memo
    FROM bank_line_matches m
    JOIN ledger_transactions t ON t.id = m.transaction_id
    WHERE m.business_id = ${businessId}::uuid
  `);
  return [...rows].map((r) => ({
    lineId: r.line_id,
    transactionId: r.transaction_id,
    decidedBy: r.decided_by,
    memo: r.memo,
  }));
}

/** Why a hand-made match was refused, in terms the page can explain. */
export type MatchRefusal =
  | 'no_such_line'
  | 'no_such_movement'
  | 'amounts_differ'
  | 'line_already_matched'
  | 'movement_already_matched';

export type MatchByHandOutcome =
  { outcome: 'matched' } | { outcome: 'refused'; reason: MatchRefusal };

/**
 * A merchant deciding what the rule would not.
 *
 * Two of the rule's three conditions are lifted here, because a person knows
 * things the rule cannot: which of two identical transfers this one is, and
 * that a payment recorded a month late is still the same payment. So the
 * ambiguity refusal goes and the four-day window goes.
 *
 * The amount does not. Two figures a bank charge apart are two facts, and a
 * match that spans them buries the charge inside a reconciliation reporting
 * agreement that does not exist. A merchant with a charge to account for
 * needs a second entry, not a looser match, and the refusal says so.
 */
export async function matchByHand(
  tx: TenantDb,
  input: { businessId: string; lineId: string; transactionId: string; actor: string },
): Promise<MatchByHandOutcome> {
  const [line] = await tx
    .select({ id: bankStatementLines.id, amountK: bankStatementLines.amountK })
    .from(bankStatementLines)
    .where(
      and(
        eq(bankStatementLines.businessId, input.businessId),
        eq(bankStatementLines.id, input.lineId),
      ),
    );
  if (!line) return { outcome: 'refused', reason: 'no_such_line' };

  const open = await openMovements(tx, input.businessId, { ids: [input.transactionId] });
  const movement = open.find((m) => m.transactionId === input.transactionId);
  if (!movement) {
    /* Either it is not a bank movement of this business at all, or somebody
     * already claimed it. The two read differently to a merchant. */
    const claimed = await matchesFor(tx, input.businessId);
    return {
      outcome: 'refused',
      reason: claimed.some((m) => m.transactionId === input.transactionId)
        ? 'movement_already_matched'
        : 'no_such_movement',
    };
  }
  if (movement.amountK !== line.amountK) {
    return { outcome: 'refused', reason: 'amounts_differ' };
  }

  /* ON CONFLICT rather than a read: the line's index is the only thing that
   * can settle two merchants deciding at once, and a read here would be a
   * check-then-act. */
  const inserted = await tx
    .insert(bankLineMatches)
    .values({
      businessId: input.businessId,
      lineId: input.lineId,
      transactionId: input.transactionId,
      decidedBy: 'manual',
    })
    .onConflictDoNothing()
    .returning({ id: bankLineMatches.id });

  if (inserted.length === 0) {
    return { outcome: 'refused', reason: 'line_already_matched' };
  }

  await tx.insert(auditEvents).values({
    businessId: input.businessId,
    actor: input.actor,
    entity: 'bank_line_match',
    entityId: input.lineId,
    action: 'matched',
    newValue: { transactionId: input.transactionId, decidedBy: 'manual' } as never,
    sourceType: 'dashboard',
  });
  return { outcome: 'matched' };
}

/**
 * Undo a pairing.
 *
 * A DELETE, never an UPDATE into a different match: the application holds no
 * UPDATE on this table, and releasing then deciding again is two facts a
 * merchant can follow in the audit trail rather than one that overwrote the
 * other. The line and the posting are left exactly as they were, because
 * neither was ever changed by being matched.
 */
export async function unmatchLine(
  tx: TenantDb,
  input: { businessId: string; lineId: string; actor: string },
): Promise<number> {
  const removed = await tx
    .delete(bankLineMatches)
    .where(
      and(
        eq(bankLineMatches.businessId, input.businessId),
        eq(bankLineMatches.lineId, input.lineId),
      ),
    )
    .returning({ transactionId: bankLineMatches.transactionId });

  if (removed.length > 0) {
    await tx.insert(auditEvents).values({
      businessId: input.businessId,
      actor: input.actor,
      entity: 'bank_line_match',
      entityId: input.lineId,
      action: 'released',
      oldValue: { transactionId: removed[0]!.transactionId } as never,
      sourceType: 'dashboard',
    });
  }
  return removed.length;
}
