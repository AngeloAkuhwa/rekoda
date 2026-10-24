/**
 * PaymentCharge (spec §19.1; PR-057): every line of a checkout breakdown
 * as a record. The SURCHARGE gate lives in core's breakdown builder — the
 * repo enforces it again at the write, because a charge a merchant did
 * not choose must not exist however it was asked for.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import {
  SurchargeNotConfigured,
  type ChargeBeneficiary,
  type ChargeType,
  type EconomicFeeBearer,
} from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { orders } from '../schema/commerce.js';
import { invoices, payments } from '../schema/finance.js';
import { auditEvents } from '../schema/ops.js';
import { paymentCharges, paymentIntents } from '../schema/payments-hub.js';

export async function recordCharge(
  tx: TenantDb,
  input: {
    businessId: string;
    orderId: string;
    type: ChargeType;
    /** What the customer reads. Honest, not "convenience fee". */
    label: string;
    amountMinor: number;
    currency?: string;
    beneficiary: ChargeBeneficiary;
    economicBearer: EconomicFeeBearer;
    taxCode?: string | null;
    providerCostScheduleId?: string | null;
    /** The merchant's explicit choice; required for SURCHARGE. */
    surchargeConfigured?: boolean;
  },
): Promise<{ id: string }> {
  if (input.type === 'SURCHARGE' && !input.surchargeConfigured) {
    throw new SurchargeNotConfigured();
  }
  const rows = await tx
    .insert(paymentCharges)
    .values({
      businessId: input.businessId,
      orderId: input.orderId,
      type: input.type,
      label: input.label,
      amountMinor: input.amountMinor,
      ...(input.currency ? { currency: input.currency } : {}),
      beneficiary: input.beneficiary,
      economicBearer: input.economicBearer,
      ...(input.taxCode ? { taxCode: input.taxCode } : {}),
      ...(input.providerCostScheduleId
        ? { providerCostScheduleId: input.providerCostScheduleId }
        : {}),
    })
    .returning({ id: paymentCharges.id });
  const row = rows[0];
  if (!row) throw new Error('recordCharge: insert returned no row');
  return row;
}

/**
 * The breakdown, in the order the checkout wrote it. `id` is the tiebreaker,
 * not the sort key: migration 0148 makes `created_at` advance between rows
 * written in one transaction, but rows from before it keep their ties, and a
 * tie has to resolve the same way on every read or the receipt reshuffles
 * the moment `resolveChargeActual` moves a line in the heap.
 */
export async function chargesForOrder(tx: TenantDb, businessId: string, orderId: string) {
  return tx
    .select()
    .from(paymentCharges)
    .where(and(eq(paymentCharges.businessId, businessId), eq(paymentCharges.orderId, orderId)))
    .orderBy(paymentCharges.createdAt, paymentCharges.id);
}

/**
 * ESTIMATED at checkout, ACTUAL once settled (§19.1). The amount may move
 * with the resolution — the provider's real fee replaces the schedule's
 * guess — and resolves exactly once.
 *
 * Production reaches this through `resolveOrderProcessingFee` (G-116, OWN-42),
 * when the payout covering an order's last payment settles.
 */
export async function resolveChargeActual(
  tx: TenantDb,
  input: { businessId: string; chargeId: string; actualAmountMinor?: number },
): Promise<'resolved' | 'not_found' | 'already_actual'> {
  const rows = await tx
    .update(paymentCharges)
    .set({
      actualOrEstimated: 'ACTUAL',
      ...(input.actualAmountMinor !== undefined ? { amountMinor: input.actualAmountMinor } : {}),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(paymentCharges.businessId, input.businessId),
        eq(paymentCharges.id, input.chargeId),
        eq(paymentCharges.actualOrEstimated, 'ESTIMATED'),
      ),
    )
    .returning({ id: paymentCharges.id });
  if (rows.length === 1) return 'resolved';
  const exists = await tx
    .select({ id: paymentCharges.id })
    .from(paymentCharges)
    .where(
      and(eq(paymentCharges.businessId, input.businessId), eq(paymentCharges.id, input.chargeId)),
    )
    .limit(1);
  return exists[0] ? 'already_actual' : 'not_found';
}

export type OrderFeeResolution =
  'resolved' | 'no_estimate' | 'awaiting_payment' | 'awaiting_settlement' | 'no_fee_evidence';

/**
 * G-116 (OWN-42): an order's PAYMENT_PROCESSING charge becomes ACTUAL when
 * the payout covering the order's last payment has settled (§19.1 "once
 * settled"), never at authorisation. The figure is the sum of the provider's
 * own stated fee on each of the order's verified payments, so a part-paid
 * order counts every payment once, and the charge resolves exactly once (the
 * ESTIMATED predicate under a row lock). The estimate is not lost: when the
 * actual differs, an audit event keeps both figures.
 *
 * It waits, and changes nothing, while the order is not fully paid, while any
 * of its payments is not `settled` (a `held` payout is not final), or while a
 * payment carries no stated fee.
 */
export async function resolveOrderProcessingFee(
  tx: TenantDb,
  businessId: string,
  orderId: string,
): Promise<OrderFeeResolution> {
  const locked = await tx
    .select()
    .from(paymentCharges)
    .where(
      and(
        eq(paymentCharges.businessId, businessId),
        eq(paymentCharges.orderId, orderId),
        eq(paymentCharges.type, 'PAYMENT_PROCESSING'),
        eq(paymentCharges.actualOrEstimated, 'ESTIMATED'),
      ),
    )
    .orderBy(paymentCharges.createdAt, paymentCharges.id)
    .limit(1)
    .for('update');
  const charge = locked[0];
  if (!charge) return 'no_estimate';

  const orderRows = await tx
    .select({ totalK: orders.totalK, invoiceId: orders.invoiceId })
    .from(orders)
    .where(and(eq(orders.businessId, businessId), eq(orders.id, orderId)))
    .limit(1);
  const order = orderRows[0];
  if (!order) return 'no_estimate';

  const paid = await tx
    .select({
      amountK: payments.amountK,
      providerFeeK: payments.providerFeeK,
      settlementStatus: payments.settlementStatus,
    })
    .from(payments)
    .innerJoin(
      paymentIntents,
      and(
        eq(paymentIntents.businessId, payments.businessId),
        eq(paymentIntents.id, payments.paymentIntentId),
      ),
    )
    .where(
      and(
        eq(payments.businessId, businessId),
        /* Production intents name the invoice, never the order (the checkout
         * services mint them from `orders.invoiceId`), so the order is found
         * through either link. */
        or(
          eq(paymentIntents.orderId, orderId),
          order.invoiceId ? eq(paymentIntents.invoiceId, order.invoiceId) : sql`false`,
        ),
        eq(payments.verified, 1),
        inArray(payments.status, ['confirmed', 'partially_refunded']),
      ),
    );
  if (paid.length === 0) return 'awaiting_payment';
  /* Fully paid is read from what stands, not from gross payment amounts: a
   * part-refund unwinds allocations and reopens the invoice balance, and a
   * fee resolved over a reopened order would miss the next payment's fee. */
  if (order.invoiceId) {
    const inv = await tx
      .select({ balanceDueK: invoices.balanceDueK })
      .from(invoices)
      .where(and(eq(invoices.businessId, businessId), eq(invoices.id, order.invoiceId)))
      .limit(1);
    if (!inv[0] || Number(inv[0].balanceDueK) !== 0) return 'awaiting_payment';
  } else if (paid.reduce((sum, p) => sum + Number(p.amountK), 0) < Number(order.totalK)) {
    return 'awaiting_payment';
  }
  if (paid.some((p) => p.settlementStatus !== 'settled')) return 'awaiting_settlement';
  /* Paystack verify maps an absent `fees` to 0, so a stated zero cannot be
   * told from no evidence; a real card or transfer fee is never zero, and a
   * wrongly final zero is worse than an estimate that stays. */
  if (paid.some((p) => p.providerFeeK === null || Number(p.providerFeeK) <= 0)) {
    return 'no_fee_evidence';
  }

  const actualMinor = paid.reduce((sum, p) => sum + Number(p.providerFeeK), 0);
  const resolved = await resolveChargeActual(tx, {
    businessId,
    chargeId: charge.id,
    actualAmountMinor: actualMinor,
  });
  if (resolved !== 'resolved') return 'no_estimate';
  await tx.insert(auditEvents).values({
    businessId,
    actor: 'system',
    entity: 'payment_charge',
    entityId: charge.id,
    action: 'resolved_actual',
    oldValue: { actualOrEstimated: 'ESTIMATED', amountMinor: Number(charge.amountMinor) },
    newValue: { actualOrEstimated: 'ACTUAL', amountMinor: actualMinor, orderId },
    sourceType: 'settlement',
  });
  return 'resolved';
}

/** The orders the given payments settle (through their intents). */
export async function orderIdsForPayments(
  tx: TenantDb,
  businessId: string,
  paymentIds: string[],
): Promise<string[]> {
  if (paymentIds.length === 0) return [];
  const rows = await tx
    .selectDistinct({ orderId: orders.id })
    .from(payments)
    .innerJoin(
      paymentIntents,
      and(
        eq(paymentIntents.businessId, payments.businessId),
        eq(paymentIntents.id, payments.paymentIntentId),
      ),
    )
    .innerJoin(
      orders,
      and(
        eq(orders.businessId, payments.businessId),
        or(eq(orders.id, paymentIntents.orderId), eq(orders.invoiceId, paymentIntents.invoiceId)),
      ),
    )
    .where(and(eq(payments.businessId, businessId), inArray(payments.id, paymentIds)));
  return rows.map((r) => r.orderId);
}

/**
 * The same resolution, started from an invoice that has just closed: a
 * provider payment that settled while the rest of the balance was still to be
 * collected (a cash payment recorded later) is not stamped again, so the
 * closing payment is the other moment the order can become final.
 */
export async function resolveProcessingFeeForInvoice(
  tx: TenantDb,
  businessId: string,
  invoiceId: string,
): Promise<void> {
  const rows = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.businessId, businessId), eq(orders.invoiceId, invoiceId)));
  for (const row of rows) await resolveOrderProcessingFee(tx, businessId, row.id);
}
