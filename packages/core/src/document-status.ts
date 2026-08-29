/**
 * The three dimensions of a document's state (spec Appendix E.3; PR-084).
 *
 * An invoice is simultaneously ISSUED, PARTIALLY_PAID and OVERDUE, and a
 * single column cannot say that. Lifecycle MAY be persisted — DRAFT →
 * ISSUED → VOID are real transitions somebody performed and there is no
 * other record of them. The other two dimensions are DERIVED, always:
 * payment from totals, allocations and applied credits; collection from
 * those plus the due date. A stored copy of a derived fact is a second
 * answer to the same question, free to disagree the day nobody is looking.
 *
 * Bills mirror this exactly (E.3's own words): the same payment vocabulary,
 * the same derivation, the debt merely pointing the other way.
 */
import { lagosDay } from './recurring.js';
import { isOverdue } from './due-dates.js';
import type { Kobo } from './money.js';

/** UNPAID · PARTIALLY_PAID · PAID — from what has actually settled. */
export type DocumentPaymentStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

/**
 * What has settled against what was billed. `settledK` is payments PLUS
 * applied credits — a debt worked off by credit is as settled as one paid
 * in cash, and E.3 names both.
 */
export function paymentStatusFor(totalK: Kobo, settledK: Kobo): DocumentPaymentStatus {
  if (settledK <= 0) return 'UNPAID';
  if (settledK < totalK) return 'PARTIALLY_PAID';
  return 'PAID';
}

/**
 * CURRENT · DUE · OVERDUE — what is being done about getting paid.
 *
 * The derivable subset of E.3's vocabulary: IN_DISPUTE, IN_COLLECTION and
 * WRITTEN_OFF are collection ACTS somebody records, and until a surface
 * records them there is nothing honest to derive them from. Absent, named,
 * never guessed.
 *
 * CURRENT deliberately covers a settled document, an undated debt and a
 * debt not yet due: none of them is being chased, and ageing an undated
 * debt would invent a deadline the merchant never set (the same rule the
 * ageing report follows). DUE is the due day itself, in Lagos — the day to
 * send the polite reminder, not yet the day anything is late.
 */
export type CollectionStatus = 'CURRENT' | 'DUE' | 'OVERDUE';

export function collectionStatusFor(
  dueDate: Date | null,
  balanceDueK: Kobo,
  now: Date,
): CollectionStatus {
  if (balanceDueK <= 0 || dueDate === null) return 'CURRENT';
  if (isOverdue(dueDate, balanceDueK, now)) return 'OVERDUE';
  if (lagosDay(dueDate) === lagosDay(now)) return 'DUE';
  return 'CURRENT';
}
