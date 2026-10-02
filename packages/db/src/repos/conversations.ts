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
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  CONFIRMATION_TTL_SECONDS,
  sanitizeCommandForPersistence,
  type ConfirmationContext,
} from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { commandDrafts, conversationMessages, conversations } from '../schema/ops.js';

export type Channel = 'meta' | 'twilio' | 'simulator';
export type Direction = 'inbound' | 'outbound';
export type MessageKind = 'text' | 'voice' | 'media' | 'interactive';

/**
 * The business's thread on this channel, creating it the first time.
 *
 * `ON CONFLICT DO NOTHING` against `conversations_merchant_ux` (F.2's
 * partial merchant unique, migration 0087) rather than select-then-insert:
 * two messages arriving together would otherwise both find no thread and
 * both create one.
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
     * only ever shrinks. Customer threads arrive through
     * `resolveThread`, never through here. The conflict target is the
     * PARTIAL merchant unique (058a-4), so the race lands on the same
     * row it always did. */
    .values({ businessId, channel, conversationKind: 'MERCHANT' })
    .onConflictDoNothing({
      target: [conversations.businessId, conversations.channel],
      where: sql`conversation_kind = 'MERCHANT'`,
    })
    .returning({ id: conversations.id });

  const created = inserted[0];
  if (created) return created.id;

  const existing = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.businessId, businessId),
        eq(conversations.channel, channel),
        eq(conversations.conversationKind, 'MERCHANT'),
      ),
    )
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

  /* Enabled by 058a-4's partial constraints: a new customer's first
   * message mints their thread, and the F.2 unique makes the race land
   * every writer on one row. */
  const inserted = await tx
    .insert(conversations)
    .values({
      businessId: target.businessId,
      channel: target.channel,
      conversationKind: 'CUSTOMER',
      channelAccountId: target.channelAccountId,
      participantBlindIndex: target.participantBlindIndex,
      participantIndexKeyVersion: target.participantIndexKeyVersion,
      ...(target.customerId ? { customerId: target.customerId } : {}),
    })
    .onConflictDoNothing({
      target: [
        conversations.businessId,
        conversations.channel,
        conversations.channelAccountId,
        conversations.participantBlindIndex,
        conversations.participantIndexKeyVersion,
      ],
      where: sql`conversation_kind = 'CUSTOMER' AND participant_blind_index IS NOT NULL`,
    })
    .returning({ id: conversations.id });
  const created = inserted[0];
  if (created) return created.id;

  const raced = await tx
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
  const winner = raced[0];
  if (!winner) throw new Error('resolveThread: conflict reported but no thread found');
  return winner.id;
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

/**
 * A business's own messages, newest last. For the dashboard and for tests.
 *
 * `id` is the tiebreaker, not the sort key. Migration 0146 makes `created_at`
 * advance between rows written in one transaction, but two inserts can still
 * land on the same microsecond, and rows written before 0146 already share an
 * instant with everything else their transaction wrote. A tie has to resolve
 * the same way every read or the merchant's history reshuffles between page
 * loads; `id` cannot recover the true order of those older rows, and does not
 * pretend to.
 */
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
    .orderBy(conversationMessages.createdAt, conversationMessages.id)
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
    .orderBy(conversationMessages.createdAt, conversationMessages.id)
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
  /**
   * What the preview showed, computed from SQL (OWN-16): a deliberate
   * overpayment's figures, checked again at `yes`. Typed by core; ids and
   * kobo only, never the model's content, so it does NOT pass the
   * transient-field policy that `command` does.
   */
  confirmationContext?: ConfirmationContext | null;
  /** The member whose message drafted this (0157), when known. */
  requestedBy?: string | null;
  /** The retired question a funding-answer rebuild was built from (0157). */
  rebuiltFrom?: string | null;
  /**
   * The merchant was shown a preview a "yes" confirms, not a question
   * (G-23). Only an expired preview is answered "that request has expired".
   */
  previewed?: boolean;
  /**
   * The instant the confirmation window opens. Tests only: production leaves
   * it unset and the database clock decides, the same clock as `created_at`.
   */
  now?: Date;
}

/**
 * "Now" for a draft's confirmation window (G-23): the instant the caller
 * names, else the database clock. A confirmation names the moment the
 * merchant's message reached Rekoda (the webhook's own timestamp, on the
 * database clock), so a "yes" sent inside the window is judged inside it
 * however long the queue, a retry or a voice transcription takes; tests
 * name an instant to reach the boundary without sleeping. Never a process's
 * own clock.
 */
const draftClock = (now: Date | undefined) =>
  sql`coalesce(${now ? now.toISOString() : null}::timestamptz, clock_timestamp())`;

export interface DraftRow {
  id: string;
  intent: string;
  state: string;
  command: unknown;
  identityLink?: unknown;
  /** Raw as stored; read it through `parseConfirmationContext`. */
  confirmationContext?: unknown;
  /** Shown as a preview, not asked as a question (G-23). */
  previewed?: boolean;
  /** When its confirmation window closes (G-23), where the read selects it. */
  expiresAt?: Date;
  /** The member whose message drafted it (0157), where the read selects it. */
  requestedBy?: string | null;
  /** The retired question a rebuild was built from (0157), where selected. */
  rebuiltFrom?: string | null;
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
      /* THE persistence boundary (R5): every draft write passes through the
       * central transient-field policy, HERE, at the only INSERT into
       * command_drafts — never at whichever call site remembered. The
       * preview the merchant reads is built from the live command before
       * this line, so "echoed once, never stored" holds in both halves. */
      command: sanitizeCommandForPersistence(draft.command) as never,
      model: draft.model,
      identityLink: (draft.identityLink ?? null) as never,
      confirmationContext: (draft.confirmationContext ?? null) as never,
      previewed: draft.previewed ?? false,
      requestedBy: draft.requestedBy ?? null,
      rebuiltFrom: draft.rebuiltFrom ?? null,
      /* G-23: a preview is confirmable for CONFIRMATION_TTL_SECONDS, the same
       * window as a HIGH_RISK confirmation. Set once, at the only INSERT: a
       * redelivered message hits the conflict below and keeps the window its
       * first delivery opened, so a replay never extends it. */
      expiresAt: sql`${draftClock(draft.now)} + make_interval(secs => ${CONFIRMATION_TTL_SECONDS})`,
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
    .orderBy(commandDrafts.insertionSeq);
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
/**
 * "Only what the merchant could have been answering" (G-23): a draft
 * written after a message was received is not what that message is about.
 * A retried "yes" can run after a newer request has been previewed; it must
 * confirm the preview it was sent for, never one that did not exist yet, and
 * a "no" or a correction must not touch a preview it never saw. Both sides
 * are on the database clock.
 */
const seenBy = (asOf: Date | undefined) =>
  asOf ? sql`${commandDrafts.createdAt} <= ${asOf.toISOString()}::timestamptz` : undefined;

/**
 * Whether a read-only Query's draft counts (Build 6). Stated by every caller,
 * never defaulted inside one function:
 *
 *  - `skip`: what a "yes", a "no" or a correction is ABOUT. A Query is
 *    answered at once and its draft is kept only for the record; nothing
 *    about it can be confirmed. Counted, a question asked between a preview
 *    and its "yes" ("How much did I sell?", "Last month.") became the newest
 *    pending draft, so the "yes" claimed the QUESTION and the preview never
 *    confirmed; and after an expired preview it hid the expiry behind a
 *    draft nobody could confirm.
 *  - `count`: everything else, exactly as before Build 6. In particular the
 *    two-ask erasure: any message that records a draft between the two
 *    asks, a model-answered question included, breaks the pair and keeps
 *    the data. Erasure is irreversible, so it must never be narrowed by a
 *    rule written for a "yes".
 *
 * Skipping a read never lets a "yes" reach PAST it: a "yes" whose newest
 * confirmable draft is older than a read asked since (`hasReadsAfter`) is
 * answered by a pointer back at the preview (`retireNewestReadAfter`, one
 * read per yes, as base took) when that draft is a delivered financial
 * preview, and otherwise exactly as before Build 6, as a "yes" to the read;
 * never by a claim of the older draft.
 */
export type ReadDrafts = 'skip' | 'count';

const readsFilter = (reads: ReadDrafts) =>
  reads === 'skip' ? sql`${commandDrafts.intent} <> 'Query'` : undefined;

/**
 * The newest pending draft, every intent counted, a Query included (the
 * pre-Build-6 rule). The erasure ceremony reads this one.
 */
export function pendingDraft(
  tx: TenantDb,
  businessId: string,
  options: { asOf?: Date } = {},
): Promise<DraftRow | null> {
  return newestPendingDraft(tx, businessId, { ...options, reads: 'count' });
}

/**
 * The newest pending draft a "yes", a "no" or a correction can be about:
 * a read-only Query's draft is skipped (Build 6).
 */
export function pendingDraftToAnswer(
  tx: TenantDb,
  businessId: string,
  options: { asOf?: Date } = {},
): Promise<DraftRow | null> {
  return newestPendingDraft(tx, businessId, { ...options, reads: 'skip' });
}

async function newestPendingDraft(
  tx: TenantDb,
  businessId: string,
  options: { asOf?: Date | undefined; reads: ReadDrafts },
): Promise<DraftRow | null> {
  const rows = await tx
    .select({
      id: commandDrafts.id,
      intent: commandDrafts.intent,
      state: commandDrafts.state,
      command: commandDrafts.command,
      identityLink: commandDrafts.identityLink,
      confirmationContext: commandDrafts.confirmationContext,
      previewed: commandDrafts.previewed,
      expiresAt: commandDrafts.expiresAt,
      requestedBy: commandDrafts.requestedBy,
      rebuiltFrom: commandDrafts.rebuiltFrom,
      messageKind: conversationMessages.kind,
    })
    .from(commandDrafts)
    .leftJoin(
      conversationMessages,
      eq(conversationMessages.id, commandDrafts.conversationMessageId),
    )
    .where(
      and(
        eq(commandDrafts.businessId, businessId),
        eq(commandDrafts.state, 'pending'),
        readsFilter(options.reads),
        seenBy(options.asOf),
      ),
    )
    /* The newest PENDING draft is what the merchant's "yes" will execute, so
     * "newest" is decided by `insertion_seq` - the database-assigned ordinal
     * (0149) - never by `created_at` (two drafts can share a microsecond)
     * and never by `id` (a random uuid whose order says nothing about which
     * draft came second). */
    .orderBy(desc(commandDrafts.insertionSeq))
    .limit(1);
  return rows[0] ?? null;
}

/** What a claim found (CG3, G-23). */
export type DraftClaim =
  /** This call, and only this call, now owns the draft: execute it. */
  | { readonly outcome: 'claimed' }
  /** The window had closed: nothing may execute, and the merchant is told. */
  | { readonly outcome: 'expired' }
  /** Confirmed by another "yes", corrected, cancelled or retired. */
  | { readonly outcome: 'not_pending' };

/**
 * CG3 — claim a draft for issuing, exactly once, and only inside its window.
 *
 * `WHERE state = 'pending'` IS the mutual exclusion. Two rapid "yes" messages
 * become two jobs on two connections; both read the draft, both decide to
 * issue, and the merchant's customer receives two invoices with two numbers
 * for one sale. On WhatsApp a double-tap is not an edge case, it is Tuesday.
 *
 * G-23: the same UPDATE carries `expires_at > now`, so the age check is part
 * of the claim itself, never a read that a later write trusts. A draft that
 * is still pending but whose window has closed is moved to `expired` by the
 * second statement, exactly once (its own `state = 'pending'` predicate),
 * and can never become `confirmed` afterwards. Valid iff now < expires_at:
 * at the instant itself the draft has expired.
 *
 * `not_pending` for the loser of a race is not an error: the document is
 * being issued by somebody else, and the right response is to say nothing
 * further rather than to apologise for a success.
 */
export async function claimDraft(
  tx: TenantDb,
  draftId: string,
  options: { now?: Date } = {},
): Promise<DraftClaim> {
  const now = draftClock(options.now);
  const claimed = await tx.execute<{ id: string }>(sql`
    UPDATE command_drafts SET state = 'confirmed', updated_at = clock_timestamp()
     WHERE id = ${draftId}::uuid AND state = 'pending' AND expires_at > ${now}
       AND created_at <= ${now}
    RETURNING id`);
  if ([...claimed].length === 1) return { outcome: 'claimed' };

  const expired = await tx.execute<{ id: string }>(sql`
    UPDATE command_drafts SET state = 'expired', updated_at = clock_timestamp()
     WHERE id = ${draftId}::uuid AND state = 'pending' AND expires_at <= ${now}
    RETURNING id`);
  if ([...expired].length === 1) return { outcome: 'expired' };

  /* Neither: somebody else moved it first. A concurrent "yes" that expired
   * it is still an expiry to this caller, never a success it should be
   * quiet about. */
  const [row] = [
    ...(await tx.execute<{ state: string }>(
      sql`SELECT state FROM command_drafts WHERE id = ${draftId}::uuid`,
    )),
  ];
  return row?.state === 'expired' ? { outcome: 'expired' } : { outcome: 'not_pending' };
}

/**
 * The preview this message produced never reached the merchant (G-23): the
 * send failed and was swallowed so the draft could survive. Without this the
 * draft would still say `previewed`, and a later "yes" after its window
 * would be told an unseen request expired.
 */
export async function markDraftUnseen(
  tx: TenantDb,
  businessId: string,
  conversationMessageId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE command_drafts SET previewed = false, updated_at = clock_timestamp()
     WHERE business_id = ${businessId}::uuid
       AND conversation_message_id = ${conversationMessageId}::uuid
       AND previewed`);
}

/**
 * Close every confirmation window that has lapsed for this business (G-23).
 *
 * Lazy and interaction-time: called when the merchant next speaks (a yes, a
 * no, a new request, the erasure phrase), before anything reads "the pending
 * draft". A stale preview stops being pending at that moment, so nothing that
 * follows can pick it as the thing a "yes" executes, correct it, or count it
 * as cancelled. Only `pending` rows past their window move; a retired
 * question (`abandoned`) is not a window and is left alone. The claim still
 * carries its own predicate for a window that closes after this runs.
 */
export async function expireStaleDrafts(
  tx: TenantDb,
  businessId: string,
  options: { now?: Date } = {},
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE command_drafts SET state = 'expired', updated_at = clock_timestamp()
     WHERE business_id = ${businessId}::uuid
       AND state = 'pending'
       AND expires_at <= ${draftClock(options.now)}
    RETURNING id`);
  return [...rows].length;
}

/**
 * CG5 — a correction replaces the draft it corrects.
 *
 * Superseded rather than deleted: the merchant said something, and what they
 * said is part of the record even after they changed their mind. It is also
 * the only way to answer "why does this invoice say 3 when I first said 4".
 */
export async function supersedePendingDrafts(
  tx: TenantDb,
  businessId: string,
  options: { asOf?: Date } = {},
): Promise<number> {
  const updated = await tx
    .update(commandDrafts)
    .set({ state: 'superseded', updatedAt: new Date() })
    .where(
      and(
        eq(commandDrafts.businessId, businessId),
        eq(commandDrafts.state, 'pending'),
        seenBy(options.asOf),
      ),
    )
    .returning({ id: commandDrafts.id });
  return updated.length;
}

/**
 * Supersede every draft still pending from BEFORE this one (G-61).
 *
 * A purchase question the merchant answers by sending the purchase again
 * becomes the conversation: a preview left waiting from before it is no
 * longer what a "yes" or a "no" is about. Superseding it keeps its record
 * and stops it lingering, pending but never confirmable, where a later
 * stray "no" would count it as cancelled. The ordinal decides "before".
 */
export async function supersedeDraftsBefore(
  tx: TenantDb,
  businessId: string,
  draftId: string,
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE command_drafts SET state = 'superseded', updated_at = now()
     WHERE business_id = ${businessId}::uuid
       AND state = 'pending'
       AND insertion_seq < (
         SELECT d.insertion_seq FROM command_drafts d
          WHERE d.id = ${draftId}::uuid AND d.business_id = ${businessId}::uuid)
    RETURNING id`);
  return [...rows].length;
}

/**
 * Whether a read-only Query draft, still pending and seen by `asOf`, was
 * recorded AFTER `draftId` (Build 6): the merchant asked the books something
 * since that draft, so a "yes" now is not plainly agreement to it. Changes
 * nothing; `retireNewestReadAfter` is the write.
 */
export async function hasReadsAfter(
  tx: TenantDb,
  businessId: string,
  draftId: string,
  options: { asOf?: Date } = {},
): Promise<boolean> {
  const seen = options.asOf
    ? sql`AND created_at <= ${options.asOf.toISOString()}::timestamptz`
    : sql``;
  const rows = await tx.execute<{ found: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM command_drafts
       WHERE business_id = ${businessId}::uuid
         AND state = 'pending'
         AND intent = 'Query'
         AND insertion_seq > (
           SELECT d.insertion_seq FROM command_drafts d
            WHERE d.id = ${draftId}::uuid AND d.business_id = ${businessId}::uuid)
         ${seen}) AS found`);
  return [...rows][0]?.found === true;
}

/**
 * Retire the NEWEST read-only Query draft asked after a preview (Build 6).
 *
 * A "yes" whose newest confirmable draft is a preview older than a question
 * the merchant asked since is not agreement to that preview: they were
 * last looking at an answer, and "correct" may well be about the figure.
 * Nothing is claimed. Exactly ONE Query draft, the newest pending one newer
 * than `draftId` and seen by `asOf`, is superseded, and the merchant is
 * pointed back at the preview. That is the draft the same "yes" claimed
 * before Build 6, so the number of yeses it takes to reach the preview is
 * exactly base's: one per question asked since, then one that confirms it
 * through the ordinary claim, if it is still inside its window. The
 * preview is untouched. Returns how many moved (0 or 1).
 */
export async function retireNewestReadAfter(
  tx: TenantDb,
  businessId: string,
  draftId: string,
  options: { asOf?: Date } = {},
): Promise<number> {
  const seen = options.asOf
    ? sql`AND created_at <= ${options.asOf.toISOString()}::timestamptz`
    : sql``;
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE command_drafts SET state = 'superseded', updated_at = clock_timestamp()
     WHERE id = (
       SELECT id FROM command_drafts
        WHERE business_id = ${businessId}::uuid
          AND state = 'pending'
          AND intent = 'Query'
          AND insertion_seq > (
            SELECT d.insertion_seq FROM command_drafts d
             WHERE d.id = ${draftId}::uuid AND d.business_id = ${businessId}::uuid)
          ${seen}
        ORDER BY insertion_seq DESC
        LIMIT 1)
       AND business_id = ${businessId}::uuid
       AND state = 'pending'
    RETURNING id`);
  return [...rows].length;
}

/**
 * The newest draft in ANY state, by the database ordinal (G-61), every
 * intent counted: the pre-Build-6 rule. No production path reads it now
 * (a "yes" and a "no" read `latestDraftToAnswer`); it stays as the
 * counting counterpart the repository tests pin.
 *
 * A retired clarification is `abandoned`, so `pendingDraft` skips it; this
 * is how a "yes" sent straight after the question can tell that the thing
 * the merchant is looking at is that question, not some older preview. The
 * same holds for a preview whose window closed (`expired`, G-23): it is
 * still the last thing the merchant was shown.
 */
export function latestDraft(
  tx: TenantDb,
  businessId: string,
  options: { asOf?: Date } = {},
): Promise<LatestDraft | null> {
  return newestDraft(tx, businessId, { ...options, reads: 'count' });
}

/**
 * The newest draft in any state that a "yes" or a "no" can be about, which
 * also decides whether an expired preview is what gets reported: a
 * read-only Query's draft is skipped (Build 6).
 */
export function latestDraftToAnswer(
  tx: TenantDb,
  businessId: string,
  options: { asOf?: Date } = {},
): Promise<LatestDraft | null> {
  return newestDraft(tx, businessId, { ...options, reads: 'skip' });
}

export interface LatestDraft {
  id: string;
  state: string;
  command: unknown;
  expiresAt: Date;
  previewed: boolean;
}

async function newestDraft(
  tx: TenantDb,
  businessId: string,
  options: { asOf?: Date | undefined; reads: ReadDrafts },
): Promise<LatestDraft | null> {
  const rows = await tx
    .select({
      id: commandDrafts.id,
      state: commandDrafts.state,
      command: commandDrafts.command,
      expiresAt: commandDrafts.expiresAt,
      previewed: commandDrafts.previewed,
    })
    .from(commandDrafts)
    .where(
      and(
        eq(commandDrafts.businessId, businessId),
        readsFilter(options.reads),
        seenBy(options.asOf),
        /* An undone rebuild (0156) never reached anybody: it is never the
         * latest thing to answer, so a "yes" or a "no" after it finds the
         * question it was rebuilt from again. */
        isNull(commandDrafts.undoneRebuildOf),
        /* Nor is a withdrawn preview (0157): it never reached anybody. */
        eq(commandDrafts.withdrawn, false),
      ),
    )
    .orderBy(desc(commandDrafts.insertionSeq))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Retire ONE pending draft, keeping it on the record (G-61).
 *
 * A purchase that could only be answered with a question the merchant
 * answers by sending the purchase AGAIN (the funding source, a ₦0 amount)
 * is stored for the audit trail but must never be confirmable: a later
 * "yes" that claimed it would ask again and invite the same purchase twice.
 * `abandoned`, not `superseded`: a retired question is still the last
 * thing the merchant was asked, which a cancelled draft is not. Only this
 * draft, and only while pending; every other draft is left alone.
 *
 * Nothing else writes `abandoned` to a draft (the 0008 comment predates
 * this use): a future sweep that did would make a "yes" re-ask it.
 */
export async function retireDraft(
  tx: TenantDb,
  businessId: string,
  draftId: string,
): Promise<boolean> {
  const updated = await tx
    .update(commandDrafts)
    .set({ state: 'abandoned', updatedAt: new Date() })
    .where(
      and(
        eq(commandDrafts.businessId, businessId),
        eq(commandDrafts.id, draftId),
        eq(commandDrafts.state, 'pending'),
      ),
    )
    .returning({ id: commandDrafts.id });
  return updated.length === 1;
}

/**
 * The retired (abandoned) draft a G-61 funding-source question was asked
 * about, read for the answer to rebuild from (G-68 Phase 2). Null unless it
 * is this business's, it is still `abandoned`, and it is a purchase: a
 * question since closed by "no", or anything else, rebuilds nothing.
 *
 * Read-only on purpose. The draft is never claimed, confirmed or revived:
 * the answer builds a NEW command and a fresh preview, and the retired
 * draft stays on the record exactly as it was.
 */
export async function retiredPurchaseDraft(
  tx: TenantDb,
  businessId: string,
  draftId: string,
): Promise<{ id: string; command: unknown; createdAt: Date } | null> {
  const rows = await tx
    .select({
      id: commandDrafts.id,
      command: commandDrafts.command,
      createdAt: commandDrafts.createdAt,
    })
    .from(commandDrafts)
    .where(
      and(
        eq(commandDrafts.businessId, businessId),
        eq(commandDrafts.id, draftId),
        eq(commandDrafts.state, 'abandoned'),
        eq(commandDrafts.intent, 'RecordPurchase'),
        /* Defence in depth (G-68 review; Codex review): a question with ANY
         * newer draft other than a read (`Query`) or a model clarification
         * (`Unclear`), IN ANY STATE, is not answerable: a preview of the
         * purchase sent again, another purchase, a newer CG1 question, or a
         * newer question's rebuilt preview since cancelled. The newest
         * question wins. The ONE exception is told apart by an explicit
         * marker, never by a combination of states: the undone rebuild of
         * this very question (migration 0156), whose preview never reached
         * anybody. */
        sql`NOT EXISTS (
          SELECT 1 FROM command_drafts newer
           WHERE newer.business_id = ${businessId}::uuid
             AND newer.insertion_seq > ${commandDrafts.insertionSeq}
             AND newer.intent NOT IN ('Query', 'Unclear')
             AND newer.undone_rebuild_of IS DISTINCT FROM ${commandDrafts.id}
             AND NOT newer.withdrawn)`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Close every retired G-61 purchase question asked BEFORE this draft
 * (`abandoned` to `superseded`) and return their ids (G-68 review). Called
 * when a new financial preview is recorded: whatever the question was, the
 * merchant has moved on to a preview, and the question must not stay
 * answerable by a short "cash" from somebody else, or the purchase could be
 * booked twice. Conditional on `abandoned`, in the caller's transaction.
 */
export async function closeRetiredQuestionsBefore(
  tx: TenantDb,
  businessId: string,
  draftId: string,
): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE command_drafts q
       SET state = 'superseded', updated_at = clock_timestamp()
      FROM command_drafts current
     WHERE current.id = ${draftId}::uuid
       AND current.business_id = ${businessId}::uuid
       AND q.business_id = ${businessId}::uuid
       AND q.state = 'abandoned'
       AND q.intent = 'RecordPurchase'
       AND q.insertion_seq < current.insertion_seq
    RETURNING q.id`);
  return [...rows].map((r) => r.id);
}

/** A draft's state and creation time, or null; read-only. */
export async function draftStateOf(
  tx: TenantDb,
  businessId: string,
  draftId: string,
): Promise<{ state: string; intent: string; createdAt: Date } | null> {
  const rows = await tx
    .select({
      state: commandDrafts.state,
      intent: commandDrafts.intent,
      createdAt: commandDrafts.createdAt,
    })
    .from(commandDrafts)
    .where(and(eq(commandDrafts.businessId, businessId), eq(commandDrafts.id, draftId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * How many inbound messages reached this business's thread AFTER the message
 * that parked a draft, not counting `excludeMessageId` (the message asking
 * now). The two-ask erasure (G-68 review) is a PAIR only when nothing at all
 * was said between the two asks: any inbound message, from any member, by
 * any path, breaks it, so the copy's "anything else keeps it" is literally
 * true and no new no-draft path can narrow it. Outbound replies do not count.
 */
export async function inboundSinceDraft(
  tx: TenantDb,
  businessId: string,
  draftId: string,
  excludeMessageId: string,
  /** The current ask's event: messages ingested AFTER it are not "between"
   * the two asks (Codex review), even when their job ran first. */
  currentEventId?: string,
): Promise<number> {
  /* Fail CLOSED: if the parked ask's message cannot be found, the pair is
   * treated as broken (the data is kept), never as intact. */
  const parked = await tx.execute<{ id: string }>(sql`
    SELECT m.id FROM command_drafts d
      JOIN conversation_messages m
        ON m.id = d.conversation_message_id AND m.business_id = d.business_id
     WHERE d.id = ${draftId}::uuid AND d.business_id = ${businessId}::uuid`);
  if ([...parked].length === 0) return Number.MAX_SAFE_INTEGER;
  const rows = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n
      FROM conversation_messages later
      JOIN command_drafts d ON d.id = ${draftId}::uuid AND d.business_id = ${businessId}::uuid
      JOIN conversation_messages parked
        ON parked.id = d.conversation_message_id AND parked.business_id = d.business_id
     WHERE later.business_id = ${businessId}::uuid
       AND later.conversation_id = parked.conversation_id
       AND later.direction = 'inbound'
       AND later.created_at >= parked.created_at
       AND later.id <> parked.id
       AND later.id <> ${excludeMessageId}::uuid
       AND (
         ${currentEventId ?? null}::uuid IS NULL
         OR COALESCE(
              (SELECT e.created_at FROM external_events e
                WHERE e.provider = 'meta' AND e.external_id = later.provider_message_id
                  AND e.business_id = later.business_id),
              later.created_at)
            <= COALESCE(
                 (SELECT cur.created_at FROM external_events cur
                   WHERE cur.id = ${currentEventId ?? null}::uuid),
                 'infinity'::timestamptz))`);
  return [...rows][0]?.n ?? 0;
}

/**
 * How many inbound MESSAGE EVENTS the business received AFTER the event of
 * the message that parked a draft, not counting `currentEventId` (G-68,
 * Codex review). The durable record of "anything said between the two
 * erasure asks": an external event is stored at webhook ingest, BEFORE any
 * processing, so a message whose job later failed (before its conversation
 * row was written) still counts. A customer's message on the shop's own
 * WhatsApp (its job is a `customer.message`) is a different conversation
 * and does not count; an event whose job row cannot be found counts.
 * Fails CLOSED: if the parked ask's event cannot be found, the pair is
 * broken.
 */
export async function inboundEventsSinceDraft(
  tx: TenantDb,
  businessId: string,
  draftId: string,
  currentEventId: string,
): Promise<number> {
  const rows = await tx.execute<{ found: number; n: number }>(sql`
    WITH parked AS (
      SELECT e.id, e.created_at
        FROM command_drafts d
        JOIN conversation_messages m
          ON m.id = d.conversation_message_id AND m.business_id = d.business_id
        JOIN external_events e
          ON e.provider = 'meta' AND e.external_id = m.provider_message_id
         AND e.business_id = d.business_id
       WHERE d.id = ${draftId}::uuid AND d.business_id = ${businessId}::uuid
    )
    SELECT (SELECT count(*)::int FROM parked) AS found,
           (SELECT count(*)::int
              FROM external_events later, parked
             WHERE later.business_id = ${businessId}::uuid
               AND later.event_type LIKE 'message.%'
               AND later.created_at >= parked.created_at
               AND later.id <> parked.id
               AND later.id <> ${currentEventId}::uuid
               /* Only events ingested up to the current ask (Codex review):
                * a message that arrived AFTER the second ask, even if its
                * job ran first, was not said between them. An unknown
                * current event bounds nothing (fails closed). */
               AND later.created_at <= COALESCE(
                 (SELECT cur.created_at FROM external_events cur
                   WHERE cur.id = ${currentEventId}::uuid),
                 'infinity'::timestamptz)
               AND NOT EXISTS (
                 SELECT 1 FROM jobs j
                  WHERE j.business_id = later.business_id
                    AND j.kind = 'customer.message'
                    AND j.singleton_key = later.id::text)) AS n`);
  const row = [...rows][0];
  if (!row || row.found === 0) return Number.MAX_SAFE_INTEGER;
  return row.n;
}

/**
 * Every PENDING funding-answer rebuild recorded before this draft, with its
 * command (G-68, final-head review), read so the caller can supersede the
 * ones the SAME member's new purchase preview replaces (`rebuiltPurchaseFate`).
 */
export async function pendingRebuildsBefore(
  tx: TenantDb,
  businessId: string,
  draftId: string,
): Promise<{ id: string; command: unknown; requestedBy: string | null }[]> {
  const rows = await tx.execute<{ id: string; command: unknown; requested_by: string | null }>(sql`
    SELECT r.id, r.command, r.requested_by
      FROM command_drafts r
      JOIN command_drafts current
        ON current.id = ${draftId}::uuid AND current.business_id = r.business_id
     WHERE r.business_id = ${businessId}::uuid
       AND r.state = 'pending'
       AND r.rebuilt_from IS NOT NULL
       AND r.insertion_seq < current.insertion_seq
     ORDER BY r.insertion_seq`);
  return [...rows].map((r) => ({ id: r.id, command: r.command, requestedBy: r.requested_by }));
}

/**
 * Supersede ONE pending funding-answer rebuild that the same member's newer
 * purchase preview of the same total replaces (G-68): their one purchase is
 * never two confirmable previews. Conditional on `pending`.
 */
export async function supersedeRebuild(
  tx: TenantDb,
  businessId: string,
  draftId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    UPDATE command_drafts SET state = 'superseded', updated_at = clock_timestamp()
     WHERE business_id = ${businessId}::uuid
       AND id = ${draftId}::uuid
       AND state = 'pending'
       AND rebuilt_from IS NOT NULL
    RETURNING id`);
  return [...rows].length === 1;
}

/**
 * Withdraw a preview that never reached the merchant and restore the retired
 * purchase questions it closed (G-68, Codex review). The preview is
 * superseded and marked `withdrawn` (so it never blocks those questions as a
 * newer draft), and each question goes back from `superseded` to
 * `abandoned`, answerable again. Conditional on each draft's state, so it
 * undoes only what this message did.
 */
export async function withdrawPreviewAndRestore(
  tx: TenantDb,
  businessId: string,
  messageId: string,
  questionIds: readonly string[],
): Promise<void> {
  await tx.execute(sql`
    UPDATE command_drafts
       SET state = 'superseded', withdrawn = true, updated_at = clock_timestamp()
     WHERE business_id = ${businessId}::uuid
       AND conversation_message_id = ${messageId}::uuid
       AND state = 'pending'`);
  for (const id of questionIds) {
    await tx.execute(sql`
      UPDATE command_drafts SET state = 'abandoned', updated_at = clock_timestamp()
       WHERE business_id = ${businessId}::uuid
         AND id = ${id}::uuid
         AND state = 'superseded'
         AND intent = 'RecordPurchase'`);
  }
}

/**
 * Undo a same-member replacement whose preview never reached the merchant
 * (G-68, Codex review): the new draft is superseded, so no yes confirms a
 * preview nobody saw, and every rebuild it replaced is pending again, so
 * the preview the merchant DID see is the one a yes confirms. Conditional
 * on each draft's state, so it undoes only what this message did.
 */
export async function undoReplacement(
  tx: TenantDb,
  businessId: string,
  messageId: string,
  replacedIds: readonly string[],
): Promise<void> {
  await tx.execute(sql`
    UPDATE command_drafts SET state = 'superseded', updated_at = clock_timestamp()
     WHERE business_id = ${businessId}::uuid
       AND conversation_message_id = ${messageId}::uuid
       AND state = 'pending'`);
  for (const id of replacedIds) {
    await tx.execute(sql`
      UPDATE command_drafts SET state = 'pending', updated_at = clock_timestamp()
       WHERE business_id = ${businessId}::uuid
         AND id = ${id}::uuid
         AND state = 'superseded'
         AND rebuilt_from IS NOT NULL`);
  }
}

/**
 * Undo a funding-answer rebuild whose preview never reached the merchant
 * (G-68, Codex review): the new draft is superseded so no yes can confirm a
 * preview nobody saw, and the retired question is restored to `abandoned`
 * so it can be answered again. Conditional on each draft's state, so it
 * undoes only what this message did.
 */
export async function undoRebuild(
  tx: TenantDb,
  businessId: string,
  rebuiltFromId: string,
  messageId: string,
): Promise<void> {
  /* Marked explicitly as the undone rebuild of THIS question (0156), the
   * one newer draft that does not close it in `retiredPurchaseDraft`. */
  await tx.execute(sql`
    UPDATE command_drafts
       SET state = 'superseded', undone_rebuild_of = ${rebuiltFromId}::uuid,
           updated_at = clock_timestamp()
     WHERE business_id = ${businessId}::uuid
       AND conversation_message_id = ${messageId}::uuid
       AND state = 'pending'`);
  await tx.execute(sql`
    UPDATE command_drafts SET state = 'abandoned', updated_at = clock_timestamp()
     WHERE business_id = ${businessId}::uuid
       AND id = ${rebuiltFromId}::uuid
       AND state = 'superseded'`);
}

/**
 * A "no" to a retired question closes it (G-61): it becomes an ordinary
 * cancelled draft, so a later "yes" does not ask it again. Only the one
 * draft named, and only while retired. Also used as the one-shot claim of
 * a short funding answer's rebuild (G-68). A question answered by a resend
 * is closed the same way, by `closeRetiredQuestionsBefore`, and stays on
 * the record as `superseded`.
 */
export async function closeRetiredDraft(
  tx: TenantDb,
  businessId: string,
  draftId: string,
): Promise<boolean> {
  const updated = await tx
    .update(commandDrafts)
    .set({ state: 'superseded', updatedAt: new Date() })
    .where(
      and(
        eq(commandDrafts.businessId, businessId),
        eq(commandDrafts.id, draftId),
        eq(commandDrafts.state, 'abandoned'),
      ),
    )
    .returning({ id: commandDrafts.id });
  return updated.length === 1;
}

/**
 * Whether a retired purchase question was asked AFTER this draft (G-61).
 *
 * The merchant answers such a question by sending the purchase again, so
 * a preview left waiting from before it is no longer what a "yes" is
 * about: neither straight after the question nor after the replacement is
 * confirmed (a double-tapped yes). The older draft stays pending, never
 * confirmable by yes; a "no" clears it as before.
 */
export async function isBehindRetiredQuestion(
  tx: TenantDb,
  businessId: string,
  draftId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ behind: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM command_drafts q
       WHERE q.business_id = ${businessId}::uuid
         AND q.state = 'abandoned'
         AND q.insertion_seq > (
           SELECT d.insertion_seq FROM command_drafts d
            WHERE d.id = ${draftId}::uuid AND d.business_id = ${businessId}::uuid)
    ) AS behind`);
  return [...rows][0]?.behind === true;
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
