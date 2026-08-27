/**
 * Goods coming back (spec §14.3; Appendix B.2/B.2a; F2, PR-080).
 *
 * The disposition decides the accounting, never the other way round:
 *
 *   RESALABLE    rejoins sellable stock at the ORIGINAL issue cost the
 *                outbound movement carried, DR Inventory / CR COGS, and
 *                THEN the weighted average recalculates — both required,
 *                not in tension (Appendix B's worked example).
 *   DAMAGED /    a holding location, not sellable stock. No movement.
 *   QUARANTINED  With a supported salvage value: DR Inventory at the
 *                salvage, the difference to the original issue cost as
 *                a NAMED inventory loss, CR COGS at the original cost.
 *                Without one, the economic loss stays where the return
 *                policy put it — inventory absorbs nothing.
 *   SCRAPPED     gone. No inventory value remains, no posting.
 *
 * A zero-value return is never admitted to sellable stock to make the
 * quantity balance: only RESALABLE writes a movement, structurally.
 * Physical quantity and financial valuation are different books, and
 * the goods_returns row is where a damaged quantity lives while its
 * value is still an open question.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  averageAfterRemovalK,
  weightedAverageCostK,
  type LedgerLine,
  type Posting,
} from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { goodsReturns, inventoryMovements, products } from '../schema/commerce.js';
import { auditEvents } from '../schema/ops.js';
import { writePosting } from './issue.js';
import { recordMovement } from './stock.js';

export type ReturnDisposition = 'RESALABLE' | 'DAMAGED' | 'QUARANTINED' | 'SCRAPPED';

export interface RecordGoodsReturnInput {
  businessId: string;
  productId: string;
  /** The sale the goods came back from, when the merchant named one. */
  invoiceId?: string | null;
  quantity: number;
  disposition: ReturnDisposition;
  /** TOTAL supported value on a DAMAGED or QUARANTINED return. */
  salvageValueK?: number | null;
  sourceType: string;
  sourceId?: string | null;
  actor: string;
}

export type GoodsReturnOutcome =
  | {
      outcome: 'returned';
      returnId: string;
      /** Per unit, from the outbound movement; null when it was uncosted. */
      originalIssueCostK: number | null;
      /** The product's average after the return. Unchanged unless RESALABLE. */
      averageCostK: number | null;
      ledgerTransactionId: string | null;
    }
  | {
      outcome: 'refused';
      reason: 'no_such_product' | 'salvage_needs_damaged_or_quarantined' | 'salvage_exceeds_cost';
    };

/** The issue cost the outbound movement carried for this sale, per unit. */
async function originalIssueCost(
  tx: TenantDb,
  businessId: string,
  productId: string,
  invoiceId: string | null,
): Promise<number | null> {
  const rows = await tx
    .select({ unitCostK: inventoryMovements.unitCostK })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.businessId, businessId),
        eq(inventoryMovements.productId, productId),
        eq(inventoryMovements.reason, 'sale'),
        ...(invoiceId ? [eq(inventoryMovements.sourceId, invoiceId)] : []),
      ),
    )
    .orderBy(desc(inventoryMovements.createdAt))
    .limit(1);
  return rows[0]?.unitCostK ?? null;
}

export async function recordGoodsReturn(
  tx: TenantDb,
  input: RecordGoodsReturnInput,
): Promise<GoodsReturnOutcome> {
  if (
    input.salvageValueK != null &&
    input.disposition !== 'DAMAGED' &&
    input.disposition !== 'QUARANTINED'
  ) {
    return { outcome: 'refused', reason: 'salvage_needs_damaged_or_quarantined' };
  }

  /* Locked like a delivery is: the average recalculation below reads the
   * on-hand sum, and two returns racing would both average against the
   * same pre-state. */
  const lockedRows = await tx.execute<{ unit_cost_k: string | number | null; on_hand: number }>(sql`
    SELECT p.unit_cost_k,
           (SELECT coalesce(sum(m.delta), 0)::int
              FROM inventory_movements m WHERE m.product_id = p.id) AS on_hand
    FROM products p
    WHERE p.business_id = ${input.businessId}::uuid AND p.id = ${input.productId}::uuid
    FOR UPDATE OF p
  `);
  const locked = [...lockedRows][0];
  if (!locked) return { outcome: 'refused', reason: 'no_such_product' };
  const currentAverageK = locked.unit_cost_k === null ? null : Number(locked.unit_cost_k);

  const issueCostK = await originalIssueCost(
    tx,
    input.businessId,
    input.productId,
    input.invoiceId ?? null,
  );
  const originalTotalK = issueCostK === null ? null : issueCostK * input.quantity;
  if (
    input.salvageValueK != null &&
    originalTotalK !== null &&
    input.salvageValueK > originalTotalK
  ) {
    /* Salvage above the original cost would book a GAIN through an
     * inventory-loss line. Whatever that is, it is not a return. */
    return { outcome: 'refused', reason: 'salvage_exceeds_cost' };
  }

  let ledgerTransactionId: string | null = null;
  let averageCostK = currentAverageK;

  if (input.disposition === 'RESALABLE') {
    /* 1–2: restore quantity at the ORIGINAL issue cost and reverse COGS
     * at that same historical cost — the part that protects gross profit
     * from a price swing. Uncosted history restores quantity only: no
     * figure is invented for a posting. */
    await recordMovement(tx, {
      businessId: input.businessId,
      productId: input.productId,
      delta: input.quantity,
      reason: 'return',
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      unitCostK: issueCostK,
    });
    if (issueCostK !== null && originalTotalK !== null && originalTotalK > 0) {
      const posting: Posting = {
        memo: `Goods returned to stock at original issue cost`,
        lines: [
          { account: 'INVENTORY', debitK: originalTotalK, creditK: 0 },
          { account: 'COGS', debitK: 0, creditK: originalTotalK },
        ] as LedgerLine[],
      };
      ledgerTransactionId = await writePosting(
        tx,
        input.businessId,
        posting,
        input.sourceType,
        input.sourceId ?? `return:${input.productId}`,
      );
      /* 3–4: the average RECALCULATES from the resulting quantity and
       * value — quantity times average must equal inventory value, and
       * holding the average fixed breaks that identity on the first
       * return (Appendix B, superseded-draft note). */
      averageCostK = weightedAverageCostK({
        onHand: locked.on_hand,
        averageCostK: currentAverageK,
        arriving: input.quantity,
        costK: originalTotalK,
      });
      await tx
        .update(products)
        .set({ unitCostK: averageCostK })
        .where(and(eq(products.businessId, input.businessId), eq(products.id, input.productId)));
    }
  } else if (
    (input.disposition === 'DAMAGED' || input.disposition === 'QUARANTINED') &&
    input.salvageValueK != null &&
    originalTotalK !== null &&
    originalTotalK > 0
  ) {
    /* Salvage: the SUPPORTED value becomes asset, the difference is a
     * NAMED inventory loss, and COGS is reversed at the original cost.
     * No movement — a damaged quantity is not sellable stock, and the
     * value sits against the holding location this row is. */
    const lossK = originalTotalK - input.salvageValueK;
    const lines: LedgerLine[] = [
      ...(input.salvageValueK > 0
        ? [{ account: 'INVENTORY', debitK: input.salvageValueK, creditK: 0 } as LedgerLine]
        : []),
      ...(lossK > 0 ? [{ account: 'EXPENSES', debitK: lossK, creditK: 0 } as LedgerLine] : []),
      { account: 'COGS', debitK: 0, creditK: originalTotalK } as LedgerLine,
    ];
    const posting: Posting = {
      memo: `Inventory loss on ${input.disposition.toLowerCase()} return (salvage recorded)`,
      lines,
    };
    ledgerTransactionId = await writePosting(
      tx,
      input.businessId,
      posting,
      input.sourceType,
      input.sourceId ?? `return:${input.productId}`,
    );
  }
  /* DAMAGED/QUARANTINED without salvage, and SCRAPPED: no movement and
   * no posting. The economic loss stays where the return policy put it;
   * inventory absorbs nothing (B.2a). */

  const rows = await tx
    .insert(goodsReturns)
    .values({
      businessId: input.businessId,
      productId: input.productId,
      invoiceId: input.invoiceId ?? null,
      quantity: input.quantity,
      disposition: input.disposition,
      originalIssueCostK: issueCostK,
      salvageValueK: input.salvageValueK ?? null,
      ledgerTransactionId,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
    })
    .returning({ id: goodsReturns.id });
  const row = rows[0];
  if (!row) throw new Error('recordGoodsReturn: insert returned no row');

  await tx.insert(auditEvents).values({
    businessId: input.businessId,
    actor: input.actor,
    entity: 'goods_return',
    entityId: row.id,
    action: 'returned',
    newValue: { quantity: input.quantity, disposition: input.disposition } as never,
    sourceType: input.sourceType,
  });

  return {
    outcome: 'returned',
    returnId: row.id,
    originalIssueCostK: issueCostK,
    averageCostK,
    ledgerTransactionId,
  };
}

export type SupplierReturnOutcome =
  | { outcome: 'returned'; averageCostK: number | null; ledgerTransactionId: string }
  | { outcome: 'refused'; reason: 'no_such_product' | 'more_than_on_hand' | 'uncosted_receipt' };

/**
 * Goods going BACK to a supplier (Appendix B): reverses the receipt at
 * the RECEIPT'S OWN cost, and the average is recomputed as at that
 * moment. Negative stock is refused before anything is written.
 */
export async function recordSupplierReturn(
  tx: TenantDb,
  input: {
    businessId: string;
    productId: string;
    quantity: number;
    /** The receipt's own per-unit cost being reversed. */
    unitCostK: number;
    /** Where the credit lands: the debt shrinks, or the cash comes back. */
    settledVia: 'ACCOUNTS_PAYABLE' | 'CASH' | 'BANK';
    sourceType: string;
    sourceId?: string | null;
    actor: string;
  },
): Promise<SupplierReturnOutcome> {
  const lockedRows = await tx.execute<{ unit_cost_k: string | number | null; on_hand: number }>(sql`
    SELECT p.unit_cost_k,
           (SELECT coalesce(sum(m.delta), 0)::int
              FROM inventory_movements m WHERE m.product_id = p.id) AS on_hand
    FROM products p
    WHERE p.business_id = ${input.businessId}::uuid AND p.id = ${input.productId}::uuid
    FOR UPDATE OF p
  `);
  const locked = [...lockedRows][0];
  if (!locked) return { outcome: 'refused', reason: 'no_such_product' };
  if (input.quantity > locked.on_hand) {
    return { outcome: 'refused', reason: 'more_than_on_hand' };
  }

  const averageCostK = averageAfterRemovalK({
    onHand: locked.on_hand,
    averageCostK: locked.unit_cost_k === null ? null : Number(locked.unit_cost_k),
    removing: input.quantity,
    unitCostK: input.unitCostK,
  });

  await recordMovement(tx, {
    businessId: input.businessId,
    productId: input.productId,
    delta: -input.quantity,
    reason: 'supplier_return',
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    unitCostK: input.unitCostK,
  });

  const totalK = input.unitCostK * input.quantity;
  const posting: Posting = {
    memo: 'Goods returned to supplier at receipt cost',
    lines: [
      { account: input.settledVia, debitK: totalK, creditK: 0 },
      { account: 'INVENTORY', debitK: 0, creditK: totalK },
    ] as LedgerLine[],
  };
  const ledgerTransactionId = await writePosting(
    tx,
    input.businessId,
    posting,
    input.sourceType,
    input.sourceId ?? `supplier-return:${input.productId}`,
  );

  await tx
    .update(products)
    .set({ unitCostK: averageCostK })
    .where(and(eq(products.businessId, input.businessId), eq(products.id, input.productId)));

  await tx.insert(auditEvents).values({
    businessId: input.businessId,
    actor: input.actor,
    entity: 'supplier_return',
    entityId: input.productId,
    action: 'returned',
    newValue: { quantity: input.quantity, unitCostK: input.unitCostK } as never,
    sourceType: input.sourceType,
  });

  return { outcome: 'returned', averageCostK, ledgerTransactionId };
}
