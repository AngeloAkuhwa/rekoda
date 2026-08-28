/**
 * The seam between the API-key rules and the API-key rows (spec §27).
 *
 * Same division as `AuthService`: every rule comes from
 * `@rekoda/core/api-keys`, every row goes through a `@rekoda/db` repo, and
 * this file holds neither. What it does hold is the ORDER the checks happen
 * in, which is the security property worth reading twice:
 *
 *   shape → resolve → validity → entitlement → rate limit → month's meter
 *
 * Cheapest and least revealing first. A malformed bearer never reaches the
 * database; an unknown token never reaches the entitlement read; a key
 * belonging to a business without REKODA_API never spends rate-limit room;
 * and the MONTH's capacity is taken last, behind the per-minute ceiling, so
 * a flood cannot burn a merchant's month faster than that ceiling allows.
 */
import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  API_KEY_PREFIXES,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  MAX_LIVE_KEYS_PER_APPLICATION,
  issueApiKey,
  modeOfPrefix,
  type ApiKeyMode,
  parseApiKey,
  rateWindowStart,
  retryAfterSeconds,
  shouldTouch,
  validateApiKey,
} from '@rekoda/core/api-keys';
import type { RandomSource } from '@rekoda/core/identity';
import { usagePeriod } from '@rekoda/core';
import {
  apiKeysRepo,
  entitlementsRepo,
  identity,
  usageRepo,
  withBusiness,
  type Db,
  type TenantDb,
} from '@rekoda/db';
import type { ApiApplicationView, ApiKeyView, CreateApiKeyResponse } from '@rekoda/contracts';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import { meterAllowance } from '../billing/plan-terms.js';

/** Why a presented key was refused. The caller sees far less than this. */
export type ApiAuthFailure =
  | { reason: 'malformed' }
  | { reason: 'unknown' }
  | { reason: 'revoked' }
  | { reason: 'expired' }
  | { reason: 'application_disabled' }
  | { reason: 'not_entitled' }
  | { reason: 'rate_limited'; retryAfterSeconds: number }
  | { reason: 'quota_exhausted' };

/** Who the caller is, once the whole chain has said yes. */
export interface ApiCaller {
  keyId: string;
  businessId: string;
  applicationId: string;
  keyPrefix: string;
  /** `test` reads the same books and writes nothing (PR-114). */
  mode: ApiKeyMode;
  rateLimitPerMinute: number;
}

export type ApiAuthResult =
  { ok: true; caller: ApiCaller } | { ok: false; failure: ApiAuthFailure };

/** A mint refused, and the reason a merchant can act on. */
export type MintRefusal =
  | { reason: 'unknown_application' }
  | { reason: 'application_disabled' }
  | { reason: 'too_many_keys'; limit: number };

@Injectable()
export class ApiKeysService {
  private readonly random: RandomSource = (n) => randomBytes(n);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Authenticate a bearer token presented to the public API.
   *
   * The reservation is deliberately the LAST step and happens under the pin
   * the key itself resolved to. Counting a request against a business before
   * knowing the caller may act as that business would let an unauthorised
   * token spend a paying merchant's ceiling.
   */
  async authenticate(rawToken: string, now = new Date()): Promise<ApiAuthResult> {
    const parsed = parseApiKey(rawToken);
    if (!parsed) return { ok: false, failure: { reason: 'malformed' } };

    const key = await apiKeysRepo.resolve(this.db, parsed.tokenHash);
    if (!key) return { ok: false, failure: { reason: 'unknown' } };

    const verdict = validateApiKey(
      {
        expiresAt: key.expiresAt,
        revokedAt: key.revokedAt,
        applicationStatus: key.applicationStatus,
      },
      now,
    );
    if (verdict.status !== 'valid') return { ok: false, failure: { reason: verdict.status } };

    return withBusiness(this.db, key.businessId, async (tx) => {
      /* Spec §27: the API is a separate commercial entitlement, in no plan.
       * A key that authenticates for a business which never bought it is an
       * open door with a credential in front of it. */
      const refusal = await entitlementsRepo.requireEntitlement(tx, key.businessId, 'REKODA_API');
      if (refusal) return { ok: false, failure: { reason: 'not_entitled' } } as const;

      const windowStart = rateWindowStart(now);
      const reservation = await apiKeysRepo.reserveRequest(tx, {
        businessId: key.businessId,
        apiKeyId: key.id,
        windowStart,
        limit: key.rateLimitPerMinute,
      });
      if (!reservation.ok) {
        return {
          ok: false,
          failure: { reason: 'rate_limited', retryAfterSeconds: retryAfterSeconds(now) },
        } as const;
      }

      /* The month's capacity, last (spec §27: API usage is metered).
       *
       * A SANDBOX call is exempt. A merchant who bought the API bought it
       * to run their business, and a developer proving their wiring should
       * not be spending that month's capacity to do it — a sandbox that
       * costs real units is one nobody uses twice. The per-minute ceiling
       * still applies, so free does not mean unbounded.
       *
       * The plan allowance is ZERO on every plan, and that is canon rather
       * than an omission: §27 puts the API in no plan, so capacity is what
       * the API product credited as bonus for this month. `consumeUnit`
       * reads `allowance + bonus`, so a merchant who bought the product
       * spends what they bought and one who has not is refused here rather
       * than at some later, more expensive point. */
      const mode = modeOfPrefix(key.prefix) ?? 'live';
      if (mode === 'live') {
        const granted = await usageRepo.consumeUnit(
          tx,
          key.businessId,
          usagePeriod(now),
          'API_REQUEST_UNITS',
          await this.apiAllowance(tx, key.businessId, 'API_REQUEST_UNITS'),
        );
        if (!granted) return { ok: false, failure: { reason: 'quota_exhausted' } } as const;
      }

      /* Housekeeping rides the request that earned it: the closed windows
       * for this one key, and `last_used_at` at most once a minute. Both are
       * bounded by the key already in hand, so neither becomes a sweep. */
      await apiKeysRepo.pruneWindows(tx, key.businessId, key.id, windowStart);
      if (shouldTouch(key.lastUsedAt, now)) {
        await apiKeysRepo.touch(tx, key.businessId, key.id, now);
      }

      return {
        ok: true,
        caller: {
          keyId: key.id,
          businessId: key.businessId,
          applicationId: key.applicationId,
          keyPrefix: key.prefix,
          mode,
          rateLimitPerMinute: key.rateLimitPerMinute,
        },
      } as const;
    });
  }

  /**
   * Register an application, if the merchant has room for another.
   *
   * `API_APPLICATIONS` is a count of things that EXIST rather than a tally
   * of events, so the unit is spent when one is registered and is not given
   * back: the month it was created in is the month it was sold in, which is
   * how every other exhaustible unit behaves.
   */
  async registerApplication(
    businessId: string,
    name: string,
    now = new Date(),
  ): Promise<ApiApplicationView | { reason: 'quota_exhausted' }> {
    return withBusiness(this.db, businessId, async (tx) => {
      const granted = await usageRepo.consumeUnit(
        tx,
        businessId,
        usagePeriod(now),
        'API_APPLICATIONS',
        await this.apiAllowance(tx, businessId, 'API_APPLICATIONS'),
      );
      if (!granted) return { reason: 'quota_exhausted' } as const;

      return viewApplication(await apiKeysRepo.createApplication(tx, { businessId, name }));
    });
  }

  /**
   * What this business may spend of an API unit this month.
   *
   * Through the same catalogue seam every other meter reads, so a
   * grandfathered merchant is judged by the terms they were sold. Today
   * every plan sells zero of these three, which §27 requires; the figure
   * that matters is the bonus the API product credits.
   */
  private apiAllowance(
    tx: TenantDb,
    businessId: string,
    unit: 'API_REQUEST_UNITS' | 'API_APPLICATIONS',
  ): Promise<number> {
    return usageRepo
      .planFor(tx, businessId)
      .then((plan) => meterAllowance(this.config, tx, businessId, plan, unit));
  }

  async listApplications(
    businessId: string,
  ): Promise<{ applications: ApiApplicationView[]; keys: ApiKeyView[] }> {
    return withBusiness(this.db, businessId, async (tx) => {
      const applications = await apiKeysRepo.applicationsFor(tx, businessId);
      const keys = await apiKeysRepo.keysFor(tx, businessId);
      return { applications: applications.map(viewApplication), keys: keys.map(viewKey) };
    });
  }

  /**
   * Mint a key and hand back the token exactly once.
   *
   * The cap is checked inside the same transaction as the insert, so two
   * simultaneous mints cannot both read "four live" and both write a fifth.
   */
  async mintKey(
    businessId: string,
    applicationId: string,
    input: { label: string | null; expiresAt: Date | null; mode: ApiKeyMode },
    now = new Date(),
  ): Promise<CreateApiKeyResponse | MintRefusal> {
    return withBusiness(this.db, businessId, async (tx) => {
      const application = await apiKeysRepo.applicationById(tx, businessId, applicationId);
      if (!application) return { reason: 'unknown_application' } as const;
      if (application.status !== 'active') return { reason: 'application_disabled' } as const;

      /* The cap is per WORLD: four test keys must not stop a rotation of
       * the live one. */
      const live = await apiKeysRepo.liveKeyCount(
        tx,
        businessId,
        applicationId,
        now,
        API_KEY_PREFIXES[input.mode],
      );
      if (live >= MAX_LIVE_KEYS_PER_APPLICATION) {
        return { reason: 'too_many_keys', limit: MAX_LIVE_KEYS_PER_APPLICATION } as const;
      }

      const issued = issueApiKey(this.random, input.mode);
      const row = await apiKeysRepo.insertKey(tx, {
        businessId,
        applicationId,
        prefix: issued.prefix,
        tokenHash: issued.tokenHash,
        label: input.label,
        rateLimitPerMinute: DEFAULT_RATE_LIMIT_PER_MINUTE,
        expiresAt: input.expiresAt,
      });
      return { key: viewKey(row), token: issued.token };
    });
  }

  async revokeKey(businessId: string, keyId: string, now = new Date()): Promise<boolean> {
    return withBusiness(this.db, businessId, (tx) =>
      apiKeysRepo.revokeKey(tx, businessId, keyId, now),
    );
  }

  async setApplicationStatus(
    businessId: string,
    applicationId: string,
    status: 'active' | 'disabled',
  ): Promise<boolean> {
    return withBusiness(this.db, businessId, (tx) =>
      apiKeysRepo.setApplicationStatus(tx, businessId, applicationId, status),
    );
  }

  /** The business a key speaks for, by name. Read under the caller's own pin. */
  async businessName(businessId: string): Promise<string | null> {
    const business = await identity.businessById(this.db, businessId);
    return business?.name ?? null;
  }
}

function viewApplication(row: apiKeysRepo.ApiApplication): ApiApplicationView {
  return {
    id: row.id,
    name: row.name,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    createdAt: row.createdAt.toISOString(),
  };
}

function viewKey(row: apiKeysRepo.ApiKeyRow): ApiKeyView {
  return {
    id: row.id,
    applicationId: row.applicationId,
    prefix: row.prefix,
    mode: modeOfPrefix(row.prefix) ?? 'live',
    label: row.label,
    rateLimitPerMinute: row.rateLimitPerMinute,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
