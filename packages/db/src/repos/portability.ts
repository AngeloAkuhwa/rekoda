/**
 * The record of a data-portability request (PR-118, migration 0114).
 *
 * Taking your own books out of Rekoda is a right, so nothing here decides
 * whether it is allowed on commercial grounds: there is no plan check, no
 * allowance and no entitlement. What these rows do is keep the right from
 * becoming a denial-of-service against the estate, and answer "who took a
 * complete copy of this business's books, and when" months later.
 */
import { sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';

export interface PortabilityRequest {
  id: string;
  actor: string;
  requestedAt: Date;
  completedAt: Date | null;
  bytes: number | null;
}

/**
 * Start one, or say which rule refused it.
 *
 * `in_flight` comes from the partial unique index rather than a prior read:
 * two simultaneous requests would both see "none in flight", and the
 * database is the only thing that can break that tie. `too_soon` is a read,
 * because a throttle is advisory rather than an invariant, and the honest
 * answer includes WHEN they may ask again.
 */
export async function begin(
  tx: TenantDb,
  businessId: string,
  actor: string,
  minGapSeconds: number,
  now: Date = new Date(),
): Promise<{ id: string } | { refused: 'in_flight' } | { refused: 'too_soon'; retryAt: Date }> {
  const recent = await tx.execute<{ requested_at: string | Date }>(sql`
    SELECT requested_at FROM portability_exports
     WHERE business_id = ${businessId} AND completed_at IS NOT NULL
     ORDER BY requested_at DESC
     LIMIT 1
  `);
  const last = [...recent][0];
  if (last) {
    const at = last.requested_at instanceof Date ? last.requested_at : new Date(last.requested_at);
    const retryAt = new Date(at.getTime() + minGapSeconds * 1000);
    if (retryAt > now) return { refused: 'too_soon', retryAt };
  }

  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO portability_exports (business_id, actor, requested_at)
    VALUES (${businessId}, ${actor}, ${now.toISOString()}::timestamptz)
    ON CONFLICT DO NOTHING
    RETURNING id
  `);
  const row = [...rows][0];
  return row ? { id: row.id } : { refused: 'in_flight' };
}

/** Hand-over recorded. The row stays forever; only the flight ends. */
export async function complete(
  tx: TenantDb,
  businessId: string,
  id: string,
  bytes: number,
  now: Date = new Date(),
): Promise<void> {
  await tx.execute(sql`
    UPDATE portability_exports
       SET completed_at = ${now.toISOString()}::timestamptz, bytes = ${bytes}
     WHERE business_id = ${businessId} AND id = ${id} AND completed_at IS NULL
  `);
}

/**
 * Abandon a request that produced nothing.
 *
 * Deliberately marks it completed with zero bytes rather than deleting it:
 * the application may not erase this table, and "they asked and it failed"
 * is a fact worth keeping. It also clears the in-flight slot, so one failed
 * export does not lock a merchant out of their own data.
 */
export async function abandon(tx: TenantDb, businessId: string, id: string): Promise<void> {
  await complete(tx, businessId, id, 0);
}

/** Every request this business has made, newest first. */
export async function historyFor(
  tx: TenantDb,
  businessId: string,
  limit = 50,
): Promise<PortabilityRequest[]> {
  const rows = await tx.execute<{
    id: string;
    actor: string;
    requested_at: string | Date;
    completed_at: string | Date | null;
    bytes: string | number | null;
  }>(sql`
    SELECT id, actor, requested_at, completed_at, bytes
      FROM portability_exports
     WHERE business_id = ${businessId}
     ORDER BY requested_at DESC
     LIMIT ${limit}
  `);
  return [...rows].map((row) => ({
    id: row.id,
    actor: row.actor,
    requestedAt: at(row.requested_at)!,
    completedAt: at(row.completed_at),
    bytes: row.bytes === null ? null : Number(row.bytes),
  }));
}

function at(value: string | Date | null): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}
