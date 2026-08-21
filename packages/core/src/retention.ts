/**
 * The published retention schedule (ADR 0024, /privacy#retention).
 *
 * Here rather than in the web app because two things must agree about it: the
 * page that promises a merchant a period, and the sweep that enforces it. Two
 * copies of a retention period is one page telling a merchant something the
 * database does not do.
 *
 * These are MAXIMUMS. A maximum is a promise about a date, which is why the
 * sweep exists at all: a published schedule nothing enforces becomes untrue on
 * a specific day rather than gradually. `apps/api/src/privacy/retention-sweep.ts`
 * keeps it.
 */
export const RETENTION = {
  /**
   * Books, after the year of assessment they belong to. Nigerian tax
   * administration's floor, and the reason an erasure request cannot take
   * invoices and ledger entries with it.
   */
  financialYears: 6,
  /** A trial nobody converted, after it ends. */
  abandonedTrialDays: 90,
  /** Chat history and drafts, after an account closes. Not financial records. */
  conversationDays: 90,
  /** Warning before anything is deleted on this schedule. */
  noticeDays: 30,
} as const;

/**
 * When the warning goes out: far enough before deletion that the merchant has
 * the full notice period to export, sign up or ask for more time.
 */
export const RETENTION_NOTICE_DAYS = RETENTION.abandonedTrialDays - RETENTION.noticeDays;

const DAY_MS = 86_400_000;

/** The date a record must be older than to be due. */
export function retentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS);
}
