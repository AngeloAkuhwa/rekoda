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

/**
 * Claim the right to answer a stranger, at most once per window.
 *
 * One statement, so two workers racing produce one reply: the conditional
 * UPDATE fires only when the last reply is older than the window, and
 * "no row returned" means somebody else just answered them.
 */
export async function claimStrangerReply(
  db: Db,
  matchKey: string,
  windowMs = 24 * 60 * 60 * 1_000,
  now = new Date(),
): Promise<boolean> {
  const since = new Date(now.getTime() - windowMs);
  const rows = await db.execute<{ match_key: string }>(sql`
    INSERT INTO stranger_contacts (match_key, last_replied_at)
    VALUES (${matchKey}, ${now.toISOString()}::timestamptz)
    ON CONFLICT (match_key) DO UPDATE
      SET last_replied_at = ${now.toISOString()}::timestamptz
      WHERE stranger_contacts.last_replied_at < ${since.toISOString()}::timestamptz
    RETURNING match_key
  `);
  return [...rows].length === 1;
}

export interface EventHealth {
  /** Stored, never processed. A backlog here means a sweep is not running. */
  unprocessed: number;
  /**
   * Processed but marked with a reason, and not yet worked — the exception
   * queue (§35). OPEN ones only, so this count and `exceptionQueue` below
   * agree: a number that kept reporting exceptions an operator had already
   * dealt with would teach them to stop believing the number.
   */
  flagged: number;
  /** Signature checks that failed. Should be zero; anything else is an attack or a key. */
  badSignatures: number;
}

/**
 * Webhook intake, in three numbers.
 *
 * The paystack pump has always marked events with WHY they went nowhere
 * ('unknown_reference', 'foreign_reference') and called those marks "the
 * admin exception queue" — a queue nothing could read until now.
 */
export async function eventHealth(db: Db, provider: string): Promise<EventHealth> {
  const rows = await db.execute<{ unprocessed: number; flagged: number; bad: number }>(sql`
    SELECT
      count(*) FILTER (WHERE processed_at IS NULL)::int              AS unprocessed,
      count(*) FILTER (WHERE processed_at IS NOT NULL
                         AND error IS NOT NULL
                         AND resolved_at IS NULL)::int               AS flagged,
      count(*) FILTER (WHERE signature_valid = 0)::int               AS bad
    FROM external_events
    WHERE provider = ${provider}
  `);
  const row = [...rows][0];
  return {
    unprocessed: row?.unprocessed ?? 0,
    flagged: row?.flagged ?? 0,
    badSignatures: row?.bad ?? 0,
  };
}

/* ── the exception queue an operator works ───────────────────────────────── */

export interface OpsEventRow {
  id: string;
  provider: string;
  eventType: string;
  /** The tenant it reached, when it reached one. An id, never a name. */
  businessId: string | null;
  /** Why it was flagged. Never overwritten, including by a resolution. */
  error: string | null;
  signatureValid: number;
  createdAt: Date;
  /** How long it has been sitting. What an operator actually judges by. */
  ageSeconds: number;
}

export interface ExceptionQueue {
  /**
   * Stored, never processed, never attributed. A handful is normal traffic in
   * flight; a growing list with real age on it means a sweep is not running.
   */
  stuck: OpsEventRow[];
  /** Processed and flagged with a reason, and nobody has worked it yet. */
  flagged: OpsEventRow[];
}

/**
 * The queue, as ROWS (MASTER-PLAN §6.4).
 *
 * Everything else on the ops surface is deliberately numbers, so that a
 * cross-tenant console never quietly becomes a feature. This is the one
 * exception and it earns it: a mark the pump left cannot be acted on by any
 * merchant, because an unattributed event belongs to nobody, so if no operator
 * can see it then nobody can.
 *
 * What it will NOT return is the payload. Those are sealed under `VAULT_KEY`
 * (see privacy/payload-vault.ts) and hold the sender's number and message
 * text; a queue that unsealed them to help somebody triage would be a
 * plaintext feed of every merchant's conversations behind one header. The id,
 * the type and the reason are what triage actually needs, and the payload is
 * one deliberate lookup away for whoever has cause.
 *
 * No age threshold is baked in. "Stuck" is a judgement about a deployment's
 * normal latency, and `ageSeconds` is the number to make it with.
 */
export async function exceptionQueue(q: Queryable, limit = 50): Promise<ExceptionQueue> {
  const rows = await q.execute<{
    id: string;
    provider: string;
    event_type: string;
    business_id: string | null;
    error: string | null;
    signature_valid: number;
    created_at: Date;
    age_seconds: number;
    bucket: string;
  }>(sql`
    (SELECT id, provider, event_type, business_id, error, signature_valid, created_at,
            EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds,
            'stuck' AS bucket
       FROM external_events
      WHERE processed_at IS NULL AND business_id IS NULL
      ORDER BY created_at
      LIMIT ${limit})
    UNION ALL
    (SELECT id, provider, event_type, business_id, error, signature_valid, created_at,
            EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds,
            'flagged' AS bucket
       FROM external_events
      WHERE error IS NOT NULL AND resolved_at IS NULL
      ORDER BY created_at
      LIMIT ${limit})
  `);

  const queue: ExceptionQueue = { stuck: [], flagged: [] };
  for (const r of rows) {
    const row: OpsEventRow = {
      id: r.id,
      provider: r.provider,
      eventType: r.event_type,
      businessId: r.business_id,
      error: r.error,
      signatureValid: r.signature_valid,
      createdAt: new Date(r.created_at),
      ageSeconds: Number(r.age_seconds),
    };
    if (r.bucket === 'stuck') queue.stuck.push(row);
    else queue.flagged.push(row);
  }
  return queue;
}

/**
 * Work one exception: record who decided and what they decided.
 *
 * `resolved_at IS NULL` in the WHERE is the mutual exclusion, so two operators
 * clicking at once produce one resolution and the loser is told the row was
 * already worked rather than silently overwriting the first decision.
 *
 * A stuck event is stamped processed at the same time, because that is what
 * resolving it MEANS: it was never going to be attributed, and leaving it
 * unprocessed would keep a sweep picking it up forever. A flagged one is
 * already processed and only gains the decision.
 */
export async function resolveEvent(
  q: Queryable,
  id: string,
  resolution: string,
  actor: string,
  now = new Date(),
): Promise<boolean> {
  const rows = await q.execute<{ id: string }>(sql`
    UPDATE external_events
       SET resolved_at = ${now.toISOString()}::timestamptz,
           resolved_by = ${actor},
           resolution  = ${resolution},
           processed_at = COALESCE(processed_at, ${now.toISOString()}::timestamptz)
     WHERE id = ${id}::uuid
       AND resolved_at IS NULL
     RETURNING id
  `);
  return [...rows].length === 1;
}
