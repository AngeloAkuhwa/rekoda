/**
 * The facts that tell one stock purchase from another (G-81, OD-23), read
 * for `purchaseMatches` in core, and the lock the purchase work holds while
 * it re-reads what is booked.
 *
 * Nothing here stores or logs a fingerprint. Every fact is a column that
 * already exists: the stored command's total and reference (a document
 * kind from a closed set and its digits, never letters), the product row a
 * name resolves to or a booking moved and whether it is catalogue-linked
 * (`external_catalogue_id`, the only trusted product identity, owner ruling
 * D3), the message's arrival, and the records a held question named.
 *
 * Product proof is DORMANT: nothing writes `external_catalogue_id` today,
 * so no product is trusted and no purchase is proven separate by product.
 * A name only ever resolves to a row here; before any catalogue writer
 * ships, product proof must never rest on that raw name match (G-81). No supplier, product or customer text is read into a
 * comparison or returned; a product name is folded and matched inside SQL,
 * as `productByName` does.
 *
 * Tenant-scoped like every repository: each statement names the business,
 * and RLS holds it to the business the transaction was opened for.
 */
import { sql } from 'drizzle-orm';
import {
  gatePurchase,
  normalisePurchaseReference,
  purchaseArrival,
  purchaseTotalK,
  type ProductIdentity,
  type PurchaseFacts,
  type PurchaseRecord,
  type RecordRef,
} from '@rekoda/core';
import { LOCK_CLASS, type TenantDb } from '../client.js';

/**
 * Serialise this business's purchases of ONE total, to the end of the
 * transaction (G-81, G-89). Taken by the purchase work at a chat yes, inside
 * the business's inbound lock on the chat path, and at a dashboard purchase
 * order receive (and its SAME answer), which takes no inbound lock; nothing
 * takes the inbound lock after this one. Between chat yeses it is a
 * BACKSTOP, since the inbound lock already serialises them; between a chat
 * yes and a dashboard receive it is the only net, so whichever commits
 * second reads the first's booking. The preview-time read does not take it:
 * the inbound lock and message order already serialise it.
 */
export async function lockPurchaseTotal(
  tx: TenantDb,
  businessId: string,
  amountK: number,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${LOCK_CLASS.purchaseIdentity}, hashtext(${`${businessId}:${amountK}`}))`,
  );
}

/**
 * Everything a "separate" answer declared this purchase apart from, as a
 * LATERAL join aliased `alias` with `asked_about_drafts` and
 * `asked_about_expenses` (Codex review of 0e9bf52): the records the held
 * question `start` named, and those of every question before it in its
 * line. A fresh preview refused at its yes is held again (keeping its own
 * `separate_from`), so a later "separate" to that refusal still carries what
 * the first answer declared, and the merchant is never asked about it again.
 * Bounded, and tenant-scoped at every step.
 */
const declaredLineage = (start: ReturnType<typeof sql>, businessId: string, alias: string) => sql`
  LEFT JOIN LATERAL (
    WITH RECURSIVE line(id, separate_from, named_drafts, named_expenses, depth) AS (
      SELECT c.id, c.separate_from, c.asked_about_drafts, c.asked_about_expenses, 0
        FROM command_drafts c
       WHERE c.id = ${start} AND c.business_id = ${businessId}::uuid
      UNION ALL
      SELECT c.id, c.separate_from, c.asked_about_drafts, c.asked_about_expenses, line.depth + 1
        FROM command_drafts c
        JOIN line ON c.id = line.separate_from
       WHERE c.business_id = ${businessId}::uuid AND line.depth < 16)
    SELECT (SELECT array_agg(DISTINCT x) FROM line, unnest(line.named_drafts) x)
             AS asked_about_drafts,
           (SELECT array_agg(DISTINCT y) FROM line, unnest(line.named_expenses) y)
             AS asked_about_expenses) ${sql.raw(alias)} ON true`;

/** The fold `productByName` matches on, applied to a stored mention. */
const foldedMention = (mention: ReturnType<typeof sql>) =>
  sql`lower(regexp_replace(btrim(${mention}), '[[:space:]]+', ' ', 'g'))`;

const productOf = (id: string | null, trusted: boolean | null): ProductIdentity | null =>
  id ? { id, trusted: trusted === true } : null;

/** The records a held question named, as the refs core compares. */
function namedRefs(drafts: string[] | null, expenses: string[] | null): RecordRef[] {
  return [
    ...(drafts ?? []).map((draftId) => ({ draftId, expenseId: null })),
    ...(expenses ?? []).map((expenseId) => ({ draftId: null, expenseId })),
  ];
}

/** When a message arrived, by its stored webhook event (else its row). */
const arrivalOf = (message: ReturnType<typeof sql>) => sql`coalesce(
  (SELECT ev.created_at FROM external_events ev
    WHERE ev.provider = 'meta' AND ev.external_id = ${message}.provider_message_id
      AND ev.business_id = ${message}.business_id),
  ${message}.created_at)`;

type DraftRow = {
  id: string;
  command: unknown;
  requested_by: string | null;
  at: Date | string;
  named_drafts: string[] | null;
  named_expenses: string[] | null;
  product_id: string | null;
  product_trusted: boolean | null;
};

/** One statement for every draft read, so the two checks see one truth. */
function draftsQuery(businessId: string, where: ReturnType<typeof sql>) {
  return sql`
    SELECT d.id, d.command, d.requested_by,
           ${arrivalOf(sql`m`)} AS at,
           sep.asked_about_drafts::text[] AS named_drafts,
           sep.asked_about_expenses::text[] AS named_expenses,
           p.id AS product_id, p.external_catalogue_id IS NOT NULL AS product_trusted
      FROM command_drafts d
      JOIN conversation_messages m
        ON m.id = d.conversation_message_id AND m.business_id = d.business_id
      ${declaredLineage(sql`d.separate_from`, businessId, 'sep')}
      LEFT JOIN LATERAL (
        SELECT p.id, p.external_catalogue_id FROM products p
         WHERE p.business_id = d.business_id
           AND ${foldedMention(sql`p.name`)} = ${foldedMention(sql`d.command->>'productMention'`)}
         ORDER BY p.created_at
         LIMIT 1) p ON true
     WHERE d.business_id = ${businessId}::uuid
       AND d.intent = 'RecordPurchase'
       AND ${where}`;
}

function factsOf(row: DraftRow, amountK: number): PurchaseFacts {
  const command = row.command as Record<string, unknown>;
  return {
    amountK,
    at: new Date(row.at),
    /* Only a product that arrives with a usable quantity is one (Codex
     * review of 7f173b6): a mention with none delivers nothing. */
    product: purchaseArrival(command as never)
      ? productOf(row.product_id, row.product_trusted)
      : null,
    reference: normalisePurchaseReference(command['supplierReference']),
    separateFrom: namedRefs(row.named_drafts, row.named_expenses),
    self: { draftId: row.id, expenseId: null },
  };
}

/**
 * The facts of one purchase draft, whatever its state, or null when the
 * draft is not a readable purchase of this business.
 */
export async function draftFacts(
  tx: TenantDb,
  businessId: string,
  draftId: string,
): Promise<(PurchaseFacts & { requestedBy: string | null }) | null> {
  if (!UUID.test(draftId)) return null;
  const rows = await tx.execute<DraftRow>(draftsQuery(businessId, sql`d.id = ${draftId}::uuid`));
  const row = [...rows][0];
  if (!row) return null;
  const amountK = purchaseTotalK(row.command);
  if (amountK === null) return null;
  return { ...factsOf(row, amountK), requestedBy: row.requested_by };
}

/**
 * The facts of a purchase about to be drafted from `messageId`: when that
 * message arrived, the product row the mention names if one exists, the
 * stated reference, and what a "separate" answer declared it apart from.
 */
export async function newPurchaseFacts(
  tx: TenantDb,
  businessId: string,
  input: {
    messageId: string;
    amountK: number;
    productMention: string | null;
    reference: unknown;
    /** The held question a "separate" answer is about, if any. */
    separateFrom?: string | null;
  },
): Promise<PurchaseFacts> {
  const rows = await tx.execute<{
    at: Date | string | null;
    product_id: string | null;
    product_trusted: boolean | null;
    named_drafts: string[] | null;
    named_expenses: string[] | null;
  }>(sql`
    SELECT
      (SELECT ${arrivalOf(sql`cm`)} FROM conversation_messages cm
        WHERE cm.id = ${input.messageId}::uuid AND cm.business_id = ${businessId}::uuid) AS at,
      p.id AS product_id, p.external_catalogue_id IS NOT NULL AS product_trusted,
      h.asked_about_drafts::text[] AS named_drafts,
      h.asked_about_expenses::text[] AS named_expenses
      FROM (SELECT 1) one
      LEFT JOIN LATERAL (
        SELECT p.id, p.external_catalogue_id FROM products p
         WHERE p.business_id = ${businessId}::uuid
           AND ${foldedMention(sql`p.name`)} = ${foldedMention(sql`${input.productMention}::text`)}
         ORDER BY p.created_at
         LIMIT 1) p ON true
      ${declaredLineage(sql`${input.separateFrom ?? null}::uuid`, businessId, 'h')}`);
  const row = [...rows][0];
  return {
    amountK: input.amountK,
    at: row?.at ? new Date(row.at) : new Date(),
    product: productOf(row?.product_id ?? null, row?.product_trusted ?? null),
    reference: normalisePurchaseReference(input.reference, input.amountK / 100),
    separateFrom: namedRefs(row?.named_drafts ?? null, row?.named_expenses ?? null),
    self: { draftId: null, expenseId: null },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every purchase of this total a new one may be (D1): the pending purchase
 * drafts, and the stock purchases BOOKED from 24 hours before `asOf` (D2),
 * from any ingress. `excludeDraftId` is the purchase being checked, by its
 * draft id and by the source it books under, so it is never its own
 * duplicate.
 *
 * Which records count is bounded three ways, never by mixing clocks:
 *  - `messageId` (a preview): by message ORDER (fresh review of #262). Under
 *    the business's inbound lock every visible record came from an earlier
 *    message, except one whose message was stored AFTER this one (a delayed
 *    or retried event): those are left out. Drafts and bookings are stamped
 *    when processed, later than the webhook, so no `<= asOf` bound applies.
 *  - `bookedSince` (the purchase work at the yes): every booking from then
 *    on, so a retried yes never ages one out (Codex review).
 *  - otherwise: records stamped at or before `asOf`.
 */
export async function purchaseRecords(
  tx: TenantDb,
  businessId: string,
  amountK: number,
  options: {
    asOf?: Date;
    excludeDraftId?: string | null;
    bookedOnly?: boolean;
    bookedSince?: Date;
    messageId?: string;
    /**
     * Only purchases booked in CHAT that no purchase order was answered
     * SAME against (G-89): what a dashboard receive is compared with. Another
     * received order is its own document, never this one's duplicate, and a
     * Chat purchase already linked to an order is that order's delivery.
     */
    chatOnly?: boolean;
  } = {},
): Promise<{ now: Date; records: PurchaseRecord[] }> {
  const asOf = sql`coalesce(${options.asOf ? options.asOf.toISOString() : null}::timestamptz, clock_timestamp())`;
  const exclude = options.excludeDraftId ?? null;
  const excludeUuid = exclude && UUID.test(exclude) ? exclude : null;
  /* When the message cannot be read, the bound falls back to `asOf`, which
   * keeps every record a readable message would: a missing row makes the
   * check stricter, never switches it off (fan-out review of 8dfce8f). */
  const cutoff = options.messageId
    ? sql`coalesce((SELECT ${arrivalOf(sql`cm`)} FROM conversation_messages cm
            WHERE cm.id = ${options.messageId}::uuid AND cm.business_id = ${businessId}::uuid),
            ${asOf})`
    : null;

  const records: PurchaseRecord[] = [];
  if (!options.bookedOnly) {
    const pending = await tx.execute<DraftRow>(
      draftsQuery(
        businessId,
        /* A preview whose window has closed can never be confirmed (G-23),
         * so it is nobody's duplicate. */
        /* Only a preview that reached somebody is "waiting for a yes" (Codex
         * review); one whose send failed is never described as one. The
         * purchase work at the yes still refuses a duplicate booked from it. */
        sql`d.state = 'pending' AND d.previewed AND d.expires_at > ${asOf}
            AND d.id IS DISTINCT FROM ${excludeUuid}::uuid
            AND ${cutoff ? sql`${arrivalOf(sql`m`)} <= ${cutoff}` : sql`d.created_at <= ${asOf}`}`,
      ),
    );
    for (const row of pending) {
      const total = purchaseTotalK(row.command);
      if (total !== amountK) continue;
      records.push({
        ...factsOf(row, total),
        id: row.id,
        state: 'pending',
        bookedAt: null,
        requestedBy: row.requested_by,
        billNumber: null,
      });
    }
  }

  const window = options.bookedSince
    ? sql`e.created_at > ${options.bookedSince.toISOString()}::timestamptz`
    : cutoff
      ? sql`e.created_at > ${asOf} - interval '24 hours'
            AND (CASE WHEN m.id IS NULL THEN e.created_at <= ${asOf}
                      ELSE ${arrivalOf(sql`m`)} <= ${cutoff} END)`
      : sql`e.created_at > ${asOf} - interval '24 hours' AND e.created_at <= ${asOf}`;

  const booked = await tx.execute<{
    id: string;
    draft_id: string | null;
    booked_at: Date | string;
    at: Date | string;
    requested_by: string | null;
    command: unknown;
    named_drafts: string[] | null;
    named_expenses: string[] | null;
    product_id: string | null;
    product_trusted: boolean | null;
    bill_number: string | null;
  }>(sql`
    SELECT e.id, d.id AS draft_id, e.created_at AS booked_at,
           CASE WHEN m.id IS NULL THEN e.created_at ELSE ${arrivalOf(sql`m`)} END AS at,
           d.requested_by, d.command,
           sep.asked_about_drafts::text[] AS named_drafts,
           sep.asked_about_expenses::text[] AS named_expenses,
           mv.product_id, p.external_catalogue_id IS NOT NULL AS product_trusted,
           b.bill_number
      FROM expenses e
      LEFT JOIN command_drafts d
        ON e.source_type = 'chat'
       AND d.business_id = e.business_id
       AND d.id = CASE WHEN e.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                       THEN e.source_id::uuid END
      LEFT JOIN conversation_messages m
        ON m.id = d.conversation_message_id AND m.business_id = e.business_id
      ${declaredLineage(sql`d.separate_from`, businessId, 'sep')}
      /* A booking's product is conclusive only when it moved exactly ONE
       * product (Codex review): a multi-line received order is never
       * represented by one of its lines, so it can never prove a purchase of
       * another of them separate. */
      LEFT JOIN LATERAL (
        SELECT CASE WHEN count(DISTINCT im.product_id) = 1
                    THEN (array_agg(im.product_id))[1] END AS product_id
          FROM inventory_movements im
         WHERE im.business_id = e.business_id
           AND im.source_type = e.source_type
           AND im.source_id = e.source_id) mv ON true
      LEFT JOIN products p ON p.id = mv.product_id AND p.business_id = e.business_id
      LEFT JOIN bills b ON b.expense_id = e.id AND b.business_id = e.business_id
     WHERE e.business_id = ${businessId}::uuid
       AND e.category = 'stock'
       AND e.status = 'recorded'
       AND e.amount_k = ${amountK}
       AND ${window}
       ${
         options.chatOnly
           ? sql`AND e.source_type = 'chat'
                 AND NOT EXISTS (SELECT 1 FROM orders o
                                  WHERE o.business_id = e.business_id
                                    AND o.received_expense_id = e.id)`
           : sql``
       }
       AND (${exclude}::text IS NULL
            OR NOT (e.source_type = 'chat' AND e.source_id = ${exclude}::text))
     ORDER BY e.created_at DESC`);

  for (const row of booked) {
    const command = (row.command ?? {}) as Record<string, unknown>;
    records.push({
      amountK,
      at: new Date(row.at),
      product: productOf(row.product_id, row.product_trusted),
      reference: normalisePurchaseReference(command['supplierReference']),
      separateFrom: namedRefs(row.named_drafts, row.named_expenses),
      self: { draftId: row.draft_id, expenseId: row.id },
      id: row.id,
      state: 'booked',
      bookedAt: new Date(row.booked_at),
      requestedBy: row.requested_by,
      billNumber: row.bill_number,
    });
  }

  const now = await clockOf(tx, options.asOf);
  return { now, records };
}

async function clockOf(tx: TenantDb, asOf: Date | undefined): Promise<Date> {
  if (asOf) return asOf;
  const rows = await tx.execute<{ now: Date | string }>(sql`SELECT clock_timestamp() AS now`);
  return new Date([...rows][0]!.now);
}

/**
 * The sender's OWN pending purchase previews of this total whose send failed
 * (so `previewed` is false, and the purchase would preview), as records the
 * caller compares exactly as any other (Codex review of 5bfe87e; was G-91):
 * never described as waiting previews, but still claimable. The caller
 * replaces one only when it is the single one that may be the same
 * purchase, never one proven or declared separate. Bounded by message
 * order, as `purchaseRecords` is. Another member's unseen draft is never
 * read.
 */
export async function unseenOwnPurchaseDrafts(
  tx: TenantDb,
  businessId: string,
  amountK: number,
  options: { actorId: string; asOf: Date; messageId: string; excludeDraftId?: string | null },
): Promise<PurchaseRecord[]> {
  if (!UUID.test(options.actorId) || !UUID.test(options.messageId)) return [];
  const exclude = options.excludeDraftId ?? null;
  const excludeUuid = exclude && UUID.test(exclude) ? exclude : null;
  const rows = await tx.execute<DraftRow>(
    draftsQuery(
      businessId,
      sql`d.state = 'pending' AND NOT d.previewed
          AND d.requested_by = ${options.actorId}::uuid
          AND d.expires_at > ${options.asOf.toISOString()}::timestamptz
          AND d.id IS DISTINCT FROM ${excludeUuid}::uuid
          AND ${arrivalOf(sql`m`)} <= coalesce((SELECT ${arrivalOf(sql`cm`)} FROM conversation_messages cm
                WHERE cm.id = ${options.messageId}::uuid AND cm.business_id = ${businessId}::uuid),
                ${options.asOf.toISOString()}::timestamptz)`,
    ),
  );
  const records: PurchaseRecord[] = [];
  for (const row of rows) {
    if (purchaseTotalK(row.command) !== amountK) continue;
    /* Only a draft that was a confirmable PREVIEW whose send failed: a
     * purchase held back for a question (CG1 arithmetic, the G-61 funding
     * source) is also stored unpreviewed, but its question was delivered
     * and it can never be confirmed, so it is no copy of anything (final-head
     * review of 77e9da8). */
    if (gatePurchase(row.command as never).gate !== 'CG2') continue;
    records.push({
      ...factsOf(row, amountK),
      id: row.id,
      state: 'pending',
      bookedAt: null,
      requestedBy: row.requested_by,
      billNumber: null,
    });
  }
  return records;
}
