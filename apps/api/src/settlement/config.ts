/**
 * The configuration of the dedicated settlement process (OD-51.2).
 *
 * This process exists so that the general background worker never holds the settlement database
 * credential: a compromised worker (the process that reads provider data, renders documents and
 * talks to Meta and the model providers) can then no longer record a payment, apply a paid plan
 * or credit a pack. It holds exactly one database credential (`SETTLEMENT_DATABASE_URL`, the
 * `rekoda_settlement` role), the platform Paystack key it verifies every payment with, and the
 * vault key that opens a stored webhook event. It runs two job kinds and serves no public route.
 *
 * Deliberately not `loadConfig`: that one describes the API and the worker and requires their
 * secrets. None of the others belongs here, and in production their presence is refused.
 */
const PAYSTACK_API = 'https://api.paystack.co';
const NON_PRODUCTION_ENVS = new Set(['development', 'test']);

/** A configuration this process refuses to start with. The message never carries a value. */
export class SettlementConfigError extends Error {}

export interface SettlementProcessConfig {
  /** The loopback port of the health check; nothing else listens. */
  port: number;
  release: string;
  commit: string;
  isProduction: boolean;
  settlementDatabaseUrl: string;
  /** Empty means not configured: a verify then answers "not found" and nothing settles. */
  paystackSecretKey: string;
  paystackBaseUrl: string;
  /** Opens the sealed webhook event a `billing.process` job names. */
  vaultKey: string;
  /** This process's own setting, checked against the pricing source in force at start (0215). */
  planCatalogueReads: boolean;
  concurrency: number;
}

/** Credentials and keys that belong to OTHER processes; this one must not be handed any. */
const FOREIGN_SECRETS = [
  'DATABASE_URL',
  'WORKER_DATABASE_URL',
  'OPERATOR_DATABASE_URL',
  'MATCH_KEY',
  'CONNECTION_KEY',
  'OTP_PEPPER',
  'REKODA_API_SECRET',
  'REKODA_OPERATOR_SECRET',
  'MONO_SECRET_KEY',
  'META_APP_SECRET',
  'META_ACCESS_TOKEN',
  'META_VERIFY_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SECRET',
] as const;

function label(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key];
  if (!value) return fallback;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
    throw new SettlementConfigError(
      `${key} must be 1 to 64 letters, digits, dots, dashes or underscores`,
    );
  }
  return value;
}

function wholeNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new SettlementConfigError(`${key} must be a whole number from ${min} to ${max}`);
  }
  return Number(raw);
}

export function loadSettlementConfig(
  env: NodeJS.ProcessEnv = process.env,
): SettlementProcessConfig {
  const nodeEnv = env['NODE_ENV'];
  const isProduction = nodeEnv !== undefined && nodeEnv !== '' && !NON_PRODUCTION_ENVS.has(nodeEnv);

  const settlementDatabaseUrl = env['SETTLEMENT_DATABASE_URL'];
  if (!settlementDatabaseUrl) {
    throw new SettlementConfigError(
      'SETTLEMENT_DATABASE_URL (the rekoda_settlement role) is required: Rekoda charges are settled only under it',
    );
  }
  if (!/^postgres(ql)?:\/\//.test(settlementDatabaseUrl)) {
    throw new SettlementConfigError('SETTLEMENT_DATABASE_URL must be a postgres:// URL');
  }

  /* One database credential, and no secret that belongs to another process. In production a
   * foreign secret here is a deployment mistake that would quietly undo the separation, so it is
   * refused by name (never by value). Elsewhere a developer's shared .env is tolerated. */
  if (isProduction) {
    const foreign = FOREIGN_SECRETS.filter((key) => (env[key] ?? '') !== '');
    if (foreign.length > 0) {
      throw new SettlementConfigError(
        `the settlement process must not be given ${foreign.join(', ')}: it holds the settlement credential, the platform Paystack key and the vault key, and nothing else (OD-51)`,
      );
    }
  }
  for (const key of ['DATABASE_URL', 'WORKER_DATABASE_URL', 'OPERATOR_DATABASE_URL'] as const) {
    if (env[key] && env[key] === settlementDatabaseUrl) {
      throw new SettlementConfigError(
        `SETTLEMENT_DATABASE_URL must be its own credential, not ${key}`,
      );
    }
  }

  const vaultKey = env['VAULT_KEY'] ?? '';
  if (!/^[0-9a-f]{64}$/i.test(vaultKey)) {
    throw new SettlementConfigError('VAULT_KEY must be 64 hex characters (openssl rand -hex 32)');
  }

  /* Every verify carries the secret key, so in production the host is the provider's own. */
  const base = env['PAYSTACK_BASE_URL']?.trim();
  if (base && isProduction && base !== PAYSTACK_API) {
    throw new SettlementConfigError(
      `PAYSTACK_BASE_URL must not be set in production: it points the provider's requests, and the secret key they carry, at a host other than ${PAYSTACK_API}. Remove it.`,
    );
  }

  const reads = env['REKODA_PLAN_CATALOGUE_READS'];
  if (reads !== undefined && reads !== '' && reads !== '0' && reads !== '1') {
    throw new SettlementConfigError('REKODA_PLAN_CATALOGUE_READS must be 1 (the default) or 0');
  }

  return {
    /* 0 (any free port) is for tests; a production health check needs the one it is told. */
    port: wholeNumber(env, 'PORT', 3003, isProduction ? 1 : 0, 65535),
    release: label(env, 'REKODA_RELEASE', 'unversioned'),
    commit: label(env, 'REKODA_COMMIT', 'unknown'),
    isProduction,
    settlementDatabaseUrl,
    paystackSecretKey: env['PAYSTACK_SECRET_KEY'] ?? '',
    paystackBaseUrl: base || PAYSTACK_API,
    vaultKey,
    planCatalogueReads: reads !== '0',
    concurrency: wholeNumber(env, 'REKODA_SETTLEMENT_CONCURRENCY', 2, 1, 16),
  };
}
