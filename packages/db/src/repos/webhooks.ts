/**
 * Webhook subscriptions and their delivery log (PR-112, migration 0111).
 *
 * Two access shapes, and the split is migration 0060's, for the same reason:
 *
 *   The merchant's own reads and writes take a `TenantDb` — registering an
 *   endpoint, rotating its secret, reading what was delivered.
 *
 *   The SENDER takes a plain `Db` on the worker connection, because claiming
 *   what is due happens before the tenant is known. That reach is the
 *   `worker_dispatch` policy, bounded to one role and visible in `\dp`.
 *
 * No rules here. When to retry, what to sign and whether an endpoint wants a
 * type are all decided in `@rekoda/core/webhooks`.
 */
import { sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';

export interface EndpointRow {
  id: string;
  businessId: string;
  url: string;
  description: string | null;
  eventTypes: string[];
  status: string;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  createdAt: Date;
}

/** The endpoint AND its secret. Only the sender ever asks for this shape. */
export interface EndpointWithSecret extends EndpointRow {
  encryptedSecret: string;
}

export interface DeliveryRow {
  id: string;
  endpointId: string;
  eventType: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lastStatus: number | null;
  lastError: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

/** What the sender needs to make one attempt. */
export interface DueDelivery {
  id: string;
  businessId: string;
  endpointId: string;
  url: string;
  encryptedSecret: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/* ────────────────────────── subscriptions ───────────────────────── */

export async function createEndpoint(
  tx: TenantDb,
  input: {
    businessId: string;
    url: string;
    description: string | null;
    eventTypes: readonly string[];
    encryptedSecret: string;
  },
): Promise<EndpointRow> {
  const rows = await tx.execute<EndpointColumns>(sql`
    INSERT INTO webhook_endpoints (business_id, url, description, event_types, encrypted_secret)
    VALUES (
      ${input.businessId}, ${input.url}, ${input.description},
      ${sql.raw(arrayLiteral(input.eventTypes))}, ${input.encryptedSecret}
    )
    RETURNING id, business_id, url, description, event_types, status,
              last_success_at, consecutive_failures, created_at
  `);
  return toEndpoint([...rows][0]!);
}

export async function endpointsFor(tx: TenantDb, businessId: string): Promise<EndpointRow[]> {
  const rows = await tx.execute<EndpointColumns>(sql`
    SELECT id, business_id, url, description, event_types, status,
           last_success_at, consecutive_failures, created_at
      FROM webhook_endpoints
     WHERE business_id = ${businessId}
     ORDER BY created_at DESC
  `);
  return [...rows].map(toEndpoint);
}

export async function setEndpointStatus(
  tx: TenantDb,
  businessId: string,
  id: string,
  status: 'active' | 'disabled',
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE webhook_endpoints
       SET status = ${status}, updated_at = now()
     WHERE business_id = ${businessId} AND id = ${id}
     RETURNING id
  `);
  return [...rows].length > 0;
}

/**
 * Rotate the signing secret.
 *
 * Deliberately abrupt rather than a grace period with two live secrets: a
 * rotation is what a merchant does when they believe the old secret leaked,
 * and a window where the leaked one still verifies is the opposite of what
 * they asked for. The cost is that they update their verifier promptly,
 * which is the trade the situation calls for.
 */
export async function rotateSecret(
  tx: TenantDb,
  businessId: string,
  id: string,
  encryptedSecret: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE webhook_endpoints
       SET encrypted_secret = ${encryptedSecret}, updated_at = now()
     WHERE business_id = ${businessId} AND id = ${id}
     RETURNING id
  `);
  return [...rows].length > 0;
}

/** Every live endpoint of one business, with its secret. The sender's read. */
export async function activeEndpointsFor(
  tx: TenantDb,
  businessId: string,
): Promise<EndpointWithSecret[]> {
  const rows = await tx.execute<EndpointColumns & { encrypted_secret: string }>(sql`
    SELECT id, business_id, url, description, event_types, status,
           last_success_at, consecutive_failures, created_at, encrypted_secret
      FROM webhook_endpoints
     WHERE business_id = ${businessId} AND status = 'active'
     ORDER BY created_at
  `);
  return [...rows].map((row) => ({ ...toEndpoint(row), encryptedSecret: row.encrypted_secret }));
}

/* ─────────────────────────── the fan-out ────────────────────────── */

/**
 * Queue one fact for one endpoint, or find it already queued.
 *
 * `ON CONFLICT DO NOTHING` on `(endpoint_id, outbox_event_id)` is what makes
 * the fan-out safe to run twice: the dispatcher is at-least-once by design,
 * so the SECOND pass over an event must be a no-op rather than a duplicate
 * in the merchant's endpoint.
 */
export async function queueDelivery(
  tx: TenantDb,
  input: {
    businessId: string;
    endpointId: string;
    outboxEventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO webhook_deliveries (
      business_id, endpoint_id, outbox_event_id, event_type, payload
    )
    VALUES (
      ${input.businessId}, ${input.endpointId}, ${input.outboxEventId},
      ${input.eventType}, ${JSON.stringify(input.payload)}::jsonb
    )
    ON CONFLICT (endpoint_id, outbox_event_id) DO NOTHING
    RETURNING id
  `);
  return [...rows].length > 0;
}

/**
 * Lease a batch of due deliveries for one sender.
 *
 * `FOR UPDATE SKIP LOCKED` and a lease timestamp, exactly as the outbox
 * claims its own batch: two senders running is a deployment detail, not a
 * reason for a merchant to receive one fact twice.
 */
export async function claimDue(
  worker: Db,
  limit = 25,
  now: Date = new Date(),
  leaseMs = 300_000,
): Promise<DueDelivery[]> {
  const rows = await worker.execute<{
    id: string;
    business_id: string;
    endpoint_id: string;
    url: string;
    encrypted_secret: string;
    event_type: string;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
  }>(sql`
    WITH due AS (
      SELECT d.id
        FROM webhook_deliveries d
        JOIN webhook_endpoints e ON e.id = d.endpoint_id
       WHERE d.status = 'pending'
         AND d.next_attempt_at <= ${now.toISOString()}::timestamptz
         AND e.status = 'active'
         AND (d.locked_at IS NULL
              OR d.locked_at < ${new Date(now.getTime() - leaseMs).toISOString()}::timestamptz)
       ORDER BY d.next_attempt_at
       LIMIT ${limit}
       FOR UPDATE OF d SKIP LOCKED
    )
    UPDATE webhook_deliveries d
       SET locked_at = ${now.toISOString()}::timestamptz
      FROM due, webhook_endpoints e
     WHERE d.id = due.id AND e.id = d.endpoint_id
    RETURNING d.id, d.business_id, d.endpoint_id, e.url, e.encrypted_secret,
              d.event_type, d.payload, d.attempts, d.max_attempts
  `);
  return [...rows].map((row) => ({
    id: row.id,
    businessId: row.business_id,
    endpointId: row.endpoint_id,
    url: row.url,
    encryptedSecret: row.encrypted_secret,
    eventType: row.event_type,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  }));
}

export async function markDelivered(
  worker: Db,
  id: string,
  status: number,
  now: Date = new Date(),
): Promise<void> {
  await worker.execute(sql`
    UPDATE webhook_deliveries
       SET status = 'delivered',
           attempts = attempts + 1,
           last_status = ${status},
           last_error = NULL,
           delivered_at = ${now.toISOString()}::timestamptz,
           locked_at = NULL
     WHERE id = ${id}
  `);
  await worker.execute(sql`
    UPDATE webhook_endpoints e
       SET last_success_at = ${now.toISOString()}::timestamptz,
           consecutive_failures = 0,
           updated_at = now()
      FROM webhook_deliveries d
     WHERE d.id = ${id} AND e.id = d.endpoint_id
  `);
}

/**
 * Record a failed attempt, and give up at the ceiling.
 *
 * The status decides itself from `attempts + 1` against `max_attempts`, in
 * the statement, so a sender that crashes between deciding and writing
 * cannot leave a delivery that will be retried forever.
 */
export async function markAttemptFailed(
  worker: Db,
  input: {
    id: string;
    status: number | null;
    error: string;
    nextAttemptAt: Date;
  },
): Promise<'pending' | 'dead'> {
  const rows = await worker.execute<{ status: string }>(sql`
    UPDATE webhook_deliveries
       SET attempts = attempts + 1,
           last_status = ${input.status},
           last_error = ${input.error.slice(0, 500)},
           locked_at = NULL,
           next_attempt_at = ${input.nextAttemptAt.toISOString()}::timestamptz,
           status = CASE WHEN attempts + 1 >= max_attempts THEN 'dead' ELSE 'pending' END
     WHERE id = ${input.id}
    RETURNING status
  `);
  await worker.execute(sql`
    UPDATE webhook_endpoints e
       SET consecutive_failures = e.consecutive_failures + 1, updated_at = now()
      FROM webhook_deliveries d
     WHERE d.id = ${input.id} AND e.id = d.endpoint_id
  `);
  return [...rows][0]?.status === 'dead' ? 'dead' : 'pending';
}

/** The merchant's delivery log, newest first. */
export async function deliveriesFor(
  tx: TenantDb,
  businessId: string,
  limit = 50,
): Promise<DeliveryRow[]> {
  const rows = await tx.execute<DeliveryColumns>(sql`
    SELECT id, endpoint_id, event_type, status, attempts, max_attempts,
           next_attempt_at, last_status, last_error, delivered_at, created_at
      FROM webhook_deliveries
     WHERE business_id = ${businessId}
     ORDER BY created_at DESC
     LIMIT ${Math.min(Math.max(limit, 1), 200)}
  `);
  return [...rows].map(toDelivery);
}

/** Deliveries that gave up. An operator probe, like the outbox's dead list. */
export async function deadDeliveries(
  worker: Db,
  limit = 50,
): Promise<Array<{ id: string; businessId: string; eventType: string; lastError: string | null }>> {
  const rows = await worker.execute<{
    id: string;
    business_id: string;
    event_type: string;
    last_error: string | null;
  }>(sql`
    SELECT id, business_id, event_type, last_error
      FROM webhook_deliveries
     WHERE status = 'dead'
     ORDER BY created_at DESC
     LIMIT ${Math.min(Math.max(limit, 1), 200)}
  `);
  return [...rows].map((row) => ({
    id: row.id,
    businessId: row.business_id,
    eventType: row.event_type,
    lastError: row.last_error,
  }));
}

interface EndpointColumns extends Record<string, unknown> {
  id: string;
  business_id: string;
  url: string;
  description: string | null;
  event_types: string[];
  status: string;
  last_success_at: string | Date | null;
  consecutive_failures: number;
  created_at: string | Date;
}

interface DeliveryColumns extends Record<string, unknown> {
  id: string;
  endpoint_id: string;
  event_type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | Date;
  last_status: number | null;
  last_error: string | null;
  delivered_at: string | Date | null;
  created_at: string | Date;
}

function toEndpoint(row: EndpointColumns): EndpointRow {
  return {
    id: row.id,
    businessId: row.business_id,
    url: row.url,
    description: row.description,
    eventTypes: row.event_types ?? [],
    status: row.status,
    lastSuccessAt: at(row.last_success_at),
    consecutiveFailures: Number(row.consecutive_failures),
    createdAt: at(row.created_at)!,
  };
}

function toDelivery(row: DeliveryColumns): DeliveryRow {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventType: row.event_type,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: at(row.next_attempt_at)!,
    lastStatus: row.last_status === null ? null : Number(row.last_status),
    lastError: row.last_error,
    deliveredAt: at(row.delivered_at),
    createdAt: at(row.created_at)!,
  };
}

function at(value: string | Date | null): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

/**
 * A `text[]` literal, built here rather than passed as a parameter.
 *
 * The driver has no array binding for this shape, and the alternative — a
 * comma-joined string cast in SQL — is where an event type containing a
 * comma becomes two subscriptions. Every element is quoted and escaped, and
 * the caller's values are already constrained to the known type list.
 */
function arrayLiteral(values: readonly string[]): string {
  if (values.length === 0) return `ARRAY[]::text[]`;
  const quoted = values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ');
  return `ARRAY[${quoted}]::text[]`;
}
