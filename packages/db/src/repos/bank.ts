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
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  KEY_BY_CODE,
  fingerprintLines,
  matchStatement,
  paymentReferencesIn,
  reversal,
  type BankStatementLine,
  type LedgerLine,
} from '@rekoda/core';
import { LOCK_CLASS, type Db, type TenantDb } from '../client.js';
import { codeOf } from './accounts.js';
import { writePosting } from './issue.js';
import { BANK_CLASSIFICATION_SOURCE } from './journal.js';
import {
  bankLineMatches,
  bankStatementLines,
  financialAccountConnections,
  ledgerEntries,
  ledgerTransactions,
} from '../schema/finance.js';
import { accounts, financialAccounts } from '../schema/accounts.js';
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
/** Rows per INSERT: comfortably under the wire protocol's 65,535 parameters. */
const IMPORT_CHUNK_ROWS = 1_000;

export async function importStatementLines(
  tx: TenantDb,
  input: {
    businessId: string;
    lines: readonly (BankStatementLine & { externalTransactionId?: string | null })[];
    actor: string;
    /** §22.3 (PR-073): the feed connection the lines came through. Absent
     * for uploads, whose identity stays the fingerprint alone. */
    connectionId?: string | null;
    /** Test seam: rows per INSERT, so a test can prove the chunk walk. */
    chunkRows?: number;
  },
): Promise<ImportedStatement> {
  /* Takes turns with a forget of the same day (G-97): read mid-forget, the
   * lines about to go would count as duplicates, and the day would vanish
   * behind an answer saying it was already here. */
  await lockBankPairings(tx, input.businessId);
  /* With PR-073 the DO NOTHING absorbs conflicts on BOTH identities: the
   * fingerprint (same content re-imported through any door) and the
   * partial provider-identity unique (the same external id re-polled
   * through the same connection, even if the provider reworded its
   * description in between). */
  /* Extracted BEFORE the key is computed, and once, so the references that
   * land on the row are the same ones the fingerprint was built from. Doing
   * it twice would invite the two to drift apart, and the identity of a line
   * would stop matching what the line says about itself.
   *
   * Narration and `bankRef` together, joined the way the old reader joined
   * them, because a bank that files the reference in its own reference field
   * rather than the description is not a bank that should stop reconciling.
   *
   * This is the LAST place the bank's words exist. They arrived in memory,
   * they are read exactly here, and the INSERT below does not carry them:
   * after this line returns there is no narration anywhere in Rekoda. */
  const withReferences = input.lines.map((line) => ({
    ...line,
    paymentReferences: paymentReferencesIn(`${line.narration} ${line.bankRef ?? ''}`),
  }));
  const keyed = fingerprintLines(withReferences);
  if (keyed.length === 0) return { imported: 0, duplicates: 0 };

  /**
   * Inserted in bounded chunks, because one statement can be a year of
   * banking: the extended query protocol caps bind parameters at 65,535, and
   * six columns a row puts a single INSERT's ceiling near 10,900 lines. A
   * file the contract happily accepts (2 MB is roughly 25,000 lines) would
   * hit the driver's wall with the whole import half-applied. Chunks inside
   * the one transaction keep the import atomic and the count honest.
   */
  const chunkRows = input.chunkRows ?? IMPORT_CHUNK_ROWS;
  let imported = 0;
  for (let at = 0; at < keyed.length; at += chunkRows) {
    const chunk = keyed.slice(at, at + chunkRows);
    const inserted = await tx
      .insert(bankStatementLines)
      .values(
        chunk.map((line) => ({
          businessId: input.businessId,
          postedOn: line.postedOn,
          amountK: line.amountK,
          bankRef: line.bankRef,
          paymentReferences: line.paymentReferences,
          fingerprint: line.fingerprint,
          /* §22.3: identity travels as a pair or not at all — an external
           * id with no connection to scope it is the global identifier
           * the constraint forbids. */
          financialAccountConnectionId: input.connectionId ?? null,
          externalTransactionId: input.connectionId ? (line.externalTransactionId ?? null) : null,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: bankStatementLines.id });
    imported += inserted.length;
  }
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
  /**
   * The Rekoda references the bank's text carried, extracted at ingest.
   *
   * What the readers hand out in place of the narration itself. Matching
   * only ever wanted these; the merchant only ever needed to recognise the
   * line, which a date, an amount and a reference already do.
   */
  paymentReferences: readonly string[];
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
         JOIN accounts acc ON acc.id = e.account_id
        WHERE e.business_id = ${businessId}::uuid
          AND acc.code = ${codeOf('BANK')})::bigint AS ledger_k,
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
 * Off by default. The reconciliation rule has no use for it: `matchStatement`
 * is order-independent (it pairs only mutual one-to-one candidates, so no
 * ordering changes which pairings win) and it consumes its whole input rather
 * than a visible prefix. Only the page, which shows a prefix and lets a
 * merchant act on it, needs the open lines at the front. An earlier version
 * of this comment claimed reordering changes equally-good pairings; it does
 * not — equally good means ambiguous, and ambiguous is never paired.
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
    payment_references: string[] | null;
    bank_ref: string | null;
  }>(sql`
    SELECT l.id, l.posted_on::text AS posted_on, l.amount_k, l.payment_references, l.bank_ref
    FROM bank_statement_lines l
    WHERE l.business_id = ${businessId}::uuid
    ${order}
    LIMIT ${limit}
  `);
  return [...rows].map((r) => ({
    id: r.id,
    postedOn: r.posted_on,
    amountK: Number(r.amount_k),
    paymentReferences: r.payment_references ?? [],
    bankRef: r.bank_ref,
  }));
}

/**
 * EVERY statement line, read in bounded chunks.
 *
 * For the reconciliation rule, which has to see the whole statement or it
 * measures the wrong thing: `bankPositionFor` counts all lines with an
 * uncapped COUNT(*), and a rule fed a page would sit directly beneath a card
 * describing the whole. The movements side was never capped, so a cap here
 * protected nothing consistent.
 *
 * Chunked by id keyset rather than one unbounded SELECT so no single query
 * grows with the business, and by id rather than by date because the rule is
 * order-independent: it pairs only when a line has exactly one candidate AND
 * that posting has exactly one line wanting it, so no ordering can change
 * which pairings win. `chunkSize` is a test seam — a suite proves the loop
 * crosses chunk boundaries with a small one rather than seeding thousands of
 * rows.
 */
export async function allBankLinesFor(
  tx: TenantDb,
  businessId: string,
  chunkSize = 1_000,
): Promise<BankLine[]> {
  type Row = {
    id: string;
    posted_on: string;
    amount_k: string;
    payment_references: string[] | null;
    bank_ref: string | null;
  };
  const all: BankLine[] = [];
  let after: string | null = null;
  for (;;) {
    const rows: Row[] = [
      ...(await tx.execute<Row>(sql`
      SELECT id, posted_on::text AS posted_on, amount_k, payment_references, bank_ref
      FROM bank_statement_lines
      WHERE business_id = ${businessId}::uuid
        ${after === null ? sql`` : sql`AND id > ${after}::uuid`}
      ORDER BY id
      LIMIT ${chunkSize}
    `)),
    ];
    for (const r of rows) {
      all.push({
        id: r.id,
        postedOn: r.posted_on,
        amountK: Number(r.amount_k),
        paymentReferences: r.payment_references ?? [],
        bankRef: r.bank_ref,
      });
    }
    if (rows.length < chunkSize) return all;
    after = rows[rows.length - 1]!.id;
  }
}

/** One classification a forgotten day took with it, reversed. */
export interface ForgottenClassification {
  lineId: string;
  originalLedgerTransactionId: string;
  reversalLedgerTransactionId: string;
}

/** What forgetting a day did, so the merchant is told the truth about it. */
export interface ForgottenDay {
  removed: number;
  /** Classification journals reversed because their lines went (G-97). */
  reversed: ForgottenClassification[];
}

/**
 * Take an import back out.
 *
 * A merchant who uploaded the wrong account's statement has to be able to
 * undo it, and there is no honest way to edit a line into being right. The
 * whole day range goes, because that is the unit a person can picture.
 *
 * The lines' matches go with them, and for an ordinary match that is all:
 * a sale, a payment or a journal somebody wrote existed apart from the
 * statement and is not touched. A CLASSIFICATION is different (G-97, OD-24's
 * principle): its journal exists only because the line was classified, so
 * it is reversed here, before the line goes, exactly as a release reverses
 * it. Left standing, the same day imported again and classified again
 * booked one movement twice. Which matches are classifications comes from
 * provenance alone, as in `releaseLine`; classifications posted before G-95
 * carry `journal` and are left as ordinary matches, not inferred.
 *
 * One transaction for the whole day: every reversal, the deletion and the
 * audit row commit together or not at all, and a refusal from the ledger
 * (`PeriodClosed`, today's month closed) leaves every line where it was.
 * It takes turns under `LOCK_CLASS.bankPairing` with everything else that
 * pairs a line (classify, hand match, release, reconcile), so a pairing in
 * flight commits first and is seen, or waits and then finds no line. An
 * import takes the same lock, so it lands wholly before (and is forgotten
 * with the day) or wholly after (and stays). Only the lines read here are
 * deleted, all the same.
 */
export async function forgetStatementDay(
  tx: TenantDb,
  input: { businessId: string; postedOn: string; actor: string },
): Promise<ForgottenDay> {
  await lockBankPairings(tx, input.businessId);
  const dayLines = await tx
    .select({ id: bankStatementLines.id })
    .from(bankStatementLines)
    .where(
      and(
        eq(bankStatementLines.businessId, input.businessId),
        eq(bankStatementLines.postedOn, input.postedOn),
      ),
    )
    .orderBy(bankStatementLines.id);
  if (dayLines.length === 0) return { removed: 0, reversed: [] };
  const lineIds = dayLines.map((l) => l.id);

  /* The day's classifications, by provenance: the matched posting is the
   * line's own `bank_classification`, not itself a reversal, and not
   * already reversed (the unique reversal index stands behind this). */
  const classified = await tx
    .select({
      lineId: bankLineMatches.lineId,
      transactionId: ledgerTransactions.id,
      memo: ledgerTransactions.memo,
    })
    .from(bankLineMatches)
    .innerJoin(
      ledgerTransactions,
      and(
        eq(ledgerTransactions.businessId, bankLineMatches.businessId),
        eq(ledgerTransactions.id, bankLineMatches.transactionId),
      ),
    )
    .where(
      and(
        eq(bankLineMatches.businessId, input.businessId),
        inArray(bankLineMatches.lineId, lineIds),
        eq(ledgerTransactions.sourceType, BANK_CLASSIFICATION_SOURCE),
        sql`${ledgerTransactions.sourceId} = ${bankLineMatches.lineId}::text`,
        isNull(ledgerTransactions.reversesId),
        sql`NOT EXISTS (SELECT 1 FROM ledger_transactions rev
                         WHERE rev.business_id = ${ledgerTransactions.businessId}
                           AND rev.reverses_id = ${ledgerTransactions.id})`,
      ),
    )
    .orderBy(bankLineMatches.lineId);

  const reversed: ForgottenClassification[] = [];
  for (const c of classified) {
    reversed.push({
      lineId: c.lineId,
      originalLedgerTransactionId: c.transactionId,
      reversalLedgerTransactionId: await reverseClassification(tx, {
        businessId: input.businessId,
        lineId: c.lineId,
        transactionId: c.transactionId,
        memo: `Statement day forgotten: ${c.memo}`,
        original: c.memo,
      }),
    });
  }

  const removed = await tx
    .delete(bankStatementLines)
    .where(
      and(
        eq(bankStatementLines.businessId, input.businessId),
        inArray(bankStatementLines.id, lineIds),
      ),
    )
    .returning({ id: bankStatementLines.id });

  await tx.insert(auditEvents).values({
    businessId: input.businessId,
    actor: input.actor,
    entity: 'bank_statement',
    entityId: input.postedOn,
    action: 'forgotten',
    /* Bounded by the day's classifications, each one a person's decision,
     * never by the number of lines the bank sent. */
    newValue: {
      removed: removed.length,
      reversedClassifications: reversed.length,
      ...(reversed.length > 0 ? { classificationReversals: reversed } : {}),
    } as never,
    sourceType: 'dashboard',
  });
  return { removed: removed.length, reversed };
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
  /** Tier-3 proposals (§22.1): a reference agrees, the amounts do not.
   * Shown to a person, never applied. */
  suggested: number;
  /** The proposals themselves, enriched for the review screen. */
  proposals: {
    lineId: string;
    transactionId: string;
    why: 'reference_found_amount_differs';
    movementAmountK: number;
    movementOccurredOn: string;
    movementMemo: string;
  }[];
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
 * A released classification and its reversal, kept off the reconciliation
 * (G-95, OD-24).
 *
 * Releasing a classification reverses the journal Rekoda wrote for it, and
 * both postings move the bank: offered as candidates, or counted as money
 * the statement never saw, they would be two "unexplained" entries that
 * together are nothing. Narrow on purpose, and structural: only a
 * `bank_classification` posting with a reversal of the SAME line, and that
 * reversal. Every other reversal (a voided expense paid from the bank, a
 * voided invoice) stays exactly as visible as it was.
 *
 * `alias` is the query's own name for `ledger_transactions`; the SQL carries
 * no value from outside.
 */
const notAReleasedClassification = (alias: 't' | 'lt') =>
  sql.raw(`
      AND NOT (${alias}.source_type = '${BANK_CLASSIFICATION_SOURCE}' AND (
        EXISTS (SELECT 1 FROM ledger_transactions rev
                 WHERE rev.business_id = ${alias}.business_id
                   AND rev.reverses_id = ${alias}.id
                   AND rev.source_type = ${alias}.source_type
                   AND rev.source_id = ${alias}.source_id)
        OR EXISTS (SELECT 1 FROM ledger_transactions orig
                    WHERE orig.business_id = ${alias}.business_id
                      AND orig.id = ${alias}.reverses_id
                      AND orig.source_type = ${alias}.source_type
                      AND orig.source_id = ${alias}.source_id)))`);

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
): Promise<
  {
    transactionId: string;
    occurredOn: string;
    amountK: number;
    reference: string | null;
    memo: string;
  }[]
> {
  const rows = await tx.execute<{
    transaction_id: string;
    occurred_on: string;
    amount_k: string;
    memo: string | null;
  }>(sql`
    SELECT e.transaction_id,
           (e.created_at AT TIME ZONE 'Africa/Lagos')::date::text AS occurred_on,
           (SUM(e.debit_k) - SUM(e.credit_k))::bigint AS amount_k,
           max(lt.memo) AS memo
    FROM ledger_entries e
    JOIN accounts acc ON acc.id = e.account_id
    JOIN ledger_transactions lt ON lt.id = e.transaction_id
    WHERE e.business_id = ${businessId}::uuid AND acc.code = ${codeOf('BANK')}${notAReleasedClassification('lt')}
    GROUP BY e.transaction_id, (e.created_at AT TIME ZONE 'Africa/Lagos')::date
    HAVING SUM(e.debit_k) - SUM(e.credit_k) <> 0
  `);
  /* Only the extracted reference reaches the rule, never the memo itself:
   * tier 1 matches on the identity §9 minted, and nothing else in a memo
   * is the matcher's to read (§22.1). */
  return [...rows].map((r) => ({
    transactionId: r.transaction_id,
    occurredOn: r.occurred_on,
    amountK: Number(r.amount_k),
    reference: paymentReferencesIn(r.memo ?? '')[0] ?? null,
    /* For the review screen's proposal cards, never for the rule. */
    memo: r.memo ?? '',
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
  input: { businessId: string; commit: boolean; batchSize?: number },
): Promise<Reconciliation> {
  /* A committing pass takes turns with a classification release (G-95).
   * Its reads are separate statements, so without this it could read the
   * movements from before a release and the pairings from after it, and
   * pair the line with the journal that release just reversed. */
  if (input.commit) await lockBankPairings(tx, input.businessId);
  const [lines, movements, existing] = await Promise.all([
    /* The WHOLE statement, not a page of it: the counts this returns sit on
     * the same screen as an uncapped COUNT(*), and a rule fed five thousand
     * lines would quietly disagree with it past that. The rule itself still
     * runs once over the full set — batching the rule would let a pairing
     * depend on which chunk a line landed in. */
    allBankLinesFor(tx, input.businessId, input.batchSize),
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
    open.map((l) => ({
      id: l.id,
      postedOn: l.postedOn,
      amountK: l.amountK,
      /* Read, not re-derived. Ingest extracted these from the bank's text
       * while it still had it, so this is the same set the old expression
       * computed here on every pass, and the text it came from is now free
       * to stop being stored (§22.1). */
      references: l.paymentReferences,
    })),
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
          tier: m.tier,
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
    suggested: result.suggestions.length,
    proposals: result.suggestions.map((sug) => {
      const movement = movementById.get(sug.transactionId);
      return {
        lineId: sug.lineId,
        transactionId: sug.transactionId,
        why: sug.why,
        movementAmountK: movement?.amountK ?? 0,
        movementOccurredOn: movement?.occurredOn ?? '',
        movementMemo: movement?.memo ?? '',
      };
    }),
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
    JOIN accounts acc ON acc.id = e.account_id
    JOIN ledger_transactions t ON t.id = e.transaction_id
    WHERE e.business_id = ${businessId}::uuid
      AND acc.code = ${codeOf('BANK')}${onlyIds}${notAReleasedClassification('t')}
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
  /**
   * The lines the caller is actually decorating. Without this, the bank page
   * read every match the business ever made to caption the five hundred
   * lines it shows: a decoration query that grew with the tenant's history
   * rather than with the page.
   */
  lineIds: readonly string[],
): Promise<
  {
    lineId: string;
    transactionId: string;
    decidedBy: string;
    /** Which §22.1 tier decided it: 1, 2 or 4. */
    tier: number;
    /** The person's sentence on a tier-4 match; null on auto tiers. */
    reason: string | null;
    memo: string;
  }[]
> {
  if (lineIds.length === 0) return [];
  const rows = await tx.execute<{
    line_id: string;
    transaction_id: string;
    decided_by: string;
    tier: number;
    reason: string | null;
    memo: string;
  }>(sql`
    SELECT m.line_id, m.transaction_id, m.decided_by, m.tier, m.reason, t.memo
    FROM bank_line_matches m
    JOIN ledger_transactions t ON t.id = m.transaction_id
    WHERE m.business_id = ${businessId}::uuid
      AND m.line_id IN (${sql.join(
        lineIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);
  return [...rows].map((r) => ({
    lineId: r.line_id,
    transactionId: r.transaction_id,
    decidedBy: r.decided_by,
    tier: r.tier,
    reason: r.reason,
    memo: r.memo,
  }));
}

/** One line, with whether anything already claims it — the classify
 * door's pre-check (§22.2), read before a journal is minted for it. The
 * caller holds `lockBankPairings` first (G-97). */
export async function lineFor(
  tx: TenantDb,
  businessId: string,
  lineId: string,
): Promise<(BankLine & { matched: boolean }) | null> {
  const rows = await tx.execute<{
    id: string;
    posted_on: string;
    amount_k: string;
    payment_references: string[] | null;
    bank_ref: string | null;
    match_id: string | null;
  }>(sql`
    SELECT l.id, l.posted_on::text AS posted_on, l.amount_k, l.payment_references, l.bank_ref,
           m.id AS match_id
    FROM bank_statement_lines l
    LEFT JOIN bank_line_matches m ON m.business_id = l.business_id AND m.line_id = l.id
    WHERE l.business_id = ${businessId}::uuid AND l.id = ${lineId}::uuid
  `);
  const row = [...rows][0];
  if (!row) return null;
  return {
    id: row.id,
    postedOn: row.posted_on,
    amountK: Number(row.amount_k),
    paymentReferences: row.payment_references ?? [],
    bankRef: row.bank_ref,
    matched: row.match_id !== null,
  };
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
  input: {
    businessId: string;
    lineId: string;
    transactionId: string;
    actor: string;
    /** §22.1 tier 4: a person decides, WITH A REASON RECORDED. Non-empty;
     * the constraint refuses a manual match without one. */
    reason: string;
  },
): Promise<MatchByHandOutcome> {
  /* A forget of this line's day takes turns with the pairing: it waits
   * and then sees the match, or went first and this finds no line (G-97). */
  await lockBankPairings(tx, input.businessId);
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
    const [claimed] = await tx
      .select({ id: bankLineMatches.lineId })
      .from(bankLineMatches)
      .where(
        and(
          eq(bankLineMatches.businessId, input.businessId),
          eq(bankLineMatches.transactionId, input.transactionId),
        ),
      )
      .limit(1);
    return {
      outcome: 'refused',
      reason: claimed ? 'movement_already_matched' : 'no_such_movement',
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
      tier: 4,
      reason: input.reason,
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
    newValue: {
      transactionId: input.transactionId,
      decidedBy: 'manual',
      reason: input.reason,
    } as never,
    sourceType: 'dashboard',
  });
  return { outcome: 'matched' };
}

/**
 * One business's pairings, one writer at a time (`LOCK_CLASS.bankPairing`).
 *
 * Taken by everything that writes or removes a line's match: a committing
 * reconcile, a hand match, a classification (before its pre-check), a
 * release and a forget; and by an import, so it never reads a day mid-forget. Row locks cannot do this job: the application role
 * holds no UPDATE on the append-only statement lines, so it cannot take
 * `FOR SHARE` or `FOR UPDATE` on them.
 */
export async function lockBankPairings(tx: TenantDb, businessId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${LOCK_CLASS.bankPairing}, hashtext(${businessId}))`,
  );
}

/** What a release did, so the merchant is told the truth about it. */
export type ReleaseOutcome =
  | { outcome: 'not_matched' }
  /** Two facts that existed apart are no longer paired. Nothing posted. */
  | { outcome: 'released_match'; transactionId: string }
  /** The journal Rekoda wrote for this line's classification is reversed. */
  | {
      outcome: 'released_classification';
      originalTransactionId: string;
      reversalTransactionId: string;
    };

/**
 * A classification whose stored posting cannot be named in the chart.
 * Thrown so the release rolls back whole: reversing what cannot be named
 * would be worse than refusing, and the match must not go without it.
 */
export class UnreversibleClassification extends Error {
  constructor(public readonly transactionId: string) {
    super(`classification posting ${transactionId} cannot be reversed from its stored entries`);
  }
}

/**
 * Reverse one classification's posting, exactly as it was written (G-95,
 * reused by G-97).
 *
 * The caller has already proven, from provenance alone, that the posting is
 * this line's own unreversed `bank_classification`, and owns the
 * transaction: this writes, it decides nothing. The stored entries are the
 * truth being reversed, not what the classification rules would write
 * today. Dated now, like every void, so a closed month refuses through the
 * ledger's own `PeriodClosed` and the caller's whole transaction rolls back.
 */
async function reverseClassification(
  tx: TenantDb,
  input: {
    businessId: string;
    lineId: string;
    transactionId: string;
    /** The original posting's memo, carried onto the reversed shape. */
    original: string;
    /** What the reversal says about itself. */
    memo: string;
  },
): Promise<string> {
  const entries = await tx
    .select({
      accountCode: accounts.code,
      debitK: ledgerEntries.debitK,
      creditK: ledgerEntries.creditK,
    })
    .from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .where(
      and(
        eq(ledgerEntries.businessId, input.businessId),
        eq(ledgerEntries.transactionId, input.transactionId),
      ),
    );
  const lines: LedgerLine[] = [];
  for (const entry of entries) {
    const account = KEY_BY_CODE[entry.accountCode];
    if (!account) throw new UnreversibleClassification(input.transactionId);
    lines.push({ account, debitK: Number(entry.debitK), creditK: Number(entry.creditK) });
  }
  if (lines.length === 0) throw new UnreversibleClassification(input.transactionId);

  return writePosting(
    tx,
    input.businessId,
    reversal({ memo: input.original, lines }, input.memo),
    BANK_CLASSIFICATION_SOURCE,
    input.lineId,
    { reversesId: input.transactionId },
  );
}

/**
 * Undo a pairing, and what the pairing meant (G-95, OD-24 Option A).
 *
 * Two different things share the Release button. A line paired with a
 * posting that existed on its own (a sale, an expense, a journal somebody
 * wrote) is two facts no longer said to correspond: the pairing goes and
 * the books do not move. A line Rekoda CLASSIFIED is different: the journal
 * exists only because the merchant said what that money was, so releasing
 * the judgement reverses it. Left standing, a second classification of the
 * same line booked the same money twice.
 *
 * Which one it is comes from the ledger's own provenance and nothing else:
 * the matched posting is `bank_classification` for THIS line and is not
 * itself a reversal. No memo, reason, account pair or date is read.
 * Classifications posted before this rule carry `journal` and are released
 * the ordinary way; they are not inferred.
 *
 * The DELETE is the claim, made before anything is written, as the voids
 * claim their row first: it takes the match row's lock, so a second release
 * arriving together waits, then finds nothing and posts nothing. A
 * committing reconcile takes turns with it under `LOCK_CLASS.bankPairing`,
 * so the rule cannot pair the line again with the journal being reversed. The
 * reversal is dated today, like every void, and a refusal from the ledger
 * (`PeriodClosed`) rolls the claim back with everything else. The
 * application holds no UPDATE here, and `ledger_tx_reversal_once_ux` stands
 * behind the claim in case anything ever gets past it.
 */
export async function releaseLine(
  tx: TenantDb,
  input: { businessId: string; lineId: string; actor: string },
): Promise<ReleaseOutcome> {
  await lockBankPairings(tx, input.businessId);
  const [claimed] = await tx
    .delete(bankLineMatches)
    .where(
      and(
        eq(bankLineMatches.businessId, input.businessId),
        eq(bankLineMatches.lineId, input.lineId),
      ),
    )
    .returning({ lineId: bankLineMatches.lineId, transactionId: bankLineMatches.transactionId });
  if (!claimed) return { outcome: 'not_matched' };
  /* The line's id as the database holds it. The caller's spelling matched
   * the uuid column case-insensitively, but `source_id` is text, and an
   * upper-case id must not turn a classification into an ordinary release. */
  const lineId = claimed.lineId;

  const [matched] = await tx
    .select({
      memo: ledgerTransactions.memo,
      sourceType: ledgerTransactions.sourceType,
      sourceId: ledgerTransactions.sourceId,
      reversesId: ledgerTransactions.reversesId,
    })
    .from(ledgerTransactions)
    .where(
      and(
        eq(ledgerTransactions.businessId, input.businessId),
        eq(ledgerTransactions.id, claimed.transactionId),
      ),
    );
  const classified =
    matched !== undefined &&
    matched.sourceType === BANK_CLASSIFICATION_SOURCE &&
    matched.sourceId === lineId &&
    matched.reversesId === null;

  if (!classified) {
    await tx.insert(auditEvents).values({
      businessId: input.businessId,
      actor: input.actor,
      entity: 'bank_line_match',
      entityId: lineId,
      action: 'released',
      oldValue: { transactionId: claimed.transactionId } as never,
      sourceType: 'dashboard',
    });
    return { outcome: 'released_match', transactionId: claimed.transactionId };
  }

  const reversalTransactionId = await reverseClassification(tx, {
    businessId: input.businessId,
    lineId,
    transactionId: claimed.transactionId,
    memo: `Classification released: ${matched.memo}`,
    original: matched.memo,
  });

  await tx.insert(auditEvents).values({
    businessId: input.businessId,
    actor: input.actor,
    entity: 'bank_line_match',
    entityId: lineId,
    action: 'classification_released',
    oldValue: { transactionId: claimed.transactionId } as never,
    newValue: {
      lineId,
      originalLedgerTransactionId: claimed.transactionId,
      reversalLedgerTransactionId: reversalTransactionId,
    } as never,
    sourceType: 'dashboard',
  });
  return {
    outcome: 'released_classification',
    originalTransactionId: claimed.transactionId,
    reversalTransactionId,
  };
}

/* ── the live feed's standing link (fix-plan 4, G5) ──────────────────────── */

export interface FeedConnection {
  id: string;
  provider: string;
  accountRef: string;
  bankName: string;
  accountLast4: string;
  /** The place money sits that this connection reads (0061, PR-073). */
  financialAccountId: string;
  /** linked | unlinked. Unlinked keeps the row: lapsed is not never-was. */
  status: string;
  /** `YYYY-MM-DD`, or null before the first sync. */
  lastSyncedOn: string | null;
}

export async function feedConnectionFor(
  tx: TenantDb,
  businessId: string,
): Promise<FeedConnection | null> {
  const rows = await tx
    .select({
      id: financialAccountConnections.id,
      financialAccountId: financialAccountConnections.financialAccountId,
      provider: financialAccountConnections.providerType,
      accountRef: financialAccountConnections.externalAccountId,
      bankName: financialAccountConnections.bankName,
      accountLast4: financialAccountConnections.accountLast4,
      status: financialAccountConnections.status,
      lastSyncedOn: financialAccountConnections.lastSyncedOn,
    })
    .from(financialAccountConnections)
    .where(eq(financialAccountConnections.businessId, businessId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Record that the merchant authorised the aggregator.
 *
 * An upsert on the one-per-business index rather than an insert, because
 * re-linking is the ordinary repair for a lapsed consent: the new account
 * reference replaces the old, the status comes back to `linked`, and the
 * sync cursor resets so the next pull re-covers the gap. The fingerprint
 * dedupe makes the re-covered overlap free.
 */
export async function linkFeed(
  tx: TenantDb,
  input: {
    businessId: string;
    provider: string;
    accountRef: string;
    bankName: string;
    accountLast4: string;
    actor: string;
  },
): Promise<void> {
  /* The connection reads ONE place money sits (§22.3, migration 0095).
   * V1 has exactly one 'bank' financial account per business, seeded at
   * creation; a business without one is a seeding defect worth an error,
   * never a silently connection-less feed. */
  const accounts = await tx
    .select({ id: financialAccounts.id })
    .from(financialAccounts)
    .where(
      and(eq(financialAccounts.businessId, input.businessId), eq(financialAccounts.kind, 'bank')),
    )
    .orderBy(financialAccounts.createdAt)
    .limit(1);
  const financialAccountId = accounts[0]?.id;
  if (!financialAccountId) {
    throw new Error('linkFeed: this business has no bank financial account to connect');
  }

  await tx
    .insert(financialAccountConnections)
    .values({
      businessId: input.businessId,
      financialAccountId,
      providerType: input.provider,
      externalAccountId: input.accountRef,
      bankName: input.bankName,
      accountLast4: input.accountLast4,
      status: 'linked',
    })
    .onConflictDoUpdate({
      target: [
        financialAccountConnections.businessId,
        financialAccountConnections.financialAccountId,
      ],
      set: {
        providerType: input.provider,
        externalAccountId: input.accountRef,
        bankName: input.bankName,
        accountLast4: input.accountLast4,
        status: 'linked',
        lastSyncedOn: null,
        updatedAt: new Date(),
      },
    });

  await tx.insert(auditEvents).values({
    businessId: input.businessId,
    actor: input.actor,
    entity: 'bank_feed',
    entityId: input.accountRef,
    action: 'linked',
    newValue: { provider: input.provider, bankName: input.bankName } as never,
    sourceType: 'dashboard',
  });
}

/** A sync ran and covered up to this Lagos day. */
export async function markFeedSynced(tx: TenantDb, businessId: string, day: string): Promise<void> {
  await tx
    .update(financialAccountConnections)
    .set({ lastSyncedOn: day, updatedAt: new Date() })
    .where(eq(financialAccountConnections.businessId, businessId));
}

/**
 * The aggregator answered that its access lapsed. The row stays, marked, so
 * the page can say "link it again" instead of pretending nothing was ever
 * linked.
 */
export async function markFeedUnlinked(
  tx: TenantDb,
  businessId: string,
  actor: string,
): Promise<void> {
  const marked = await tx
    .update(financialAccountConnections)
    .set({ status: 'unlinked', updatedAt: new Date() })
    .where(
      and(
        eq(financialAccountConnections.businessId, businessId),
        eq(financialAccountConnections.status, 'linked'),
      ),
    )
    .returning({ accountRef: financialAccountConnections.externalAccountId });

  if (marked.length > 0) {
    await tx.insert(auditEvents).values({
      businessId,
      actor,
      entity: 'bank_feed',
      entityId: marked[0]!.accountRef,
      action: 'unlinked',
      sourceType: 'dashboard',
    });
  }
}

/**
 * Every business with a LINKED feed, across tenants — the background
 * sweep's worklist (`sweep_read_feed_connections`, migration 0095). Worker
 * connection only; ids, nothing else.
 */
export async function linkedFeedBusinesses(
  workerDb: Db,
  limit = 500,
): Promise<Array<{ businessId: string }>> {
  return workerDb
    .select({ businessId: financialAccountConnections.businessId })
    .from(financialAccountConnections)
    .where(eq(financialAccountConnections.status, 'linked'))
    .orderBy(financialAccountConnections.updatedAt)
    .limit(limit);
}
