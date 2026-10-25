/**
 * Addresses Rekoda must not mail (N7, migration 0179). Platform-wide and keyed by an address
 * hash, so these take the plain `Db`, not a tenant transaction: there is no tenant to pin.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { emailSuppressions } from '../schema/subscriptions.js';

export type SuppressionReason = 'bounced' | 'complained';

/** Records a suppression; a second event for the same address changes nothing. */
export async function suppress(
  db: Db,
  input: { addressHash: string; reason: SuppressionReason; providerEventId: string | null },
): Promise<void> {
  await db.insert(emailSuppressions).values(input).onConflictDoNothing();
}

export async function isSuppressed(db: Db, addressHash: string): Promise<boolean> {
  const rows = await db
    .select({ addressHash: emailSuppressions.addressHash })
    .from(emailSuppressions)
    .where(eq(emailSuppressions.addressHash, addressHash))
    .limit(1);
  return rows.length > 0;
}
