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
  const replayed = await rowForMessage(tx, input);
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
      ${clock(input.now)} + make_interval(secs => ${CONTINUATION_TTL_SECONDS}))
    ON CONFLICT DO NOTHING
    RETURNING id`);
  const created = [...inserted][0];
  if (created) return { id: created.id, isNew: true };

  const raced = await rowForMessage(tx, input);
  return raced ? { id: raced, isNew: false } : null;
}

/** The row this member's message already opened, if it opened one. */
async function rowForMessage(
  tx: TenantDb,
  input: Pick<OpenContinuationInput, 'businessId' | 'userId' | 'sourceMessageId'>,
): Promise<string | null> {
  const existing = await tx.execute<{ id: string }>(sql`
    SELECT id FROM conversation_continuations
     WHERE business_id = ${input.businessId}::uuid
       AND user_id = ${input.userId}::uuid
       AND source_message_id = ${input.sourceMessageId}::uuid`);
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
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE conversation_continuations
       SET state = 'superseded', updated_at = clock_timestamp()
     WHERE business_id = ${businessId}::uuid
       AND source_message_id = ${sourceMessageId}::uuid
       AND state = 'open'
    RETURNING id`);
  return [...rows].length;
}
