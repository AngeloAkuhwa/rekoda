/**
 * The merchant's own WABA (spec §24; PR-058): connected by them, routed by
 * us. Embedded Signup COMPLETES with a (wabaId, phoneNumberId, token)
 * triple — this repo records the completion, answers the routing question,
 * and keeps the 24-hour service window per customer. Production
 * enablement waits on W0; everything here works against test numbers.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';
import { wabaConnections, wabaServiceWindows, wabaTemplates } from '../schema/waba.js';

export type ConnectWabaOutcome =
  | { outcome: 'connected'; id: string }
  /* The routing key belongs to somebody else: one number, one business. */
  | { outcome: 'number_taken' };

/**
 * Record a completed Embedded Signup. Idempotent for the SAME business —
 * a re-run refreshes the token and stays CONNECTED — and refused for a
 * different one, because `phone_number_id` is the global routing key.
 */
export async function connectWaba(
  tx: TenantDb,
  input: {
    businessId: string;
    wabaId: string;
    phoneNumberId: string;
    displayPhone?: string;
    accessTokenCipher: string;
    tokenTail: string;
  },
): Promise<ConnectWabaOutcome> {
  const rows = await tx
    .insert(wabaConnections)
    .values({
      businessId: input.businessId,
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      ...(input.displayPhone ? { displayPhone: input.displayPhone } : {}),
      status: 'CONNECTED',
      accessTokenCipher: input.accessTokenCipher,
      tokenTail: input.tokenTail,
      connectedAt: sql`now()` as never,
    })
    .onConflictDoNothing({ target: [wabaConnections.phoneNumberId] })
    .returning({ id: wabaConnections.id });
  const row = rows[0];
  if (row) return { outcome: 'connected', id: row.id };

  /* Conflict: ours to refresh, or somebody else's to refuse. RLS means a
   * foreign row is invisible here, so an empty update IS the refusal. */
  const refreshed = await tx
    .update(wabaConnections)
    .set({
      wabaId: input.wabaId,
      status: 'CONNECTED',
      accessTokenCipher: input.accessTokenCipher,
      tokenTail: input.tokenTail,
      ...(input.displayPhone ? { displayPhone: input.displayPhone } : {}),
      connectedAt: sql`now()`,
      revokedAt: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(wabaConnections.businessId, input.businessId),
        eq(wabaConnections.phoneNumberId, input.phoneNumberId),
      ),
    )
    .returning({ id: wabaConnections.id });
  const own = refreshed[0];
  if (own) return { outcome: 'connected', id: own.id };
  return { outcome: 'number_taken' };
}

/**
 * phoneNumberId → BusinessId. THE routing question, answered pre-tenant
 * (the `worker_resolve` policy): a webhook names a number, and which
 * business it belongs to is the answer, not the input. An unknown
 * phoneNumberId returns null — the caller refuses, never guesses.
 */
export async function routeByPhoneNumberId(
  workerDb: Db,
  phoneNumberId: string,
): Promise<{ businessId: string; connectionId: string; status: string } | null> {
  const rows = await workerDb
    .select({
      businessId: wabaConnections.businessId,
      connectionId: wabaConnections.id,
      status: wabaConnections.status,
    })
    .from(wabaConnections)
    .where(eq(wabaConnections.phoneNumberId, phoneNumberId))
    .limit(1);
  return rows[0] ?? null;
}

export async function wabaConnectionFor(tx: TenantDb, businessId: string) {
  const rows = await tx
    .select()
    .from(wabaConnections)
    .where(eq(wabaConnections.businessId, businessId))
    .limit(1);
  return rows[0] ?? null;
}

export async function markWabaStatus(
  tx: TenantDb,
  input: {
    businessId: string;
    connectionId: string;
    status: 'CONNECTED' | 'UNHEALTHY' | 'REVOKED';
  },
): Promise<boolean> {
  const rows = await tx
    .update(wabaConnections)
    .set({
      status: input.status,
      ...(input.status === 'REVOKED' ? { revokedAt: sql`now()` } : {}),
      ...(input.status === 'CONNECTED' ? { lastHealthyAt: sql`now()` } : {}),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(wabaConnections.businessId, input.businessId),
        eq(wabaConnections.id, input.connectionId),
      ),
    )
    .returning({ id: wabaConnections.id });
  return rows.length === 1;
}

/* ── templates ──────────────────────────────────────────────────────────── */

export async function upsertTemplate(
  tx: TenantDb,
  input: {
    businessId: string;
    wabaConnectionId: string;
    name: string;
    language?: string;
    category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION' | 'SERVICE';
    providerTemplateId?: string;
  },
): Promise<{ id: string }> {
  const rows = await tx
    .insert(wabaTemplates)
    .values({
      businessId: input.businessId,
      wabaConnectionId: input.wabaConnectionId,
      name: input.name,
      ...(input.language ? { language: input.language } : {}),
      category: input.category,
      ...(input.providerTemplateId ? { providerTemplateId: input.providerTemplateId } : {}),
    })
    .onConflictDoUpdate({
      target: [
        wabaTemplates.businessId,
        wabaTemplates.wabaConnectionId,
        wabaTemplates.name,
        wabaTemplates.language,
      ],
      set: {
        category: input.category,
        ...(input.providerTemplateId ? { providerTemplateId: input.providerTemplateId } : {}),
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: wabaTemplates.id });
  const row = rows[0];
  if (!row) throw new Error('upsertTemplate: upsert returned no row');
  return row;
}

export async function markTemplateStatus(
  tx: TenantDb,
  input: {
    businessId: string;
    templateId: string;
    status: 'APPROVED' | 'REJECTED' | 'PAUSED';
  },
): Promise<boolean> {
  const rows = await tx
    .update(wabaTemplates)
    .set({ status: input.status, updatedAt: sql`now()` })
    .where(
      and(eq(wabaTemplates.businessId, input.businessId), eq(wabaTemplates.id, input.templateId)),
    )
    .returning({ id: wabaTemplates.id });
  return rows.length === 1;
}

/* ── the 24-hour service window ─────────────────────────────────────────── */

/** A customer message opens (or extends) their window: 24 hours from now. */
export async function touchServiceWindow(
  tx: TenantDb,
  input: { businessId: string; wabaConnectionId: string; customerHash: string; at?: Date },
): Promise<void> {
  const at = input.at ?? new Date();
  const expires = new Date(at.getTime() + 24 * 60 * 60 * 1000);
  await tx
    .insert(wabaServiceWindows)
    .values({
      businessId: input.businessId,
      wabaConnectionId: input.wabaConnectionId,
      customerHash: input.customerHash,
      windowExpiresAt: expires,
    })
    .onConflictDoUpdate({
      target: [
        wabaServiceWindows.businessId,
        wabaServiceWindows.wabaConnectionId,
        wabaServiceWindows.customerHash,
      ],
      set: { windowExpiresAt: expires, updatedAt: sql`now()` },
    });
}

/**
 * Is this customer's window open NOW? Outside it, a freeform reply cannot
 * be sent — the caller must choose a template, whose category is metered
 * to its own unit (§4.2).
 */
export async function serviceWindowOpen(
  tx: TenantDb,
  input: { businessId: string; wabaConnectionId: string; customerHash: string; at?: Date },
): Promise<boolean> {
  const at = input.at ?? new Date();
  const rows = await tx
    .select({ windowExpiresAt: wabaServiceWindows.windowExpiresAt })
    .from(wabaServiceWindows)
    .where(
      and(
        eq(wabaServiceWindows.businessId, input.businessId),
        eq(wabaServiceWindows.wabaConnectionId, input.wabaConnectionId),
        eq(wabaServiceWindows.customerHash, input.customerHash),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row !== undefined && row.windowExpiresAt.getTime() > at.getTime();
}
