/**
 * The count on the shelf, against the figure in the books.
 *
 * These two drift, and they drift in one direction. A purchase described in
 * prose — "restocked the shop, 50k" — debits INVENTORY and names no product,
 * so nothing ever credits it back when those goods are sold: cost of sale
 * only reaches the ledger through a product that carries a cost. From the
 * first such purchase the balance sheet overstates what the business owns,
 * and the gap only widens.
 *
 * Rekoda will not close that gap quietly. Silently writing the ledger down to
 * a count would destroy the only evidence that anything was wrong, and would
 * do it using a figure that is itself only as good as the costs a merchant
 * has recorded. So both numbers are shown, the difference is named, and one
 * posting is offered.
 */
import { sql } from 'drizzle-orm';
import { postStockCount } from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { auditEvents } from '../schema/ops.js';
import { writePosting } from './issue.js';

/** What the ledger calls a count that was acted on. */
export const STOCK_COUNT_SOURCE = 'stock_count';

export interface StockValuation {
  /** INVENTORY on the balance sheet: debits less credits, all time. */
  ledgerK: number;
  /** On hand times what it cost, over every product that has a cost. */
  countedK: number;
  /** countedK - ledgerK. Negative means the books claim stock nobody has. */
  differenceK: number;
  /**
   * Products holding stock that nobody has said the cost of.
   *
   * Load-bearing rather than informational. Their goods are real and their
   * value is missing from `countedK`, so an adjustment made while this is
   * above zero would write off stock the business still holds. The count is
   * shown either way; the posting is refused until it is nil.
   */
  uncosted: number;
}

/**
 * Both figures, from the two places they actually live.
 *
 * One statement rather than two round trips, because the whole instrument is
 * a comparison and a page that fetched the halves separately could show a
 * count and a ledger balance from different moments.
 */
export async function stockValuationFor(tx: TenantDb, businessId: string): Promise<StockValuation> {
  const rows = await tx.execute<{
    ledger_k: string;
    counted_k: string;
    uncosted: number;
  }>(sql`
    WITH ledger AS (
      SELECT COALESCE(SUM(e.debit_k) - SUM(e.credit_k), 0)::bigint AS ledger_k
      FROM ledger_entries e
      WHERE e.business_id = ${businessId}::uuid AND e.account = 'INVENTORY'
    ),
    held AS (
      SELECT p.unit_cost_k,
             GREATEST(COALESCE(SUM(m.delta), 0), 0)::int AS on_hand
      FROM products p
      LEFT JOIN inventory_movements m ON m.product_id = p.id
      WHERE p.business_id = ${businessId}::uuid
      GROUP BY p.id, p.unit_cost_k
    )
    SELECT ledger.ledger_k,
           COALESCE(SUM(held.on_hand * held.unit_cost_k), 0)::bigint AS counted_k,
           COUNT(*) FILTER (WHERE held.unit_cost_k IS NULL AND held.on_hand > 0)::int AS uncosted
    FROM ledger LEFT JOIN held ON true
    GROUP BY ledger.ledger_k
  `);
  const row = [...rows][0];
  const ledgerK = row ? Number(row.ledger_k) : 0;
  const countedK = row ? Number(row.counted_k) : 0;
  return {
    ledgerK,
    countedK,
    differenceK: countedK - ledgerK,
    uncosted: row?.uncosted ?? 0,
  };
}

export interface StockCountInput {
  businessId: string;
  actor: string;
  /**
   * The day it was counted, as `YYYY-MM-DD`.
   *
   * Recorded on the entry, deliberately NOT stamped as its date. The
   * difference being posted was computed from the shelf and the ledger as
   * they are right now, so dating it back into the month the merchant walked
   * the shelf would put figures derived from today into a month that did not
   * produce them. It lands today, where it was worked out.
   */
  countedOn: string;
}

export type StockCountOutcome =
  | { outcome: 'adjusted'; differenceK: number; countedK: number; ledgerTransactionId: string }
  | { outcome: 'agrees'; countedK: number }
  | { outcome: 'costs_missing'; uncosted: number };

/**
 * Bring the ledger to the count, and record where the difference went.
 *
 * The valuation is read INSIDE this transaction rather than taken from the
 * caller. A figure the browser posted back would be a figure from whenever
 * that page was rendered, and an adjustment computed from a stale count is
 * exactly the silent misstatement this whole instrument exists to surface.
 */
export async function recordStockCount(
  tx: TenantDb,
  input: StockCountInput,
): Promise<StockCountOutcome> {
  const valuation = await stockValuationFor(tx, input.businessId);
  if (valuation.uncosted > 0) {
    return { outcome: 'costs_missing', uncosted: valuation.uncosted };
  }
  if (valuation.differenceK === 0) {
    return { outcome: 'agrees', countedK: valuation.countedK };
  }

  const posting = postStockCount({
    memo: `Stock count ${input.countedOn}`,
    differenceK: valuation.differenceK,
  });
  const ledgerTransactionId = await writePosting(
    tx,
    input.businessId,
    posting,
    STOCK_COUNT_SOURCE,
    input.countedOn,
  );

  await tx.insert(auditEvents).values({
    businessId: input.businessId,
    actor: input.actor,
    entity: 'stock_count',
    entityId: ledgerTransactionId,
    action: 'adjusted',
    newValue: {
      countedOn: input.countedOn,
      ledgerK: valuation.ledgerK,
      countedK: valuation.countedK,
      differenceK: valuation.differenceK,
    } as never,
    sourceType: 'dashboard',
  });

  return {
    outcome: 'adjusted',
    differenceK: valuation.differenceK,
    countedK: valuation.countedK,
    ledgerTransactionId,
  };
}
