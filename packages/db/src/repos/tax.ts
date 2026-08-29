/**
 * The tax model's storage operations (spec §13; F2, PR-078).
 *
 * Reads answer "what is this business's tax standing for this code, ON
 * THIS DATE" — the rate is always derived from the effective-dated
 * observations, never a stored constant, so a Finance Act moves it with
 * a row. The separated calculator that writes TaxEvent rows from these
 * answers is PR-079's; nothing here computes tax.
 *
 * OPEN COMPLIANCE: configuration seeded with Nigeria's published
 * figures, never a statutory-compliance claim.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';
import { taxCodes, taxEvents, taxRates } from '../schema/tax.js';

/** Nigeria-first defaults, the same rows migration 0099 seeded the
 * estate with. ZERO_RATED and EXEMPT charge nothing and carry no rate
 * observations — an absent observation IS the zero. */
const DEFAULT_CODES = [
  { code: 'STANDARD_RATE', label: 'VAT (standard rate)', treatment: 'TAXABLE' },
  { code: 'ZERO_RATED', label: 'Zero-rated', treatment: 'ZERO_RATED' },
  { code: 'EXEMPT', label: 'VAT exempt', treatment: 'EXEMPT' },
] as const;

/** Nigeria's published VAT history: 5% until Feb 2020, 7.5% since
 * (Finance Act 2019). Observations, so the next Act is a new row. */
const STANDARD_RATE_HISTORY = [
  { rateBps: 500, effectiveFrom: '2015-01-01' },
  { rateBps: 750, effectiveFrom: '2020-02-01' },
] as const;

/** A new business's tax configuration, born with it. Idempotent. */
export async function seedTaxModel(tx: TenantDb, businessId: string): Promise<void> {
  const inserted = await tx
    .insert(taxCodes)
    .values(DEFAULT_CODES.map((c) => ({ businessId, ...c })))
    .onConflictDoNothing()
    .returning({ id: taxCodes.id, code: taxCodes.code });
  const standard =
    inserted.find((c) => c.code === 'STANDARD_RATE') ??
    (
      await tx
        .select({ id: taxCodes.id, code: taxCodes.code })
        .from(taxCodes)
        .where(and(eq(taxCodes.businessId, businessId), eq(taxCodes.code, 'STANDARD_RATE')))
    )[0];
  if (!standard) throw new Error('seedTaxModel: STANDARD_RATE did not seed');
  await tx
    .insert(taxRates)
    .values(
      STANDARD_RATE_HISTORY.map((r) => ({
        businessId,
        taxCodeId: standard.id,
        rateBps: r.rateBps,
        effectiveFrom: r.effectiveFrom,
      })),
    )
    .onConflictDoNothing();
}

export interface TaxCodeRow {
  id: string;
  code: string;
  label: string;
  treatment: string;
  pointPolicy: string;
  active: boolean;
}

export async function taxCodesFor(tx: TenantDb, businessId: string): Promise<TaxCodeRow[]> {
  return tx
    .select({
      id: taxCodes.id,
      code: taxCodes.code,
      label: taxCodes.label,
      treatment: taxCodes.treatment,
      pointPolicy: taxCodes.pointPolicy,
      active: taxCodes.active,
    })
    .from(taxCodes)
    .where(eq(taxCodes.businessId, businessId))
    .orderBy(taxCodes.code);
}

export interface TaxStanding {
  taxCodeId: string;
  code: string;
  treatment: string;
  pointPolicy: string;
  /** The rate IN FORCE on the asked date. Zero for a treatment that
   * charges nothing, and zero for a TAXABLE code before its first
   * observation — an honest "no rate had been published yet". */
  rateBps: number;
}

/**
 * This business's standing for one code, on one date. Null when the
 * code is not configured — the caller decides what an unconfigured code
 * means; nothing here invents one.
 */
export async function taxStandingFor(
  tx: TenantDb,
  businessId: string,
  code: string,
  onDate: string,
): Promise<TaxStanding | null> {
  const rows = await tx.execute<{
    tax_code_id: string;
    code: string;
    treatment: string;
    point_policy: string;
    rate_bps: number | null;
  }>(sql`
    SELECT t.id AS tax_code_id, t.code, t.treatment, t.point_policy,
           (SELECT r.rate_bps FROM tax_rates r
            WHERE r.business_id = t.business_id AND r.tax_code_id = t.id
              AND r.effective_from <= ${onDate}::date
            ORDER BY r.effective_from DESC LIMIT 1) AS rate_bps
    FROM tax_codes t
    WHERE t.business_id = ${businessId}::uuid AND t.code = ${code} AND t.active
  `);
  const row = [...rows][0];
  if (!row) return null;
  return {
    taxCodeId: row.tax_code_id,
    code: row.code,
    treatment: row.treatment,
    pointPolicy: row.point_policy,
    /* A non-TAXABLE treatment charges nothing whatever any row says. */
    rateBps: row.treatment === 'TAXABLE' ? Number(row.rate_bps ?? 0) : 0,
  };
}

/* ── TaxEvent (spec §13; 0100, PR-079) ───────────────────────────────────── */

export interface RecordTaxEventInput {
  businessId: string;
  taxCodeId: string;
  basisMinor: number;
  taxMinor: number;
  currency?: string;
  sourceType: string;
  sourceId: string;
  /** The TAX POINT (§13), from the code's point policy — never invented. */
  occurredAt: Date;
  /** The posting that carried the tax to the books, when one did. */
  journalId?: string | null;
}

/**
 * Record that a tax point occurred, ONCE: the §13 unique absorbs a
 * retried issue, so 'duplicate' is an ordinary answer, never an error.
 */
export async function recordTaxEvent(
  tx: TenantDb,
  input: RecordTaxEventInput,
): Promise<'recorded' | 'duplicate'> {
  const inserted = await tx
    .insert(taxEvents)
    .values({
      businessId: input.businessId,
      taxCodeId: input.taxCodeId,
      basisMinor: input.basisMinor,
      taxMinor: input.taxMinor,
      currency: input.currency ?? 'NGN',
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      occurredAt: input.occurredAt,
      journalId: input.journalId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: taxEvents.id });
  return inserted.length > 0 ? 'recorded' : 'duplicate';
}

export interface TaxEventRow {
  id: string;
  taxCodeId: string;
  basisMinor: number;
  taxMinor: number;
  currency: string;
  sourceType: string;
  sourceId: string;
  occurredAt: Date;
  journalId: string | null;
}

export async function taxEventsFor(
  tx: TenantDb,
  businessId: string,
  limit = 200,
): Promise<TaxEventRow[]> {
  return tx
    .select({
      id: taxEvents.id,
      taxCodeId: taxEvents.taxCodeId,
      basisMinor: taxEvents.basisMinor,
      taxMinor: taxEvents.taxMinor,
      currency: taxEvents.currency,
      sourceType: taxEvents.sourceType,
      sourceId: taxEvents.sourceId,
      occurredAt: taxEvents.occurredAt,
      journalId: taxEvents.journalId,
    })
    .from(taxEvents)
    .where(eq(taxEvents.businessId, businessId))
    .orderBy(taxEvents.occurredAt)
    .limit(limit);
}
