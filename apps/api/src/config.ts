/**
 * Environment, validated once at boot.
 *
 * A misconfigured deployment must fail on startup with the name of the missing
 * variable, not at 2am on a merchant's first OTP. Every secret here has a
 * minimum length because a short one is a configuration mistake wearing a
 * valid-looking value.
 */
export interface ApiConfig {
  port: number;
  databaseUrl: string;
  /** Server-side pepper for OTP hashing. Never stored beside the hash. */
  otpPepper: string;
  /** Signs setup grants and session-adjacent artefacts. */
  secret: string;
  /**
   * Returns the OTP in the API response. Development and end-to-end tests
   * only — refused outright when NODE_ENV is production, because the failure
   * mode is handing every caller a working credential for any number.
   */
  revealOtp: boolean;
  corsOrigins: string[];
  /** Requests per IP per minute. See the note in main.ts. */
  rateLimitMax: number;
  /** AES-256-GCM key for the identity vault and for sealed event payloads. */
  vaultKey: string;
  /** Keyed HMAC for deterministic identity matching. NOT the vault key. */
  matchKey: string;
  /** Verifies X-Hub-Signature-256 on the Meta webhook. */
  metaAppSecret: string;
  /** Echoed back during Meta's GET subscription handshake. */
  metaVerifyToken: string;
  /**
   * `rekoda_worker` credentials — the only role allowed to claim a job before
   * its tenant is known (migration 0004). Null when this process is not a
   * worker.
   */
  workerDatabaseUrl: string | null;
  /** Whether this process polls the queue as well as serving requests. */
  workerEnabled: boolean;
  /** Empty means "behave as if the provider is down" — see ai.module.ts. */
  anthropicApiKey: string;
  aiModelDefault: string;
  /** Daily ceilings. The thing on the other side of these is a bill. */
  aiCallsPerBusinessPerDay: number;
  aiCallsGlobalPerDay: number;
  /** Recorded on every usage row, so a past cost is never re-derived. */
  planningFxNairaPerUsd: number;
  /** Sends replies. Empty means replies are recorded but not delivered. */
  metaAccessToken: string;
  metaPhoneNumberId: string;
  metaGraphVersion: string;
  /**
   * USD micros per in-window service reply. Zero today — Meta does not charge
   * for them yet — and chargeable from 1 October 2026, at which point this is
   * the one number that needs changing.
   */
  metaServiceReplyCostMicros: number;
}

class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, key: string, minLength = 0): string {
  const value = env[key];
  if (!value) throw new ConfigError(`${key} is required`);
  if (value.length < minLength) {
    throw new ConfigError(`${key} must be at least ${minLength} characters`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const isProduction = env['NODE_ENV'] === 'production';

  const revealOtp = env['REKODA_REVEAL_OTP'] === '1';
  if (revealOtp && isProduction) {
    throw new ConfigError(
      'REKODA_REVEAL_OTP must never be set in production — it returns live OTP codes to any caller',
    );
  }

  const workerEnabled = env['REKODA_WORKER'] === '1';
  if (workerEnabled && !env['WORKER_DATABASE_URL']) {
    throw new ConfigError('REKODA_WORKER=1 requires WORKER_DATABASE_URL (the rekoda_worker role)');
  }

  return {
    port: Number(env['PORT'] ?? 3001),
    databaseUrl: required(env, 'DATABASE_URL'),
    otpPepper: required(env, 'OTP_PEPPER', 32),
    secret: required(env, 'REKODA_API_SECRET', 32),
    revealOtp,
    /**
     * Both required everywhere, not just in production. A deployment without
     * them cannot store a customer identity or read an inbound message, so
     * "optional in development" would only mean discovering that at the first
     * real message instead of at boot. 64 hex characters = 32 bytes, which is
     * what `openssl rand -hex 32` produces and what AES-256 needs.
     */
    vaultKey: required(env, 'VAULT_KEY', 64),
    matchKey: required(env, 'MATCH_KEY', 64),
    corsOrigins: (env['REKODA_CORS_ORIGINS'] ?? 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Raised by the integration suite, which legitimately makes a few hundred
    // requests from one address in well under a minute.
    rateLimitMax: Number(env['REKODA_RATE_LIMIT_MAX'] ?? 60),
    /**
     * Required in production, optional elsewhere. An empty secret makes
     * `verifyMetaSignature` return false for everything, so a misconfigured
     * deployment rejects webhooks rather than accepting unsigned ones — the
     * safe direction to fail.
     */
    metaAppSecret: isProduction
      ? required(env, 'META_APP_SECRET', 16)
      : (env['META_APP_SECRET'] ?? ''),
    metaVerifyToken: isProduction
      ? required(env, 'META_VERIFY_TOKEN', 16)
      : (env['META_VERIFY_TOKEN'] ?? ''),
    /**
     * No fallback to DATABASE_URL, deliberately. The obvious convenience —
     * "use the app connection if no worker one is set" — would hand the runner
     * a role with no cross-tenant claim policy, so the queue would appear
     * permanently empty and jobs would pile up silently. Worse, in an
     * environment where DATABASE_URL happens to be the owner, it would hand
     * the runner BYPASSRLS. Absent means absent.
     */
    workerDatabaseUrl: env['WORKER_DATABASE_URL'] ?? null,
    workerEnabled,
    /**
     * Optional, deliberately. The deterministic router answers most messages
     * without a model, so a missing key degrades the product rather than
     * breaking it — and a developer running the web app to look at a page
     * should not need an Anthropic account.
     */
    anthropicApiKey: env['ANTHROPIC_API_KEY'] ?? '',
    aiModelDefault: env['AI_MODEL_DEFAULT'] ?? 'claude-sonnet-latest',
    /**
     * Defaults are a ceiling, not a target. At ~₦8 a call (pricing-model.md),
     * 60 per merchant is about ₦480 a day against a subscription, and 5,000
     * platform-wide bounds the worst day this product can have to roughly
     * ₦40,000 — a number that can be absorbed while someone investigates,
     * rather than discovered on an invoice.
     */
    aiCallsPerBusinessPerDay: Number(env['AI_DAILY_CALLS_PER_BUSINESS'] ?? 60),
    aiCallsGlobalPerDay: Number(env['AI_DAILY_CALLS_GLOBAL'] ?? 5_000),
    planningFxNairaPerUsd: Number(env['PLANNING_FX_NGN_PER_USD'] ?? 1_450),
    metaAccessToken: env['META_ACCESS_TOKEN'] ?? '',
    metaPhoneNumberId: env['META_PHONE_NUMBER_ID'] ?? '',
    metaGraphVersion: env['META_GRAPH_VERSION'] ?? 'v21.0',
    metaServiceReplyCostMicros: Number(env['META_SERVICE_REPLY_COST_MICROS'] ?? 0),
  };
}

export const CONFIG = Symbol('ApiConfig');
