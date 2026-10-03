/**
 * Conversational continuation state (migration 0154, Build 6).
 *
 * What a short reply may continue: a question Rekoda asked ONE member
 * ("Which period?"), or the read it just answered them. Every function takes
 * the business AND the member: the tenant policy keeps businesses apart, and
 * the `user_id` predicate in every statement keeps the people of one business
 * apart, so an accountant's "last month" can never answer the owner's
 * question.
 *
 * Not the financial confirmation state. Nothing here reads, writes or names a
 * command draft; a "yes" is decided by `conversationsRepo` alone (G-23).
 *
 * Time: "now" is the instant the caller names (the moment the merchant's
 * message reached Rekoda), else the database clock, never a process's own
 * clock. Tests name instants instead of sleeping. A row is live iff it is
 * open, it existed at that instant (`created_at <= now`: a reply cannot
 * answer a question asked after it was sent), and `now < expires_at`; the
 * predicate is in each statement, never a read a later write trusts.
 */
import { sql } from 'drizzle-orm';
import {
  CONTINUATION_TTL_SECONDS,
  continuationColumns,
  parseContinuation,
  type ContinuationState,
} from '@rekoda/core';
import type { TenantDb } from '../client.js';

const clock = (now: Date | undefined) =>
  sql`coalesce(${now ? now.toISOString() : null}::timestamptz, clock_timestamp())`;

export interface OpenContinuationInput {
  businessId: string;
  /** The member who was asked: `users.id` of the sender's membership. */
  userId: string;
  /** The inbound message whose answer opened this (provenance, replay guard). */
  sourceMessageId: string;
  state: ContinuationState;
  /** Tests only: when the window opens. Production uses the database clock. */
  now?: Date;
  /**
   * When it closes, if not CONTINUATION_TTL_SECONDS after it opens: a G-61
   * funding question stays answerable exactly as long as its answer window
   * (G-68 review), so the "Reply *bank* or *cash*" it offered stays true.
   */
  expiresAt?: Date;
}

export interface OpenContinuation {
  id: string;
  state: ContinuationState;
}

/**
 * Retire every open row this member has that existed when their message
 * arrived, in one statement: past its window it becomes `expired`,
 * otherwise `superseded`. Returns how many moved.
 *
 * Called when the member says something that does not continue what was
 * open (the newest thing said wins). `created_at <= now`, as on every read
 * and claim: a message received before a question was written is not a
 * reply to it, and must not close it.
 */
export async function retireContinuations(
  tx: TenantDb,
  businessId: string,
  userId: string,
  options: { now?: Date } = {},
): Promise<number> {
  const now = clock(options.now);
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE conversation_continuations
       SET state = CASE WHEN expires_at <= ${now} THEN 'expired' ELSE 'superseded' END,
           updated_at = clock_timestamp()
     WHERE business_id = ${businessId}::uuid
       AND user_id = ${userId}::uuid
       AND state = 'open'
       AND created_at <= ${now}
    RETURNING id`);
  return [...rows].length;
}

/**
 * Open a continuation for this member, retiring whatever was open (newest
 * wins). One row per source message: a replayed message changes nothing,
 * and in particular does not retire the row it opened the first time.
 *
 * The retire here has no `created_at` predicate on purpose: this is the
 * newest question being written NOW, and every open row is older than it.
 *
 * `ON CONFLICT DO NOTHING` covers both uniques: the message one (a replay
 * racing itself) and the one-open-per-member one. For the second, two
 * concurrent openers for one member both retire, both insert; the second
 * insert waits on the first's uncommitted row and, once that commits, does
 * nothing: the FIRST to commit stands, and the loser returns null. The
 * inbound handler serialises a business's messages, so this is a backstop.
 */
export async function openContinuation(
  tx: TenantDb,
  input: OpenContinuationInput,
): Promise<{ id: string; isNew: boolean } | null> {
  const columns = continuationColumns(input.state);
  const replayed = await rowForMessage(tx, input, columns.expects);
  if (replayed) return { id: replayed, isNew: false };

  await tx.execute(sql`
    UPDATE conversation_continuations
       SET state = CASE WHEN expires_at <= ${clock(input.now)} THEN 'expired' ELSE 'superseded' END,
           updated_at = clock_timestamp()
     WHERE business_id = ${input.businessId}::uuid
       AND user_id = ${input.userId}::uuid
       AND state = 'open'`);
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO conversation_continuations
      (business_id, user_id, source_message_id, kind, expects, topic, period,
       customer_token, document_ref, options, draft_id, expires_at)
    VALUES (
      ${input.businessId}::uuid, ${input.userId}::uuid, ${input.sourceMessageId}::uuid,
      ${columns.kind}, ${columns.expects}, ${columns.topic}, ${columns.period},
      ${columns.customerToken}, ${columns.documentRef},
      ${columns.options === null ? null : JSON.stringify(columns.options)}::jsonb,
      ${columns.draftId}::uuid,
      ${
        input.expiresAt
          ? sql`${input.expiresAt.toISOString()}::timestamptz`
          : sql`${clock(input.now)} + make_interval(secs => ${CONTINUATION_TTL_SECONDS})`
      })
    ON CONFLICT DO NOTHING
    RETURNING id`);
  const created = [...inserted][0];
  if (created) return { id: created.id, isNew: true };

  const raced = await rowForMessage(tx, input, columns.expects);
  return raced ? { id: raced, isNew: false } : null;
}

/**
 * The row this member's message already opened FOR THIS EXPECTED ANSWER, if
 * it opened one (0158): one message may ask one member two different things
 * over its life (a funding answer whose rebuild was held for the identity
 * question, then, when that question was never delivered, the funding
 * question given back), and a replay still finds its own row.
 */
async function rowForMessage(
  tx: TenantDb,
  input: Pick<OpenContinuationInput, 'businessId' | 'userId' | 'sourceMessageId'>,
  expects: string | null,
): Promise<string | null> {
  const existing = await tx.execute<{ id: string }>(sql`
    SELECT id FROM conversation_continuations
     WHERE business_id = ${input.businessId}::uuid
       AND user_id = ${input.userId}::uuid
       AND source_message_id = ${input.sourceMessageId}::uuid
       AND expects IS NOT DISTINCT FROM ${expects}`);
  return [...existing][0]?.id ?? null;
}

type Row = {
  id: string;
  kind: string;
  expects: string | null;
  topic: string | null;
  period: string | null;
  customer_token: string | null;
  document_ref: string | null;
  options: unknown;
  draft_id: string | null;
};

/**
 * The live continuation for this member, or null. Expired, consumed,
 * superseded, another member's, another business's, or written after
 * `now`: all null, which is "nothing open". A row that does not parse as a
 * shape core writes is null too.
 */
export async function currentContinuation(
  tx: TenantDb,
  businessId: string,
  userId: string,
  options: { now?: Date } = {},
): Promise<OpenContinuation | null> {
  const now = clock(options.now);
  const rows = await tx.execute<Row>(sql`
    SELECT id, kind, expects, topic, period, customer_token, document_ref, options, draft_id
      FROM conversation_continuations
     WHERE business_id = ${businessId}::uuid
       AND user_id = ${userId}::uuid
       AND state = 'open'
       AND created_at <= ${now}
       AND expires_at > ${now}
     ORDER BY insertion_seq DESC
     LIMIT 1`);
  const row = [...rows][0];
  if (!row) return null;
  const state = parseContinuation({
    kind: row.kind,
    expects: row.expects,
    topic: row.topic,
    period: row.period,
    customerToken: row.customer_token,
    documentRef: row.document_ref,
    options: row.options,
    draftId: row.draft_id,
  });
  return state ? { id: row.id, state } : null;
}

/**
 * Claim a clarification for its answer, exactly once.
 *
 * The predicates ARE the claim, as `claimDraft`'s are: open, this member's,
 * this business's, existing at `now`, and inside its window, all in the one
 * UPDATE. Two replies racing for one question get one `true`; the loser, and
 * a reply after the window, gets `false` and treats the question as absent.
 */
export async function consumeContinuation(
  tx: TenantDb,
  businessId: string,
  userId: string,
  continuationId: string,
  options: { now?: Date } = {},
): Promise<boolean> {
  const now = clock(options.now);
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE conversation_continuations
       SET state = 'consumed', updated_at = clock_timestamp()
     WHERE id = ${continuationId}::uuid
       AND business_id = ${businessId}::uuid
       AND user_id = ${userId}::uuid
       AND state = 'open'
       AND created_at <= ${now}
       AND expires_at > ${now}
    RETURNING id`);
  return [...rows].length === 1;
}

/**
 * Retire the continuation this message's answer opened, if it is still open
 * (Build 6): the reply never reached the member (the send failed and was
 * swallowed so the transaction commits), so a question they never saw, or an
 * answer they never read, is not something their next message continues.
 * The continuation-side twin of `markDraftUnseen`. Returns how many moved.
 */
export async function retireContinuationOpenedBy(
  tx: TenantDb,
  businessId: string,
  sourceMessageId: string,
  /** A question the merchant DID see that this message re-opened (G-81,
   * Codex review): kept open, because its earlier wording reached them. */
  options: { keepDraftId?: string } = {},
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE conversation_continuations
       SET state = 'superseded', updated_at = clock_timestamp()
     WHERE business_id = ${businessId}::uuid
       AND source_message_id = ${sourceMessageId}::uuid
       AND state = 'open'
       AND (${options.keepDraftId ?? null}::uuid IS NULL
            OR draft_id IS DISTINCT FROM ${options.keepDraftId ?? null}::uuid)
    RETURNING id`);
  return [...rows].length;
}

/**
 * Retire every open continuation, for ANY member of this business, that
 * names this draft (G-68 review): a G-61 funding question is answered ONCE.
 * After the purchase is rebuilt from it, no other member's short answer may
 * rebuild it again. Returns WHO held one, and until when, so a rebuild that
 * is undone (its preview never reached anybody) can re-open exactly those
 * members' answers inside their own windows (Codex review), and nobody
 * else's.
 */
export async function retireContinuationsForDraft(
  tx: TenantDb,
  businessId: string,
  draftId: string,
): Promise<{ userId: string; expiresAt: Date }[]> {
  const rows = await tx.execute<{ user_id: string; expires_at: Date | string }>(sql`
    UPDATE conversation_continuations
       SET state = 'superseded', updated_at = clock_timestamp()
     WHERE business_id = ${businessId}::uuid
       AND draft_id = ${draftId}::uuid
       AND state = 'open'
    RETURNING user_id, expires_at`);
  return [...rows].map((r) => ({ userId: r.user_id, expiresAt: new Date(r.expires_at) }));
}

/**
 * This member's NEWEST continuation, in any state, or null (G-68 review).
 * Read only to tell a member, truthfully and without a model, that the
 * funding question their short answer is about was already answered or
 * closed.
 */
export async function newestContinuation(
  tx: TenantDb,
  businessId: string,
  userId: string,
  /** The instant the message reached Rekoda: rows written after it are not
   * "newest" for it (a delayed or retried event never sees the future). */
  options: { now?: Date } = {},
): Promise<ContinuationState | null> {
  const rows = await tx.execute<Row>(sql`
    SELECT id, kind, expects, topic, period, customer_token, document_ref, options, draft_id
      FROM conversation_continuations
     WHERE business_id = ${businessId}::uuid AND user_id = ${userId}::uuid
       AND created_at <= ${clock(options.now)}
     ORDER BY insertion_seq DESC
     LIMIT 1`);
  const row = [...rows][0];
  if (!row) return null;
  return parseContinuation({
    kind: row.kind,
    expects: row.expects,
    topic: row.topic,
    period: row.period,
    customerToken: row.customer_token,
    documentRef: row.document_ref,
    options: row.options,
    draftId: row.draft_id,
  });
}

/**
 * Was this member ever asked the identity question about this held purchase
 * (G-81), in any state of that question? A yes, a no or a doubtful answer
 * from the member who was asked is about the question and re-asks it; from
 * anybody else it is about what THEY were shown, and the held purchase is
 * not in their way.
 */
export async function wasAskedAbout(
  tx: TenantDb,
  businessId: string,
  userId: string,
  draftId: string,
  /** The reply's instant: a question opened after it was never asked of it
   * (Codex review). */
  options: { now?: Date } = {},
): Promise<boolean> {
  const rows = await tx.execute<{ asked: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM conversation_continuations
       WHERE business_id = ${businessId}::uuid
         AND user_id = ${userId}::uuid
         AND expects = 'purchase_identity'
         AND draft_id = ${draftId}::uuid
         AND created_at <= ${clock(options.now)})
      /* ... and still askable: a held purchase past its window asks nothing. */
      AND EXISTS (
      SELECT 1 FROM command_drafts h
       WHERE h.business_id = ${businessId}::uuid
         AND h.id = ${draftId}::uuid
         AND h.state = 'held'
         AND h.expires_at > ${clock(options.now)}) AS asked`);
  return [...rows][0]?.asked === true;
}

/**
 * A re-asked identity question that never reached the merchant (G-81): the
 * continuation kept open for it ends when the held purchase's restored
 * window ends, never later. Returns how many moved.
 */
export async function alignOpenedByExpiry(
  tx: TenantDb,
  businessId: string,
  sourceMessageId: string,
  draftId: string,
  expiresAt: Date,
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE conversation_continuations
       SET expires_at = ${expiresAt.toISOString()}::timestamptz,
           updated_at = clock_timestamp()
     WHERE business_id = ${businessId}::uuid
       AND source_message_id = ${sourceMessageId}::uuid
       AND draft_id = ${draftId}::uuid
       AND state = 'open'
    RETURNING id`);
  return [...rows].length;
}

/**
 * Re-open a continuation a reply superseded when that reply never reached
 * the member (G-81): the question they last saw is the one they are still
 * answering. Only while it is inside its window, and only when this member
 * has nothing else open. Returns whether it re-opened.
 */
export async function reopenSuperseded(
  tx: TenantDb,
  businessId: string,
  continuationId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE conversation_continuations c
       SET state = 'open', updated_at = clock_timestamp()
     WHERE c.id = ${continuationId}::uuid
       AND c.business_id = ${businessId}::uuid
       AND c.state = 'superseded'
       AND c.expires_at > clock_timestamp()
       AND NOT EXISTS (
         SELECT 1 FROM conversation_continuations o
          WHERE o.business_id = c.business_id
            AND o.user_id = c.user_id
            AND o.state = 'open')
    RETURNING c.id`);
  return [...rows].length === 1;
}
