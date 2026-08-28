/**
 * The Payment Hub's storage (docs/payments-v1.md §3–9).
 *
 * Provider-NEUTRAL by column design: `provider_type` is data, external
 * identifiers are opaque text, and nothing in here spells "subaccount code" as
 * a concept the rest of the system could grow to depend on. Only the adapter
 * for a given provider knows what its `external_subaccount_id` means.
 *
 * Deliberately NOT a reuse of `business_connections` — that table is channel
 * plumbing (WABA ids, catalogue links). Settlement details, KYC state and
 * capabilities are payment semantics, and folding them into the channel table
 * would couple two lifecycles that change for different reasons.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { businesses } from './tenancy.js';
import { customers } from './privacy.js';
import { invoices } from './finance.js';
import { orders } from './commerce.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** One merchant's standing with one payment provider (payments-v1 §3–5). */
export const paymentConnections = pgTable(
  'payment_connections',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    providerType: text('provider_type').notNull(), // paystack | monnify | …
    /** Opaque provider identifiers. Only the matching adapter reads them. */
    externalMerchantId: text('external_merchant_id'),
    externalSubaccountId: text('external_subaccount_id'),
    settlementBankCode: text('settlement_bank_code'),
    /**
     * The full account number lives ONLY as a vault blob; `last4` exists so
     * every surface can render `GTBank •••• 4821` without a decrypt.
     */
    settlementAccountCipher: text('settlement_account_cipher'),
    settlementAccountLast4: text('settlement_account_last4'),
    settlementAccountName: text('settlement_account_name'),
    /** The §5 state machine. The CHECK constraint lives in the migration.
     * BLENDED and on its way out: §17.1 splits it into the four axes
     * below (PR-051); readers cut over to `productionEnabled` in P1. */
    status: text('status').notNull().default('pending_details'),
    kycStatus: text('kyc_status').notNull().default('pending'),
    /** §17.1's independent axes: they fail independently, so blending
     * them makes real states unrepresentable. */
    operationalStatus: text('operational_status').notNull().default('NOT_CONFIGURED'),
    commercialStatus: text('commercial_status').notNull().default('UNCONFIRMED'),
    complianceStatus: text('compliance_status').notNull().default('PERMITTED'),
    /** DERIVED in the database (GENERATED column): all four must permit.
     * kyc 'not_required' permits — a merchant-supplied live key is the
     * provider's own verification (PR-052). */
    productionEnabled: boolean('production_enabled'),
    /** §17.2 provider-neutral attributes. PLATFORM_ONLY is a real
     * arrangement, not a degenerate case. */
    accountOwnership: text('account_ownership').notNull().default('MERCHANT_OWNED'),
    representation: text('representation').notNull().default('SUB_MERCHANT'),
    credentialSource: text('credential_source').notNull().default('PLATFORM_ISSUED'),
    /** Who bears the provider's fee (§14) — commercial choice, never code.
     * BLENDED and narrowing: §19 splits it into the two columns below
     * (PR-056); the split arithmetic still reads this until the
     * PaymentCharge model lands. */
    feePolicy: text('fee_policy').notNull().default('merchant_bearing'),
    /** §19: who ends up out of pocket. Rekoda's concept, enumerated. */
    economicFeeBearer: text('economic_fee_bearer').notNull().default('MERCHANT'),
    /** §19: what we send to the provider. Adapter-specific, opaque to the
     * core — the adapter that owns the vocabulary validates it. */
    providerFeePayer: text('provider_fee_payer'),
    /**
     * The merchant's OWN provider secret key (ADR 0019, migration 0046),
     * vaulted like the account number beside it. `merchant_key` mode is what
     * the storefront charges against; `platform_subaccount` stays gated on
     * the written §47 confirmation. The tail exists so the card can say
     * "key ending 4821" without a decrypt.
     */
    merchantKeyCipher: text('merchant_key_cipher'),
    merchantKeyTail: text('merchant_key_tail'),
    keyMode: text('key_mode').notNull().default('platform_subaccount'),
    /** When the one-time approaching-the-cap nudge went out (ADR 0019,
     * migration 0048). Null until it has; never cleared. */
    graduationNudgedAt: timestamp('graduation_nudged_at', { withTimezone: true }),
    /** Provider capabilities as data, so adapters can differ (§7). */
    capabilities: jsonb('capabilities')
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('payment_connections_business_provider_ux').on(t.businessId, t.providerType)],
);

/**
 * A Rekoda payment record that exists BEFORE anything reaches a provider
 * (payments-v1 §8). Nothing is ever initialised provider-side without one.
 */
export const paymentIntents = pgTable(
  'payment_intents',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    customerId: uuid('customer_id').references(() => customers.id),
    orderId: uuid('order_id').references(() => orders.id),
    invoiceId: uuid('invoice_id').references(() => invoices.id),
    providerType: text('provider_type').notNull(),
    paymentConnectionId: uuid('payment_connection_id').references(() => paymentConnections.id),
    /** RKD-PAY-… — the authoritative reference, minted by Rekoda (§9). */
    reference: text('reference').notNull(),
    expectedAmountK: bigint('expected_amount_k', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('NGN'),
    /** bank_transfer first for Nigerian V1 (§10). */
    methodPreference: text('method_preference').notNull().default('bank_transfer'),
    providerReference: text('provider_reference'),
    /** Opaque checkout handle (a URL, a code) — adapter-owned, never parsed. */
    providerCheckoutRef: text('provider_checkout_ref'),
    /**
     * The Pay-with-Transfer temporary account for THIS transaction (ADR
     * 0016, migration 0047). On the intent because it must be re-shown, not
     * re-minted, while the intent lives — and forgotten with it. Not a
     * secret: its whole job is to be shown to the paying customer.
     */
    transferBank: text('transfer_bank'),
    transferAccountNumber: text('transfer_account_number'),
    transferAccountName: text('transfer_account_name'),
    transferExpiresAt: timestamp('transfer_expires_at', { withTimezone: true }),
    status: text('status').notNull().default('created'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * GLOBALLY unique, deliberately not per-business: the reference is what an
     * unattributed bank transfer gets matched by, and a match that first needs
     * to know the business is circular (§9).
     */
    uniqueIndex('payment_intents_reference_ux').on(t.reference),
    /** One LIVE intent per invoice — the mint race has a database-decided
     * winner (migration 0011). Terminal intents leave the index. */
    uniqueIndex('payment_intents_live_invoice_ux')
      .on(t.businessId, t.invoiceId)
      .where(
        sql`invoice_id IS NOT NULL AND status NOT IN ('succeeded', 'failed', 'expired', 'cancelled')`,
      ),
    index('payment_intents_business_status_ix').on(t.businessId, t.status),
    index('payment_intents_invoice_ix').on(t.invoiceId),
  ],
);

/* ── payment attempts (spec §6.1, §22.3; migration 0081, PR-054) ── */

/** One try against an intent. The provider's attempt id is scoped to the
 * connection that produced it — never assumed globally unique. A try that
 * happened stays on file; only its status resolves. */
export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    paymentIntentId: uuid('payment_intent_id').notNull(),
    paymentConnectionId: uuid('payment_connection_id').notNull(),
    providerAttemptId: text('provider_attempt_id').notNull(),
    status: text('status').notNull().default('INITIATED'),
    method: text('method'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_attempts_provider_ux').on(
      t.businessId,
      t.paymentConnectionId,
      t.providerAttemptId,
    ),
    index('payment_attempts_intent_ix').on(t.businessId, t.paymentIntentId),
  ],
);

/* ── payment charges (spec §19.1; migration 0083, PR-057) ── */

/** A breakdown line the customer read: a record, never deleted. The
 * taxable base is stated per line, and an estimate resolves to actual. */
export const paymentCharges = pgTable(
  'payment_charges',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    orderId: uuid('order_id').notNull(),
    type: text('type').notNull(),
    label: text('label').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('NGN'),
    beneficiary: text('beneficiary').notNull(),
    economicBearer: text('economic_bearer').notNull(),
    taxCode: text('tax_code'),
    actualOrEstimated: text('actual_or_estimated').notNull().default('ESTIMATED'),
    providerCostScheduleId: uuid('provider_cost_schedule_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('payment_charges_order_ix').on(t.businessId, t.orderId)],
);

/* ── provider settlement (spec §20; migration 0090, PR-063) ── */

/** What the provider paid out, and when. The provider's numbers, recorded
 * as reported; the components explain the gross→net gap. */
export const settlements = pgTable(
  'settlements',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    paymentConnectionId: uuid('payment_connection_id').notNull(),
    /** Connection-scoped (§22.3), never assumed globally unique. */
    providerSettlementId: text('provider_settlement_id').notNull(),
    status: text('status').notNull().default('PENDING'),
    currency: text('currency').notNull().default('NGN'),
    grossK: bigint('gross_k', { mode: 'number' }).notNull(),
    netK: bigint('net_k', { mode: 'number' }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('settlements_provider_ux').on(
      t.businessId,
      t.paymentConnectionId,
      t.providerSettlementId,
    ),
    index('settlements_business_status_ix').on(t.businessId, t.status),
  ],
);

/** Which payments a payout covered. Immutable once written. */
export const settlementItems = pgTable(
  'settlement_items',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    settlementId: uuid('settlement_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    amountK: bigint('amount_k', { mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('settlement_items_payment_ux').on(t.businessId, t.settlementId, t.paymentId),
    index('settlement_items_payment_ix').on(t.businessId, t.paymentId),
  ],
);

/** A signed adjustment (§20's nine kinds), signed by DIRECTION, never by a
 * negative amount. Immutable once written. */
export const settlementComponents = pgTable(
  'settlement_components',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    settlementId: uuid('settlement_id').notNull(),
    kind: text('kind').notNull(),
    direction: text('direction').notNull(),
    amountK: bigint('amount_k', { mode: 'number' }).notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [index('settlement_components_settlement_ix').on(t.businessId, t.settlementId)],
);

/* ── chargebacks (spec §21; migration 0091, PR-066) ── */

/** The provider taking money back. Timing decides the posting: before
 * settlement the clearing reverses; after it the merchant owes the
 * provider — a liability, never a second receivable. */
export const chargebacks = pgTable(
  'chargebacks',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    paymentConnectionId: uuid('payment_connection_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    providerChargebackId: text('provider_chargeback_id').notNull(),
    amountK: bigint('amount_k', { mode: 'number' }).notNull(),
    timing: text('timing').notNull(),
    recoveredVia: text('recovered_via'),
    status: text('status').notNull().default('OPEN'),
    reason: text('reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('chargebacks_provider_ux').on(
      t.businessId,
      t.paymentConnectionId,
      t.providerChargebackId,
    ),
    index('chargebacks_business_status_ix').on(t.businessId, t.status),
    index('chargebacks_payment_ix').on(t.businessId, t.paymentId),
  ],
);

/* ── refunds and payment reversals (spec §6.1; migration 0092, PR-067) ── */

/** Money returned DELIBERATELY: it leaves the bank or the till, on the day
 * it actually happens, and it always has a reason. */
export const refunds = pgTable(
  'refunds',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    paymentId: uuid('payment_id').notNull(),
    amountK: bigint('amount_k', { mode: 'number' }).notNull(),
    method: text('method').notNull(),
    providerRefundId: text('provider_refund_id'),
    reason: text('reason').notNull(),
    actor: text('actor').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('refunds_payment_ix').on(t.businessId, t.paymentId),
    uniqueIndex('refunds_provider_ux').on(t.businessId, t.providerRefundId),
  ],
);

/** A payment UNDONE before settlement: whole, once, at the provider. */
export const paymentReversals = pgTable(
  'payment_reversals',
  {
    id: id(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    paymentId: uuid('payment_id').notNull(),
    paymentConnectionId: uuid('payment_connection_id').notNull(),
    amountK: bigint('amount_k', { mode: 'number' }).notNull(),
    providerReversalId: text('provider_reversal_id'),
    reason: text('reason').notNull(),
    actor: text('actor').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('payment_reversals_payment_ux').on(t.businessId, t.paymentId)],
);

/* ── platform provider capabilities (spec §17, §18; 0093, PR-068) ── */

/** GLOBAL reference data: what each provider may do on this platform, and
 * which external blocker says otherwise. No business_id, no RLS — the
 * platform's standing is not tenant state; each merchant's own standing
 * lives on their connection's four §17.1 axes. Read-only to both roles. */
export const providerCapabilities = pgTable(
  'provider_capabilities',
  {
    id: id(),
    providerType: text('provider_type').notNull(),
    capability: text('capability').notNull(),
    /* Three independent axes and one derived from them (0115). The derived
     * column is GENERATED in the database, so it is read and never
     * written. */
    technicalSupport: boolean('technical_support').notNull().default(false),
    technicalNote: text('technical_note'),
    commercialApproval: boolean('commercial_approval').notNull().default(false),
    commercialNote: text('commercial_note'),
    complianceApproval: boolean('compliance_approval').notNull().default(false),
    complianceNote: text('compliance_note'),
    productionEnabled: boolean('production_enabled').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('provider_capabilities_ux').on(t.providerType, t.capability)],
);

/* ── provider cost schedules (spec §17, §19.1, §24, §29; 0094, PR-072) ── */

/** Effective-dated observations of published provider rate cards — the
 * table ratios and estimates are DERIVED from, never a stored multiple.
 * Same construction as provider_capabilities: GLOBAL reference data, no
 * RLS, read-only to both runtime roles; a new card is a new row. */
export const providerCostSchedules = pgTable(
  'provider_cost_schedules',
  {
    id: id(),
    providerType: text('provider_type').notNull(),
    costType: text('cost_type').notNull(),
    providerProduct: text('provider_product').notNull(),
    version: text('version').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    basis: text('basis').notNull(),
    unitPriceMicros: bigint('unit_price_micros', { mode: 'number' }),
    percentPpm: integer('percent_ppm'),
    flatMinor: bigint('flat_minor', { mode: 'number' }),
    capMinor: bigint('cap_minor', { mode: 'number' }),
    waiveFlatUnderMinor: bigint('waive_flat_under_minor', { mode: 'number' }),
    currency: text('currency').notNull(),
    note: text('note'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('provider_cost_schedules_ux').on(
      t.providerType,
      t.providerProduct,
      t.effectiveFrom,
    ),
  ],
);
