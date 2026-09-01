/**
 * The queue of objects promised to the bin (PR-136).
 *
 * Rekoda splits every file in two: the bytes live in R2, the KEY lives in a
 * row. That is the right split (ADR 0006) and it made one thing easy to miss
 * for a long time - deleting the row does not delete the file, and the moment
 * the row goes, nothing left in the estate knows the key.
 *
 * So the key is written HERE first, in the same transaction that orphans the
 * object, and the row is deleted only once the object is actually gone. A
 * crash, an R2 outage or a rolled-back deletion all land somewhere safe: the
 * work is either still queued or was never promised.
 *
 * There is no "done" state on purpose. An empty table means nothing is
 * outstanding, which is a control an operator can read at a glance; a growing
 * log of successes is one nobody reads.
 */
import { sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';

/**
 * Why the object is owed to the bin.
 *
 * The first two are sweeps. The other two are one upload going one of two
 * ways (0129): `image_replaced` is the photo a successful re-upload displaced,
 * and `upload_orphaned` is bytes written for an upload that then failed, so
 * they never had a row at all. Kept apart because a queue full of the second
 * is a symptom and a queue full of the first is a busy shop.
 */
export type ObjectDeletionReason =
  'business_deleted' | 'evidence_purged' | 'image_replaced' | 'upload_orphaned';

export interface PendingObjectDeletion {
  id: string;
  storageKey: string;
  attempts: number;
}

/**
 * Promise to delete these objects.
 *
 * Idempotent on the key: one pending deletion per object, so a sweep that
 * runs twice over the same rows queues one job, not two. Called inside the
 * caller's transaction - never after it - so the promise and the orphaning
 * commit together or not at all.
 */
export async function enqueueObjectDeletions(
  tx: TenantDb,
  businessId: string,
  storageKeys: readonly string[],
  reason: ObjectDeletionReason,
): Promise<number> {
  const keys = [...new Set(storageKeys.filter((key) => key.length > 0))];
  if (keys.length === 0) return 0;

  /* Every key is a bound parameter. These keys come from our own columns
   * rather than from a request, but a repository that interpolates a value
   * into SQL text teaches the next one to do it with a value that does. */
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO pending_object_deletions (business_id, storage_key, reason)
    VALUES ${sql.join(
      keys.map((key) => sql`(${businessId}::uuid, ${key}, ${reason})`),
      sql`, `,
    )}
    ON CONFLICT (storage_key) DO NOTHING
    RETURNING id
  `);
  return [...rows].length;
}

/**
 * What is due to be tried now, oldest promise first.
 *
 * Read on the WORKER credential: the businesses these belong to are usually
 * deleted, so there is no tenant to pin and no policy that could match one.
 */
export async function dueObjectDeletions(
  db: Db,
  now: Date,
  limit: number,
): Promise<PendingObjectDeletion[]> {
  const rows = await db.execute<{ id: string; storage_key: string; attempts: number }>(sql`
    SELECT id, storage_key, attempts
      FROM pending_object_deletions
     WHERE next_attempt_at <= ${now.toISOString()}::timestamptz
     ORDER BY next_attempt_at
     LIMIT ${limit}
  `);
  return [...rows].map((row) => ({
    id: row.id,
    storageKey: row.storage_key,
    attempts: row.attempts,
  }));
}

/** The object is gone. The promise is kept, so the row goes with it. */
export async function objectDeleted(db: Db, id: string): Promise<void> {
  await db.execute(sql`DELETE FROM pending_object_deletions WHERE id = ${id}::uuid`);
}

/**
 * The provider refused. Count the attempt, record WHY, and come back later.
 *
 * The row is never dropped on failure, however many times it fails: a
 * deletion we promised and could not perform must stay visible until somebody
 * performs it. `reason` is truncated because it is provider prose of
 * unbounded length, and it is the caller's job to have redacted it first.
 */
export async function objectDeletionFailed(
  db: Db,
  id: string,
  reason: string,
  nextAttemptAt: Date,
): Promise<void> {
  await db.execute(sql`
    UPDATE pending_object_deletions
       SET attempts = attempts + 1,
           last_error = ${reason.slice(0, 300)},
           next_attempt_at = ${nextAttemptAt.toISOString()}::timestamptz
     WHERE id = ${id}::uuid
  `);
}

/** How many objects are still owed, for the ops health surface. */
export async function pendingObjectDeletionCount(db: Db): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM pending_object_deletions`,
  );
  return Number([...rows][0]?.n ?? '0');
}
