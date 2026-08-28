/**
 * Rows for the public API's credentials (spec §27, migration 0110).
 *
 * No rules here. Whether a key is valid, what a token looks like and how
 * wide a rate window is are all decided in `@rekoda/core/api-keys`; this
 * file only reads and writes.
 *
 * Two access shapes, and the difference is the whole tenancy story:
 *
 *   `resolve` takes a plain `Db`, because authenticating a bearer token
 *   happens BEFORE the tenant is known — the business is the answer, not an
 *   input. It reaches its row through the `api_key_resolve` function, the
 *   one bounded cross-tenant read migration 0110 grants.
 *
 *   Everything else takes a `TenantDb`, because everything else is a
 *   merchant managing their own applications under the pin.
 */
import { sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';

export interface ApiApplication {
  id: string;
  businessId: string;
  name: string;
  status: string;
  createdAt: Date;
}

export interface ApiKeyRow {
  id: string;
  applicationId: string;
  prefix: string;
  label: string | null;
  rateLimitPerMinute: number;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/** What authentication gets back. No secret, not even the hash it was given. */
export interface ResolvedApiKey {
  id: string;
  businessId: string;
  applicationId: string;
  prefix: string;
  rateLimitPerMinute: number;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  applicationStatus: string;
}

/* ────────────────────────── applications ────────────────────────── */

/** The five columns every application read selects, as postgres returns them. */
interface ApplicationColumns extends Record<string, unknown> {
  id: string;
  business_id: string;
  name: string;
  status: string;
  created_at: string | Date;
}

export async function createApplication(
  tx: TenantDb,
  input: { businessId: string; name: string },
): Promise<ApiApplication> {
  const rows = await tx.execute<ApplicationColumns>(sql`
    INSERT INTO api_applications (business_id, name)
    VALUES (${input.businessId}, ${input.name})
    RETURNING id, business_id, name, status, created_at
  `);
  return toApplication([...rows][0]!);
}

export async function applicationsFor(tx: TenantDb, businessId: string): Promise<ApiApplication[]> {
  const rows = await tx.execute<ApplicationColumns>(sql`
    SELECT id, business_id, name, status, created_at
      FROM api_applications
     WHERE business_id = ${businessId}
     ORDER BY created_at
  `);
  return [...rows].map(toApplication);
}

export async function applicationById(
  tx: TenantDb,
  businessId: string,
  id: string,
): Promise<ApiApplication | null> {
  const rows = await tx.execute<ApplicationColumns>(sql`
    SELECT id, business_id, name, status, created_at
      FROM api_applications
     WHERE business_id = ${businessId} AND id = ${id}
  `);
  const row = [...rows][0];
  return row ? toApplication(row) : null;
}

/** Disabling an application refuses every key it ever issued, in one act. */
export async function setApplicationStatus(
  tx: TenantDb,
  businessId: string,
  id: string,
  status: 'active' | 'disabled',
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE api_applications
       SET status = ${status}, updated_at = now()
     WHERE business_id = ${businessId} AND id = ${id}
     RETURNING id
  `);
  return [...rows].length > 0;
}

/* ───────────────────────────── keys ─────────────────────────────── */

/** The nine columns every key read selects, in the shape postgres returns. */
interface KeyColumns extends Record<string, unknown> {
  id: string;
  application_id: string;
  prefix: string;
  label: string | null;
  rate_limit_per_minute: number;
  last_used_at: string | Date | null;
  expires_at: string | Date | null;
  revoked_at: string | Date | null;
  created_at: string | Date;
}

export async function insertKey(
  tx: TenantDb,
  input: {
    businessId: string;
    applicationId: string;
    prefix: string;
    tokenHash: string;
    label: string | null;
    rateLimitPerMinute: number;
    expiresAt: Date | null;
  },
): Promise<ApiKeyRow> {
  const rows = await tx.execute<KeyColumns>(sql`
    INSERT INTO api_keys (
      business_id, application_id, prefix, token_hash, label,
      rate_limit_per_minute, expires_at
    )
    VALUES (
      ${input.businessId}, ${input.applicationId}, ${input.prefix}, ${input.tokenHash},
      ${input.label}, ${input.rateLimitPerMinute},
      ${input.expiresAt?.toISOString() ?? null}::timestamptz
    )
    RETURNING id, application_id, prefix, label, rate_limit_per_minute,
              last_used_at, expires_at, revoked_at, created_at
  `);
  return toKeyRow([...rows][0]!);
}

/** Live keys an application holds. The count the mint cap is checked against. */
export async function liveKeyCount(
  tx: TenantDb,
  businessId: string,
  applicationId: string,
  now: Date,
): Promise<number> {
  const rows = await tx.execute<{ live: number }>(sql`
    SELECT count(*)::int AS live
      FROM api_keys
     WHERE business_id = ${businessId}
       AND application_id = ${applicationId}
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ${now.toISOString()}::timestamptz)
  `);
  return [...rows][0]?.live ?? 0;
}

export async function keysFor(tx: TenantDb, businessId: string): Promise<ApiKeyRow[]> {
  const rows = await tx.execute<KeyColumns>(sql`
    SELECT id, application_id, prefix, label, rate_limit_per_minute,
           last_used_at, expires_at, revoked_at, created_at
      FROM api_keys
     WHERE business_id = ${businessId}
     ORDER BY created_at DESC
  `);
  return [...rows].map(toKeyRow);
}

/**
 * Kill a key. Idempotent, and it never rewrites an existing `revoked_at`:
 * when a key was killed is the fact an incident review is reading, and a
 * second click must not move it.
 */
export async function revokeKey(
  tx: TenantDb,
  businessId: string,
  id: string,
  now: Date,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE api_keys
       SET revoked_at = COALESCE(revoked_at, ${now.toISOString()}::timestamptz)
     WHERE business_id = ${businessId} AND id = ${id}
     RETURNING id
  `);
  return [...rows].length > 0;
}

/**
 * Resolve a presented token to the tenant it authenticates.
 *
 * The plain `Db` and the function call are the same decision: this is the
 * one read in the API-key surface that cannot be pinned, so it goes through
 * the one thing migration 0110 grants for it, and nothing else in this file
 * may reach across tenants at all.
 */
export async function resolve(db: Db, tokenHash: string): Promise<ResolvedApiKey | null> {
  const rows = await db.execute<{
    id: string;
    business_id: string;
    application_id: string;
    prefix: string;
    rate_limit_per_minute: number;
    last_used_at: string | Date | null;
    expires_at: string | Date | null;
    revoked_at: string | Date | null;
    application_status: string;
  }>(sql`SELECT * FROM api_key_resolve(${tokenHash})`);
  const row = [...rows][0];
  if (!row) return null;
  return {
    id: row.id,
    businessId: row.business_id,
    applicationId: row.application_id,
    prefix: row.prefix,
    rateLimitPerMinute: row.rate_limit_per_minute,
    lastUsedAt: at(row.last_used_at),
    expiresAt: at(row.expires_at),
    revokedAt: at(row.revoked_at),
    applicationStatus: row.application_status,
  };
}

export async function touch(
  tx: TenantDb,
  businessId: string,
  id: string,
  now: Date,
): Promise<void> {
  await tx.execute(sql`
    UPDATE api_keys SET last_used_at = ${now.toISOString()}::timestamptz
     WHERE business_id = ${businessId} AND id = ${id}
  `);
}

/* ────────────────────────── rate windows ────────────────────────── */

export type RateReservation = { ok: true; calls: number } | { ok: false };

/**
 * Take one request from the key's minute, or take nothing.
 *
 * `ON CONFLICT … DO UPDATE … WHERE calls < limit` is the entire mechanism,
 * copied deliberately from `reserveAiCall`: when the WHERE fails PostgreSQL
 * updates nothing and returns nothing, so "no row" means "no room" and there
 * is no increment to undo. A SELECT-then-UPDATE limiter is not a ceiling.
 *
 * The INSERT path is not covered by that WHERE — there is no conflicting row
 * on the first request of the minute — so a limit below one is refused up
 * front rather than silently allowing that first request through.
 */
export async function reserveRequest(
  tx: TenantDb,
  input: {
    businessId: string;
    apiKeyId: string;
    windowStart: Date;
    limit: number;
  },
): Promise<RateReservation> {
  if (input.limit < 1) return { ok: false };

  const rows = await tx.execute<{ calls: number }>(sql`
    INSERT INTO api_key_rate_windows (api_key_id, business_id, window_start, calls)
    VALUES (
      ${input.apiKeyId}, ${input.businessId},
      ${input.windowStart.toISOString()}::timestamptz, 1
    )
    ON CONFLICT (api_key_id, window_start) DO UPDATE
      SET calls = api_key_rate_windows.calls + 1
      WHERE api_key_rate_windows.calls < ${input.limit}
    RETURNING calls
  `);
  const row = [...rows][0];
  return row ? { ok: true, calls: row.calls } : { ok: false };
}

/**
 * Drop this key's closed windows.
 *
 * Per key and bounded, rather than a sweep: the caller already holds the
 * pin and the key id, the rows are worthless the moment their minute ends,
 * and a counter table nobody prunes is a slow leak with a retention policy
 * attached to it.
 */
export async function pruneWindows(
  tx: TenantDb,
  businessId: string,
  apiKeyId: string,
  before: Date,
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM api_key_rate_windows
     WHERE business_id = ${businessId}
       AND api_key_id = ${apiKeyId}
       AND window_start < ${before.toISOString()}::timestamptz
  `);
}

function toKeyRow(row: KeyColumns): ApiKeyRow {
  return {
    id: row.id,
    applicationId: row.application_id,
    prefix: row.prefix,
    label: row.label,
    rateLimitPerMinute: row.rate_limit_per_minute,
    lastUsedAt: at(row.last_used_at),
    expiresAt: at(row.expires_at),
    revokedAt: at(row.revoked_at),
    createdAt: at(row.created_at)!,
  };
}

function toApplication(row: ApplicationColumns): ApiApplication {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    status: row.status,
    createdAt: at(row.created_at)!,
  };
}

/**
 * A timestamp as a Date, whatever the driver handed back.
 *
 * `tx.execute` returns raw driver values rather than drizzle's decoded
 * columns, and a timestamptz arrives as a string. Every repo that reads
 * through raw SQL coerces here rather than letting a string wearing a
 * `Date` type reach a caller that then calls `toISOString` on it.
 */
function at(value: string | Date | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}
