/**
 * Scheduled and bulk payment reminders (REM-05, migration 0189, OWN-43).
 *
 * A batch is bookkeeping only: which invoices, which channels, when, and how far dispatch has got.
 * It holds no contact, message or money, and the send itself (with every eligibility re-read) is
 * the single-reminder path. Each recipient's outcome is the `invoice_reminders` row keyed
 * `batch:<batch id>:<item id>:<channel>`, so the batch reads its truth from the reminder history
 * rather than keeping a second copy that could disagree with it.
 *
 * Lock order, everywhere: the batch row, then its items. Cancellation takes the batch `FOR UPDATE`;
 * a claim and the dispatch guard take it `FOR SHARE`. So a cancellation and a dispatch are ordered,
 * never interleaved, and cannot deadlock.
 */
import { sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';

export type BatchChannels = 'auto' | 'whatsapp' | 'email' | 'both';
export type BatchState = 'scheduled' | 'completed' | 'cancelled';
export type BatchItemState = 'pending' | 'dispatching' | 'done' | 'cancelled' | 'skipped';

export interface BatchRow {
  id: string;
  channels: BatchChannels;
  attest: boolean;
  state: BatchState;
  scheduledFor: Date;
  itemCount: number;
  createdBy: string;
  createdAt: Date;
  cancelledAt: Date | null;
  completedAt: Date | null;
}

export interface BatchCounts {
  pending: number;
  sent: number;
  notSent: number;
  uncertain: number;
  cancelled: number;
}

export interface BatchItemRow {
  itemId: string;
  invoiceNumber: string;
  state: BatchItemState;
  reasonCode: string | null;
  reminders: Array<{
    channel: 'email' | 'whatsapp';
    status: 'sending' | 'sent' | 'blocked' | 'failed' | 'uncertain';
    reasonCode: string | null;
    sentAt: Date | null;
  }>;
}

/** The reminder idempotency key of one recipient (the reminder service appends `:<channel>`). */
export const batchItemKey = (batchId: string, itemId: string): string =>
  `batch:${batchId}:${itemId}`;

type RawBatch = {
  id: string;
  channels: BatchChannels;
  attest: boolean;
  state: BatchState;
  scheduled_for: Date;
  item_count: number;
  created_by: string;
  created_at: Date;
  cancelled_at: Date | null;
  completed_at: Date | null;
};

const toBatch = (r: RawBatch): BatchRow => ({
  id: r.id,
  channels: r.channels,
  attest: r.attest,
  state: r.state,
  scheduledFor: new Date(r.scheduled_for),
  itemCount: Number(r.item_count),
  createdBy: r.created_by,
  createdAt: new Date(r.created_at),
  cancelledAt: r.cancelled_at ? new Date(r.cancelled_at) : null,
  completedAt: r.completed_at ? new Date(r.completed_at) : null,
});

const BATCH_COLUMNS = sql`b.id, b.channels, b.attest, b.state, b.scheduled_for, b.item_count,
  b.created_by, b.created_at, b.cancelled_at, b.completed_at`;

/** Invoice ids for these numbers in this business; numbers it does not have are simply absent. */
export async function invoiceIdsByNumber(
  tx: TenantDb,
  businessId: string,
  invoiceNumbers: string[],
): Promise<Map<string, string>> {
  if (invoiceNumbers.length === 0) return new Map();
  const rows = await tx.execute<{ id: string; invoice_number: string }>(sql`
    SELECT id, invoice_number FROM invoices
    WHERE business_id = ${businessId}
      AND invoice_number IN (${sql.join(
        invoiceNumbers.map((n) => sql`${n}`),
        sql`, `,
      )})
  `);
  return new Map([...rows].map((r) => [r.invoice_number, r.id]));
}

/**
 * Write a confirmed batch and its items in one statement group. Idempotent on the merchant's key:
 * a repeat returns the existing batch (`created: false`) and writes nothing.
 */
export async function createBatch(
  tx: TenantDb,
  input: {
    businessId: string;
    channels: BatchChannels;
    attest: boolean;
    scheduledFor: Date;
    idempotencyKey: string;
    createdBy: string;
    invoiceIds: string[];
  },
): Promise<{ id: string; created: boolean }> {
  /* One key at a time, so two raced confirmations cannot both insert. */
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('reminder_batch:' || ${input.businessId}::text || ':' || ${input.idempotencyKey}))`,
  );
  const existing = await batchByKey(tx, input.businessId, input.idempotencyKey);
  if (existing) return { id: existing.id, created: false };

  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO reminder_batches
      (business_id, channels, attest, scheduled_for, idempotency_key, item_count, created_by)
    VALUES (${input.businessId}, ${input.channels}, ${input.attest}, ${input.scheduledFor.toISOString()}::timestamptz,
            ${input.idempotencyKey}, ${input.invoiceIds.length}, ${input.createdBy})
    RETURNING id
  `);
  const id = [...inserted][0]!.id;
  await tx.execute(sql`
    INSERT INTO reminder_batch_items (business_id, batch_id, invoice_id, position)
    VALUES ${sql.join(
      input.invoiceIds.map(
        (invoiceId, position) => sql`(${input.businessId}, ${id}, ${invoiceId}, ${position})`,
      ),
      sql`, `,
    )}
  `);
  return { id, created: true };
}

export async function batchByKey(
  tx: TenantDb,
  businessId: string,
  idempotencyKey: string,
): Promise<BatchRow | null> {
  const rows = await tx.execute<RawBatch>(sql`
    SELECT ${BATCH_COLUMNS} FROM reminder_batches b
    WHERE b.business_id = ${businessId} AND b.idempotency_key = ${idempotencyKey}
  `);
  const row = [...rows][0];
  return row ? toBatch(row) : null;
}

export async function batchById(
  tx: TenantDb,
  businessId: string,
  batchId: string,
): Promise<BatchRow | null> {
  const rows = await tx.execute<RawBatch>(sql`
    SELECT ${BATCH_COLUMNS} FROM reminder_batches b
    WHERE b.business_id = ${businessId} AND b.id = ${batchId}
  `);
  const row = [...rows][0];
  return row ? toBatch(row) : null;
}

/**
 * Each recipient's summary state, from the batch item and its reminder rows: sent if any channel
 * was sent; uncertain if none was and any is uncertain or still sending; cancelled or pending while
 * nothing was attempted; otherwise not sent (refused, failed or skipped).
 */
const ITEM_OUTCOME = sql`
  CASE
    WHEN bool_or(r.status = 'sent') THEN 'sent'
    WHEN bool_or(r.status IN ('uncertain', 'sending')) THEN 'uncertain'
    WHEN count(r.id) = 0 AND i.state = 'cancelled' THEN 'cancelled'
    WHEN count(r.id) = 0 AND i.state IN ('pending', 'dispatching') AND b.state = 'cancelled'
      THEN 'cancelled'
    WHEN count(r.id) = 0 AND i.state IN ('pending', 'dispatching') THEN 'pending'
    ELSE 'not_sent'
  END`;

const REMINDER_JOIN = sql`
  LEFT JOIN invoice_reminders r
    ON r.business_id = i.business_id
   AND r.idempotency_key IN ('batch:' || i.batch_id || ':' || i.id || ':whatsapp',
                             'batch:' || i.batch_id || ':' || i.id || ':email')`;

export async function batchCounts(
  tx: TenantDb,
  businessId: string,
  batchIds: string[],
): Promise<Map<string, BatchCounts>> {
  const out = new Map<string, BatchCounts>();
  if (batchIds.length === 0) return out;
  const rows = await tx.execute<{
    batch_id: string;
    pending: string;
    sent: string;
    not_sent: string;
    uncertain: string;
    cancelled: string;
  }>(sql`
    WITH per_item AS (
      SELECT i.batch_id, ${ITEM_OUTCOME} AS outcome
      FROM reminder_batch_items i
      JOIN reminder_batches b ON b.business_id = i.business_id AND b.id = i.batch_id
      ${REMINDER_JOIN}
      WHERE i.business_id = ${businessId}
        AND i.batch_id IN (${sql.join(
          batchIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      GROUP BY i.batch_id, i.id, i.state, b.state
    )
    SELECT batch_id,
           count(*) FILTER (WHERE outcome = 'pending')   AS pending,
           count(*) FILTER (WHERE outcome = 'sent')      AS sent,
           count(*) FILTER (WHERE outcome = 'not_sent')  AS not_sent,
           count(*) FILTER (WHERE outcome = 'uncertain') AS uncertain,
           count(*) FILTER (WHERE outcome = 'cancelled') AS cancelled
    FROM per_item GROUP BY batch_id
  `);
  for (const r of rows) {
    out.set(r.batch_id, {
      pending: Number(r.pending),
      sent: Number(r.sent),
      notSent: Number(r.not_sent),
      uncertain: Number(r.uncertain),
      cancelled: Number(r.cancelled),
    });
  }
  return out;
}

export async function batchItems(
  tx: TenantDb,
  businessId: string,
  batchId: string,
): Promise<BatchItemRow[]> {
  const rows = await tx.execute<{
    item_id: string;
    invoice_number: string;
    state: BatchItemState;
    reason_code: string | null;
    reminders: Array<{
      channel: 'email' | 'whatsapp';
      status: 'sending' | 'sent' | 'blocked' | 'failed' | 'uncertain';
      reason_code: string | null;
      sent_at: string | null;
    }> | null;
  }>(sql`
    SELECT i.id AS item_id, inv.invoice_number, i.state, i.reason_code,
           json_agg(json_build_object('channel', r.channel, 'status', r.status,
                                      'reason_code', r.reason_code, 'sent_at', r.sent_at)
                    ORDER BY r.channel DESC) FILTER (WHERE r.id IS NOT NULL) AS reminders
    FROM reminder_batch_items i
    JOIN invoices inv ON inv.business_id = i.business_id AND inv.id = i.invoice_id
    ${REMINDER_JOIN}
    WHERE i.business_id = ${businessId} AND i.batch_id = ${batchId}
    GROUP BY i.id, inv.invoice_number, i.state, i.reason_code, i.position
    ORDER BY i.position
  `);
  return [...rows].map((r) => ({
    itemId: r.item_id,
    invoiceNumber: r.invoice_number,
    state: r.state,
    reasonCode: r.reason_code,
    reminders: (r.reminders ?? []).map((m) => ({
      channel: m.channel,
      status: m.status,
      reasonCode: m.reason_code,
      sentAt: m.sent_at ? new Date(m.sent_at) : null,
    })),
  }));
}

export async function recentBatches(
  tx: TenantDb,
  businessId: string,
  limit: number,
): Promise<BatchRow[]> {
  const rows = await tx.execute<RawBatch>(sql`
    SELECT ${BATCH_COLUMNS} FROM reminder_batches b
    WHERE b.business_id = ${businessId}
    ORDER BY b.created_at DESC, b.id DESC
    LIMIT ${Math.min(Math.max(limit, 1), 50)}
  `);
  return [...rows].map(toBatch);
}

/**
 * Stop a batch. Only a scheduled batch can be cancelled; every recipient not yet claimed for
 * dispatch is cancelled with it. A recipient already claimed is stopped by the dispatch guard if
 * its send has not yet committed its `sending` row (the guard reads this batch's state in that
 * same transaction), and otherwise is already with the provider and is reported as such.
 */
export async function cancelBatch(
  tx: TenantDb,
  businessId: string,
  batchId: string,
  userId: string,
  now: Date,
): Promise<
  { outcome: 'cancelled'; cancelledCount: number } | { outcome: 'not_cancellable' } | null
> {
  const locked = await tx.execute<{ state: BatchState }>(sql`
    SELECT state FROM reminder_batches
    WHERE business_id = ${businessId} AND id = ${batchId}
    FOR UPDATE
  `);
  const row = [...locked][0];
  if (!row) return null;
  if (row.state !== 'scheduled') return { outcome: 'not_cancellable' };
  const cancelled = await tx.execute<{ id: string }>(sql`
    UPDATE reminder_batch_items
    SET state = 'cancelled', reason_code = 'batch_cancelled', finished_at = ${now.toISOString()}::timestamptz
    WHERE business_id = ${businessId} AND batch_id = ${batchId} AND state = 'pending'
    RETURNING id
  `);
  await tx.execute(sql`
    UPDATE reminder_batches
    SET state = 'cancelled', cancelled_at = ${now.toISOString()}::timestamptz, cancelled_by = ${userId}
    WHERE business_id = ${businessId} AND id = ${batchId}
  `);
  return { outcome: 'cancelled', cancelledCount: [...cancelled].length };
}

export interface ClaimedItem {
  itemId: string;
  invoiceNumber: string;
  batch: BatchRow;
}

/**
 * Claim the next recipient of a due, still-scheduled batch, immediately before its send. A
 * recipient left `dispatching` before `staleBefore` (a worker died mid-send) is claimed again: its
 * send reuses the same reminder key, so a reminder that was already attempted is returned, never
 * repeated. `SKIP LOCKED` keeps two claimers off the same recipient.
 */
export async function claimNextItem(
  tx: TenantDb,
  businessId: string,
  batchId: string,
  now: Date,
  staleBefore: Date,
): Promise<ClaimedItem | null> {
  const batches = await tx.execute<RawBatch>(sql`
    SELECT ${BATCH_COLUMNS} FROM reminder_batches b
    WHERE b.business_id = ${businessId} AND b.id = ${batchId}
      AND b.state = 'scheduled' AND b.scheduled_for <= ${now.toISOString()}::timestamptz
    FOR SHARE
  `);
  const batch = [...batches][0];
  if (!batch) return null;
  const claimed = await tx.execute<{ id: string; invoice_number: string }>(sql`
    WITH next AS (
      SELECT i.id FROM reminder_batch_items i
      WHERE i.business_id = ${businessId} AND i.batch_id = ${batchId}
        AND (i.state = 'pending' OR (i.state = 'dispatching' AND i.claimed_at < ${staleBefore.toISOString()}::timestamptz))
      ORDER BY i.position
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE reminder_batch_items i
    SET state = 'dispatching', claimed_at = ${now.toISOString()}::timestamptz
    FROM next, invoices inv
    WHERE i.id = next.id AND inv.business_id = i.business_id AND inv.id = i.invoice_id
    RETURNING i.id, inv.invoice_number
  `);
  const item = [...claimed][0];
  if (!item) return null;
  return { itemId: item.id, invoiceNumber: item.invoice_number, batch: toBatch(batch) };
}

/** Moves a claimed recipient on exactly once; a recipient no longer `dispatching` is left alone. */
export async function finishItem(
  tx: TenantDb,
  businessId: string,
  itemId: string,
  state: 'done' | 'skipped' | 'cancelled',
  reasonCode: string | null,
  now: Date,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE reminder_batch_items
    SET state = ${state}, reason_code = ${reasonCode}, finished_at = ${now.toISOString()}::timestamptz
    WHERE business_id = ${businessId} AND id = ${itemId} AND state = 'dispatching'
    RETURNING id
  `);
  return [...rows].length > 0;
}

/**
 * Puts a claimed recipient back without an attempt (the pass is stopping early, for example after
 * repeated provider failures). Its send never started, so it is simply pending again.
 */
export async function releaseItem(tx: TenantDb, businessId: string, itemId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE reminder_batch_items SET state = 'pending', claimed_at = NULL
    WHERE business_id = ${businessId} AND id = ${itemId} AND state = 'dispatching'
  `);
}

/** A scheduled batch with nothing left to dispatch becomes completed. */
export async function completeIfDrained(
  tx: TenantDb,
  businessId: string,
  batchId: string,
  now: Date,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE reminder_batches b
    SET state = 'completed', completed_at = ${now.toISOString()}::timestamptz
    WHERE b.business_id = ${businessId} AND b.id = ${batchId} AND b.state = 'scheduled'
      AND NOT EXISTS (
        SELECT 1 FROM reminder_batch_items i
        WHERE i.business_id = b.business_id AND i.batch_id = b.id
          AND i.state IN ('pending', 'dispatching')
      )
    RETURNING b.id
  `);
  return [...rows].length > 0;
}

/**
 * The dispatch guard, read inside the transaction that would write a recipient's `sending` row:
 * the batch is still scheduled (not cancelled), and the person who scheduled it is still a member
 * allowed to send reminders. `FOR SHARE` orders it against a cancellation.
 */
export async function dispatchAllowed(
  tx: TenantDb,
  businessId: string,
  batchId: string,
  userId: string,
): Promise<'ok' | 'batch_cancelled' | 'scheduler_not_authorised'> {
  const rows = await tx.execute<{ state: BatchState }>(sql`
    SELECT state FROM reminder_batches
    WHERE business_id = ${businessId} AND id = ${batchId}
    FOR SHARE
  `);
  const state = [...rows][0]?.state;
  if (state !== 'scheduled') return 'batch_cancelled';
  const member = await tx.execute<{ role: string }>(sql`
    SELECT role FROM memberships WHERE business_id = ${businessId} AND user_id = ${userId}
  `);
  const role = [...member][0]?.role;
  return role === 'owner' || role === 'delegate' ? 'ok' : 'scheduler_not_authorised';
}

/**
 * ID-only discovery of due batches (OWN-57, ADR 0035 Amendment 1). Runs on the worker credential
 * through the dedicated SECURITY DEFINER function; returns ids and the scheduled time only.
 */
export async function dueBatches(
  workerDb: Db,
  asOf: Date,
  pageSize: number,
  afterId: string | null,
): Promise<Array<{ batchId: string; businessId: string; scheduledFor: Date }>> {
  const rows = await workerDb.execute<{ id: string; business_id: string; scheduled_for: Date }>(
    sql`SELECT id, business_id, scheduled_for
        FROM sweep_due_reminder_batches(${asOf.toISOString()}::timestamptz, ${pageSize}, ${afterId}::uuid)`,
  );
  return [...rows].map((r) => ({
    batchId: r.id,
    businessId: r.business_id,
    scheduledFor: new Date(r.scheduled_for),
  }));
}
