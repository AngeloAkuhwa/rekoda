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
  index,
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
    /** The §5 state machine. The CHECK constraint lives in the migration. */
    status: text('status').notNull().default('pending_details'),
    kycStatus: text('kyc_status').notNull().default('pending'),
    /** Who bears the provider's fee (§14) — commercial choice, never code. */
    feePolicy: text('fee_policy').notNull().default('merchant_bearing'),
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
