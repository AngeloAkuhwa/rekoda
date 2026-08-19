/**
 * Identity persistence (spec §36, MASTER-PLAN 5.2.2).
 *
 * This file holds SQL, locking and transaction boundaries — and no rules. The
 * rules live in `@rekoda/core/identity`, which has no database and no clock, so
 * they stay deterministically testable. The API layer reads state through here,
 * applies a rule, and writes the result back inside the same transaction.
 *
 * That split is why `withPhoneLock` exists rather than a `verifyOtp` method:
 * the lock and the transaction are a persistence concern, the decision made
 * inside them is not.
 */
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';
import { withBusiness, withUser } from '../client.js';
import {
  businesses,
  magicLinks,
  memberships,
  otpChallenges,
  sessions,
  users,
} from '../schema/tenancy.js';

/** Either a pool handle or a transaction — every read below accepts both. */
export type Queryable = Db | TenantDb;

/* ─────────────────────────────── OTP ─────────────────────────────── */

export interface OtpChallengeRow {
  id: string;
  phone: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

/**
 * Serialise every OTP decision for one number.
 *
 * Without this, the attempt limit is not a limit: five concurrent guesses all
 * read `attempts = 0`, all conclude they are within budget, and all write
 * `attempts = 1`. An attacker willing to open parallel connections gets
 * unlimited tries against a counter that never climbs. A transaction-scoped
 * advisory lock keyed on the phone number is the cheapest correct fix — it is
 * released on commit or rollback with no cleanup path to forget.
 */
export async function withPhoneLock<T>(
  db: Db,
  phone: string,
  fn: (tx: TenantDb) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${phone}, 0))`);
    return fn(tx);
  });
}

/** The newest unconsumed, unexpired challenge for a number, if any. */
export async function liveChallengeFor(
  q: Queryable,
  phone: string,
  now: Date,
): Promise<OtpChallengeRow | null> {
  const rows = await q
    .select()
    .from(otpChallenges)
    .where(
      and(
        eq(otpChallenges.phone, phone),
        isNull(otpChallenges.consumedAt),
        gt(otpChallenges.expiresAt, now),
      ),
    )
    .orderBy(desc(otpChallenges.createdAt))
    .limit(1);

  const row = rows[0];
  return row ? toChallengeRow(row) : null;
}

/**
 * Wrong guesses across ALL of a number's challenges in the window.
 *
 * The per-challenge attempt limit alone is only a sixty-second inconvenience:
 * burn five guesses, wait for the cooldown, request a fresh challenge with the
 * counter back at zero, repeat. Summing `attempts` over the window is what
 * actually bounds guessing, and it needs no extra table — `attempts` only ever
 * counts wrong codes.
 */
export async function failuresSince(q: Queryable, phone: string, since: Date): Promise<number> {
  const rows = await q
    .select({ total: sql<string>`coalesce(sum(${otpChallenges.attempts}), 0)` })
    .from(otpChallenges)
    .where(and(eq(otpChallenges.phone, phone), gt(otpChallenges.createdAt, since)));
  return Number(rows[0]?.total ?? 0);
}

export async function insertChallenge(
  q: Queryable,
  challenge: Omit<OtpChallengeRow, 'id' | 'createdAt'>,
): Promise<OtpChallengeRow> {
  const rows = await q
    .insert(otpChallenges)
    .values({
      phone: challenge.phone,
      codeHash: challenge.codeHash,
      attempts: challenge.attempts,
      expiresAt: challenge.expiresAt,
      consumedAt: challenge.consumedAt,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('insertChallenge: insert returned no row');
  return toChallengeRow(row);
}

/** Persists the next state a rule returned. Never invents one of its own. */
export async function saveChallengeState(
  q: Queryable,
  id: string,
  next: { attempts: number; consumedAt: Date | null },
): Promise<void> {
  await q
    .update(otpChallenges)
    .set({ attempts: next.attempts, consumedAt: next.consumedAt })
    .where(eq(otpChallenges.id, id));
}

function toChallengeRow(row: typeof otpChallenges.$inferSelect): OtpChallengeRow {
  return {
    id: row.id,
    phone: row.phone,
    codeHash: row.codeHash,
    attempts: row.attempts,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
  };
}

/* ────────────────────────────── users ────────────────────────────── */

export interface UserRow {
  id: string;
  phone: string;
  displayName: string | null;
}

/**
 * The phone IS the identity anchor, so this must be idempotent under races:
 * two devices verifying the same number concurrently must converge on one user,
 * not race to create two and split the merchant's ledger. `ON CONFLICT` makes
 * the unique index do that work instead of a read-then-write window.
 */
export async function upsertUserByPhone(q: Queryable, phone: string): Promise<UserRow> {
  const rows = await q
    .insert(users)
    .values({ phone })
    .onConflictDoUpdate({
      target: users.phone,
      // A no-op SET is what makes RETURNING yield the existing row; DO NOTHING
      // returns nothing at all on conflict, which would look like failure.
      set: { updatedAt: new Date() },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('upsertUserByPhone: upsert returned no row');
  return { id: row.id, phone: row.phone, displayName: row.displayName };
}

export async function findUserById(q: Queryable, id: string): Promise<UserRow | null> {
  const rows = await q.select().from(users).where(eq(users.id, id)).limit(1);
  const row = rows[0];
  return row ? { id: row.id, phone: row.phone, displayName: row.displayName } : null;
}

export async function findUserByPhone(q: Queryable, phone: string): Promise<UserRow | null> {
  const rows = await q.select().from(users).where(eq(users.phone, phone)).limit(1);
  const row = rows[0];
  return row ? { id: row.id, phone: row.phone, displayName: row.displayName } : null;
}

/* ──────────────────────────── businesses ─────────────────────────── */

export interface NewBusiness {
  name: string;
  businessType: string | null;
  ownerUserId: string;
}

export interface BusinessRow {
  id: string;
  name: string;
  businessType: string | null;
  plan: string;
}

/**
 * Create a business and its owner membership under RLS.
 *
 * The `tenant_self` policy requires `app.business_id` to equal the row's own
 * `id`, which means the id cannot come from a `DEFAULT` — there is nothing to
 * pin before the insert runs. Generating it in the application and pinning it
 * first is legal but sharp enough that MASTER-PLAN 4.4 #5 called for a
 * dedicated helper and a test rather than leaving it for onboarding to
 * rediscover. This is that helper.
 */
export async function createBusinessWithOwner(db: Db, input: NewBusiness): Promise<BusinessRow> {
  const businessId = crypto.randomUUID();
  return withBusiness(db, businessId, async (tx) => {
    const rows = await tx
      .insert(businesses)
      .values({
        id: businessId,
        name: input.name,
        businessType: input.businessType,
        ownerUserId: input.ownerUserId,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('createBusinessWithOwner: insert returned no row');

    await tx.insert(memberships).values({ businessId, userId: input.ownerUserId, role: 'owner' });

    return {
      id: row.id,
      name: row.name,
      businessType: row.businessType,
      plan: row.plan,
    };
  });
}

/** Add a member to an existing tenant. Written under that tenant's pin. */
export async function addMembership(
  db: Db,
  businessId: string,
  userId: string,
  role: string,
): Promise<void> {
  await withBusiness(db, businessId, async (tx) => {
    await tx.insert(memberships).values({ businessId, userId, role });
  });
}

export interface MembershipRow {
  businessId: string;
  role: string;
}

/**
 * Which tenants may this user enter?
 *
 * This is the one question that must be answered BEFORE a tenant can be
 * pinned, so `withBusiness` cannot help — and `memberships` is RLS-protected,
 * so an unpinned SELECT correctly returns nothing.
 *
 * The fix is a second, deliberately narrow pin: `app.user_id`, backed by a
 * SELECT-ONLY policy (migrations/0002_identity.sql). Writes still go only
 * through `tenant_isolation`, so this cannot be used to forge a membership —
 * only to read which ones exist. It leaks no financial data: a caller that can
 * pin an arbitrary user id learns business ids and role names, and must still
 * pin the business itself to read a single naira.
 *
 * A SECURITY DEFINER function was the obvious alternative and does not work
 * here: the tenant tables are under FORCE ROW LEVEL SECURITY, so the policies
 * apply to the table owner too, and a definer-rights function owned by that
 * role is filtered exactly like everyone else.
 */
export async function membershipsForUser(db: Db, userId: string): Promise<MembershipRow[]> {
  return withUser(db, userId, async (tx) => {
    const rows = await tx
      .select({ businessId: memberships.businessId, role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.active, true)));
    return rows;
  });
}

/** The tenant row itself, read under its own pin. */
export async function businessById(db: Db, businessId: string): Promise<BusinessRow | null> {
  return withBusiness(db, businessId, async (tx) => {
    const rows = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
    const row = rows[0];
    return row
      ? { id: row.id, name: row.name, businessType: row.businessType, plan: row.plan }
      : null;
  });
}

/* ─────────────────────────── magic links ─────────────────────────── */

export interface MagicLinkRow {
  id: string;
  userId: string;
  businessId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}

export async function insertMagicLink(
  q: Queryable,
  link: Omit<MagicLinkRow, 'id'>,
): Promise<MagicLinkRow> {
  const rows = await q
    .insert(magicLinks)
    .values({
      userId: link.userId,
      businessId: link.businessId,
      tokenHash: link.tokenHash,
      expiresAt: link.expiresAt,
      usedAt: link.usedAt,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('insertMagicLink: insert returned no row');
  return row as MagicLinkRow;
}

export async function findMagicLinkByHash(
  q: Queryable,
  tokenHash: string,
): Promise<MagicLinkRow | null> {
  const rows = await q
    .select()
    .from(magicLinks)
    .where(eq(magicLinks.tokenHash, tokenHash))
    .limit(1);
  return (rows[0] as MagicLinkRow | undefined) ?? null;
}

/**
 * Burn a magic link, and report whether THIS caller is the one that burned it.
 *
 * A read-then-write would let two concurrent redemptions of the same URL both
 * observe `used_at IS NULL` and both mint a session — which is exactly the
 * property "single use" is supposed to deny. The `IS NULL` predicate lives in
 * the UPDATE so the database decides the winner, and `rowCount` reports it.
 */
export async function consumeMagicLink(q: Queryable, id: string, now: Date): Promise<boolean> {
  const updated = await q
    .update(magicLinks)
    .set({ usedAt: now })
    .where(and(eq(magicLinks.id, id), isNull(magicLinks.usedAt)))
    .returning({ id: magicLinks.id });
  return updated.length === 1;
}

/* ───────────────────────────── sessions ──────────────────────────── */

export interface SessionRow {
  id: string;
  userId: string;
  businessId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export async function insertSession(
  q: Queryable,
  session: Omit<SessionRow, 'id'>,
): Promise<SessionRow> {
  const rows = await q
    .insert(sessions)
    .values({
      userId: session.userId,
      businessId: session.businessId,
      tokenHash: session.tokenHash,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('insertSession: insert returned no row');
  return row as SessionRow;
}

export async function findSessionByHash(
  q: Queryable,
  tokenHash: string,
): Promise<SessionRow | null> {
  const rows = await q.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1);
  return (rows[0] as SessionRow | undefined) ?? null;
}

/** Rolling refresh. Never resurrects: a revoked row is excluded by predicate. */
export async function extendSession(q: Queryable, id: string, expiresAt: Date): Promise<void> {
  await q
    .update(sessions)
    .set({ expiresAt })
    .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
}

export async function revokeSession(q: Queryable, id: string, now: Date): Promise<void> {
  await q.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, id));
}

/* ─────────────────────────── schema health ───────────────────────── */

/**
 * How many migrations the database admits to having applied.
 *
 * "Can I connect?" is the wrong health question: a server that accepts
 * connections while carrying no schema looks healthiest of all, and is the one
 * that silently loses a merchant's first sale.
 */
export async function migrationCount(q: Queryable): Promise<number> {
  const rows = await q.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM rekoda_migrations`,
  );
  return [...rows][0]?.n ?? 0;
}

/** Liveness only — can we reach the server at all? Never throws. */
export async function ping(q: Queryable): Promise<boolean> {
  try {
    await q.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}
