/**
 * Proportional fulfilment arithmetic (spec §12.5, Appendix B; PR-047).
 *
 * "Partial fulfilment recognises only the fulfilled proportion. Never
 * more." The arithmetic that makes that true is exact: integer minor
 * units, quantities at a stated precision (three decimals), division
 * rounded DOWN by rule — never more — with the residual CARRIED, never
 * dropped: because the engine recognises cumulative deltas, whatever
 * rounding held back mid-way posts on the delivery that completes the
 * line, and a fully delivered line has earned exactly its total.
 */
import { RecognitionInvariantViolation } from './recognition.js';

/** Quantities are compared at this precision, as integers. */
const QUANTITY_SCALE = 1000;

export interface FulfilmentLine {
  /** The line's revenue, integer minor units. Never gross, never VAT. */
  lineTotalMinor: number;
  /** Ordered quantity. Up to three decimals. */
  quantity: number;
  /** Delivered so far, cumulative. Up to three decimals. */
  deliveredToDate: number;
}

const scaled = (value: number, what: string): bigint => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RecognitionInvariantViolation(`${what} must be a non-negative number, got ${value}`);
  }
  return BigInt(Math.round(value * QUANTITY_SCALE));
};

/**
 * What one line has earned, cumulatively: floor(total × delivered ÷
 * quantity), in BigInt so a large total times a large quantity cannot
 * slip through floating point.
 */
export function earnedForLineMinor(line: FulfilmentLine): number {
  if (!Number.isSafeInteger(line.lineTotalMinor) || line.lineTotalMinor < 0) {
    throw new RecognitionInvariantViolation(
      `line total must be a non-negative integer, got ${line.lineTotalMinor}`,
    );
  }
  const quantity = scaled(line.quantity, 'quantity');
  const delivered = scaled(line.deliveredToDate, 'delivered');
  if (quantity === 0n) {
    throw new RecognitionInvariantViolation('a line with zero quantity cannot be fulfilled');
  }
  if (delivered > quantity) {
    /* Over-delivery is a data defect, not extra revenue. */
    throw new RecognitionInvariantViolation(
      `delivered ${line.deliveredToDate} exceeds ordered ${line.quantity}`,
    );
  }
  return Number((BigInt(line.lineTotalMinor) * delivered) / quantity);
}

/** The order's earnedToDate: the sum of its lines' cumulative earnings. */
export function earnedToDateMinor(lines: readonly FulfilmentLine[]): number {
  return lines.reduce((sum, line) => sum + earnedForLineMinor(line), 0);
}
