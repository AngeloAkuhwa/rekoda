/**
 * The conversation record (MASTER-PLAN §5.3.2).
 *
 * Every write here takes a `TenantDb` — a handle that is already pinned — so
 * a message cannot be filed against the wrong business by forgetting an
 * argument. Both tables are under row-level security.
 *
 * `body` is TOKENISED text or nothing. This file has no vault key and no way
 * to obtain one; storing a raw message through it is not an oversight that
 * could happen, it is a value the caller would have to construct on purpose.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';
import { conversationMessages, conversations } from '../schema/ops.js';

export type Channel = 'meta' | 'twilio' | 'simulator';
export type Direction = 'inbound' | 'outbound';
export type MessageKind = 'text' | 'voice' | 'media' | 'interactive';

/**
 * The business's thread on this channel, creating it the first time.
 *
 * `ON CONFLICT DO NOTHING` against `conversations_business_channel_ux`
 * (migration 0006) rather than select-then-insert: two messages arriving
 * together would otherwise both find no thread and both create one.
 */
export async function threadFor(
  tx: TenantDb,
  businessId: string,
  channel: Channel,
): Promise<string> {
  const inserted = await tx
    .insert(conversations)
    .values({ businessId, channel })
    .onConflictDoNothing({ target: [conversations.businessId, conversations.channel] })
    .returning({ id: conversations.id });

  const created = inserted[0];
  if (created) return created.id;

  const existing = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.businessId, businessId), eq(conversations.channel, channel)))
    .limit(1);

  const row = existing[0];
  if (!row) throw new Error('threadFor: conflict reported but no existing thread found');
  return row.id;
}

export interface InboundMessage {
  businessId: string;
  channel: Channel;
  kind: MessageKind;
  /** Tokenised. Null when the message was answered without ever being read. */
  body: string | null;
  /** Provider message id — the idempotency key. */
  providerMessageId: string;
}

/**
 * Record one inbound message, exactly once.
 *
 * The provider's message id is unique across the table, so a job that runs
 * twice — a reclaimed lock, a retried delivery — writes one row. The caller
 * gets `false` and knows not to act on it again.
 */
export async function recordInbound(
  tx: TenantDb,
  message: InboundMessage,
): Promise<{ id: string; isNew: boolean }> {
  const conversationId = await threadFor(tx, message.businessId, message.channel);

  const inserted = await tx
    .insert(conversationMessages)
    .values({
      businessId: message.businessId,
      conversationId,
      direction: 'inbound',
      kind: message.kind,
      body: message.body,
      providerMessageId: message.providerMessageId,
    })
    .onConflictDoNothing({ target: [conversationMessages.providerMessageId] })
    .returning({ id: conversationMessages.id });

  const created = inserted[0];
  if (created) return { id: created.id, isNew: true };

  const existing = await tx
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(eq(conversationMessages.providerMessageId, message.providerMessageId))
    .limit(1);

  const row = existing[0];
  if (!row) throw new Error('recordInbound: conflict reported but no existing message found');
  return { id: row.id, isNew: false };
}

export interface StoredMessage {
  id: string;
  direction: string;
  kind: string;
  body: string | null;
  providerMessageId: string | null;
}

/** A business's own messages, newest last. For the dashboard and for tests. */
export async function messagesFor(
  tx: TenantDb,
  businessId: string,
  limit = 50,
): Promise<StoredMessage[]> {
  return tx
    .select({
      id: conversationMessages.id,
      direction: conversationMessages.direction,
      kind: conversationMessages.kind,
      body: conversationMessages.body,
      providerMessageId: conversationMessages.providerMessageId,
    })
    .from(conversationMessages)
    .where(eq(conversationMessages.businessId, businessId))
    .orderBy(conversationMessages.createdAt)
    .limit(limit);
}

/** Count of threads, for the health surface. */
export async function threadCount(tx: TenantDb): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM conversations`);
  return [...rows][0]?.n ?? 0;
}
