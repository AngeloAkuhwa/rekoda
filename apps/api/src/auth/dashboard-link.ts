/**
 * The one-tap way into the dashboard, from the thread a merchant is already in.
 *
 * Rekoda is WhatsApp-native and until this existed nothing it ever said linked
 * anywhere: a merchant who wanted their statements had to leave the thread,
 * recall an address, type their number and wait for a code that arrived back
 * in the thread they had just left.
 *
 * ── why this is not a weaker door ──────────────────────────────────────────
 *
 * The thread IS already the credential. It is where the OTP is delivered, and
 * it is what a CG2 confirmation moves real money on. A link sent into it is no
 * weaker than the code it saves, and anyone holding the unlocked phone could
 * have asked for that code anyway.
 *
 * What keeps it narrow is who it is issued FOR: one member of one business,
 * resolved from the sending phone by the caller. A stranger messaging the
 * number gets nothing, and a link can never carry more access than the person
 * who asked for it already had.
 *
 * ── why it lives here and not in AuthService ───────────────────────────────
 *
 * Two callers need it: the sign-in route and the chat handler, which is a job
 * and holds no Nest injector. A function both call is one implementation; the
 * alternative was widening the handler's dependencies to reach a service for
 * two lines, or writing the token minting twice.
 */
import { randomBytes } from 'node:crypto';
import {
  hashSecret,
  issueMagicLink,
  validateMagicLink,
  MAGIC_LINK_TTL_MS,
  type RandomSource,
} from '@rekoda/core/identity';
import { identity, type Db } from '@rekoda/db';

/** How long a link lives, in whole minutes, for the message that carries it. */
export const LINK_MINUTES = Math.round(MAGIC_LINK_TTL_MS / 60_000);

const secure: RandomSource = (bytes) => randomBytes(bytes);

/**
 * Mint a link for one member of one business.
 *
 * Null when this deployment has no web address configured, so the caller says
 * so plainly rather than sending a link to nowhere. A merchant who taps one
 * and lands on an error learns that Rekoda's links do not work, and that
 * lesson outlasts the outage.
 *
 * The token exists in the message and in no row: only its hash is stored.
 */
export async function mintDashboardLink(input: {
  db: Db;
  webUrl: string | null;
  userId: string;
  businessId: string;
  now?: Date;
  random?: RandomSource;
}): Promise<string | null> {
  if (!input.webUrl) return null;

  const { token, link } = issueMagicLink(input.random ?? secure, input.now ?? new Date());
  await identity.insertMagicLink(input.db, {
    userId: input.userId,
    businessId: input.businessId,
    tokenHash: link.tokenHash,
    expiresAt: link.expiresAt,
    usedAt: null,
  });
  return `${input.webUrl}/enter?t=${encodeURIComponent(token)}`;
}

export interface RedeemedLink {
  userId: string;
  businessId: string;
}

/**
 * Burn a tapped link and report who it belonged to.
 *
 * Looked up by HASH, so a leaked database row cannot be replayed as a URL.
 * `consumeMagicLink` is the thing that decides: it burns the row with an
 * `IS NULL` predicate inside the UPDATE, so two taps of the same URL cannot
 * both succeed and the loser is told the link is spent. That is what single
 * use has to mean, and a read-then-write would not deliver it.
 *
 * Every failure answers null. Telling expired from spent from never-existed
 * would tell whoever is guessing which of the three they achieved.
 */
export async function burnDashboardLink(
  db: Db,
  token: string,
  now = new Date(),
): Promise<RedeemedLink | null> {
  const row = await identity.findMagicLinkByHash(db, hashSecret(token));
  if (!row) return null;

  const verdict = validateMagicLink(
    { tokenHash: row.tokenHash, expiresAt: row.expiresAt, usedAt: row.usedAt },
    token,
    now,
  );
  if (verdict.status !== 'valid') return null;
  if (!(await identity.consumeMagicLink(db, row.id, now))) return null;

  return { userId: row.userId, businessId: row.businessId };
}
