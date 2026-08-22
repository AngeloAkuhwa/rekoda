/**
 * Things the business keeps and uses (ADR 0026).
 *
 * The difference from an expense is not a category, it is which statement the
 * money lands on. Recording a ₦450,000 generator as an expense reports a loss
 * the business did not make, hides an asset it owns, and flatters every month
 * afterwards by charging nothing for using it.
 *
 * This slice puts the asset on the balance sheet. Charging it against the
 * months it is used is the sweep, and its own problem.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  lagosDay,
  monthlyDepreciationK,
  postAssetPurchase,
  postDepreciation,
  reversal,
  type PaymentMethod,
} from '@rekoda/core';
import type { Db, TenantDb } from '../client.js';
import { auditEvents } from '../schema/ops.js';
import { fixedAssets } from '../schema/finance.js';
import { writePosting } from './issue.js';

export interface RecordedAsset {
  assetId: string;
  ledgerTransactionId: string;
  /** What remains owed on it. Zero unless it was taken partly on credit. */
  owedK: number;
}

export async function recordAsset(
  tx: TenantDb,
  input: {
    businessId: string;
    description: string;
    costK: number;
    paidK: number;
    usefulLifeMonths: number;
    method: PaymentMethod;
    actor: string;
    boughtAt?: Date;
  },
): Promise<RecordedAsset> {
  const at = input.boughtAt ?? new Date();
  /* The posting first, so the row can carry its id and a withdrawal has
   * something exact to reverse. Throws before anything is written if the
   * figures do not make sense. */
  const posting = postAssetPurchase({
    memo: `Equipment: ${input.description}`,
    costK: input.costK,
    paidK: input.paidK,
    method: input.method,
  });
  const ledgerTransactionId = await writePosting(
    tx,
    input.businessId,
    posting,
    'asset',
    `asset:${input.description}:${at.toISOString()}`,
    { occurredAt: at },
  );

  const rows = await tx
    .insert(fixedAssets)
    .values({
      businessId: input.businessId,
      description: input.description,
      costK: input.costK,
      usefulLifeMonths: input.usefulLifeMonths,
      boughtOn: lagosDay(at),
      ledgerTransactionId,
    })
    .returning({ id: fixedAssets.id });
  const row = rows[0];
  if (!row) throw new Error('recordAsset: insert returned no row');

  await tx.insert(auditEvents).values({
    businessId: input.businessId,
    actor: input.actor,
    entity: 'fixed_asset',
    entityId: row.id,
    action: 'recorded',
    newValue: {
      description: input.description,
      costK: input.costK,
      usefulLifeMonths: input.usefulLifeMonths,
    } as never,
    sourceType: 'dashboard',
  });

  return {
    assetId: row.id,
    ledgerTransactionId,
    owedK: input.costK - input.paidK,
  };
}

export interface AssetReadback {
  id: string;
  description: string;
  costK: number;
  usefulLifeMonths: number;
  monthsCharged: number;
  boughtOn: string;
  status: string;
  /** Charged so far, and what is left on the balance sheet. */
  chargedK: number;
  bookValueK: number;
}

/**
 * What the business owns, newest first.
 *
 * `chargedK` is derived from the ledger rather than from `monthsCharged`
 * multiplied out, because the last month's charge absorbs the rounding and
 * multiplying would disagree with the balance sheet by a few kobo on most
 * assets. Two figures that disagree is the failure this codebase keeps
 * finding; deriving the visible one from the ledger is how it stops.
 */
export async function assetsFor(
  tx: TenantDb,
  businessId: string,
  limit = 100,
): Promise<AssetReadback[]> {
  const rows = await tx.execute<{
    id: string;
    description: string;
    cost_k: string;
    useful_life_months: number;
    months_charged: number;
    bought_on: string;
    status: string;
    charged_k: string;
  }>(sql`
    SELECT a.id, a.description, a.cost_k, a.useful_life_months, a.months_charged,
           a.bought_on::text AS bought_on, a.status,
           COALESCE((
             SELECT SUM(e.credit_k) - SUM(e.debit_k)
               FROM ledger_entries e
               JOIN ledger_transactions t ON t.id = e.transaction_id
              WHERE e.business_id = a.business_id
                AND e.account = 'ACCUMULATED_DEPRECIATION'
                AND t.source_id = a.id::text
           ), 0)::bigint AS charged_k
    FROM fixed_assets a
    WHERE a.business_id = ${businessId}::uuid
    ORDER BY a.bought_on DESC, a.created_at DESC
    LIMIT ${limit}
  `);
  return [...rows].map((r) => {
    const costK = Number(r.cost_k);
    const chargedK = Number(r.charged_k);
    return {
      id: r.id,
      description: r.description,
      costK,
      usefulLifeMonths: r.useful_life_months,
      monthsCharged: r.months_charged,
      boughtOn: r.bought_on,
      status: r.status,
      chargedK,
      bookValueK: r.status === 'withdrawn' ? 0 : costK - chargedK,
    };
  });
}

export type WithdrawAssetOutcome =
  | { outcome: 'withdrawn'; description: string; reversedK: number }
  | { outcome: 'not_found' }
  | { outcome: 'already_withdrawn' };

/**
 * Take back something that should not have been recorded.
 *
 * NOT a disposal. Selling or scrapping equipment is a real event with a gain
 * or a loss against its book value, and ADR 0026 says plainly that it is not
 * in this slice. This is the mistake path: the wrong figure, the wrong thing,
 * a duplicate. The posting is mirrored so the balance sheet returns to where
 * it was, exactly as a withdrawn expense does.
 */
export async function withdrawAsset(
  tx: TenantDb,
  input: { businessId: string; assetId: string; reason: string; actor: string },
): Promise<WithdrawAssetOutcome> {
  const [asset] = await tx
    .select({
      id: fixedAssets.id,
      description: fixedAssets.description,
      costK: fixedAssets.costK,
      status: fixedAssets.status,
      ledgerTransactionId: fixedAssets.ledgerTransactionId,
    })
    .from(fixedAssets)
    .where(and(eq(fixedAssets.businessId, input.businessId), eq(fixedAssets.id, input.assetId)));

  if (!asset) return { outcome: 'not_found' };
  if (asset.status !== 'recorded') return { outcome: 'already_withdrawn' };

  if (asset.ledgerTransactionId) {
    const entries = await tx.execute<{ account: string; debit_k: string; credit_k: string }>(sql`
      SELECT account, debit_k, credit_k FROM ledger_entries
      WHERE business_id = ${input.businessId}::uuid
        AND transaction_id = ${asset.ledgerTransactionId}::uuid
    `);
    const original = {
      memo: `Equipment: ${asset.description}`,
      lines: [...entries].map((e) => ({
        account: e.account as never,
        debitK: Number(e.debit_k),
        creditK: Number(e.credit_k),
      })),
    };
    await writePosting(
      tx,
      input.businessId,
      reversal(original, `Withdrawn: ${input.reason}`),
      'asset',
      `asset-withdrawn:${asset.id}`,
    );
  }

  await tx
    .update(fixedAssets)
    .set({ status: 'withdrawn' })
    .where(and(eq(fixedAssets.businessId, input.businessId), eq(fixedAssets.id, input.assetId)));

  await tx.insert(auditEvents).values({
    businessId: input.businessId,
    actor: input.actor,
    entity: 'fixed_asset',
    entityId: asset.id,
    action: 'withdrawn',
    oldValue: { description: asset.description, costK: Number(asset.costK) } as never,
    newValue: { reason: input.reason } as never,
    sourceType: 'dashboard',
  });

  return {
    outcome: 'withdrawn',
    description: asset.description,
    reversedK: Number(asset.costK),
  };
}

/** An asset with months of wear owing, across every tenant. */
export interface AssetDue {
  businessId: string;
  assetId: string;
  description: string;
  costK: number;
  usefulLifeMonths: number;
  monthsCharged: number;
  boughtOn: string;
}

/**
 * Whole months elapsed between two Lagos days.
 *
 * Calendar months, not thirty-day blocks: a generator bought on 3 March has
 * had one month of use on 3 April, whatever March's length. Bought on the
 * 31st and read on the 30th of the next month is NOT a month yet, which is
 * the conservative direction and the one that never charges for time the
 * business has not had.
 */
export function monthsElapsed(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  const months = (ty - fy) * 12 + (tm - fm);
  return Math.max(0, td >= fd ? months : months - 1);
}

/**
 * Assets owing at least one month of wear, across every tenant.
 *
 * Read through the WORKER role, which is not pinned to a business: "whose
 * equipment is due" names no tenant, exactly as the recurring sweep reads
 * "whose rent is due". The charge itself is written under a tenant pin.
 */
export async function assetsDue(db: Db, today: string, limit = 500): Promise<AssetDue[]> {
  const rows = await db.execute<{
    business_id: string;
    id: string;
    description: string;
    cost_k: string;
    useful_life_months: number;
    months_charged: number;
    bought_on: string;
  }>(sql`
    SELECT business_id, id, description, cost_k, useful_life_months, months_charged,
           bought_on::text AS bought_on
    FROM fixed_assets
    WHERE status = 'recorded'
      AND months_charged < useful_life_months
      AND bought_on <= ${today}::date
    ORDER BY bought_on ASC
    LIMIT ${limit}
  `);
  return [...rows].map((r) => ({
    businessId: r.business_id,
    assetId: r.id,
    description: r.description,
    costK: Number(r.cost_k),
    usefulLifeMonths: r.useful_life_months,
    monthsCharged: r.months_charged,
    boughtOn: r.bought_on,
  }));
}

/**
 * Charge one month of wear against one asset.
 *
 * The row is claimed with a conditional UPDATE that names the count it
 * expects, so two sweeps running at once cannot both charge the same month.
 * Whichever loses updates nothing, sees zero rows back, and stops — the same
 * shape the recurring sweep uses, and the reason neither needs a lock.
 *
 * The charge is written against `source_id = assetId`, which is what lets
 * `assetsFor` derive what has been charged from the LEDGER rather than by
 * multiplying a count. Two figures derived two ways is the failure this
 * codebase keeps finding.
 */
export async function chargeOneMonth(
  tx: TenantDb,
  input: { businessId: string; assetId: string; expectMonthsCharged: number; at: Date },
): Promise<{ charged: boolean; amountK: number }> {
  const [asset] = await tx
    .select({
      description: fixedAssets.description,
      costK: fixedAssets.costK,
      usefulLifeMonths: fixedAssets.usefulLifeMonths,
      monthsCharged: fixedAssets.monthsCharged,
      status: fixedAssets.status,
    })
    .from(fixedAssets)
    .where(and(eq(fixedAssets.businessId, input.businessId), eq(fixedAssets.id, input.assetId)));

  if (!asset || asset.status !== 'recorded') return { charged: false, amountK: 0 };
  if (asset.monthsCharged !== input.expectMonthsCharged) return { charged: false, amountK: 0 };

  const amountK = monthlyDepreciationK({
    costK: Number(asset.costK),
    usefulLifeMonths: asset.usefulLifeMonths,
    monthsCharged: asset.monthsCharged,
  });
  if (amountK <= 0) return { charged: false, amountK: 0 };

  /* Claim first. A sweep that posted and then failed to claim would charge
   * the same month again on the next pass. */
  const claimed = await tx
    .update(fixedAssets)
    .set({ monthsCharged: asset.monthsCharged + 1 })
    .where(
      and(
        eq(fixedAssets.businessId, input.businessId),
        eq(fixedAssets.id, input.assetId),
        eq(fixedAssets.monthsCharged, input.expectMonthsCharged),
      ),
    )
    .returning({ id: fixedAssets.id });
  if (claimed.length === 0) return { charged: false, amountK: 0 };

  await writePosting(
    tx,
    input.businessId,
    postDepreciation({
      memo: `Wear on ${asset.description}`,
      amountK,
    }),
    'depreciation',
    input.assetId,
    { occurredAt: input.at },
  );

  return { charged: true, amountK };
}
