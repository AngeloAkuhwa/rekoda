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
 */

/** A line as the bank reported it. */
export interface MatchableLine {
  readonly id: string;
  readonly postedOn: string;
  /** Signed kobo. Positive is money into the account. */
  readonly amountK: number;
}

/** Movement on the bank account, as the books recorded it. */
export interface MatchableMovement {
  readonly transactionId: string;
  readonly occurredOn: string;
  /** Signed kobo, same convention: debit less credit on the bank account. */
  readonly amountK: number;
}

export interface Match {
  readonly lineId: string;
  readonly transactionId: string;
  /** How many days apart the two were. Zero is the ordinary case. */
  readonly daysApart: number;
}

export interface Ambiguity {
  readonly lineId: string;
  /** Every posting that fits, so the merchant is shown the actual choice. */
  readonly candidates: readonly string[];
}

export interface MatchResult {
  readonly matched: readonly Match[];
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
  const candidatesFor = new Map<string, string[]>();
  const wantedBy = new Map<string, string[]>();

  for (const line of lines) {
    const fits = movements.filter(
      (m) =>
        m.amountK === line.amountK && daysBetween(line.postedOn, m.occurredOn) <= MATCH_WINDOW_DAYS,
    );
    candidatesFor.set(
      line.id,
      fits.map((m) => m.transactionId),
    );
    for (const m of fits) {
      wantedBy.set(m.transactionId, [...(wantedBy.get(m.transactionId) ?? []), line.id]);
    }
  }

  const matched: Match[] = [];
  const ambiguous: Ambiguity[] = [];
  const unmatchedLines: string[] = [];
  const takenMovements = new Set<string>();

  for (const line of lines) {
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
    const movement = movements.find((m) => m.transactionId === only)!;
    matched.push({
      lineId: line.id,
      transactionId: only,
      daysApart: daysBetween(line.postedOn, movement.occurredOn),
    });
    takenMovements.add(only);
  }

  /* A posting cannot be both: a matched one was wanted by exactly one line,
   * so no other line has it as a candidate. */
  const undecided = new Set(ambiguous.flatMap((a) => a.candidates));
  const left = movements.filter((m) => !takenMovements.has(m.transactionId));

  return {
    matched,
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
