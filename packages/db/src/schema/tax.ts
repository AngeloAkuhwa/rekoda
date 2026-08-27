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
