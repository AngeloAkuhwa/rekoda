/**
 * The cost side of the business, per merchant, per month.
 *
 * Every query in this file is cross-tenant and therefore needs the
 * `rekoda_worker` credential: `usage_events` and `businesses` are both under
 * FORCE row-level security, so the application role sees nothing here rather
 * than everybody, which would report a serenely profitable zero forever.
 * Migration 0019 grants that role SELECT and only SELECT on the two tables,
 * and says at length why that is a convenience rather than a widening.
 *
 * Nothing in here returns a name, a phone number or a customer. A margin
 * report is a question about money, and the id is enough to act on: it is
 * what `POST /v1/businesses/plan` already takes.
 *
 * The rows and the totals are deliberately two different queries. Listing
 * every tenant to add them up works at ten merchants and stops working
 * somewhere before ten thousand, and the failure would arrive as a slow
 * operator page rather than as an error. The totals are aggregates over the
 * whole estate; the rows are the expensive tail, which is the part anybody
 * actually reads.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../client.js';

export interface BusinessCost {
  businessId: string;
  /**
   * The plan today. A business that changed plan mid-period is priced at
   * today's plan, which is the honest simplification: nothing records what
   * they were actually charged, because nothing charges them yet.
   */
  plan: string;
  /** Provider cost for the period in kobo, at the FX captured per row. */
  costK: number;
  /** How many metered events made up that cost. Zero is a real answer. */
  events: number;
  /** When this business started, so a part-month is recognisable as one. */
  createdAt: Date;
}

export interface ProviderCost {
  provider: string;
  costK: number;
  /** Summed `quantity`: messages, seconds or documents depending on provider. */
  quantity: number;
  events: number;
}

/** How many businesses sit on each plan, over the whole estate. */
export interface PlanCount {
  plan: string;
  businesses: number;
}

/** The whole estate for one period, in three numbers the rows cannot contradict. */
export interface PeriodTotals {
  costK: number;
  events: number;
  /** Businesses that spent anything at all. The rest are quiet, not absent. */
  spending: number;
}

/** A sane page of the expensive tail. An operator reads the top, not the estate. */
export const DEFAULT_ROW_LIMIT = 200;

/**
 * The costliest merchants in one billing period (`YYYY-MM`, Lagos month).
 *
 * A LEFT JOIN, not an inner one: a business that sent nothing all month still
 * belongs in the report if it reaches the page. It is either a merchant about
 * to churn or a plan being paid for and not used, and both are worth seeing.
 */
export async function costByBusiness(
  db: Db,
  period: string,
  limit: number = DEFAULT_ROW_LIMIT,
): Promise<BusinessCost[]> {
  const rows = await db.execute<{
    business_id: string;
    plan: string;
    cost_k: string | number | null;
    events: number | null;
    created_at: string;
  }>(sql`
    SELECT
      b.id                       AS business_id,
      b.plan                     AS plan,
      coalesce(u.cost_k, 0)      AS cost_k,
      coalesce(u.events, 0)::int AS events,
      b.created_at               AS created_at
    FROM businesses b
    LEFT JOIN (
      SELECT business_id,
             sum(naira_equivalent_k) AS cost_k,
             count(*)                AS events
      FROM usage_events
      WHERE billing_period = ${period}
      GROUP BY business_id
    ) u ON u.business_id = b.id
    ORDER BY coalesce(u.cost_k, 0) DESC, b.created_at ASC
    LIMIT ${limit}
  `);
  return [...rows].map((r) => ({
    businessId: r.business_id,
    plan: r.plan,
    costK: Number(r.cost_k ?? 0),
    events: r.events ?? 0,
    createdAt: new Date(r.created_at),
  }));
}

/**
 * The period's cost over every tenant, listed or not.
 *
 * Separate from the rows on purpose. A total summed from a truncated page is
 * a total that quietly shrinks the day the estate outgrows the page, and
 * nobody would notice: it would still look like a plausible number.
 */
export async function periodTotals(db: Db, period: string): Promise<PeriodTotals> {
  const rows = await db.execute<{
    cost_k: string | number | null;
    events: number | null;
    spending: number | null;
  }>(sql`
    SELECT coalesce(sum(naira_equivalent_k), 0)  AS cost_k,
           count(*)::int                         AS events,
           count(DISTINCT business_id)::int      AS spending
    FROM usage_events
    WHERE billing_period = ${period}
  `);
  const row = [...rows][0];
  return {
    costK: Number(row?.cost_k ?? 0),
    events: row?.events ?? 0,
    spending: row?.spending ?? 0,
  };
}

/**
 * Who is on what, over the whole estate.
 *
 * This is the revenue side. Counting plans and multiplying by the price in
 * `@rekoda/core` is exact and costs one grouped scan, where summing a price
 * per listed row would only ever be as complete as the page.
 */
export async function planCensus(db: Db): Promise<PlanCount[]> {
  const rows = await db.execute<{ plan: string; businesses: number }>(sql`
    SELECT plan, count(*)::int AS businesses
    FROM businesses
    GROUP BY plan
    ORDER BY count(*) DESC
  `);
  return [...rows].map((r) => ({ plan: r.plan, businesses: r.businesses }));
}

/**
 * The same period split by who Rekoda is paying: Meta, the model vendor,
 * transcription, storage.
 *
 * This is the line that tells an operator WHICH cost to attack. "We spend
 * ₦40,000 a month" is not actionable; "₦31,000 of it is WhatsApp" is.
 */
export async function costByProvider(db: Db, period: string): Promise<ProviderCost[]> {
  const rows = await db.execute<{
    provider: string;
    cost_k: string | number | null;
    quantity: string | number | null;
    events: number | null;
  }>(sql`
    SELECT provider,
           sum(naira_equivalent_k) AS cost_k,
           sum(quantity)           AS quantity,
           count(*)::int           AS events
    FROM usage_events
    WHERE billing_period = ${period}
    GROUP BY provider
    ORDER BY sum(naira_equivalent_k) DESC
  `);
  return [...rows].map((r) => ({
    provider: r.provider,
    costK: Number(r.cost_k ?? 0),
    quantity: Number(r.quantity ?? 0),
    events: r.events ?? 0,
  }));
}

/**
 * Which billing periods have any usage at all, newest first.
 *
 * Saves an operator guessing at a month and getting an empty report they
 * cannot distinguish from a broken one.
 */
export async function meteredPeriods(db: Db, limit = 12): Promise<string[]> {
  const rows = await db.execute<{ billing_period: string }>(sql`
    SELECT DISTINCT billing_period
    FROM usage_events
    ORDER BY billing_period DESC
    LIMIT ${limit}
  `);
  return [...rows].map((r) => r.billing_period);
}
