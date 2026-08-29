/**
 * The plan catalogue (canonical spec §30, migration 0105). BL2's step A.
 *
 * PlanVersion, PlanPrice and AllowanceVersion, exactly as the spec names
 * them: a plan version is a named set of entitlements and allowances,
 * effective-dated; a price belongs to a version, in a currency, over a
 * period; an allowance row is an immutable attribute of its version.
 *
 * One catalogue for every tenant, so no RLS - and the application may never
 * write it. Both app roles hold SELECT only; versioning belongs to
 * migrations and, later, an operator surface with its own credential.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const planVersions = pgTable(
  'plan_versions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** trial | expired | chat | integrate | complete */
    planId: text('plan_id').notNull(),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    /** Team seats beyond the owner ("owner + N"). */
    seats: integer('seats').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    /** Null means current; closed at the successor's effective_from. */
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('plan_versions_plan_id_version_key').on(t.planId, t.version)],
);

export const planVersionEntitlements = pgTable(
  'plan_version_entitlements',
  {
    planVersionId: uuid('plan_version_id')
      .notNull()
      .references(() => planVersions.id),
    /* FK to entitlements(key) in the migration; the 0052 catalogue has no
     * drizzle mirror to reference here. */
    entitlementKey: text('entitlement_key').notNull(),
  },
  (t) => [primaryKey({ columns: [t.planVersionId, t.entitlementKey] })],
);

export const planPrices = pgTable('plan_prices', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  planVersionId: uuid('plan_version_id')
    .notNull()
    .references(() => planVersions.id),
  currency: text('currency').notNull(),
  /** monthly | annual */
  billingInterval: text('billing_interval').notNull(),
  /** Minor units: kobo for NGN. Zero is a real price, never a gap. */
  amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  effectiveTo: timestamp('effective_to', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const allowanceVersions = pgTable(
  'allowance_versions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    planVersionId: uuid('plan_version_id')
      .notNull()
      .references(() => planVersions.id),
    /** A §4.2 usage unit; the migration's CHECK holds the canonical list. */
    unit: text('unit').notNull(),
    /** Sold units (minutes of voice, not seconds). No row means not sold. */
    allowance: integer('allowance').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('allowance_versions_plan_version_id_unit_key').on(t.planVersionId, t.unit)],
);

export const usagePacks = pgTable(
  'usage_packs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** The stable key charges reference (subscription_charges.pack_id). */
    packId: text('pack_id').notNull(),
    version: integer('version').notNull(),
    label: text('label').notNull(),
    /** A §4.2 usage unit; the migration's CHECK holds the canonical list. */
    unit: text('unit').notNull(),
    /** Sold units (minutes of voice, not seconds). */
    quantity: integer('quantity').notNull(),
    priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('usage_packs_pack_id_version_key').on(t.packId, t.version)],
);

export const addOns = pgTable(
  'add_ons',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    addOnId: text('add_on_id').notNull(),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    /** monthly */
    billingInterval: text('billing_interval').notNull(),
    /** Null means not self-service purchasable ("Custom initially"). */
    priceMinor: bigint('price_minor', { mode: 'number' }),
    currency: text('currency').notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('add_ons_add_on_id_version_key').on(t.addOnId, t.version)],
);
