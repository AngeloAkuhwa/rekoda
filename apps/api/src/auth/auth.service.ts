/**
 * Identity orchestration (spec §36).
 *
 * Every rule this file applies comes from `@rekoda/core/identity`, which has no
 * database and no clock; every row it touches goes through a `@rekoda/db`
 * repository, which has no rules. This service is the seam between them, and
 * deliberately contains neither — so the security properties stay provable in
 * `identity.test.ts` and the tenancy properties stay provable in
 * `tenancy.integration.test.ts`.
 */
import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  hashSecret,
  issueOtp,
  issueSession,
  normalisePhone,
  validateSession,
  verifyOtp,
  type RandomSource,
} from '@rekoda/core/identity';
import { identity, type Db } from '@rekoda/db';
import type {
  MeResponse,
  MembershipSummary,
  RequestOtpResponse,
  SessionResponse,
  VerifyOtpResponse,
} from '@rekoda/contracts';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import { issueSetupToken, readSetupToken, type SetupGrant } from './tokens.js';

/** Resends inside this window return the live challenge instead of minting one. */
export const RESEND_COOLDOWN_MS = 60 * 1_000;
/** Wrong guesses tolerated per number per window, across all its challenges. */
export const MAX_FAILURES_PER_WINDOW = 15;
export const FAILURE_WINDOW_MS = 60 * 60 * 1_000;
/** Minimum age before a session's rolling expiry is written back. */
export const SESSION_REFRESH_FLOOR_MS = 24 * 60 * 60 * 1_000;

export class SetupTokenInvalid extends Error {}
export class SessionInvalid extends Error {}

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);
  private readonly random: RandomSource = (n) => randomBytes(n);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Issue a code, under a lock held for the whole decision.
   *
   * The lock is not about the insert — it is about the rate limit. Without it,
   * a burst of concurrent requests each reads the same failure count and the
   * same "no live challenge", and every one of them mints a code.
   */
  async requestOtp(rawPhone: string, now = new Date()): Promise<RequestOtpResponse> {
    const phone = normalisePhone(rawPhone);

    return identity.withPhoneLock(this.db, phone, async (tx) => {
      const since = new Date(now.getTime() - FAILURE_WINDOW_MS);
      if ((await identity.failuresSince(tx, phone, since)) >= MAX_FAILURES_PER_WINDOW) {
        return { status: 'locked_out', phone };
      }

      const live = await identity.liveChallengeFor(tx, phone, now);
      if (live) {
        // Read from `created_at` rather than derived as `expiresAt - TTL`: the
        // derivation is only correct while the TTL constant never changes, and
        // a challenge issued under an older TTL would be misjudged.
        const age = now.getTime() - live.createdAt.getTime();
        if (age < RESEND_COOLDOWN_MS) {
          return {
            status: 'resend_too_soon',
            phone,
            retryInSeconds: Math.ceil((RESEND_COOLDOWN_MS - age) / 1_000),
          };
        }
      }

      const { code, challenge } = issueOtp(phone, this.random, now, this.config.otpPepper);
      await identity.insertChallenge(tx, challenge);

      // TODO(M2): deliver over the Meta Cloud API (ADR 0011). Until the channel
      // layer lands the code never leaves the server in a deployed environment —
      // logging it would put a live credential in the log store beside the phone
      // number it unlocks.
      if (!this.config.revealOtp) {
        this.log.log(`OTP issued for ${redact(phone)} (delivery pending channel layer)`);
      }

      return this.config.revealOtp
        ? { status: 'sent', phone, devCode: code }
        : { status: 'sent', phone };
    });
  }

  /**
   * Check a code and, if it is right, hand back either a session or a setup
   * grant depending on whether the merchant already has a business.
   *
   * The whole decision happens under the phone lock, so five parallel guesses
   * cannot each observe `attempts = 0`.
   */
  async verifyOtp(rawPhone: string, code: string, now = new Date()): Promise<VerifyOtpResponse> {
    const phone = normalisePhone(rawPhone);

    const outcome = await identity.withPhoneLock(this.db, phone, async (tx) => {
      const since = new Date(now.getTime() - FAILURE_WINDOW_MS);
      if ((await identity.failuresSince(tx, phone, since)) >= MAX_FAILURES_PER_WINDOW) {
        return { kind: 'locked_out' } as const;
      }

      const challenge = await identity.liveChallengeFor(tx, phone, now);
      if (!challenge) return { kind: 'no_live_challenge' } as const;

      const result = verifyOtp(challenge, code, now, this.config.otpPepper);
      if ('challenge' in result) {
        await identity.saveChallengeState(tx, challenge.id, {
          attempts: result.challenge.attempts,
          consumedAt: result.challenge.consumedAt,
        });
      }

      if (result.status !== 'verified') return { kind: 'rule', result } as const;

      // Same transaction as the consume: a verified code must not be able to
      // produce two users if the request is retried mid-flight.
      const user = await identity.upsertUserByPhone(tx, phone);
      return { kind: 'verified', userId: user.id } as const;
    });

    switch (outcome.kind) {
      case 'locked_out':
        return { status: 'locked_out' };
      case 'no_live_challenge':
        // No live challenge covers both "never issued" and "already consumed or
        // expired". Reporting `expired` rather than distinguishing them denies a
        // prober free information about which numbers have pending sign-ins.
        return { status: 'expired' };
      case 'rule': {
        const r = outcome.result;
        if (r.status === 'wrong_code')
          return { status: 'wrong_code', attemptsLeft: r.attemptsLeft };
        return { status: r.status };
      }
      case 'verified':
        break;
    }

    const memberships = await this.membershipSummaries(outcome.userId);
    if (memberships.length === 0) {
      const { token, expiresAt } = issueSetupToken(
        { userId: outcome.userId, phone },
        now,
        this.config.secret,
      );
      return { status: 'setup_required', setupToken: token, expiresAt: expiresAt.toISOString() };
    }

    const first = memberships[0]!;
    const session = await this.mintSession(outcome.userId, first.businessId, now);
    return {
      status: 'signed_in',
      sessionToken: session.sessionToken,
      expiresAt: session.expiresAt,
      memberships,
    };
  }

  /**
   * Create the first business and exchange the setup grant for a real session.
   *
   * The grant is verified here rather than in a guard because it authorises
   * exactly this one endpoint; making it a general-purpose credential is how a
   * narrow token quietly becomes a broad one.
   */
  async createFirstBusiness(
    setupToken: string,
    input: { name: string; businessType: string | null },
    now = new Date(),
  ): Promise<SessionResponse> {
    const grant = readSetupToken(setupToken, now, this.config.secret);
    if (!grant) throw new SetupTokenInvalid('setup token is missing, expired or forged');

    // Idempotent, and this matters more than it looks.
    //
    // The grant stays valid for thirty minutes, so a merchant who double-taps
    // "Create" — or whose phone retries a request on a flaky network — would
    // otherwise end up with two businesses and two separate ledgers, from one
    // deliberate action. Returning the business they already have puts a
    // double-submit exactly where the first submit was taking them.
    const existing = await this.membershipSummaries(grant.userId);
    const already = existing[0];
    if (already) {
      const session = await this.mintSession(grant.userId, already.businessId, now);
      return {
        sessionToken: session.sessionToken,
        expiresAt: session.expiresAt,
        businessId: already.businessId,
        businessName: already.businessName,
        role: already.role,
      };
    }

    const business = await identity.createBusinessWithOwner(this.db, {
      name: input.name,
      businessType: input.businessType,
      ownerUserId: grant.userId,
    });

    const session = await this.mintSession(grant.userId, business.id, now);
    return {
      sessionToken: session.sessionToken,
      expiresAt: session.expiresAt,
      businessId: business.id,
      businessName: business.name,
      role: 'owner',
    };
  }

  /** Introspection for the web tier's setup-step guard. Null when unusable. */
  readSetupGrant(token: string, now = new Date()): SetupGrant | null {
    return readSetupToken(token, now, this.config.secret);
  }

  /**
   * Validate a session cookie and roll its expiry forward.
   *
   * Revocation is checked before the refresh inside `validateSession`, so a
   * revoked session cannot be resurrected by using it.
   */
  async resolveSession(token: string, now = new Date()): Promise<MeResponse> {
    const row = await identity.findSessionByHash(this.db, hashSecret(token));
    if (!row) throw new SessionInvalid('unknown session');

    const result = validateSession(
      { tokenHash: row.tokenHash, expiresAt: row.expiresAt, revokedAt: row.revokedAt },
      token,
      now,
    );
    if (result.status !== 'valid') throw new SessionInvalid(result.status);

    // Rolling expiry, persisted at most once a day.
    //
    // `validateSession` always returns a deadline pushed to now + 30 days, but
    // writing that on every request means a database write for every
    // authenticated page view — and buys nothing, since a session is no more
    // alive for having been touched twice in the same minute. The gap between
    // the stored deadline and the new one IS the time since the last refresh.
    if (result.session.expiresAt.getTime() - row.expiresAt.getTime() >= SESSION_REFRESH_FLOOR_MS) {
      await identity.extendSession(this.db, row.id, result.session.expiresAt);
    }

    const business = await identity.businessById(this.db, row.businessId);
    if (!business) throw new SessionInvalid('session points at a business that no longer exists');

    const memberships = await identity.membershipsForUser(this.db, row.userId);
    const membership = memberships.find((m) => m.businessId === row.businessId);
    if (!membership) throw new SessionInvalid('membership revoked');

    // A session referencing a missing user is a foreign-key violation that
    // cannot happen — but rendering an empty phone if it ever did would show the
    // merchant a dashboard that quietly lies about whose it is.
    const user = await identity.findUserById(this.db, row.userId);
    if (!user) throw new SessionInvalid('session points at a user that no longer exists');

    return {
      userId: row.userId,
      phone: user.phone,
      businessId: business.id,
      businessName: business.name,
      businessType: business.businessType,
      plan: business.plan,
      role: membership.role,
    };
  }

  async revokeSession(token: string, now = new Date()): Promise<void> {
    const row = await identity.findSessionByHash(this.db, hashSecret(token));
    if (row) await identity.revokeSession(this.db, row.id, now);
  }

  private async mintSession(
    userId: string,
    businessId: string,
    now: Date,
  ): Promise<{ sessionToken: string; expiresAt: string }> {
    const { token, session } = issueSession(this.random, now);
    await identity.insertSession(this.db, {
      userId,
      businessId,
      tokenHash: session.tokenHash,
      expiresAt: session.expiresAt,
      revokedAt: null,
    });
    // One source for the deadline: the rule computed it, so re-deriving it here
    // is a second place for the TTL to be wrong.
    return { sessionToken: token, expiresAt: session.expiresAt.toISOString() };
  }

  private async membershipSummaries(userId: string): Promise<MembershipSummary[]> {
    const rows = await identity.membershipsForUser(this.db, userId);
    const summaries: MembershipSummary[] = [];
    for (const row of rows) {
      const business = await identity.businessById(this.db, row.businessId);
      if (business) {
        summaries.push({
          businessId: row.businessId,
          businessName: business.name,
          role: row.role,
        });
      }
    }
    return summaries;
  }
}

/** Never log a whole number — the log store is not where identity should live. */
function redact(phone: string): string {
  return `${phone.slice(0, 7)}****${phone.slice(-2)}`;
}
