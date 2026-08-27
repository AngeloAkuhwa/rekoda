/**
 * RevenueRecognitionEvent and the review queue (spec §12.2, §12.5;
 * PR-045). The events are the record the engine reads its own past from —
 * `revenueRecognisedToDate` is a SUM over them, computed at posting time,
 * never cached — and the review items are the other half of the atomic
 * refusal: nothing posted, everything kept, replayable.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { ReviewReason } from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { recognitionReviewItems, revenueRecognitionEvents } from '../schema/finance.js';

export type RecordRecognitionOutcome =
  | { outcome: 'recorded'; id: string }
  /* The §12.5 quadruple already holds a row: a replayed fulfilment is not
   * a second recognition. */
  | { outcome: 'already_recorded' };

export async function recordRevenueRecognition(
  tx: TenantDb,
  input: {
    businessId: string;
    orderId: string;
    orderLineId?: string;
    sourceType: string;
    sourceId: string;
    /** REVENUE only. Never gross. Never VAT-inclusive. */
    amountMinor: number;
    ledgerTransactionId: string;
  },
): Promise<RecordRecognitionOutcome> {
  const rows = await tx
    .insert(revenueRecognitionEvents)
    .values({
      businessId: input.businessId,
      orderId: input.orderId,
      ...(input.orderLineId ? { orderLineId: input.orderLineId } : {}),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      amountMinor: input.amountMinor,
      ledgerTransactionId: input.ledgerTransactionId,
    })
    .onConflictDoNothing()
    .returning({ id: revenueRecognitionEvents.id });
  const row = rows[0];
  if (!row) return { outcome: 'already_recorded' };
  return { outcome: 'recorded', id: row.id };
}

/** §12.2: the sum of this order's RevenueRecognitionEvents, live. */
export async function revenueRecognisedToDate(
  tx: TenantDb,
  businessId: string,
  orderId: string,
): Promise<number> {
  const rows = await tx
    .select({ total: sql<string>`coalesce(sum(${revenueRecognitionEvents.amountMinor}), 0)` })
    .from(revenueRecognitionEvents)
    .where(
      and(
        eq(revenueRecognitionEvents.businessId, businessId),
        eq(revenueRecognitionEvents.orderId, orderId),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

export type OpenReviewOutcome = { outcome: 'opened'; id: string } | { outcome: 'already_open' };

/** One open item per refused event: a replayed refusal is not a second
 * thing for a human to look at. */
export async function openReviewItem(
  tx: TenantDb,
  input: {
    businessId: string;
    orderId?: string;
    reviewReason: ReviewReason;
    sourceType: string;
    sourceId: string;
    context: Record<string, unknown>;
  },
): Promise<OpenReviewOutcome> {
  const rows = await tx
    .insert(recognitionReviewItems)
    .values({
      businessId: input.businessId,
      ...(input.orderId ? { orderId: input.orderId } : {}),
      reviewReason: input.reviewReason,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      context: input.context as never,
    })
    .onConflictDoNothing()
    .returning({ id: recognitionReviewItems.id });
  const row = rows[0];
  if (!row) return { outcome: 'already_open' };
  return { outcome: 'opened', id: row.id };
}

export async function openReviewItemsFor(tx: TenantDb, businessId: string) {
  return tx
    .select()
    .from(recognitionReviewItems)
    .where(
      and(
        eq(recognitionReviewItems.businessId, businessId),
        isNull(recognitionReviewItems.resolvedAt),
      ),
    )
    .orderBy(desc(recognitionReviewItems.createdAt));
}

export async function resolveReviewItem(
  tx: TenantDb,
  input: { businessId: string; itemId: string; actor: string },
): Promise<'resolved' | 'not_found'> {
  const rows = await tx
    .update(recognitionReviewItems)
    .set({ resolvedAt: sql`now()`, resolvedBy: input.actor })
    .where(
      and(
        eq(recognitionReviewItems.businessId, input.businessId),
        eq(recognitionReviewItems.id, input.itemId),
        isNull(recognitionReviewItems.resolvedAt),
      ),
    )
    .returning({ id: recognitionReviewItems.id });
  return rows.length === 1 ? 'resolved' : 'not_found';
}
