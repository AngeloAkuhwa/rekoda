/**
 * What Rekoda charged a merchant, and for what (ADR 0024).
 *
 * Deliberately not part of the payment hub. `payments` and `payment_intents`
 * are the merchant's books - money their customers paid THEM, which posts to
 * their ledger. A subscription charge is money they paid us, and folding the
 * two together would inflate a merchant's revenue with our revenue.
 */
import { sql } from 'drizzle-orm';
import { bigint, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { businesses } from './tenancy.js';

export const subscriptionCharges = pgTable(
  'subscription_charges',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    /** first_purchase | renewal | upgrade | add_on | seat */
    kind: text('kind').notNull(),
    /** The plan paid for. Null on an add-on, which buys against the current one. */
    plan: text('plan'),
    /** An `ADD_ON_PACKS` id from core. Null on a plan charge. */
    packId: text('pack_id'),
    quantity: integer('quantity').notNull().default(1),
    /** Kobo. Zero is legal: a downgrade records the fact without taking money. */
    amountK: bigint('amount_k', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('NGN'),
    status: text('status').notNull().default('pending'),
    provider: text('provider').notNull().default('paystack'),
    /** Ours, globally unique: a callback names it before the tenant is known. */
    reference: text('reference').notNull(),
    providerReference: text('provider_reference'),
    periodStart: timestamp('period_start', { withTimezone: true }),
    periodEnd: timestamp('period_end', { withTimezone: true }),
    failureReason: text('failure_reason'),
    refundedAmountK: bigint('refunded_amount_k', { mode: 'number' }).notNull().default(0),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('subscription_charges_business_ix').on(t.businessId, t.createdAt)],
);
