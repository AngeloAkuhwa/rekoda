/**
 * PaymentCharge (spec §19.1; PR-057): every line of a checkout breakdown
 * as a record. The SURCHARGE gate lives in core's breakdown builder — the
 * repo enforces it again at the write, because a charge a merchant did
 * not choose must not exist however it was asked for.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  SurchargeNotConfigured,
  type ChargeBeneficiary,
  type ChargeType,
  type EconomicFeeBearer,
} from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { paymentCharges } from '../schema/payments-hub.js';

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
