/**
 * The conversation record (MASTER-PLAN §5.3.2).
 *
 * Every write here takes a `TenantDb` — a handle that is already pinned — so
 * a message cannot be filed against the wrong business by forgetting an
 * argument. Both tables are under row-level security.
 *
 * `body` is TOKENISED text or nothing. This file has no vault key and no way
 * to obtain one; storing a raw message through it is not an oversight that
 * could happen, it is a value the caller would have to construct by hand.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { TenantDb } from '../client.js';
import { commandDrafts, conversationMessages, conversations } from '../schema/ops.js';

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
    /* Classified at birth (F.6, PR-058a-2): every thread this function
     * mints is the merchant talking to Rekoda, so the backfill's tail
     * only ever shrinks. Customer threads arrive by their own writer
     * (058a-4) and never through here. */
    .values({ businessId, channel, conversationKind: 'MERCHANT' })
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

/* ── the thread resolver (Appendix F.2; PR-058a-3) ─────────────────────── */

/**
 * Which thread a message belongs to, stated as an identity rather than
 * assumed from a channel. MERCHANT is the old world, verbatim; CUSTOMER is
 * F.2's routing key — businessId + channel + channelAccountId +
 * participantBlindIndex — which can RESOLVE today and can only CREATE once
 * 058a-4 replaces the broad unique with the two partial constraints.
 */
export type ThreadTarget =
  | { kind: 'MERCHANT'; businessId: string; channel: Channel }
  | {
      kind: 'CUSTOMER';
      businessId: string;
      channel: Channel;
      channelAccountId: string;
      participantBlindIndex: string;
      participantIndexKeyVersion: string;
      customerId?: string | null;
    };

/** Creation of customer threads arrives with 058a-4's constraints. */
export class CustomerThreadsNotYetEnabled extends Error {
  constructor() {
    super('customer threads await the F.2 constraints (PR-058a-4); refusing to create one early');
  }
}

export async function resolveThread(tx: TenantDb, target: ThreadTarget): Promise<string> {
  if (target.kind === 'MERCHANT') {
    /* The old rule was CORRECT for merchant threads: exactly one per
     * business per channel. Same function, same row. */
    return threadFor(tx, target.businessId, target.channel);
  }

  const rows = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.businessId, target.businessId),
        eq(conversations.channel, target.channel),
        eq(conversations.conversationKind, 'CUSTOMER'),
        eq(conversations.channelAccountId, target.channelAccountId),
        eq(conversations.participantBlindIndex, target.participantBlindIndex),
        eq(conversations.participantIndexKeyVersion, target.participantIndexKeyVersion),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row) return row.id;
  /* Creating one BEFORE the partial constraints exist would let a customer
   * thread occupy the broad unique's single slot and lock the merchant out
   * of their own channel. Refuse loudly instead of breaking Chat. */
  throw new CustomerThreadsNotYetEnabled();
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
  thread?: ThreadTarget,
): Promise<{ id: string; isNew: boolean }> {
  const conversationId = await resolveThread(
    tx,
    thread ?? { kind: 'MERCHANT', businessId: message.businessId, channel: message.channel },
  );

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

/**
 * The messages of ONE thread (PR-058a-3): resolved by identity, scoped by
 * conversation. For a MERCHANT target this returns exactly what
 * `messagesFor` returns today — one business, one thread — which is the
 * flag-equivalence the cutover stands on.
 */
export async function messagesForThread(
  tx: TenantDb,
  target: ThreadTarget,
  limit = 50,
): Promise<StoredMessage[]> {
  const conversationId = await resolveThread(tx, target);
  return tx
    .select({
      id: conversationMessages.id,
      direction: conversationMessages.direction,
      kind: conversationMessages.kind,
      body: conversationMessages.body,
      providerMessageId: conversationMessages.providerMessageId,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.businessId, target.businessId),
        eq(conversationMessages.conversationId, conversationId),
      ),
    )
    .orderBy(conversationMessages.createdAt)
    .limit(limit);
}

/** Count of threads, for the health surface. */
export async function threadCount(tx: TenantDb): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM conversations`);
  return [...rows][0]?.n ?? 0;
}

export interface DraftInput {
  businessId: string;
  conversationMessageId: string;
  intent: string;
  /** Tokenised content only — this is verbatim what the model produced. */
  command: unknown;
  model: string | null;
  /**
   * A proposal to join two customer records, if this message split one person
   * into two. Confirmed by the same `yes` that confirms the command, because
   * it is the same preview the merchant is reading.
   */
  identityLink?: unknown;
}

export interface DraftRow {
  id: string;
  intent: string;
  state: string;
  command: unknown;
  identityLink?: unknown;
  /**
   * How the DRAFTING message arrived — text | voice | media | interactive.
   * Spec E.7's evidenceBasis is derived from this at confirmation time: a
   * payment drafted from a photo was seen, not typed, and the record says so.
   */
  messageKind: string | null;
}

/**
 * Store what the model understood, once per message.
 *
 * `ON CONFLICT DO NOTHING` against `command_drafts_message_ux`: a job that
 * runs twice — a reclaimed lock, a re-enqueued delivery — must not produce two
 * drafts, or the merchant gets two previews of one sale and CG3's "exactly one
 * document" has two things to choose between.
 */
export async function recordDraft(
  tx: TenantDb,
  draft: DraftInput,
): Promise<{ id: string; isNew: boolean }> {
  const inserted = await tx
    .insert(commandDrafts)
    .values({
      businessId: draft.businessId,
      conversationMessageId: draft.conversationMessageId,
      intent: draft.intent,
      command: draft.command as never,
      model: draft.model,
      identityLink: (draft.identityLink ?? null) as never,
    })
    .onConflictDoNothing({ target: [commandDrafts.conversationMessageId] })
    .returning({ id: commandDrafts.id });

  const created = inserted[0];
  if (created) return { id: created.id, isNew: true };

  const existing = await tx
    .select({ id: commandDrafts.id })
    .from(commandDrafts)
    .where(eq(commandDrafts.conversationMessageId, draft.conversationMessageId))
    .limit(1);

  const row = existing[0];
  if (!row) throw new Error('recordDraft: conflict reported but no existing draft found');
  return { id: row.id, isNew: false };
}

/** A business's own drafts, newest last. */
export async function draftsFor(tx: TenantDb, businessId: string): Promise<DraftRow[]> {
  return tx
    .select({
      id: commandDrafts.id,
      intent: commandDrafts.intent,
      state: commandDrafts.state,
      command: commandDrafts.command,
      messageKind: conversationMessages.kind,
    })
    .from(commandDrafts)
    .leftJoin(
      conversationMessages,
      eq(conversationMessages.id, commandDrafts.conversationMessageId),
    )
    .where(eq(commandDrafts.businessId, businessId))
    .orderBy(commandDrafts.createdAt);
}

export interface OutboundMessageInput {
  businessId: string;
  channel: Channel;
  kind: MessageKind;
  /**
   * TOKENISED. The conversation history must not hold a customer's real name:
   * rehydration happens at the send boundary and nowhere else (ADR 0005), so
   * what is stored here is what the gateway produced.
   */
  body: string;
}

/** Record a reply. Written BEFORE the send, so an undelivered reply is still known. */
export async function recordOutbound(
  tx: TenantDb,
  message: OutboundMessageInput,
  thread?: ThreadTarget,
): Promise<{ id: string }> {
  const conversationId = await resolveThread(
    tx,
    thread ?? { kind: 'MERCHANT', businessId: message.businessId, channel: message.channel },
  );
  const rows = await tx
    .insert(conversationMessages)
    .values({
      businessId: message.businessId,
      conversationId,
      direction: 'outbound',
      kind: message.kind,
      body: message.body,
    })
    .returning({ id: conversationMessages.id });

  const row = rows[0];
  if (!row) throw new Error('recordOutbound: insert returned no row');
  return { id: row.id };
}

/**
 * Attach the provider's id once the send succeeded.
 *
 * A row with no `provider_message_id` is therefore a reply we owed and did not
 * deliver — a state worth being able to find, rather than one indistinguishable
 * from success.
 */
export async function markOutboundSent(
  tx: TenantDb,
  id: string,
  providerMessageId: string | null,
): Promise<void> {
  if (!providerMessageId) return;
  await tx
    .update(conversationMessages)
    .set({ providerMessageId })
    .where(eq(conversationMessages.id, id));
}

/** The draft this business is waiting to confirm, if there is one. */
export async function pendingDraft(tx: TenantDb, businessId: string): Promise<DraftRow | null> {
  const rows = await tx
    .select({
      id: commandDrafts.id,
      intent: commandDrafts.intent,
      state: commandDrafts.state,
      command: commandDrafts.command,
      identityLink: commandDrafts.identityLink,
      messageKind: conversationMessages.kind,
    })
    .from(commandDrafts)
    .leftJoin(
      conversationMessages,
      eq(conversationMessages.id, commandDrafts.conversationMessageId),
    )
    .where(and(eq(commandDrafts.businessId, businessId), eq(commandDrafts.state, 'pending')))
    .orderBy(desc(commandDrafts.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * CG3 — claim a draft for issuing, exactly once.
 *
 * `WHERE state = 'pending'` IS the mutual exclusion. Two rapid "yes" messages
 * become two jobs on two connections; both read the draft, both decide to
 * issue, and the merchant's customer receives two invoices with two numbers
 * for one sale. On WhatsApp a double-tap is not an edge case, it is Tuesday.
 *
 * Returns false for the loser, which is not an error — it means the document
 * is being issued by somebody else, and the right response is to say nothing
 * further rather than to apologise for a success.
 */
export async function claimDraft(tx: TenantDb, draftId: string): Promise<boolean> {
  const claimed = await tx
    .update(commandDrafts)
    .set({ state: 'confirmed', updatedAt: new Date() })
    .where(and(eq(commandDrafts.id, draftId), eq(commandDrafts.state, 'pending')))
    .returning({ id: commandDrafts.id });
  return claimed.length === 1;
}

/**
 * CG5 — a correction replaces the draft it corrects.
 *
 * Superseded rather than deleted: the merchant said something, and what they
 * said is part of the record even after they changed their mind. It is also
 * the only way to answer "why does this invoice say 3 when I first said 4".
 */
export async function supersedePendingDrafts(tx: TenantDb, businessId: string): Promise<number> {
  const updated = await tx
    .update(commandDrafts)
    .set({ state: 'superseded', updatedAt: new Date() })
    .where(and(eq(commandDrafts.businessId, businessId), eq(commandDrafts.state, 'pending')))
    .returning({ id: commandDrafts.id });
  return updated.length;
}

/**
 * Fill in the body of a message that was already claimed.
 *
 * The voice path inserts the row FIRST, as its idempotency claim, before the
 * transcript exists: that claim is what stops a redelivered webhook
 * transcribing and metering the same recording twice. The words arrive a
 * moment later and land here.
 *
 * Returns true so the caller can treat it exactly like a fresh
 * `recordInbound` — the row is new, it just filled up in two steps. Pinned on
 * `business_id` as well as the id: this table is under row-level security,
 * and a stray id from a job payload deserves the second predicate anyway.
 */
export async function setInboundBody(
  tx: TenantDb,
  businessId: string,
  messageId: string,
  body: string,
): Promise<boolean> {
  const rows = await tx
    .update(conversationMessages)
    .set({ body })
    .where(
      and(eq(conversationMessages.id, messageId), eq(conversationMessages.businessId, businessId)),
    )
    .returning({ id: conversationMessages.id });
  return rows.length === 1;
}
