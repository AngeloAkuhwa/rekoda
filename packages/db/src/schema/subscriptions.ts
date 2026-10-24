/**
 * What Rekoda charged a merchant, and for what (ADR 0024).
 *
 * Deliberately not part of the payment hub. `payments` and `payment_intents`
 * are the merchant's books - money their customers paid THEM, which posts to
 * their ledger. A subscription charge is money they paid us, and folding the
 * two together would inflate a merchant's revenue with our revenue.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
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
    /**
     * Paid, but its plan change was refused because a newer subscription
     * decision existed when it settled (G-104). The money is real and the
     * status stays `paid`; an operator reconciles it.
     */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    /**
     * OD-30: when a PAID charge's plan change was refused, why, and how an
     * operator resolved it. Open while `unappliedAt` is set and
     * `unappliedResolvedAt` is null.
     */
    unappliedAt: timestamp('unapplied_at', { withTimezone: true }),
    unappliedReason: text('unapplied_reason'),
    unappliedResolvedAt: timestamp('unapplied_resolved_at', { withTimezone: true }),
    unappliedResolution: text('unapplied_resolution'),
    unappliedResolvedBy: text('unapplied_resolved_by'),
    /** Retired because the merchant chose another plan, not because it went stale (migration 0163, G-105). */
    abandonedAt: timestamp('abandoned_at', { withTimezone: true }),
    /** What the provider verified it took (migration 0164, G-107); the excess over `amountK` is an overpayment. */
    paidAmountK: bigint('paid_amount_k', { mode: 'number' }),
    /** The Paystack checkout this charge was initialised with (migration 0172, G-102); null until the merchant starts paying. */
    checkoutUrl: text('checkout_url'),
    checkoutStartedAt: timestamp('checkout_started_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('subscription_charges_business_ix').on(t.businessId, t.createdAt)],
);

/**
 * One Paystack checkout session for a charge (migration 0173, G-102, OWN-50).
 *
 * Paystack rejects a reused reference, so a checkout whose link was lost is
 * replaced by a new attempt with its own provider reference. A charge has at
 * most one live attempt (`initializing`, `active` or `ambiguous`); the rest
 * are history. The first attempt's provider reference is the charge's own.
 */
export const subscriptionChargeAttempts = pgTable('subscription_charge_attempts', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  chargeId: uuid('charge_id').notNull(),
  attemptNo: smallint('attempt_no').notNull(),
  providerReference: text('provider_reference').notNull(),
  /** initializing | active | ambiguous | superseded | paid | duplicate_paid | failed */
  status: text('status').notNull().default('initializing'),
  checkoutUrl: text('checkout_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
