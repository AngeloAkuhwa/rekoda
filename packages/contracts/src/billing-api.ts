/**
 * Self-service billing, on the wire (ADR 0024).
 *
 * Every amount here is integer KOBO and was computed by `@rekoda/core/billing`
 * before it reached this boundary. Nothing on the web tier does money
 * arithmetic; these schemas are what keeps that true.
 */
import { z } from 'zod';

const kobo = z.number().int().finite().nonnegative();
const isoDate = z.string().datetime({ offset: true });

/** Where a merchant stands: active, in grace after a failed card, or expired. */
export const billingStateView = z.discriminatedUnion('state', [
  z.object({ state: z.literal('active'), renewsAt: isoDate }),
  z.object({
    state: z.literal('grace'),
    endsAt: isoDate,
    daysLeft: z.number().int().nonnegative(),
  }),
  z.object({ state: z.literal('expired'), since: isoDate }),
  /** A trial has no cycle and no card. It ends; it does not lapse. */
  z.object({ state: z.literal('trial'), endsAt: isoDate.nullable() }),
]);

export const billingChargeView = z.object({
  reference: z.string(),
  kind: z.enum(['first_purchase', 'renewal', 'upgrade', 'add_on', 'seat']),
  plan: z.string().nullable(),
  packId: z.string().nullable(),
  amountK: kobo,
  status: z.enum(['pending', 'paid', 'failed', 'refunded']),
  periodStart: isoDate.nullable(),
  periodEnd: isoDate.nullable(),
  createdAt: isoDate,
});

export const billingUnitView = z.object({
  unit: z.enum(['messages', 'voice_seconds', 'documents', 'documents_understood', 'orders']),
  used: z.number().int().nonnegative(),
  /** The plan's own allowance, before anything bought. */
  allowance: z.number().int().nonnegative(),
  /** Bought capacity for this month. Does not roll over. */
  bonus: z.number().int().nonnegative(),
});

export const billingPackView = z.object({
  id: z.string(),
  label: z.string(),
  unit: z.string(),
  quantity: z.number().int().positive(),
  priceK: kobo,
});

export const billingOverviewResponse = z.object({
  plan: z.string(),
  priceK: kobo,
  status: billingStateView,
  /** The plan the next renewal moves to, when a downgrade is waiting. */
  pendingPlan: z.string().nullable(),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  units: z.array(billingUnitView),
  packs: z.array(billingPackView),
  charges: z.array(billingChargeView),
});

/** What a plan change costs today, and when it takes effect. */
export const billingQuoteResponse = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(['first_purchase', 'upgrade', 'downgrade', 'same']),
  amountK: kobo,
  effectiveFrom: z.enum(['now', 'next_renewal']),
  renewsAt: isoDate,
});

export const billingPlanChangeRequest = z.object({
  plan: z.enum(['chat', 'integrate', 'complete']),
});

/**
 * What happened when a merchant asked to change plan.
 *
 * `scheduled` costs nothing and waits for the renewal. `payment_required`
 * has opened a charge that is not paid until a provider says so. `unavailable`
 * is the honest answer while production Paystack is gated (spec §47): no
 * charge is opened, so nothing has to be cleaned up when it lifts.
 */
export const billingPlanChangeResponse = z.discriminatedUnion('state', [
  z.object({ state: z.literal('scheduled'), plan: z.string(), effectiveAt: isoDate }),
  z.object({
    state: z.literal('payment_required'),
    reference: z.string(),
    amountK: kobo,
    plan: z.string(),
  }),
  z.object({
    state: z.literal('unavailable'),
    reason: z.enum(['awaiting_platform_confirmation', 'no_cycle']),
  }),
]);

export type BillingStateView = z.infer<typeof billingStateView>;
export type BillingChargeView = z.infer<typeof billingChargeView>;
export type BillingUnitView = z.infer<typeof billingUnitView>;
export type BillingPackView = z.infer<typeof billingPackView>;
export type BillingOverviewResponse = z.infer<typeof billingOverviewResponse>;
export type BillingQuoteResponse = z.infer<typeof billingQuoteResponse>;
export type BillingPlanChangeRequest = z.infer<typeof billingPlanChangeRequest>;
export type BillingPlanChangeResponse = z.infer<typeof billingPlanChangeResponse>;
