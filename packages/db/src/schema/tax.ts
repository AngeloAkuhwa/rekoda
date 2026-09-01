/**
 * The tax model as DATA (spec §13; migration 0099, PR-078).
 *
 * No hardcoded tax assumptions: what kinds of tax standing a business
 * has (codes, each with its treatment and its §13 tax-point policy) and
 * what the statutory rate was on a date (effective-dated observations,
 * the same derived-never-stored construction as provider cost cards)
 * are rows, per business, Nigeria-first at seed time.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { businesses } from './tenancy.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const businessId = () =>
  uuid('business_id')
    .notNull()
    .references(() => businesses.id);

export const taxCodes = pgTable(
  'tax_codes',
  {
    id: id(),
    businessId: businessId(),
    code: text('code').notNull(),
    label: text('label').notNull(),
    /** TAXABLE · ZERO_RATED · EXEMPT · OUT_OF_SCOPE. */
    treatment: text('treatment').notNull(),
    /** §13: WHEN the tax event occurs for lines under this code. */
    pointPolicy: text('point_policy').notNull().default('ON_INVOICE_ISSUE'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tax_codes_code_ux').on(t.businessId, t.code)],
);

export const taxRates = pgTable(
  'tax_rates',
  {
    id: id(),
    businessId: businessId(),
    taxCodeId: uuid('tax_code_id').notNull(),
    /** Basis points: 750 is Nigeria's 7.5% VAT. Zero is a real rate. */
    rateBps: integer('rate_bps').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tax_rates_ux').on(t.businessId, t.taxCodeId, t.effectiveFrom),
    index('tax_rates_code_ix').on(t.businessId, t.taxCodeId, t.effectiveFrom),
  ],
);

/**
 * TaxEvent (spec §13; migration 0100, PR-079): the record that a tax
 * point occurred. Append-only; the §13 unique is the idempotency.
 */
export const taxEvents = pgTable(
  'tax_events',
  {
    id: id(),
    businessId: businessId(),
    taxCodeId: uuid('tax_code_id').notNull(),
    basisMinor: bigint('basis_minor', { mode: 'number' }).notNull(),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('NGN'),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    /** The TAX POINT (§13) — not automatically the recognition moment. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** The posting that carried the tax to the books, when one did. The
     * composite FK to `ledger_transactions (business_id, id)` lives in
     * migration 0137; another tenant's posting is unrepresentable. */
    journalId: uuid('journal_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tax_events_ux').on(t.businessId, t.taxCodeId, t.sourceType, t.sourceId),
    index('tax_events_business_time_ix').on(t.businessId, t.occurredAt),
  ],
);
