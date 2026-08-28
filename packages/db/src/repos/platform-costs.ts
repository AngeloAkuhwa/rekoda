/**
 * The platform-cost subledger (canonical spec §29, COST-1, migration 0107).
 *
 * One writer shape and a few reads. The write is idempotent on
 * `(provider, external_reference)`: a retried job meets the unique index
 * and records one fact, which is invariant 14's property applied to
 * Rekoda's own money. The application role can only ever add facts - the
 * database revokes UPDATE and DELETE from both app roles, and SELECT from
 * the merchant-facing one - so append-only is a property, not a promise.
 */
import { sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';

export const COST_TYPES = [
  'MESSAGING',
  'AI_INFERENCE',
  'OCR',
  'PAYMENT_FEE',
  'BANK_FEED',
  'STORAGE',
  'TELEPHONY',
] as const;
export type CostType = (typeof COST_TYPES)[number];

export type CostSource = 'PROVIDER_INVOICE' | 'PROVIDER_API' | 'DERIVED_FROM_RATE_CARD';

export interface NewCostEvent {
  provider: string;
  /** The provider's product line: a template category, a model name, a fee code. */
  providerProduct: string;
  /** Null when the cost is not attributable to one merchant. */
  businessId?: string | null;
  paymentConnectionId?: string | null;
  paymentId?: string | null;
  settlementId?: string | null;
  costType: CostType;
  /** Minor units of `currency`: kobo for NGN. */
  amountMinor: number;
  currency: string;
  taxMinor?: number | null;
  /**
   * The provider's own id for the charge - or, for a rate-card derivation,
   * the deterministic internal key it derives from. With `provider`, the
   * idempotency spine.
   */
  externalReference: string;
  incurredAt: Date;
  source: CostSource;
  costScheduleId?: string | null;
  actualOrEstimated: 'ACTUAL' | 'ESTIMATED';
}

/**
 * Record one cost fact, exactly once.
 *
 * `ON CONFLICT DO NOTHING` without a named arbiter, and deliberately no
 * RETURNING: writers run inside tenant-pinned transactions where the app
 * role holds INSERT and not SELECT (naming the arbiter columns would
 * demand SELECT on them), the reference unique is the only conflict this
 * insert can meet, and a writer has no decision to make on "already
 * recorded" anyway - the fact is there, which is what it wanted.
 */
export async function recordCostEvent(tx: TenantDb | Db, event: NewCostEvent): Promise<void> {
  await tx.execute(sql`
    INSERT INTO platform_cost_events
      (provider, provider_product, business_id, payment_connection_id,
       payment_id, settlement_id, cost_type, amount_minor, currency,
       tax_minor, external_reference, incurred_at, source, cost_schedule_id,
       actual_or_estimated)
    VALUES
      (${event.provider}, ${event.providerProduct},
       ${event.businessId ?? null}, ${event.paymentConnectionId ?? null},
       ${event.paymentId ?? null}, ${event.settlementId ?? null},
       ${event.costType}, ${event.amountMinor}, ${event.currency},
       ${event.taxMinor ?? null}, ${event.externalReference},
       ${event.incurredAt.toISOString()}::timestamptz, ${event.source},
       ${event.costScheduleId ?? null}, ${event.actualOrEstimated})
    ON CONFLICT DO NOTHING
  `);
}

export interface CostLine {
  costType: CostType;
  provider: string;
  actualOrEstimated: 'ACTUAL' | 'ESTIMATED';
  amountMinor: number;
  events: number;
}

/**
 * One merchant's platform cost over a window, by type and provider - the
 * read the margin engine reconstructs from (BL2 completion gate). Worker
 * credential: the app role cannot read this table at all.
 */
export async function costsForBusiness(
  db: Db,
  businessId: string,
  from: Date,
  to: Date,
): Promise<CostLine[]> {
  const rows = await db.execute<{
    cost_type: string;
    provider: string;
    actual_or_estimated: string;
    amount_minor: string | number;
    events: number;
  }>(sql`
    SELECT cost_type, provider, actual_or_estimated,
           sum(amount_minor)::bigint AS amount_minor,
           count(*)::int AS events
    FROM platform_cost_events
    WHERE business_id = ${businessId}::uuid
      AND incurred_at >= ${from.toISOString()}::timestamptz
      AND incurred_at < ${to.toISOString()}::timestamptz
    GROUP BY cost_type, provider, actual_or_estimated
    ORDER BY cost_type, provider
  `);
  return [...rows].map((row) => ({
    costType: row.cost_type as CostType,
    provider: row.provider,
    actualOrEstimated: row.actual_or_estimated as 'ACTUAL' | 'ESTIMATED',
    amountMinor: Number(row.amount_minor),
    events: row.events,
  }));
}

export interface PlatformCostSummary extends CostLine {
  /** Null rows are real: cost nobody's subscription carries. */
  attributed: boolean;
}

/** The whole platform's cost over a window, attributable and not. */
export async function costSummary(db: Db, from: Date, to: Date): Promise<PlatformCostSummary[]> {
  const rows = await db.execute<{
    cost_type: string;
    provider: string;
    actual_or_estimated: string;
    attributed: boolean;
    amount_minor: string | number;
    events: number;
  }>(sql`
    SELECT cost_type, provider, actual_or_estimated,
           (business_id IS NOT NULL) AS attributed,
           sum(amount_minor)::bigint AS amount_minor,
           count(*)::int AS events
    FROM platform_cost_events
    WHERE incurred_at >= ${from.toISOString()}::timestamptz
      AND incurred_at < ${to.toISOString()}::timestamptz
    GROUP BY cost_type, provider, actual_or_estimated, (business_id IS NOT NULL)
    ORDER BY cost_type, provider
  `);
  return [...rows].map((row) => ({
    costType: row.cost_type as CostType,
    provider: row.provider,
    actualOrEstimated: row.actual_or_estimated as 'ACTUAL' | 'ESTIMATED',
    attributed: row.attributed,
    amountMinor: Number(row.amount_minor),
    events: row.events,
  }));
}
