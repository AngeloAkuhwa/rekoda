/**
 * Reconciliation engine — spec §25/§26, the product's moat.
 *
 * Three realities meet here:
 *   an invoice says somebody SHOULD pay,
 *   a merchant says somebody SAYS they paid,
 *   a payment provider says money ACTUALLY moved.
 *
 * This module is pure and deterministic: given an expectation and an
 * observation it returns a verdict. It never mutates anything and it never
 * guesses — ambiguity is an EXCEPTION for a human, not a coin flip.
 */

import { assertKobo, type Kobo } from './money.js';

export type ExpectationKind = 'invoice' | 'order' | 'reported_payment';

export interface Expectation {
  readonly kind: ExpectationKind;
  /** e.g. invoice id / order id — opaque to this module. */
  readonly ref: string;
  readonly amountDueK: Kobo;
  readonly currency: string;
}

export interface Observation {
  /** e.g. Paystack reference — opaque to this module. */
  readonly ref: string;
  readonly amountK: Kobo;
  readonly currency: string;
  /** Provider-verified (webhook, signature-checked) vs merchant-reported. */
  readonly verified: boolean;
}

export type ReconciliationVerdict =
  | { readonly status: 'MATCHED'; readonly amountK: Kobo }
  | { readonly status: 'PARTIAL'; readonly amountK: Kobo; readonly outstandingK: Kobo }
  | {
      readonly status: 'EXCEPTION';
      readonly reason: 'overpayment' | 'currency_mismatch';
      readonly detailK: Kobo;
    };

/** Judge one observation against one expectation. */
export function reconcile(expected: Expectation, observed: Observation): ReconciliationVerdict {
  assertKobo(expected.amountDueK, 'amountDue');
  assertKobo(observed.amountK, 'observed amount');
  if (expected.currency !== observed.currency) {
    return { status: 'EXCEPTION', reason: 'currency_mismatch', detailK: observed.amountK };
  }
  if (observed.amountK > expected.amountDueK) {
    return {
      status: 'EXCEPTION',
      reason: 'overpayment',
      detailK: observed.amountK - expected.amountDueK,
    };
  }
  if (observed.amountK === expected.amountDueK) {
    return { status: 'MATCHED', amountK: observed.amountK };
  }
  return {
    status: 'PARTIAL',
    amountK: observed.amountK,
    outstandingK: expected.amountDueK - observed.amountK,
  };
}

/**
 * Candidate matching for an observation that arrived with no usable
 * reference (common: a bare transfer). Deterministic and conservative:
 *
 *   exactly one open expectation with the exact amount → that one;
 *   zero or several → UNMATCHED (a human decides; we never guess between
 *   two customers who both owe ₦85,000).
 */
export function findUniqueAmountMatch(
  openExpectations: readonly Expectation[],
  observed: Observation,
): Expectation | null {
  const candidates = openExpectations.filter(
    (e) => e.currency === observed.currency && e.amountDueK === observed.amountK,
  );
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

/**
 * "Payment Recorded" vs "Payment Verified" — the honesty rule (spec §10).
 * A merchant's report can settle a balance in the books; only a
 * provider-verified observation may ever mark money as CONFIRMED.
 */
export const paymentLabel = (observed: Observation): 'Payment Verified' | 'Payment Recorded' =>
  observed.verified ? 'Payment Verified' : 'Payment Recorded';
