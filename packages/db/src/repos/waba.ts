/**
 * The merchant's own WABA (spec §24; PR-058): connected by them, routed by
 * us. Embedded Signup COMPLETES with a (wabaId, phoneNumberId, token)
 * triple — this repo records the completion, answers the routing question,
 * and keeps the 24-hour service window per customer. Production
 * enablement waits on W0; everything here works against test numbers.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';
import {
  awayAssistantReplies,
  awayAssistantSettings,
  wabaCatalogueItems,
  wabaConnections,
  wabaServiceWindows,
  wabaTemplates,
} from '../schema/waba.js';

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

/* ── connection health (PR-062): the sends ARE the health check ─────────── */

/**
 * A send on the connection succeeded: the connection is demonstrably
 * healthy NOW. Touches the watermark, clears any recorded reason, and
 * recovers an UNHEALTHY connection to CONNECTED — but never resurrects a
 * REVOKED one, whose number is no longer this business's to send on:
 * revocation ends by a NEW signup, not by a send that should have failed.
 */
export async function markWabaHealthy(
  tx: TenantDb,
  input: { businessId: string; connectionId: string },
): Promise<boolean> {
  const rows = await tx
    .update(wabaConnections)
    .set({
      status: 'CONNECTED',
      healthReason: null,
      lastHealthyAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(wabaConnections.businessId, input.businessId),
        eq(wabaConnections.id, input.connectionId),
        sql`${wabaConnections.status} IN ('CONNECTED', 'UNHEALTHY')`,
      ),
    )
    .returning({ id: wabaConnections.id });
  return rows.length === 1;
}

/**
 * A send failed for a connection-shaped reason. UNHEALTHY plus WHY — a
 * merchant told their WhatsApp is "unhealthy" with no reason has nothing
 * to act on, and the reason column is what the dashboard renders. Same
 * REVOKED guard as recovery: a dead connection does not change state
 * because a send bounced off it.
 */
export async function markWabaUnhealthy(
  tx: TenantDb,
  input: { businessId: string; connectionId: string; reason: string },
): Promise<boolean> {
  const rows = await tx
    .update(wabaConnections)
    .set({ status: 'UNHEALTHY', healthReason: input.reason, updatedAt: sql`now()` })
    .where(
      and(
        eq(wabaConnections.businessId, input.businessId),
        eq(wabaConnections.id, input.connectionId),
        sql`${wabaConnections.status} IN ('CONNECTED', 'UNHEALTHY')`,
      ),
    )
    .returning({ id: wabaConnections.id });
  return rows.length === 1;
}

/**
 * W0's billing-mode confirmation, as the auditable act it is (spec §24
 * OPEN COMMERCIAL; owner decision 2). The mode, the moment and the actor
 * land together — 0089's CHECK makes any other shape unrepresentable —
 * and the mode must be one of §24's three: UNCONFIRMED is the absence of
 * a confirmation, not something one confirms.
 */
export async function confirmBillingMode(
  tx: TenantDb,
  input: {
    businessId: string;
    connectionId: string;
    mode: 'MERCHANT_DIRECT' | 'REKODA_CREDIT_LINE' | 'PARTNER_BILLED';
    /** `owner:<name>` / `operator:<name>` — never a bare 'system'. */
    actor: string;
  },
): Promise<boolean> {
  const rows = await tx
    .update(wabaConnections)
    .set({
      billingMode: input.mode,
      billingModeConfirmedAt: sql`now()`,
      billingModeConfirmedBy: input.actor,
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
    category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
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
    /** Meta's stated reason, for REJECTED/PAUSED. Approval clears it. */
    rejectionReason?: string;
  },
): Promise<boolean> {
  const rows = await tx
    .update(wabaTemplates)
    .set({
      status: input.status,
      rejectionReason: input.status === 'APPROVED' ? null : (input.rejectionReason ?? null),
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(wabaTemplates.businessId, input.businessId), eq(wabaTemplates.id, input.templateId)),
    )
    .returning({ id: wabaTemplates.id });
  return rows.length === 1;
}

export interface TemplateRow {
  id: string;
  name: string;
  language: string;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  status: string;
  rejectionReason: string | null;
}

/**
 * The template a send names, if Meta has APPROVED it (PR-060). Anything
 * else — pending, rejected, paused, absent — is null, and the caller
 * refuses before any unit is consumed: an unapproved template send would
 * bounce at Meta AFTER costing the merchant capacity.
 */
export async function approvedTemplate(
  tx: TenantDb,
  input: { businessId: string; wabaConnectionId: string; name: string; language?: string },
): Promise<TemplateRow | null> {
  const rows = await tx
    .select({
      id: wabaTemplates.id,
      name: wabaTemplates.name,
      language: wabaTemplates.language,
      category: wabaTemplates.category,
      status: wabaTemplates.status,
      rejectionReason: wabaTemplates.rejectionReason,
    })
    .from(wabaTemplates)
    .where(
      and(
        eq(wabaTemplates.businessId, input.businessId),
        eq(wabaTemplates.wabaConnectionId, input.wabaConnectionId),
        eq(wabaTemplates.name, input.name),
        eq(wabaTemplates.language, input.language ?? 'en'),
        eq(wabaTemplates.status, 'APPROVED'),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? ({ ...row } as TemplateRow) : null;
}

/** The registry, as the dashboard lists it: every template, every status. */
export async function templatesFor(tx: TenantDb, businessId: string): Promise<TemplateRow[]> {
  const rows = await tx
    .select({
      id: wabaTemplates.id,
      name: wabaTemplates.name,
      language: wabaTemplates.language,
      category: wabaTemplates.category,
      status: wabaTemplates.status,
      rejectionReason: wabaTemplates.rejectionReason,
    })
    .from(wabaTemplates)
    .where(eq(wabaTemplates.businessId, businessId))
    .orderBy(wabaTemplates.name, wabaTemplates.language);
  return rows as TemplateRow[];
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

/* ── catalogue synchronisation (spec §3.2; PR-086) ─────────────────────── */

/**
 * Link the Meta commerce catalog this WABA presents. A data act, not a
 * sync: pushing happens when the sync runs, against whatever is linked.
 */
export async function setCatalogueId(
  tx: TenantDb,
  input: { businessId: string; catalogueId: string | null },
): Promise<'linked' | 'no_connection'> {
  const updated = await tx
    .update(wabaConnections)
    .set({ catalogueId: input.catalogueId, updatedAt: new Date() })
    .where(eq(wabaConnections.businessId, input.businessId))
    .returning({ id: wabaConnections.id });
  return updated.length > 0 ? 'linked' : 'no_connection';
}

export interface CataloguePush {
  productId: string;
  /** The identity Meta knows the item by: the product id, stable. */
  retailerId: string;
  name: string;
  priceK: number;
  availability: 'in stock' | 'out of stock';
}

/**
 * What the sync must SEND: every sellable product that disagrees with its
 * synced row (or has none), plus every synced item whose product stopped
 * being sellable — pushed as 'out of stock' rather than deleted, because a
 * customer mid-conversation about an item that vanished is worse than one
 * told it is gone.
 *
 * Dirtiness is COMPARISON, never a stored flag: the products table is the
 * truth and the synced rows are the projection's own record of what Meta
 * holds. A FAILED row always re-pushes — a failure is not a state to
 * settle into.
 *
 * Availability tells the truth about the shelf where the shelf is
 * counted: a product with movements and nothing on hand is 'out of
 * stock'; one never counted (a service, say) is 'in stock' — Rekoda does
 * not invent an empty shelf for goods it never counted.
 */
export async function catalogueDiffFor(
  tx: TenantDb,
  businessId: string,
  wabaConnectionId: string,
): Promise<CataloguePush[]> {
  const rows = await tx.execute<{
    product_id: string;
    name: string;
    price_k: string | null;
    availability: string;
    sellable: boolean;
    synced_name: string | null;
    synced_price_k: string | null;
    synced_availability: string | null;
    status: string | null;
  }>(sql`
    WITH shelf AS (
      SELECT p.id AS product_id, p.name, p.unit_price_k AS price_k,
             (p.active = 1 AND p.unit_price_k IS NOT NULL) AS sellable,
             CASE
               WHEN NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.product_id = p.id)
                 THEN 'in stock'
               WHEN (SELECT COALESCE(SUM(m.delta), 0) FROM inventory_movements m
                     WHERE m.product_id = p.id) > 0
                 THEN 'in stock'
               ELSE 'out of stock'
             END AS availability
      FROM products p
      WHERE p.business_id = ${businessId}::uuid
    )
    SELECT s.product_id, s.name, s.price_k, s.availability, s.sellable,
           i.synced_name, i.synced_price_k, i.synced_availability, i.status
    FROM shelf s
    LEFT JOIN waba_catalogue_items i
      ON i.business_id = ${businessId}::uuid
     AND i.waba_connection_id = ${wabaConnectionId}::uuid
     AND i.product_id = s.product_id
    WHERE
      (s.sellable AND (
        i.product_id IS NULL
        OR i.status = 'FAILED'
        OR i.synced_name <> s.name
        OR i.synced_price_k <> s.price_k
        OR i.synced_availability <> s.availability
      ))
      OR (NOT s.sellable AND i.product_id IS NOT NULL
          AND (i.synced_availability <> 'out of stock' OR i.status = 'FAILED'))
    ORDER BY s.name
  `);
  return [...rows].map((r) => ({
    productId: r.product_id,
    retailerId: r.product_id,
    name: r.name,
    priceK: Number(r.price_k ?? r.synced_price_k ?? 0),
    availability: r.sellable ? (r.availability as 'in stock' | 'out of stock') : 'out of stock',
  }));
}

export interface CatalogueSyncResult {
  productId: string;
  retailerId: string;
  name: string;
  priceK: number;
  availability: 'in stock' | 'out of stock';
  ok: boolean;
  /** Meta's stated reason when not ok. Advisory prose, never parsed. */
  error?: string | null;
}

/** Record what a push attempted, item by item: SYNCED with the figures
 * Meta accepted, FAILED with its stated reason. One row per product per
 * connection, upserted — the projection's record follows the push. */
export async function recordCatalogueSync(
  tx: TenantDb,
  input: { businessId: string; wabaConnectionId: string; results: readonly CatalogueSyncResult[] },
): Promise<void> {
  const at = new Date();
  for (const r of input.results) {
    await tx
      .insert(wabaCatalogueItems)
      .values({
        businessId: input.businessId,
        wabaConnectionId: input.wabaConnectionId,
        productId: r.productId,
        retailerId: r.retailerId,
        syncedName: r.name,
        syncedPriceK: r.priceK,
        syncedAvailability: r.availability,
        status: r.ok ? 'SYNCED' : 'FAILED',
        error: r.ok ? null : (r.error ?? 'provider refused the item'),
        syncedAt: at,
      })
      .onConflictDoUpdate({
        target: [
          wabaCatalogueItems.businessId,
          wabaCatalogueItems.wabaConnectionId,
          wabaCatalogueItems.productId,
        ],
        set: {
          syncedName: r.name,
          syncedPriceK: r.priceK,
          syncedAvailability: r.availability,
          status: r.ok ? 'SYNCED' : 'FAILED',
          error: r.ok ? null : (r.error ?? 'provider refused the item'),
          syncedAt: at,
        },
      });
  }
}

export interface CatalogueSyncState {
  catalogueId: string | null;
  syncedCount: number;
  failedCount: number;
  /** How many pushes the next sync would send, by the same diff the sync
   * runs — the page and the job cannot disagree. */
  pendingCount: number;
  lastSyncedAt: Date | null;
}

export async function catalogueSyncStateFor(
  tx: TenantDb,
  businessId: string,
): Promise<CatalogueSyncState | null> {
  const connection = await wabaConnectionFor(tx, businessId);
  if (!connection) return null;
  const counts = await tx.execute<{ synced: string; failed: string; last: string | null }>(sql`
    SELECT COUNT(*) FILTER (WHERE status = 'SYNCED') AS synced,
           COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
           MAX(synced_at)::text AS last
    FROM waba_catalogue_items
    WHERE business_id = ${businessId}::uuid AND waba_connection_id = ${connection.id}::uuid
  `);
  const row = [...counts][0];
  const pending = await catalogueDiffFor(tx, businessId, connection.id);
  return {
    catalogueId: connection.catalogueId ?? null,
    syncedCount: Number(row?.synced ?? 0),
    failedCount: Number(row?.failed ?? 0),
    pendingCount: pending.length,
    lastSyncedAt: row?.last ? new Date(row.last) : null,
  };
}

/* ── the away assistant's configured limits (spec Appendix D; W4, PR-090) ── */

export interface AwayAssistantSettings {
  enabled: boolean;
  /** Automated replies per customer per Lagos day. 0 means zero. */
  dailyReplyLimit: number;
}

const ASSISTANT_DEFAULTS: AwayAssistantSettings = { enabled: false, dailyReplyLimit: 5 };

/**
 * The merchant's own switch and ceiling. A business with no row has the
 * defaults — OFF — because an assistant nobody enabled answers nobody.
 */
export async function assistantSettingsFor(
  tx: TenantDb,
  businessId: string,
): Promise<AwayAssistantSettings> {
  const rows = await tx
    .select({
      enabled: awayAssistantSettings.enabled,
      dailyReplyLimit: awayAssistantSettings.dailyReplyLimit,
    })
    .from(awayAssistantSettings)
    .where(eq(awayAssistantSettings.businessId, businessId))
    .limit(1);
  const row = rows[0];
  if (!row) return ASSISTANT_DEFAULTS;
  return { enabled: row.enabled === 1, dailyReplyLimit: row.dailyReplyLimit };
}

/** The merchant flips the switch or moves the ceiling. Upsert: one row per business. */
export async function setAssistantSettings(
  tx: TenantDb,
  businessId: string,
  input: AwayAssistantSettings,
): Promise<AwayAssistantSettings> {
  if (!Number.isInteger(input.dailyReplyLimit) || input.dailyReplyLimit < 0) {
    throw new RangeError('setAssistantSettings: dailyReplyLimit must be a non-negative integer');
  }
  await tx
    .insert(awayAssistantSettings)
    .values({
      businessId,
      enabled: input.enabled ? 1 : 0,
      dailyReplyLimit: input.dailyReplyLimit,
    })
    .onConflictDoUpdate({
      target: [awayAssistantSettings.businessId],
      set: {
        enabled: input.enabled ? 1 : 0,
        dailyReplyLimit: input.dailyReplyLimit,
        updatedAt: sql`now()`,
      },
    });
  return input;
}

/**
 * Claim one automated reply against the day's ceiling, atomically.
 *
 * The increment and the comparison happen in ONE statement, so two
 * messages racing cannot both slip under the limit. A refusal writes
 * nothing: the meter records replies that were actually permitted, and 0
 * means zero — the very first claim under a nought ceiling refuses.
 */
export async function claimAssistantReply(
  tx: TenantDb,
  input: { businessId: string; customerHash: string; day: string; limit: number },
): Promise<boolean> {
  if (input.limit <= 0) return false;
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO away_assistant_replies (business_id, customer_hash, day, replies)
    VALUES (${input.businessId}::uuid, ${input.customerHash}, ${input.day}, 1)
    ON CONFLICT (business_id, customer_hash, day)
    DO UPDATE SET replies = away_assistant_replies.replies + 1, updated_at = now()
      WHERE away_assistant_replies.replies < ${input.limit}
    RETURNING id
  `);
  return [...rows].length === 1;
}

/** What the meter holds for one customer on one day. */
export async function assistantRepliesUsed(
  tx: TenantDb,
  input: { businessId: string; customerHash: string; day: string },
): Promise<number> {
  const rows = await tx
    .select({ replies: awayAssistantReplies.replies })
    .from(awayAssistantReplies)
    .where(
      and(
        eq(awayAssistantReplies.businessId, input.businessId),
        eq(awayAssistantReplies.customerHash, input.customerHash),
        eq(awayAssistantReplies.day, input.day),
      ),
    )
    .limit(1);
  return rows[0]?.replies ?? 0;
}

/**
 * Every business whose catalogue is worth pushing, read across tenants
 * (PR-142).
 *
 * The worker credential, for the same reason `routeByPhoneNumberId` uses it:
 * a sweep asks which businesses have work, and that question cannot be
 * answered from inside one tenant's pin. The `worker_resolve` policy grants
 * `rekoda_worker` exactly this read and nothing else.
 *
 * UNHEALTHY is included alongside CONNECTED, matching what `syncNow` already
 * accepts: the attempt IS the health check, and a merchant whose token went
 * stale still wants their prices to catch up once it is fixed. PENDING_SIGNUP
 * and REVOKED have nothing to push to. A connection with no catalogue id is
 * left out here rather than refused later, so the sweep does no work for a
 * merchant who has not named one.
 */
export async function businessesWithCatalogue(
  workerDb: Db,
  limit = 50,
): Promise<Array<{ businessId: string; connectionId: string }>> {
  const rows = await workerDb
    .select({
      businessId: wabaConnections.businessId,
      connectionId: wabaConnections.id,
    })
    .from(wabaConnections)
    .where(
      and(
        isNotNull(wabaConnections.catalogueId),
        inArray(wabaConnections.status, ['CONNECTED', 'UNHEALTHY']),
      ),
    )
    .orderBy(wabaConnections.businessId)
    .limit(limit);
  return [...rows];
}
