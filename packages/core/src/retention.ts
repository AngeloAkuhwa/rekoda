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
  /**
   * A payment-evidence claim nobody responds to, before it EXPIRES (spec
   * §23: "an unresolved claim must not live forever automatically" — an
   * abandoned dispute is the MOST likely state for a claim to be in).
   * The deadline is stamped when the claim is raised; this is the default a
   * business starts with, and §23 makes it business configuration, so BL2
   * may later move it to data. Implementation default, recorded in the
   * amendment log rather than invented silently.
   */
  evidenceResolutionDays: 14,
  /**
   * Raw evidence media (the screenshot itself), after the claim resolves or
   * expires. The claim, its amount and its outcome survive under
   * financial-record retention; what dies is the picture of somebody's bank
   * app, which is personal data with no reason to outlive the dispute it
   * belonged to. Suspended only by an EvidenceLegalHold.
   */
  evidenceRawDays: 90,
} as const;

/** When a claim raised at this moment expires if nobody responds. */
export function evidenceResolutionDeadline(raisedAt: Date): Date {
  return new Date(raisedAt.getTime() + RETENTION.evidenceResolutionDays * DAY_MS);
}

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
