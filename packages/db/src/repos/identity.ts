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
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { trialExpiry } from '@rekoda/core';
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
import { auditEvents } from '../schema/ops.js';
import { seedChartOfAccounts } from './accounts.js';
import { seedTaxModel } from './tax.js';

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
  rcNumber: string | null;
  tin: string | null;
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
        // The trial clock starts here, written once. Without it the monthly
        // counters would hand out a fresh free trial every calendar month.
        planExpiresAt: trialExpiry(new Date()),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('createBusinessWithOwner: insert returned no row');

    await tx.insert(memberships).values({ businessId, userId: input.ownerUserId, role: 'owner' });

    /* The chart of accounts arrives WITH the business (PR-030): the engine
     * may rely on every seeded role existing, so there is no window where a
     * business exists and its chart does not. */
    await seedChartOfAccounts(tx, businessId);

    /* The tax model arrives with the business too (§13, PR-078): codes,
     * treatments, point policies and the published rate history, so no
     * caller ever reaches for a hardcoded rate. */
    await seedTaxModel(tx, businessId);

    return {
      id: row.id,
      name: row.name,
      businessType: row.businessType,
      plan: row.plan,
      rcNumber: row.rcNumber,
      tin: row.tin,
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
      ? {
          id: row.id,
          name: row.name,
          businessType: row.businessType,
          plan: row.plan,
          rcNumber: row.rcNumber,
          tin: row.tin,
        }
      : null;
  });
}

export interface BusinessSettingsPatch {
  name?: string | undefined;
  /** Empty string clears the number: "not registered" is a valid answer. */
  rcNumber?: string | undefined;
  tin?: string | undefined;
}

export interface BusinessSettings {
  name: string;
  rcNumber: string | null;
  tin: string | null;
}

/**
 * The facts a business may correct about itself (fix-plan 5, H2a).
 *
 * The columns have existed since M0 and nothing could ever write them after
 * onboarding, which made "you can change it later" a promise with no door.
 * Audited like every deliberate change: a renamed business is a fact an
 * accountant may need explained.
 */
export async function updateBusinessSettings(
  tx: TenantDb,
  businessId: string,
  patch: BusinessSettingsPatch,
  actor: string,
): Promise<BusinessSettings> {
  const before = await tx
    .select({ name: businesses.name, rcNumber: businesses.rcNumber, tin: businesses.tin })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  const previous = before[0];
  if (!previous) throw new Error('updateBusinessSettings: no such business');

  const next: BusinessSettings = {
    name: patch.name ?? previous.name,
    rcNumber: patch.rcNumber === undefined ? previous.rcNumber : patch.rcNumber || null,
    tin: patch.tin === undefined ? previous.tin : patch.tin || null,
  };
  await tx
    .update(businesses)
    .set({ name: next.name, rcNumber: next.rcNumber, tin: next.tin, updatedAt: new Date() })
    .where(eq(businesses.id, businessId));

  await tx.insert(auditEvents).values({
    businessId,
    actor,
    entity: 'business',
    entityId: businessId,
    action: 'settings_changed',
    oldValue: previous as never,
    newValue: next as never,
    sourceType: 'dashboard',
  });
  return next;
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

/**
 * The WhatsApp number to send a business's documents to — its OWNER's.
 *
 * Deliberately the owner and not "any member": a document is a financial
 * record, and sending one to whoever happened to be added to the business last
 * week is a decision nobody made. When staff roles need documents, that will
 * be a per-role setting rather than a widened query.
 *
 * Runs under a tenant pin, and must. `memberships` is under row-level
 * security, so an unpinned read returns ZERO rows however well-scoped the
 * WHERE clause looks. The `users` join is unaffected: that table is outside
 * RLS, and the pin has already decided which user id we may reach.
 */
export async function ownerPhoneFor(db: Db, businessId: string): Promise<string | null> {
  return withBusiness(db, businessId, async (tx) => {
    const rows = await tx
      .select({ phone: users.phone })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.businessId, businessId), eq(memberships.role, 'owner')))
      .limit(1);
    return rows[0]?.phone ?? null;
  });
}

/**
 * What this phone is allowed to do in this business, under an existing pin.
 *
 * The `ownerPhoneFor` above opens its own pin and so cannot be called from
 * inside a job's transaction. This one takes the pin it is given, which is
 * what a handler already holds.
 *
 * Null for a phone with no membership here. `memberships` is under row-level
 * security and `users` is deliberately outside it, so the pin is what decides
 * which user ids are reachable at all.
 */
export async function roleOfPhone(
  tx: TenantDb,
  businessId: string,
  phone: string,
): Promise<string | null> {
  const rows = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.businessId, businessId), eq(users.phone, phone)))
    .limit(1);
  return rows[0]?.role ?? null;
}

/**
 * The member behind a phone number, or null for a stranger.
 *
 * `roleOfPhone` answers "may they", which is the question at almost every
 * gate. This answers "who are they", which is only needed where something is
 * written AGAINST a person - a magic link belongs to one member, and issuing
 * one against a business without knowing which member asked would be a
 * credential with no owner.
 */
export async function memberByPhone(
  tx: TenantDb,
  businessId: string,
  phone: string,
): Promise<{ userId: string; role: string } | null> {
  const rows = await tx
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.businessId, businessId), eq(users.phone, phone)))
    .limit(1);
  return rows[0] ?? null;
}

/* ─────────────────────────── who can see the books ──────────────────────── */

export interface TeamMember {
  userId: string;
  /** E.164. The only identifier an owner has for somebody they invited. */
  phone: string;
  role: string;
  addedAt: Date;
}

/**
 * Everyone who can reach this business, under its own pin.
 *
 * `memberships` is under row-level security and `users` is deliberately
 * outside it, so the pin is what decides which user ids are reachable at all
 * — the join cannot wander into another tenant's people.
 */
export async function membersOf(tx: TenantDb, businessId: string): Promise<TeamMember[]> {
  const rows = await tx
    .select({
      userId: users.id,
      phone: users.phone,
      role: memberships.role,
      addedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(eq(memberships.businessId, businessId))
    .orderBy(memberships.createdAt);
  return rows.map((r) => ({ ...r, addedAt: new Date(r.addedAt) }));
}

export class AlreadyAMember extends Error {}

/**
 * Give somebody access to a business by their phone number.
 *
 * The user row is created if this is the first Rekoda has heard of them:
 * an accountant should not have to sign up before they can be invited, and
 * `upsertUserByPhone` is what the OTP flow will find when they do sign in.
 *
 * Refuses a duplicate rather than adding a second membership. Two rows for
 * one person is not a worse kind of access, it is a person whose role
 * depends on which row a query happens to read first.
 */
/** The plan's seat table is full. Carries the limit so the refusal can quote it. */
export class SeatLimitReached extends Error {
  constructor(readonly limit: number) {
    super(`this plan includes ${limit} team member${limit === 1 ? '' : 's'}`);
  }
}

export async function inviteMember(
  db: Db,
  businessId: string,
  phone: string,
  role: 'accountant' | 'delegate',
  /**
   * Seats beyond the owner this plan includes, from `@rekoda/core`'s table.
   * An argument for the same reason `consumeUnit` takes the allowance: the
   * decision lives in core, and this file stays SQL.
   */
  seatLimit: number,
  /** Who granted the access, `user:<id>` — an access change is an audited act. */
  actor: string,
): Promise<TeamMember> {
  const user = await upsertUserByPhone(db, phone);
  return withBusiness(db, businessId, async (tx) => {
    /* Serialized per business, or two simultaneous invites both count the
     * same table and both fit under the last seat. Transaction-scoped, the
     * same shape as every claim here: the database picks the winner. */
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${businessId}:members`}))`);

    /* Membership first: somebody already seated takes no new seat, and
     * "already a member" is the truthful answer even when the table is full. */
    const existing = await tx
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.businessId, businessId), eq(memberships.userId, user.id)))
      .limit(1);
    if (existing.length > 0) {
      throw new AlreadyAMember(`already a ${existing[0]!.role} of this business`);
    }

    const seated = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(eq(memberships.businessId, businessId), ne(memberships.role, 'owner')));
    if ((seated[0]?.n ?? 0) >= seatLimit) throw new SeatLimitReached(seatLimit);

    const inserted = await tx
      .insert(memberships)
      .values({ businessId, userId: user.id, role })
      .returning({ createdAt: memberships.createdAt });

    /* §42.13: who can see and touch the books is an audited fact. The
     * phone stays out of the row — the membership's user id is the
     * durable identity, and audit rows travel into exports. */
    await tx.insert(auditEvents).values({
      businessId,
      actor,
      entity: 'membership',
      entityId: user.id,
      action: 'invited',
      newValue: { role },
      sourceType: 'dashboard',
    });
    return {
      userId: user.id,
      phone: user.phone,
      role,
      addedAt: new Date(inserted[0]!.createdAt),
    };
  });
}

export class CannotRemoveOwner extends Error {}

/**
 * Take access away.
 *
 * The OWNER cannot be removed, by anybody including themselves. A business
 * with no owner has nobody who can invite one back, change its plan, or
 * delete its data: it is a tenant nobody can administer, and the repair is a
 * database console. Refusing here is cheaper than that.
 *
 * Returns false when there was nothing to remove, so a caller can tell "gone
 * now" from "was never here" without a second query.
 */
export async function removeMember(
  tx: TenantDb,
  businessId: string,
  userId: string,
  /** Who revoked the access, `user:<id>` — an access change is an audited act. */
  actor: string,
): Promise<boolean> {
  const removed = await tx
    .delete(memberships)
    .where(
      and(
        eq(memberships.businessId, businessId),
        eq(memberships.userId, userId),
        ne(memberships.role, 'owner'),
      ),
    )
    .returning({ role: memberships.role });
  if (removed.length === 1) {
    await tx.insert(auditEvents).values({
      businessId,
      actor,
      entity: 'membership',
      entityId: userId,
      action: 'removed',
      oldValue: { role: removed[0]!.role },
      sourceType: 'dashboard',
    });
    return true;
  }

  const owner = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.businessId, businessId), eq(memberships.userId, userId)))
    .limit(1);
  if (owner[0]?.role === 'owner') throw new CannotRemoveOwner('the owner cannot be removed');
  return false;
}

/**
 * Change what a member is, without the remove-and-reinvite dance that
 * would briefly leave them with nothing (D1, PR-094). Seat-neutral by
 * construction — accountant and delegate draw from the same seat pool —
 * and the OWNER's role is not a role anybody assigns: a business whose
 * owner became a delegate has nobody who can administer it, which is the
 * same argument `removeMember` makes.
 *
 * Returns false when there is nothing to change: no such member, or the
 * member already holds that role (an audit row claiming a change that
 * changed nothing would be a lie).
 */
export async function changeMemberRole(
  tx: TenantDb,
  businessId: string,
  userId: string,
  role: 'accountant' | 'delegate',
  actor: string,
): Promise<boolean> {
  const changed = await tx
    .update(memberships)
    .set({ role })
    .where(
      and(
        eq(memberships.businessId, businessId),
        eq(memberships.userId, userId),
        ne(memberships.role, 'owner'),
        ne(memberships.role, role),
      ),
    )
    .returning({ id: memberships.userId });
  if (changed.length === 1) {
    await tx.insert(auditEvents).values({
      businessId,
      actor,
      entity: 'membership',
      entityId: userId,
      action: 'role_changed',
      newValue: { role },
      sourceType: 'dashboard',
    });
    return true;
  }

  const existing = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.businessId, businessId), eq(memberships.userId, userId)))
    .limit(1);
  if (existing[0]?.role === 'owner') {
    throw new CannotRemoveOwner('the owner cannot be given another role');
  }
  return false;
}

/* ─────────────────────── messaging consent (STOP/START) ─────────────────── */

/**
 * Record or clear a person's opt-out. Keyed by phone because that is what
 * both the inbound message and the outbound send actually carry. A phone
 * nobody has verified is a silent no-op: there is no consent state to keep
 * for a person who does not exist.
 */
export async function setOptOut(q: Queryable, phone: string, at: Date | null): Promise<boolean> {
  const rows = await q
    .update(users)
    .set({ optedOutAt: at })
    .where(eq(users.phone, phone))
    .returning({ id: users.id });
  return rows.length === 1;
}

/** Null means messages are welcome. Checked before every PROACTIVE send. */
export async function optedOutAt(q: Queryable, phone: string): Promise<Date | null> {
  const rows = await q
    .select({ optedOutAt: users.optedOutAt })
    .from(users)
    .where(eq(users.phone, phone))
    .limit(1);
  return rows[0]?.optedOutAt ?? null;
}
