/**
 * Ingress event storage (MASTER-PLAN §5.3.1).
 *
 * `external_events` is deliberately outside row-level security: an event
 * arrives before anyone knows which tenant it belongs to, and a policy keyed
 * on `app.business_id` would reject the very insert that determines it. The
 * table holds no financial data, and `business_id` is filled in when — and
 * only when — resolution succeeds.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';
import { externalEvents } from '../schema/ops.js';

export type Queryable = Db | TenantDb;

export interface IncomingEvent {
  provider: 'meta' | 'twilio' | 'paystack';
  eventType: string;
  externalId: string;
  payload: unknown;
  businessId: string | null;
}

export interface RecordedEvent {
  id: string;
  /** False when this exact event was already stored — i.e. a provider retry. */
  isNew: boolean;
}

/**
 * Store an event, exactly once.
 *
 * `ON CONFLICT DO NOTHING` against `UNIQUE(provider, external_id)` is what
 * makes a retry a no-op *by construction*. The obvious alternative — SELECT,
 * then INSERT if absent — loses the race that matters most: Meta retries
 * aggressively and in parallel, so two deliveries of the same message can both
 * find nothing and both insert. Here the database decides, and the loser
 * simply learns it was second.
 *
 * A duplicate is not an error. The caller still answers 200, because a
 * provider that gets anything else will keep retrying until it gives up and
 * disables the webhook.
 */
export async function recordEvent(q: Queryable, event: IncomingEvent): Promise<RecordedEvent> {
  const inserted = await q
    .insert(externalEvents)
    .values({
      provider: event.provider,
      eventType: event.eventType,
      externalId: event.externalId,
      payload: event.payload as never,
      businessId: event.businessId,
      // Only signed events are ever persisted; see the note in the controller.
      signatureValid: 1,
    })
    .onConflictDoNothing({
      target: [externalEvents.provider, externalEvents.externalId],
    })
    .returning({ id: externalEvents.id });

  const row = inserted[0];
  if (row) return { id: row.id, isNew: true };

  const existing = await q
    .select({ id: externalEvents.id })
    .from(externalEvents)
    .where(
      and(
        eq(externalEvents.provider, event.provider),
        eq(externalEvents.externalId, event.externalId),
      ),
    )
    .limit(1);

  const found = existing[0];
  if (!found) throw new Error('recordEvent: conflict reported but no existing row found');
  return { id: found.id, isNew: false };
}

/**
 * Mark an event handled. Errors are recorded, not thrown away.
 *
 * `businessId` is optional but callers holding a tenant pin should pass it.
 * This table is outside row-level security by necessity — see the note at the
 * top of the file — so it is the only place in the codebase where a stray id
 * from a job payload could reach another tenant's row. The extra predicate
 * costs nothing and puts the check back.
 */
export async function markProcessed(
  q: Queryable,
  id: string,
  error: string | null = null,
  businessId?: string,
): Promise<void> {
  const scope = businessId
    ? and(eq(externalEvents.id, id), eq(externalEvents.businessId, businessId))
    : eq(externalEvents.id, id);
  await q.update(externalEvents).set({ processedAt: new Date(), error }).where(scope);
}

/**
 * One event, scoped to the tenant it was attributed to.
 *
 * The `businessId` predicate is not decoration. This table is outside
 * row-level security by necessity, so a job payload carrying a stray id is the
 * one way a worker could read another tenant's event — and a worker is exactly
 * where nobody would notice.
 */
export async function eventForBusiness(
  q: Queryable,
  id: string,
  businessId: string,
): Promise<{ id: string; eventType: string; externalId: string; payload: unknown } | null> {
  const rows = await q
    .select({
      id: externalEvents.id,
      eventType: externalEvents.eventType,
      externalId: externalEvents.externalId,
      payload: externalEvents.payload,
    })
    .from(externalEvents)
    .where(and(eq(externalEvents.id, id), eq(externalEvents.businessId, businessId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Events that arrived but were never handled — the queue that exists before
 * there is a job runner, and the audit trail after there is one.
 */
export async function unprocessedEvents(
  q: Queryable,
  provider: IncomingEvent['provider'],
  limit = 50,
): Promise<Array<{ id: string; externalId: string; payload: unknown; businessId: string | null }>> {
  return q
    .select({
      id: externalEvents.id,
      externalId: externalEvents.externalId,
      payload: externalEvents.payload,
      businessId: externalEvents.businessId,
    })
    .from(externalEvents)
    .where(and(eq(externalEvents.provider, provider), isNull(externalEvents.processedAt)))
    .orderBy(externalEvents.createdAt)
    .limit(limit);
}

/**
 * Events awaiting ATTRIBUTION — stored, unprocessed, and not yet resolved to a
 * business. This is the payments pump's work list: resolving a payment
 * reference to its intent is a cross-tenant read only the worker role can
 * perform (`worker_resolve`, migration 0010), so these rows sit unattributed
 * until that role looks at them.
 */
export async function unattributedEvents(
  q: Queryable,
  provider: IncomingEvent['provider'],
  limit = 50,
): Promise<Array<{ id: string; eventType: string; payload: unknown }>> {
  return q
    .select({
      id: externalEvents.id,
      eventType: externalEvents.eventType,
      payload: externalEvents.payload,
    })
    .from(externalEvents)
    .where(
      and(
        eq(externalEvents.provider, provider),
        isNull(externalEvents.processedAt),
        isNull(externalEvents.businessId),
      ),
    )
    .orderBy(externalEvents.createdAt)
    .limit(limit);
}

/**
 * Attribute an event to the business its reference resolved to.
 *
 * The `business_id IS NULL` predicate makes attribution WRITE-ONCE: two pumps
 * racing over the same event cannot re-point it, and nothing can ever move an
 * event from one tenant to another. Returns false for the loser.
 */
export async function attributeEvent(
  q: Queryable,
  id: string,
  businessId: string,
): Promise<boolean> {
  const rows = await q
    .update(externalEvents)
    .set({ businessId })
    .where(and(eq(externalEvents.id, id), isNull(externalEvents.businessId)))
    .returning({ id: externalEvents.id });
  return rows.length === 1;
}

/** One event's processing outcome — the admin event log's core question. */
export async function eventStatus(
  q: Queryable,
  id: string,
): Promise<{ processed: boolean; error: string | null; businessId: string | null } | null> {
  const rows = await q
    .select({
      processedAt: externalEvents.processedAt,
      error: externalEvents.error,
      businessId: externalEvents.businessId,
    })
    .from(externalEvents)
    .where(eq(externalEvents.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { processed: row.processedAt != null, error: row.error, businessId: row.businessId };
}

/** Count of stored events, for the health surface. */
export async function eventCount(q: Queryable): Promise<number> {
  const rows = await q.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM external_events`);
  return [...rows][0]?.n ?? 0;
}
