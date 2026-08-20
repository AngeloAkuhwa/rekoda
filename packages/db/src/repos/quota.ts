/**
 * Reserving a model call before making one (MASTER-PLAN §5.3.3).
 *
 * The shape of every statement here is the same idea: **the limit lives in the
 * WHERE clause**, so the increment cannot happen unless there was room. A
 * read-then-decide version of this is not a ceiling — two calls arriving
 * together both see 999 against a limit of 1000 and both proceed. The thing on
 * the other side of the check is a bill, so it is worth getting exactly right.
 *
 * Both reservations happen in ONE transaction. If the platform ceiling refuses
 * after the tenant ceiling allowed, the rollback undoes the tenant's increment
 * — no manual release path, and therefore no way to leak a reservation by
 * forgetting one.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';
import { withBusiness } from '../client.js';
import { aiQuotaCounters, usageEvents } from '../schema/ops.js';

export type Queryable = Db | TenantDb;

export interface QuotaLimits {
  /** Calls one business may make in a Lagos day. */
  perBusinessPerDay: number;
  /** Calls the whole platform may make in a Lagos day. The backstop. */
  globalPerDay: number;
}

export type Reservation =
  | { ok: true; businessCalls: number; globalCalls: number }
  | { ok: false; refusedBy: 'business' | 'platform' };

/**
 * The LAGOS day, so "it resets at midnight" is true for the merchant reading
 * it. Nigeria is fixed UTC+1 with no daylight saving, so this is arithmetic
 * rather than a timezone database — the same shift `usagePeriod` applies to
 * the monthly meter, which keeps the two ceilings on one calendar.
 */
export function lagosDay(at: Date): string {
  return new Date(at.getTime() + 3_600_000).toISOString().slice(0, 10);
}

/**
 * Take one call from both budgets, or take nothing.
 *
 * `ON CONFLICT … DO UPDATE … WHERE calls < limit` is the whole mechanism. When
 * the WHERE fails, PostgreSQL updates nothing and returns nothing — so "no row
 * returned" means "no room", and no increment happened to undo.
 *
 * The INSERT path is not covered by that WHERE (there is no conflicting row
 * yet), which is why a limit below 1 is rejected up front rather than
 * silently allowing the first call of the day through.
 */
export async function reserveAiCall(
  db: Db,
  businessId: string,
  limits: QuotaLimits,
  at: Date = new Date(),
): Promise<Reservation> {
  if (limits.perBusinessPerDay < 1) return { ok: false, refusedBy: 'business' };
  if (limits.globalPerDay < 1) return { ok: false, refusedBy: 'platform' };

  const day = lagosDay(at);

  return withBusiness<Reservation>(db, businessId, async (tx) => {
    const mine = await tx.execute<{ calls: number }>(sql`
      INSERT INTO ai_quota_counters (business_id, day, calls)
      VALUES (${businessId}::uuid, ${day}::date, 1)
      ON CONFLICT (business_id, day) DO UPDATE
        SET calls = ai_quota_counters.calls + 1
        WHERE ai_quota_counters.calls < ${limits.perBusinessPerDay}
      RETURNING calls
    `);
    const businessCalls = [...mine][0]?.calls;
    if (businessCalls === undefined) return { ok: false, refusedBy: 'business' };

    const platform = await tx.execute<{ calls: number }>(sql`
      INSERT INTO ai_global_counters (day, calls)
      VALUES (${day}::date, 1)
      ON CONFLICT (day) DO UPDATE
        SET calls = ai_global_counters.calls + 1
        WHERE ai_global_counters.calls < ${limits.globalPerDay}
      RETURNING calls
    `);
    const globalCalls = [...platform][0]?.calls;
    if (globalCalls === undefined) {
      /**
       * Refused by the platform after the tenant's budget already allowed it.
       * Throwing rolls the whole transaction back, which is what returns the
       * tenant's reservation — a merchant must not lose a call from their own
       * daily allowance because the platform was busy.
       */
      throw new PlatformCeilingReached();
    }

    return { ok: true, businessCalls, globalCalls };
  }).catch((error: unknown): Reservation => {
    if (error instanceof PlatformCeilingReached) {
      return { ok: false, refusedBy: 'platform' as const };
    }
    throw error;
  });
}

class PlatformCeilingReached extends Error {}

/**
 * Hand a reservation back.
 *
 * For the case the transaction cannot cover: the call was reserved, the
 * provider was never reached (a connection refused, a timeout before any
 * tokens were billed), so the merchant should not be charged a slot for
 * something that did not happen. `GREATEST(0, …)` because a double release is
 * a bug that should not be able to hand out free calls.
 */
export async function releaseAiCall(
  db: Db,
  businessId: string,
  at: Date = new Date(),
): Promise<void> {
  const day = lagosDay(at);
  await withBusiness(db, businessId, async (tx) => {
    await tx.execute(sql`
      UPDATE ai_quota_counters SET calls = GREATEST(0, calls - 1)
      WHERE business_id = ${businessId}::uuid AND day = ${day}::date
    `);
    await tx.execute(sql`
      UPDATE ai_global_counters SET calls = GREATEST(0, calls - 1) WHERE day = ${day}::date
    `);
  });
}

/** What a business has spent today. For the honest refusal message. */
export async function callsToday(
  tx: TenantDb,
  businessId: string,
  at: Date = new Date(),
): Promise<number> {
  const rows = await tx
    .select({ calls: aiQuotaCounters.calls })
    .from(aiQuotaCounters)
    .where(and(eq(aiQuotaCounters.businessId, businessId), eq(aiQuotaCounters.day, lagosDay(at))))
    .limit(1);
  return rows[0]?.calls ?? 0;
}

export interface UsageRecord {
  businessId: string;
  /**
   * Who charged us. `openai` belongs here for the same reason `anthropic`
   * does: the margin view groups by provider, and a call attributed to the
   * wrong one is a cost the wrong budget carries.
   */
  provider: 'meta' | 'twilio' | 'anthropic' | 'openai' | 'stt' | 'storage' | 'paystack';
  usageType: string;
  quantity: number;
  providerCostMicros: number;
  nairaEquivalentK: number;
  billingPeriod: string;
  meta?: Record<string, unknown>;
}

/**
 * Record what an external unit cost. Written for EVERY model call, including
 * the ones that failed — a call that burned tokens and then returned unusable
 * JSON still cost money, and a margin view that only counts successes is a
 * margin view that flatters.
 */
export async function recordUsage(tx: TenantDb, usage: UsageRecord): Promise<void> {
  await tx.insert(usageEvents).values({
    businessId: usage.businessId,
    provider: usage.provider,
    usageType: usage.usageType,
    quantity: usage.quantity,
    providerCostMicros: usage.providerCostMicros,
    nairaEquivalentK: usage.nairaEquivalentK,
    billingPeriod: usage.billingPeriod,
    meta: (usage.meta ?? null) as never,
  });
}

export interface UsageTotals {
  calls: number;
  providerCostMicros: number;
  nairaEquivalentK: number;
}

/**
 * What this tenant has spent. Row-level security scopes it, so there is no
 * `WHERE business_id` here and no way for a caller to widen it.
 *
 * `provider` narrows it, and needs to: one message now produces rows for two
 * providers — the model that read it and the WhatsApp message that answered —
 * so an unfiltered total answers "what did this cost", not "what did the AI
 * cost". Those are different questions and the margin view asks both.
 */
export async function usageTotals(tx: TenantDb, provider?: string): Promise<UsageTotals> {
  const rows = await tx.execute<{ n: number; micros: number; kobo: number }>(sql`
    SELECT count(*)::int AS n,
           coalesce(sum(provider_cost_micros), 0)::bigint AS micros,
           coalesce(sum(naira_equivalent_k), 0)::bigint AS kobo
    FROM usage_events
    ${provider ? sql`WHERE provider = ${provider}` : sql``}
  `);
  const row = [...rows][0];
  return {
    calls: Number(row?.n ?? 0),
    providerCostMicros: Number(row?.micros ?? 0),
    nairaEquivalentK: Number(row?.kobo ?? 0),
  };
}
