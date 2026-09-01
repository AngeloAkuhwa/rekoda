/**
 * The platform-cost subledger (canonical spec §29, COST-1, migration 0107).
 *
 * Append-only: real money Rekoda spends, one immutable fact per charge.
 * `usage_events` stays telemetry; this is the financial record the margin
 * model stands on. The application may INSERT and never UPDATE or DELETE;
 * only the worker credential reads it, because business_id is nullable and
 * the reader is the margin engine sweeping every tenant.
 */
import { sql } from 'drizzle-orm';
import { bigint, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { businesses } from './tenancy.js';

export const platformCostEvents = pgTable(
  'platform_cost_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    provider: text('provider').notNull(),
    providerProduct: text('provider_product').notNull(),
    /**
     * Nullable: some costs are not attributable to one merchant.
     *
     * That nullability is why the three references below need a CHECK as well
     * as a composite key (0140). MATCH SIMPLE skips a foreign key when EITHER
     * column is null, so without the CHECK a row could name another
     * merchant's payment while claiming to be unattributed.
     */
    businessId: uuid('business_id').references(() => businesses.id),
    /** Composite FK to `payment_connections (business_id, id)` plus a CHECK
     * that naming one requires saying whose it is; both in migration 0140. */
    paymentConnectionId: uuid('payment_connection_id'),
    /** Composite FK to `payments (business_id, id)` plus its CHECK (0140). */
    paymentId: uuid('payment_id'),
    /** Composite FK to `settlements (business_id, id)` plus its CHECK (0140). */
    settlementId: uuid('settlement_id'),
    /** MESSAGING · AI_INFERENCE · OCR · PAYMENT_FEE · BANK_FEED · STORAGE · TELEPHONY */
    costType: text('cost_type').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    taxMinor: bigint('tax_minor', { mode: 'number' }),
    /** The provider's own id for the charge; the idempotency spine with `provider`. */
    externalReference: text('external_reference').notNull(),
    incurredAt: timestamp('incurred_at', { withTimezone: true }).notNull(),
    /** PROVIDER_INVOICE · PROVIDER_API · DERIVED_FROM_RATE_CARD */
    source: text('source').notNull(),
    /** Single-column on purpose: `provider_cost_schedules` has no business_id.
     * It is platform reference data with no tenant to carry (0140). */
    costScheduleId: uuid('cost_schedule_id'),
    /** ACTUAL · ESTIMATED */
    actualOrEstimated: text('actual_or_estimated').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('platform_cost_events_reference_ux').on(t.provider, t.externalReference),
    index('platform_cost_events_business_ix').on(t.businessId, t.incurredAt),
    index('platform_cost_events_type_ix').on(t.costType, t.incurredAt),
  ],
);
