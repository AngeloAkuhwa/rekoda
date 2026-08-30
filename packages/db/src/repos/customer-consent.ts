/**
 * A customer's own STOP, kept apart from the merchant's (PR-135).
 *
 * Rekoda already had a consent flag - `users.opted_out_at`, keyed by a
 * verified phone number - and it answers a different question: may REKODA
 * message this MERCHANT. This file answers: may this MERCHANT'S SHOP
 * message this customer, on this WhatsApp number.
 *
 * The two must not be one column. A customer who also runs their own shop
 * would otherwise silence their own books by telling somebody else's shop
 * to stop, and keying the row would need the customer's raw number, which
 * the estate deliberately does not hold in a lookupable form.
 *
 * So the key is the participant blind index the thread already routes by
 * (`participantIndexFor`), scoped to the business and the WABA number. The
 * same person messaging two shops is two unrelated rows: that separation is
 * the whole point of the two-level index, and this table inherits it.
 */
import { and, eq, sql } from 'drizzle-orm';
import { customerMessageOptouts } from '../schema/waba.js';
import type { TenantDb } from '../client.js';

/** Everything needed to name one customer on one merchant's channel. */
export interface CustomerConsentKey {
  businessId: string;
  channelAccountId: string;
  customerHash: string;
  indexKeyVersion: string;
}

/**
 * Record STOP (`at` a date) or START (`at` null).
 *
 * Idempotent by construction: repeating STOP rewrites the same row rather
 * than stacking, which is what a customer sending it three times deserves.
 * The FIRST refusal keeps its timestamp on a repeat - `opted_out_at` only
 * moves when the state actually changes - so "when did they ask" stays
 * answerable, while `updated_at` records that they asked again.
 */
export async function setCustomerOptOut(
  tx: TenantDb,
  key: CustomerConsentKey,
  at: Date | null,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO customer_message_optouts
      (business_id, channel_account_id, customer_hash, index_key_version, opted_out_at)
    VALUES (${key.businessId}::uuid, ${key.channelAccountId}, ${key.customerHash},
            ${key.indexKeyVersion}, ${at?.toISOString() ?? null}::timestamptz)
    ON CONFLICT (business_id, channel_account_id, customer_hash, index_key_version)
    DO UPDATE SET
      opted_out_at = CASE
        /* Already stopped and stopping again: keep the original moment. */
        WHEN customer_message_optouts.opted_out_at IS NOT NULL
         AND EXCLUDED.opted_out_at IS NOT NULL THEN customer_message_optouts.opted_out_at
        ELSE EXCLUDED.opted_out_at
      END,
      updated_at = now()
  `);
}

/**
 * May this customer be messaged?
 *
 * Asked before every customer-directed send, so it is one indexed lookup on
 * the unique key and nothing else. Absent row means never asked, which
 * means yes.
 */
export async function customerOptedOut(tx: TenantDb, key: CustomerConsentKey): Promise<boolean> {
  const rows = await tx
    .select({ optedOutAt: customerMessageOptouts.optedOutAt })
    .from(customerMessageOptouts)
    .where(
      and(
        eq(customerMessageOptouts.businessId, key.businessId),
        eq(customerMessageOptouts.channelAccountId, key.channelAccountId),
        eq(customerMessageOptouts.customerHash, key.customerHash),
        eq(customerMessageOptouts.indexKeyVersion, key.indexKeyVersion),
      ),
    )
    .limit(1);
  return rows[0]?.optedOutAt != null;
}
