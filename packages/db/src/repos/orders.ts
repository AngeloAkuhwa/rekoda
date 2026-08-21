/**
 * Orders somebody else placed (MASTER-PLAN §5.3.5).
 *
 * `orders` and `order_items` have been in the schema since M0 with nothing
 * writing them, waiting for a door that lets a customer rather than a
 * merchant say what they want. This is the first of those doors: a message
 * the customer wrote, forwarded by the merchant.
 *
 * An order is NOT a financial document. Nothing is owed and nothing is
 * posted: the merchant has been asked, and until they agree there is no sale
 * and no ledger entry. Agreeing is what raises the invoice, and that is a
 * separate write with its own posting.
 *
 * ── what is deliberately not stored ────────────────────────────────────────
 *
 * The customer's own words. A forwarded message carries a name, often a
 * phone number and frequently a delivery address, all belonging to somebody
 * who never agreed to Rekoda holding them. What survives is what the books
 * need: which products, how many, at what price. The rest is echoed back to
 * the merchant once, in the preview, and never written down. It is already
 * on their phone in the message they forwarded.
 */
import { and, eq, sql } from 'drizzle-orm';
import { lagosYear } from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { orders, orderItems } from '../schema/commerce.js';
import { nextDocumentNumber } from './issue.js';

export interface PlaceOrderLine {
  productId: string;
  name: string;
  quantity: number;
  unitPriceK: number;
  lineTotalK: number;
}

export interface PlaceOrderInput {
  businessId: string;
  customerId: string | null;
  lines: PlaceOrderLine[];
  totalK: number;
  sourceType: string;
  sourceId: string;
  /**
   * The provider's own id for this order, when one exists. Null for a
   * forwarded message, which has no id of its own; the catalogue webhook
   * (Door 3) will have one, and the unique index makes a redelivered webhook
   * a no-op rather than a second order.
   */
  externalRef?: string | null;
  placedAt?: Date;
}

export interface PlacedOrder {
  id: string;
  orderNumber: string;
}

export async function placeOrder(tx: TenantDb, input: PlaceOrderInput): Promise<PlacedOrder> {
  const placedAt = input.placedAt ?? new Date();
  /* The counter first and inside the caller's transaction, same as every
   * other numbered document: a failure below un-bumps it, so numbering stays
   * dense and there is no gap for an auditor to read as a deletion. */
  const orderNumber = await nextDocumentNumber(tx, input.businessId, 'order', lagosYear(placedAt));

  const rows = await tx
    .insert(orders)
    .values({
      businessId: input.businessId,
      customerId: input.customerId,
      orderNumber,
      status: 'placed',
      totalK: input.totalK,
      externalRef: input.externalRef ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      createdAt: placedAt,
    })
    .returning({ id: orders.id });
  const order = rows[0];
  if (!order) throw new Error('placeOrder: insert returned no row');

  if (input.lines.length > 0) {
    await tx.insert(orderItems).values(
      input.lines.map((line) => ({
        businessId: input.businessId,
        orderId: order.id,
        productId: line.productId,
        name: line.name,
        quantity: line.quantity,
        unitPriceK: line.unitPriceK,
        lineTotalK: line.lineTotalK,
      })),
    );
  }

  return { id: order.id, orderNumber };
}

export type MarkOutcome = 'marked' | 'already' | 'not_found';

/**
 * Move an order on, once and only once.
 *
 * `status = ${from}` in the WHERE is the mutual exclusion, and it is the same
 * shape the void and the credit note use: the status read a moment ago
 * settles nothing, because two callers both read `placed` before either
 * writes. Only this UPDATE decides, so only its winner may raise the invoice
 * that follows.
 *
 * `invoiceId` is written by the same statement that moves the status, not by
 * a second one. A confirmed order with no invoice attached would be a row
 * claiming a document exists with no way to find it, and the register would
 * be back to matching them by eye.
 */
export async function markOrder(
  tx: TenantDb,
  businessId: string,
  id: string,
  from: string,
  to: string,
  invoiceId?: string,
): Promise<MarkOutcome> {
  const moved = await tx
    .update(orders)
    .set({ status: to, updatedAt: new Date(), ...(invoiceId ? { invoiceId } : {}) })
    .where(and(eq(orders.businessId, businessId), eq(orders.id, id), eq(orders.status, from)))
    .returning({ id: orders.id });
  if (moved.length === 1) return 'marked';

  const existing = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.businessId, businessId), eq(orders.id, id)))
    .limit(1);
  return existing.length === 1 ? 'already' : 'not_found';
}

export interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  totalK: number;
  invoiceId: string | null;
  placedAt: Date;
  lines: { name: string; quantity: number; unitPriceK: number; lineTotalK: number }[];
}

/** One order and its lines, for the register and for the tests. */
export async function orderByNumber(
  tx: TenantDb,
  businessId: string,
  orderNumber: string,
): Promise<OrderRow | null> {
  const rows = await tx
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalK: orders.totalK,
      invoiceId: orders.invoiceId,
      placedAt: orders.createdAt,
    })
    .from(orders)
    .where(and(eq(orders.businessId, businessId), eq(orders.orderNumber, orderNumber)))
    .limit(1);
  const order = rows[0];
  if (!order) return null;

  const lines = await tx
    .select({
      name: orderItems.name,
      quantity: orderItems.quantity,
      unitPriceK: orderItems.unitPriceK,
      lineTotalK: orderItems.lineTotalK,
    })
    .from(orderItems)
    .where(and(eq(orderItems.businessId, businessId), eq(orderItems.orderId, order.id)))
    .orderBy(orderItems.name);

  return {
    ...order,
    totalK: Number(order.totalK),
    lines: lines.map((line) => ({
      name: line.name,
      quantity: line.quantity,
      unitPriceK: Number(line.unitPriceK),
      lineTotalK: Number(line.lineTotalK),
    })),
  };
}

export interface OrderSummary {
  id: string;
  orderNumber: string;
  status: string;
  totalK: number;
  /** The invoice it became, by NUMBER, or null while it is still a request. */
  invoiceNumber: string | null;
  placedAt: Date;
  itemCount: number;
}

/** Every order this shop has taken, newest first. */
export async function ordersFor(
  tx: TenantDb,
  businessId: string,
  limit = 100,
): Promise<OrderSummary[]> {
  const rows = await tx.execute<{
    id: string;
    order_number: string;
    status: string;
    total_k: string;
    invoice_number: string | null;
    placed_at: Date;
    item_count: number;
  }>(sql`
    SELECT o.id, o.order_number, o.status, o.total_k::bigint AS total_k,
           inv.invoice_number, o.created_at AS placed_at,
           count(i.id)::int AS item_count
    FROM orders o
    LEFT JOIN order_items i ON i.order_id = o.id AND i.business_id = o.business_id
    LEFT JOIN invoices inv ON inv.id = o.invoice_id AND inv.business_id = o.business_id
    WHERE o.business_id = ${businessId}::uuid
    GROUP BY o.id, o.order_number, o.status, o.total_k, inv.invoice_number, o.created_at
    ORDER BY o.created_at DESC
    LIMIT ${limit}
  `);

  return [...rows].map((r) => ({
    id: r.id,
    orderNumber: r.order_number,
    status: r.status,
    totalK: Number(r.total_k),
    invoiceNumber: r.invoice_number,
    placedAt: new Date(r.placed_at),
    itemCount: r.item_count,
  }));
}
