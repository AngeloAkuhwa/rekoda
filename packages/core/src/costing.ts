/**
 * What the stock on the shelf cost (ADR 0004, the COGS account).
 *
 * `COGS` has been in the chart at code 5000 since the ledger was designed and
 * nothing has ever posted to it. The consequence is not cosmetic: inventory
 * only ever grows, a sale credits revenue with no cost against it, and the
 * profit and loss reports gross profit equal to revenue. That is not a figure
 * a merchant can trust or a lender can read.
 *
 * ── why weighted average ──────────────────────────────────────────────────
 *
 * FIFO needs a purchase history complete enough to say which batch a sale
 * came out of. A Nigerian small business tells Rekoda about the deliveries it
 * remembers, in the order it remembers them, and a costing method that is
 * wrong when the history has holes is worse than one that degrades. Weighted
 * average has no batches to lose: it is one number per product, and a missing
 * delivery moves it rather than breaking it.
 *
 * It is also the method an accountant here expects to see, which matters more
 * than the third decimal place of accuracy FIFO would buy.
 */
import type { Kobo } from './money.js';

/**
 * The new average unit cost after a delivery arrives.
 *
 * `onHand` below zero counts as zero. A negative count means the shelf and
 * the books already disagree, and weighting a new delivery against a negative
 * holding would produce a cost per unit that is not a cost of anything.
 *
 * Rounded to whole kobo, because every figure in this system is an integer
 * number of them and a fraction carried here would reappear as a rounding
 * difference on the balance sheet months later.
 */
export function weightedAverageCostK(args: {
  onHand: number;
  averageCostK: number | null;
  arriving: number;
  costK: Kobo;
}): number {
  if (args.arriving <= 0) throw new RangeError('a delivery of nothing has no cost per unit');
  if (args.costK < 0) throw new RangeError('a delivery cannot cost less than nothing');

  const held = Math.max(0, args.onHand);
  const heldValueK = args.averageCostK === null ? 0 : held * args.averageCostK;
  /* Nothing held, or nothing known about what it cost: the delivery IS the
   * average. Weighting against an unknown would be inventing a history. */
  if (held === 0 || args.averageCostK === null) return Math.round(args.costK / args.arriving);
  return Math.round((heldValueK + args.costK) / (held + args.arriving));
}

/**
 * What a quantity coming off the shelf cost.
 *
 * Null when the product has no cost recorded, which is a real and common
 * state rather than a failure: a merchant who has never told Rekoda what
 * something cost them has not given it a cost to report. The caller posts
 * nothing in that case, and the profit and loss says how much revenue had no
 * cost against it rather than quietly implying there was none.
 */
export function costOfQuantityK(averageCostK: number | null, quantity: number): number | null {
  if (averageCostK === null) return null;
  if (quantity <= 0) return null;
  return Math.round(averageCostK * quantity);
}

/**
 * The moving average after stock LEAVES at a stated cost (Appendix B:
 * a supplier return "reverses the receipt at the receipt's own cost,
 * and the average is recomputed as at that moment").
 *
 * Value-based, in integer kobo: new value = old value − removed value,
 * new average = new value ÷ new quantity, rounded once. Removing more
 * than is on hand is REFUSED — negative stock produces a negative
 * average no statement can survive (B.2). An uncosted line stays
 * uncosted: null in, null out.
 */
export function averageAfterRemovalK(args: {
  onHand: number;
  averageCostK: number | null;
  removing: number;
  unitCostK: number;
}): number | null {
  if (args.removing <= 0) throw new RangeError('a removal of nothing changes no average');
  if (args.removing > args.onHand) {
    throw new RangeError(
      `cannot remove ${args.removing} from ${args.onHand} on hand: negative stock is refused`,
    );
  }
  if (args.averageCostK === null) return null;
  const remaining = args.onHand - args.removing;
  if (remaining === 0) return null;
  const remainingValueK = args.onHand * args.averageCostK - args.removing * args.unitCostK;
  return Math.max(0, Math.round(remainingValueK / remaining));
}
