/**
 * Whether a business's counter row for `unit` exists and is free of any row lock right now.
 *
 * For tests that assert no transaction is held open across a provider call: a reservation still
 * holding the row would make this wait past the timeout and answer false. It runs as the table
 * OWNER, because no runtime role writes a usage counter directly since migration 0216 (OD-51.4),
 * and what is probed is the lock, not a privilege.
 */
import { createDb, sql } from '@rekoda/db';
import type { Urls } from '@rekoda/db/testing';

export async function usageRowIsFree(
  urls: Urls,
  businessId: string,
  unit: string,
): Promise<boolean> {
  const probe = createDb(urls.owner, { max: 1 });
  try {
    await probe.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '1500ms'`);
      const touched = await tx.execute<{ unit: string }>(
        sql`UPDATE usage_counters SET updated_at = now()
             WHERE business_id = ${businessId}::uuid AND unit = ${unit}
             RETURNING unit`,
      );
      if (touched.length !== 1) throw new Error('the reservation did not commit its row');
    });
    return true;
  } catch {
    return false;
  } finally {
    await probe.close();
  }
}
