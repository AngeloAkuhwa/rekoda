/**
 * The SEPARATED tax calculator (spec §13; F2, PR-079).
 *
 * "The tax point is not automatically the revenue-recognition point.
 * They coincide under Nigerian VAT for most of what Rekoda will see,
 * and that coincidence is exactly what would let them be fused by
 * accident." So this file is deliberately its own calculator: it reads
 * the same document state the recognition engine reads, and it answers
 * two questions the recognition engine never does — HOW MUCH tax a
 * basis carries under a treatment and rate, and WHEN the tax event
 * occurred under a point policy. It writes nothing; the repo records
 * what it answers, deduped at the database.
 */

export const TAX_TREATMENTS = ['TAXABLE', 'ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE'] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

export const TAX_POINT_POLICIES = [
  'ON_INVOICE_ISSUE',
  'ON_PAYMENT_RECEIPT',
  'ON_FULFILMENT',
] as const;
export type TaxPointPolicy = (typeof TAX_POINT_POLICIES)[number];

/**
 * Tax on a basis, under a treatment and a rate observed for the date.
 *
 * Half-up rounding on the last kobo, the same arithmetic the checkout
 * breakdown uses (§19.1) — two calculators that rounded differently
 * would disagree by one kobo on half of all documents, and the
 * disagreement would look like a bug in whichever was read second.
 * A non-TAXABLE treatment answers zero whatever rate rides along:
 * zero-rated and exempt both charge nothing, and OUT_OF_SCOPE is not a
 * tax question at all.
 */
export function calculateTax(input: {
  basisMinor: number;
  rateBps: number;
  treatment: TaxTreatment;
}): number {
  if (!Number.isSafeInteger(input.basisMinor) || input.basisMinor < 0) {
    throw new RangeError(`basisMinor must be a non-negative integer, got ${input.basisMinor}`);
  }
  if (!Number.isSafeInteger(input.rateBps) || input.rateBps < 0) {
    throw new RangeError(`rateBps must be a non-negative integer, got ${input.rateBps}`);
  }
  if (input.treatment !== 'TAXABLE') return 0;
  return Math.floor((input.basisMinor * input.rateBps + 5_000) / 10_000);
}

/**
 * WHEN the tax event occurred, under the code's §13 point policy.
 *
 * Null means the policy's moment has not happened yet — a real state,
 * never an invented date: an ON_PAYMENT_RECEIPT code on an unpaid
 * invoice has no tax point, and writing one anyway would be the fusion
 * §13 exists to prevent, just pointing the other way.
 */
export function taxPointFor(
  policy: TaxPointPolicy,
  moments: {
    issuedAt?: Date | null;
    paidAt?: Date | null;
    fulfilledAt?: Date | null;
  },
): Date | null {
  switch (policy) {
    case 'ON_INVOICE_ISSUE':
      return moments.issuedAt ?? null;
    case 'ON_PAYMENT_RECEIPT':
      return moments.paidAt ?? null;
    case 'ON_FULFILMENT':
      return moments.fulfilledAt ?? null;
  }
}
