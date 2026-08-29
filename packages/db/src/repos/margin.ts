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
export interface UsageTypeCost {
  provider: string;
  /** A message category, a model role, or whatever else was metered. */
  usageType: string;
  costK: number;
  quantity: number;
  events: number;
}

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
 * The period's cost broken down by what was bought, not who sold it.
 *
 * `costByProvider` answers "how much did Meta charge us", which was enough
 * while every outbound message was one bucket. It is not enough now: spec
 * §24 separates the message categories precisely because a utility template
 * and a marketing template differ by roughly eightfold, and "that difference
 * is the largest variable in plan margin". Grouped by provider, an eightfold
 * shift in the mix is invisible — the total moves and nothing says why.
 *
 * Generic over `usage_type` rather than special-cased to messages, because
 * the same question is worth asking of model calls, transcription seconds
 * and document renders, and BL2 will ask it of all of them.
 */
export async function costByUsageType(db: Db, period: string): Promise<UsageTypeCost[]> {
  const rows = await db.execute<{
    provider: string;
    usage_type: string;
    cost_k: string | number | null;
    quantity: string | number | null;
    events: number | null;
  }>(sql`
    SELECT provider,
           usage_type,
           sum(naira_equivalent_k) AS cost_k,
           sum(quantity)           AS quantity,
           count(*)::int           AS events
    FROM usage_events
    WHERE billing_period = ${period}
    GROUP BY provider, usage_type
    ORDER BY sum(naira_equivalent_k) DESC, count(*) DESC, usage_type ASC
  `);
  return [...rows].map((r) => ({
    provider: r.provider,
    usageType: r.usage_type,
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

/* ── the subledger side (BL2, PR-103) ─────────────────────────────────────
 *
 * Since COST-1 landed, real money lives in `platform_cost_events` and the
 * margin stands on it: cost from the subledger, revenue from the plan
 * catalogue through the grandfathering pin. `usage_events` stays in this
 * file as the telemetry detail beneath the money - what was bought, in what
 * quantity - and the two can legitimately disagree the day an ACTUAL
 * provider invoice corrects an ESTIMATED rate-card row, which is exactly
 * why the financial figure comes from the financial record.
 */

/** The Lagos month `period` labels, as a half-open UTC window. */
function lagosMonth(period: string): { from: string; to: string } {
  const [year, month] = period.split('-').map(Number);
  const from = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, 1) - 3_600_000);
  const to = new Date(Date.UTC(year ?? 1970, month ?? 1, 1) - 3_600_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * The one pricing question, as SQL: which version governs this business
 * (the pin when it matches the plan, else the version in force), and what
 * does its open monthly NGN price say. Inlined per row via LATERAL because
 * the census and the per-merchant rows both need it and neither may loop.
 */
const MONTHLY_PRICE_LATERAL = sql`
  LEFT JOIN LATERAL (
    SELECT pp.amount_minor
    FROM plan_prices pp
    WHERE pp.plan_version_id = COALESCE(
        (SELECT pv.id FROM plan_versions pv
         WHERE pv.id = b.plan_version_id AND pv.plan_id = b.plan),
        (SELECT v.id FROM plan_versions v
         WHERE v.plan_id = b.plan
           AND v.effective_from <= now()
           AND (v.effective_to IS NULL OR v.effective_to > now())
         ORDER BY v.version DESC LIMIT 1))
      AND pp.currency = 'NGN'
      AND pp.billing_interval = 'monthly'
      AND pp.effective_from <= now()
      AND (pp.effective_to IS NULL OR pp.effective_to > now())
    ORDER BY pp.effective_from DESC
    LIMIT 1
  ) price ON true`;

export interface BusinessMargin extends BusinessCost {
  /** This merchant's monthly price from the catalogue, pin-aware, in kobo. */
  revenueK: number;
}

/**
 * The costliest merchants in one period, costed from the subledger and
 * priced from the catalogue. The LEFT JOIN keeps the silent merchants: a
 * business that cost nothing all month is either about to churn or a plan
 * being paid for and not used, and both are worth seeing.
 */
export async function marginByBusiness(
  db: Db,
  period: string,
  limit: number = DEFAULT_ROW_LIMIT,
): Promise<BusinessMargin[]> {
  const window = lagosMonth(period);
  const rows = await db.execute<{
    business_id: string;
    plan: string;
    revenue_k: string | number | null;
    cost_k: string | number | null;
    events: number | null;
    created_at: string;
  }>(sql`
    SELECT
      b.id                            AS business_id,
      b.plan                          AS plan,
      coalesce(price.amount_minor, 0) AS revenue_k,
      coalesce(c.cost_k, 0)           AS cost_k,
      coalesce(c.events, 0)::int      AS events,
      b.created_at                    AS created_at
    FROM businesses b
    ${MONTHLY_PRICE_LATERAL}
    LEFT JOIN (
      SELECT business_id,
             sum(amount_minor) AS cost_k,
             count(*)          AS events
      FROM platform_cost_events
      WHERE incurred_at >= ${window.from}::timestamptz
        AND incurred_at < ${window.to}::timestamptz
      GROUP BY business_id
    ) c ON c.business_id = b.id
    ORDER BY coalesce(c.cost_k, 0) DESC, b.created_at ASC
    LIMIT ${limit}
  `);
  return [...rows].map((r) => ({
    businessId: r.business_id,
    plan: r.plan,
    revenueK: Number(r.revenue_k ?? 0),
    costK: Number(r.cost_k ?? 0),
    events: r.events ?? 0,
    createdAt: new Date(r.created_at),
  }));
}

export interface RevenueCensusRow {
  plan: string;
  businesses: number;
  /** Of those, how many are priced above zero. */
  paying: number;
  /** What the plan's businesses pay per month between them, in kobo. */
  revenueK: number;
}

/**
 * The revenue side, over the whole estate, from the catalogue rather than a
 * constant: each business is priced by ITS version through the pin, so two
 * merchants on one plan can carry two prices and the census stays exact.
 */
export async function revenueCensus(db: Db): Promise<RevenueCensusRow[]> {
  const rows = await db.execute<{
    plan: string;
    businesses: number;
    paying: number;
    revenue_k: string | number | null;
  }>(sql`
    SELECT b.plan,
           count(*)::int AS businesses,
           count(*) FILTER (WHERE coalesce(price.amount_minor, 0) > 0)::int AS paying,
           coalesce(sum(price.amount_minor), 0) AS revenue_k
    FROM businesses b
    ${MONTHLY_PRICE_LATERAL}
    GROUP BY b.plan
    ORDER BY count(*) DESC
  `);
  return [...rows].map((r) => ({
    plan: r.plan,
    businesses: r.businesses,
    paying: r.paying,
    revenueK: Number(r.revenue_k ?? 0),
  }));
}

export interface CostTypeLine {
  /** A §29 cost class: MESSAGING, AI_INFERENCE, OCR, PAYMENT_FEE, BANK_FEED, STORAGE, TELEPHONY. */
  costType: string;
  provider: string;
  /** ESTIMATED rows are rate-card derivations; ACTUAL rows are the provider's word. */
  actualOrEstimated: string;
  costK: number;
  events: number;
}

/** The period's money by §29 class, straight off the subledger. */
export async function costEventsByType(db: Db, period: string): Promise<CostTypeLine[]> {
  const window = lagosMonth(period);
  const rows = await db.execute<{
    cost_type: string;
    provider: string;
    actual_or_estimated: string;
    cost_k: string | number | null;
    events: number | null;
  }>(sql`
    SELECT cost_type, provider, actual_or_estimated,
           sum(amount_minor) AS cost_k,
           count(*)::int     AS events
    FROM platform_cost_events
    WHERE incurred_at >= ${window.from}::timestamptz
      AND incurred_at < ${window.to}::timestamptz
    GROUP BY cost_type, provider, actual_or_estimated
    ORDER BY sum(amount_minor) DESC
  `);
  return [...rows].map((r) => ({
    costType: r.cost_type,
    provider: r.provider,
    actualOrEstimated: r.actual_or_estimated,
    costK: Number(r.cost_k ?? 0),
    events: r.events ?? 0,
  }));
}

/** The estate's subledger totals for one period, unattributed cost included. */
export async function costEventTotals(db: Db, period: string): Promise<PeriodTotals> {
  const window = lagosMonth(period);
  const rows = await db.execute<{
    cost_k: string | number | null;
    events: number | null;
    spending: number | null;
  }>(sql`
    SELECT coalesce(sum(amount_minor), 0)      AS cost_k,
           count(*)::int                       AS events,
           count(DISTINCT business_id)::int    AS spending
    FROM platform_cost_events
    WHERE incurred_at >= ${window.from}::timestamptz
      AND incurred_at < ${window.to}::timestamptz
  `);
  const row = [...rows][0];
  return {
    costK: Number(row?.cost_k ?? 0),
    events: row?.events ?? 0,
    spending: row?.spending ?? 0,
  };
}
