/**
 * Which statement line is which posting.
 *
 * Pure, so the rule can be argued with in a test rather than in production.
 *
 * The rule is deliberately timid, because a wrong match is worse than no
 * match at all. An unmatched line is a question a merchant can answer; a
 * wrong one is a reconciliation that reports agreement between books and bank
 * that does not exist, which is the single failure this whole feature was
 * built to prevent. So nothing is matched on a resemblance:
 *
 *   - The amount must be EXACT. Not close, not rounded. Two figures that
 *     differ by a bank charge are two facts, and pretending otherwise buries
 *     the charge.
 *   - A few days either side, because a transfer made on Friday posts on
 *     Monday and a merchant records it when it happened.
 *   - One candidate on each side, or nothing. Two postings of ₦20,000 in the
 *     same week are exactly when a computer should stop and ask.
 *
 * §22.1's tiers (PR-074), on top of that timidity:
 *
 *   1  exact reference       the Rekoda reference minted for exactly this
 *                            (§9: "what makes reconciliation deterministic")
 *                            appears on BOTH sides and the amounts agree.
 *                            Strong enough to cut through an amount-and-date
 *                            ambiguity nothing else could.
 *   2  strong deterministic  exact amount, inside the window, one candidate
 *                            on each side. No counterparty name strengthens
 *                            this tier, deliberately: customer and supplier
 *                            names never reach the matcher (the same privacy
 *                            rule that keeps them out of movement memos), so
 *                            the both-sides uniqueness IS the third leg.
 *   3  suggested             proposed to a human, NEVER applied — the
 *                            `suggestions` and `ambiguous` outputs. A match
 *                            row of tier 3 is unrepresentable in the store.
 *   4  manual review         a person decides, with a reason recorded —
 *                            `matchByHand`, not this function.
 *
 * AI can explain. Deterministic logic or an authorised human decides — this
 * function is the deterministic logic, and nothing model-shaped feeds it.
 */

/** A line as the bank reported it. */
export interface MatchableLine {
  readonly id: string;
  readonly postedOn: string;
  /** Signed kobo. Positive is money into the account. */
  readonly amountK: number;
  /**
   * Rekoda payment references found in the bank's text, extracted by the
   * caller. The rule never sees the narration itself — only the
   * references it carried (tier 1).
   */
  readonly references?: readonly string[];
}

/** Movement on the bank account, as the books recorded it. */
export interface MatchableMovement {
  readonly transactionId: string;
  readonly occurredOn: string;
  /** Signed kobo, same convention: debit less credit on the bank account. */
  readonly amountK: number;
  /**
   * The Rekoda payment reference this posting carries, when it carries
   * one — extracted by the caller, so the rule never reads a memo.
   */
  readonly reference?: string | null;
}

/** §22.1: the tiers that AUTO-match. Tier 3 proposes; tier 4 is a person. */
export type AutoMatchTier = 1 | 2;

export interface Match {
  readonly lineId: string;
  readonly transactionId: string;
  /** How many days apart the two were. Zero is the ordinary case. */
  readonly daysApart: number;
  /** Which §22.1 tier decided it: 1 exact reference, 2 strong deterministic. */
  readonly tier: AutoMatchTier;
}

/** A tier-3 proposal: shown to a human, NEVER applied (§22.1). */
export interface Suggestion {
  readonly lineId: string;
  readonly transactionId: string;
  /** Why it is only a suggestion, in vocabulary a surface can explain. */
  readonly why: 'reference_found_amount_differs';
}

export interface Ambiguity {
  readonly lineId: string;
  /** Every posting that fits, so the merchant is shown the actual choice. */
  readonly candidates: readonly string[];
}

export interface MatchResult {
  readonly matched: readonly Match[];
  /** Tier 3: the reference says these belong together but the amounts do
   * not agree — a bank charge, a partial transfer, a typo. Proposed to a
   * person, never applied: two figures are two facts. */
  readonly suggestions: readonly Suggestion[];
  /** More than one posting fits, so a person decides. */
  readonly ambiguous: readonly Ambiguity[];
  /** Nothing in the books fits. Often the point: money nobody recorded. */
  readonly unmatchedLines: readonly string[];
  /**
   * Nothing on the statement fits. Money the books claim and the bank does
   * not, which is the serious direction: a payment recorded that never came.
   *
   * A posting some line MIGHT be is not here. It is in `undecidedMovements`,
   * and the difference is the difference between "the bank never saw this"
   * and "one of these two is on the statement and nobody knows which". A
   * screen that called the second one absent would report ₦300,000 missing
   * from a bank that plainly shows ₦150,000 of it.
   */
  readonly unmatchedMovements: readonly string[];
  /** Candidates for a line that had more than one. Waiting on a person. */
  readonly undecidedMovements: readonly string[];
}

/**
 * How far apart a posting and a statement line may sit and still be the same
 * event.
 *
 * Four days covers a Friday transfer posting on Monday, plus a day. Wider
 * than that and a fortnightly rent and its own statement line start finding
 * each other's neighbours.
 */
export const MATCH_WINDOW_DAYS = 4;

const DAY = 86_400_000;

/** Whole days between two `YYYY-MM-DD` days, ignoring any clock. */
function daysBetween(a: string, b: string): number {
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / DAY;
}

/**
 * Pair what can only be paired one way.
 *
 * Two passes, and the second is what keeps this honest. The first collects
 * every candidate for every line; the second accepts a pairing only when the
 * line has exactly one candidate AND that posting has exactly one line
 * wanting it. A posting two lines both want is not a match either way round,
 * even though each line sees only one option.
 */
export function matchStatement(
  lines: readonly MatchableLine[],
  movements: readonly MatchableMovement[],
): MatchResult {
  /* ── tier 1: exact reference (§22.1) ──────────────────────────────────
   * The reference was minted to make reconciliation deterministic (§9),
   * so it is the ONE thing allowed to decide ahead of the amount-and-date
   * pass — including through an ambiguity that pass could never resolve.
   * It still refuses on a disagreeing amount: the pair becomes a tier-3
   * SUGGESTION, because two figures are two facts. */
  const matched: Match[] = [];
  const suggestions: Suggestion[] = [];
  const takenLines = new Set<string>();
  const takenByReference = new Set<string>();

  const linesByReference = new Map<string, MatchableLine[]>();
  for (const line of lines) {
    for (const reference of new Set(line.references ?? [])) {
      const wanting = linesByReference.get(reference);
      if (wanting) wanting.push(line);
      else linesByReference.set(reference, [line]);
    }
  }
  const referenced = movements
    .filter((m) => m.reference)
    .sort((a, b) => a.transactionId.localeCompare(b.transactionId));
  for (const movement of referenced) {
    if (takenByReference.has(movement.transactionId)) continue;
    const wanting = (linesByReference.get(movement.reference!) ?? []).filter(
      (l) => !takenLines.has(l.id),
    );
    /* Two lines carrying the same reference is exactly when a computer
     * should stop: neither is claimed, both stay for the person. */
    if (wanting.length !== 1) continue;
    const line = wanting[0]!;
    if (line.amountK !== movement.amountK) {
      suggestions.push({
        lineId: line.id,
        transactionId: movement.transactionId,
        why: 'reference_found_amount_differs',
      });
      continue;
    }
    matched.push({
      lineId: line.id,
      transactionId: movement.transactionId,
      daysApart: daysBetween(line.postedOn, movement.occurredOn),
      tier: 1,
    });
    takenLines.add(line.id);
    takenByReference.add(movement.transactionId);
  }

  const openLines = lines.filter((l) => !takenLines.has(l.id));
  const openMovements = movements.filter((m) => !takenByReference.has(m.transactionId));

  /* ── tier 2: strong deterministic ─────────────────────────────────── */
  const candidatesFor = new Map<string, string[]>();
  const wantedBy = new Map<string, string[]>();

  /**
   * The amount predicate is exact equality, so it is hashable, and hashing it
   * is what makes this function safe to run over a whole statement: scanning
   * every movement for every line is quadratic, and a three-year statement
   * against three years of postings is a page load that blocks the event
   * loop for minutes. Bucketed by amount, the work is proportional to the
   * lines plus the movements plus the genuine amount collisions, which is
   * the part a human actually has to think about anyway.
   */
  const byAmount = new Map<number, MatchableMovement[]>();
  const byTransactionId = new Map<string, MatchableMovement>();
  for (const m of openMovements) {
    const bucket = byAmount.get(m.amountK);
    if (bucket) bucket.push(m);
    else byAmount.set(m.amountK, [m]);
    byTransactionId.set(m.transactionId, m);
  }

  for (const line of openLines) {
    const fits = (byAmount.get(line.amountK) ?? []).filter(
      (m) => daysBetween(line.postedOn, m.occurredOn) <= MATCH_WINDOW_DAYS,
    );
    candidatesFor.set(
      line.id,
      fits.map((m) => m.transactionId),
    );
    for (const m of fits) {
      const wanting = wantedBy.get(m.transactionId);
      if (wanting) wanting.push(line.id);
      else wantedBy.set(m.transactionId, [line.id]);
    }
  }

  const ambiguous: Ambiguity[] = [];
  const unmatchedLines: string[] = [];
  const takenMovements = new Set<string>(takenByReference);

  for (const line of openLines) {
    const candidates = candidatesFor.get(line.id) ?? [];
    if (candidates.length === 0) {
      unmatchedLines.push(line.id);
      continue;
    }
    if (candidates.length > 1) {
      ambiguous.push({ lineId: line.id, candidates });
      continue;
    }
    const only = candidates[0]!;
    /* The posting wants this line back, or somebody else wants it too. */
    if ((wantedBy.get(only) ?? []).length !== 1) {
      ambiguous.push({ lineId: line.id, candidates });
      continue;
    }
    const movement = byTransactionId.get(only)!;
    matched.push({
      lineId: line.id,
      transactionId: only,
      daysApart: daysBetween(line.postedOn, movement.occurredOn),
      tier: 2,
    });
    takenMovements.add(only);
  }

  /* A posting cannot be both: a matched one was wanted by exactly one line,
   * so no other line has it as a candidate. */
  const undecided = new Set(ambiguous.flatMap((a) => a.candidates));
  const left = movements.filter((m) => !takenMovements.has(m.transactionId));

  return {
    matched,
    suggestions,
    ambiguous,
    unmatchedLines,
    unmatchedMovements: left
      .filter((m) => !undecided.has(m.transactionId))
      .map((m) => m.transactionId),
    undecidedMovements: left
      .filter((m) => undecided.has(m.transactionId))
      .map((m) => m.transactionId),
  };
}
