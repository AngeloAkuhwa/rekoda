/**
 * Tenancy + identity — spec §39/§40.
 * Every business-owned table in every other schema file carries businessId
 * and is covered by an RLS policy (see migrations/rls.sql).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** A person, keyed by verified phone. NO password column will ever exist. */
export const users = pgTable(
  'users',
  {
    id: id(),
    /** E.164. Unique — the phone IS the identity anchor. */
    phone: text('phone').notNull(),
    displayName: text('display_name'),
    /** STOP as a fact: set by STOP, cleared by START, checked before every proactive send. */
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_phone_ux').on(t.phone)],
);

/** The tenant. */
export const businesses = pgTable(
  'businesses',
  {
    id: id(),
    name: text('name').notNull(),
    businessType: text('business_type'),
    currency: text('currency').notNull().default('NGN'),
    country: text('country').notNull().default('NG'),
    /** CAC/TIN captured when available — never blocks onboarding (spec §20). */
    rcNumber: text('rc_number'),
    tin: text('tin'),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id),
    plan: text('plan').notNull().default('trial'), // trial | chat | integrate | complete
    /**
     * When the current plan period ends: a hard stop on a trial, the renewal
     * date on a paid plan (ADR 0024). One column, one meaning.
     */
    planExpiresAt: timestamp('plan_expires_at', { withTimezone: true }),
    trialStartedAt: timestamp('trial_started_at', { withTimezone: true }).notNull().defaultNow(),
    /** Start of the current paid cycle. The denominator when prorating. */
    cycleStartedAt: timestamp('cycle_started_at', { withTimezone: true }),
    /** The day of the month renewals anchor to, so short months do not drift. */
    renewalAnchorDay: smallint('renewal_anchor_day'),
    /** Set when a renewal charge fails; the seven-day grace clock starts here. */
    paymentFailedAt: timestamp('payment_failed_at', { withTimezone: true }),
    /** A downgrade waiting for the next renewal. Null renews onto the same plan. */
    pendingPlan: text('pending_plan'),
    /** The last grace-reminder day sent, claimed by conditional UPDATE. */
    lastGraceReminderDay: smallint('last_grace_reminder_day'),
    /**
     * The Lagos month through which the books are closed, or null.
     *
     * A watermark rather than a list of closed periods (migration 0034):
     * closing is monotonic, "closed through August" is one fact a merchant
     * can hold in their head, and reopening is then a single visible act. A
     * trigger on the ledger enforces it, so no writer can post behind it by
     * forgetting to look.
     */
    booksClosedThrough: text('books_closed_through'),
    settings: jsonb('settings')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('businesses_owner_ix').on(t.ownerUserId)],
);

/** Membership: who may act inside a tenant, and as what (spec §35). */
export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(), // owner | accountant | delegate
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('memberships_business_user_ux').on(t.businessId, t.userId),
    index('memberships_user_ix').on(t.userId),
  ],
);

/**
 * Provider connections (Integrate): WABA, catalogue, Paystack. Credentials
 * are AES-256-GCM blobs — never plaintext, never logged, never echoed.
 */
export const businessConnections = pgTable(
  'business_connections',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    provider: text('provider').notNull(), // meta_waba | catalogue | paystack | twilio_subaccount
    status: text('status').notNull().default('pending'), // pending | active | unhealthy | revoked
    /** Non-secret provider identifiers (WABA id, integration id…). */
    externalRef: text('external_ref'),
    /** Encrypted credential blob (v1.<iv>.<tag>.<ciphertext>), nullable. */
    encryptedCredential: text('encrypted_credential'),
    lastHealthyAt: timestamp('last_healthy_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('connections_business_provider_ux').on(t.businessId, t.provider)],
);

/* ── passwordless auth artefacts (spec §36) ── */

export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: id(),
    phone: text('phone').notNull(),
    /** SHA-256 of the code — the code itself is never stored. */
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('otp_phone_ix').on(t.phone)],
);

export const magicLinks = pgTable(
  'magic_links',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    /** SHA-256 of the URL token — the raw token exists only in the WhatsApp message. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('magic_links_token_ux').on(t.tokenHash)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    /** SHA-256 of the cookie value. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sessions_token_ux').on(t.tokenHash), index('sessions_user_ix').on(t.userId)],
);
