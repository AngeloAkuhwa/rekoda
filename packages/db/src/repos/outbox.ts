/**
 * The transactional outbox (canonical spec §26; PR-020).
 *
 * `append` runs in the CALLER's transaction, which is the entire pattern: the
 * event and the state change it announces are one commit, so neither can
 * exist without the other. The dispatcher then works the table like the job
 * queue works jobs — claim with SKIP LOCKED, deliver, stamp — and an event
 * that keeps failing goes visibly dead rather than silently missing.
 */
import { sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';

export interface AppendEvent {
  businessId: string;
  type: string;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

/** In the caller's transaction, always. There is no standalone variant. */
export async function append(tx: TenantDb, event: AppendEvent): Promise<{ id: string }> {
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO outbox_events (business_id, type, payload, occurred_at)
    VALUES (${event.businessId}::uuid, ${event.type},
            ${JSON.stringify(event.payload ?? {})}::jsonb,
            ${(event.occurredAt ?? new Date()).toISOString()}::timestamptz)
    RETURNING id
  `);
  const id = [...rows][0]?.id;
  if (!id) throw new Error('outbox append returned no row');
  return { id };
}

export interface ClaimedEvent {
  id: string;
  businessId: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
}

/**
 * Lease a batch for one dispatcher. `FOR UPDATE SKIP LOCKED` is what lets
 * two dispatchers run without delivering anything twice: the rows one holds
 * are invisible to the other, and a crashed dispatcher's lease expires by
 * `reclaimStalled` below rather than by anybody noticing.
 *
 * In arrival order, because an outbox that reorders events hands consumers a
 * history that never happened.
 */
export async function claimBatch(
  worker: Db,
  limit = 25,
  now = new Date(),
): Promise<ClaimedEvent[]> {
  const rows = await worker.execute<{
    id: string;
    business_id: string;
    type: string;
    payload: Record<string, unknown>;
    occurred_at: Date;
    attempts: number;
  }>(sql`
    UPDATE outbox_events o
    SET locked_at = ${now.toISOString()}::timestamptz
    FROM (
      SELECT id FROM outbox_events
      WHERE dispatched_at IS NULL
        AND attempts < max_attempts
        AND locked_at IS NULL
      ORDER BY occurred_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ) due
    WHERE o.id = due.id
    RETURNING o.id, o.business_id, o.type, o.payload, o.occurred_at, o.attempts
  `);
  return [...rows].map((row) => ({
    id: row.id,
    businessId: row.business_id,
    type: row.type,
    payload: row.payload,
    occurredAt: new Date(row.occurred_at),
    attempts: row.attempts,
  }));
}

/** Delivered. The stamp is the state; a stamped event is never re-claimed. */
export async function markDispatched(worker: Db, id: string, now = new Date()): Promise<void> {
  await worker.execute(sql`
    UPDATE outbox_events
    SET dispatched_at = ${now.toISOString()}::timestamptz, locked_at = NULL
    WHERE id = ${id}::uuid AND dispatched_at IS NULL
  `);
}

/**
 * Failed. Attempts move up, the lease releases, and once attempts reach the
 * ceiling the event stops being claimable — dead, but on the table, because
 * a poisoned event is evidence and the alternative is a delivery loop.
 */
export async function markFailed(worker: Db, id: string, error: string): Promise<void> {
  await worker.execute(sql`
    UPDATE outbox_events
    SET attempts = attempts + 1, locked_at = NULL, last_error = ${error.slice(0, 500)}
    WHERE id = ${id}::uuid AND dispatched_at IS NULL
  `);
}

/** A dispatcher died mid-batch. Its leases lapse; the events go back. */
export async function reclaimStalled(worker: Db, olderThanMs = 300_000): Promise<number> {
  const rows = await worker.execute<{ id: string }>(sql`
    UPDATE outbox_events
    SET locked_at = NULL
    WHERE dispatched_at IS NULL
      AND locked_at IS NOT NULL
      AND locked_at < ${new Date(Date.now() - olderThanMs).toISOString()}::timestamptz
    RETURNING id
  `);
  return [...rows].length;
}

/** The events that ran out of attempts: an operator's queue, never a purge. */
export async function deadEvents(worker: Db, limit = 50): Promise<ClaimedEvent[]> {
  const rows = await worker.execute<{
    id: string;
    business_id: string;
    type: string;
    payload: Record<string, unknown>;
    occurred_at: Date;
    attempts: number;
  }>(sql`
    SELECT id, business_id, type, payload, occurred_at, attempts
    FROM outbox_events
    WHERE dispatched_at IS NULL AND attempts >= max_attempts
    ORDER BY occurred_at
    LIMIT ${limit}
  `);
  return [...rows].map((row) => ({
    id: row.id,
    businessId: row.business_id,
    type: row.type,
    payload: row.payload,
    occurredAt: new Date(row.occurred_at),
    attempts: row.attempts,
  }));
}
