/**
 * The configuration of the dedicated operator process (OD-51.1).
 *
 * This process exists so that the general API never holds the billing-operator database
 * credential: a compromised API can then no longer give a business a plan. It holds exactly one
 * database credential (`OPERATOR_DATABASE_URL`, the `rekoda_billing_operator` role) and verifies
 * the operator's identity ITSELF, against its OWN token audience, so nothing the API can see or
 * say is an authority here. There is no secret shared with the API.
 *
 * Deliberately not `loadConfig`: that one describes the API and the worker and requires their
 * secrets (the vault key, the OTP pepper, provider keys). None of them belongs in this process,
 * and in production their presence is refused rather than ignored.
 */
import type { OperatorAuthConfig } from '../auth/operator-identity.js';

/** A configuration this process refuses to start with. The message never carries a value. */
export class OperatorConfigError extends Error {}

export interface OperatorProcessConfig {
  port: number;
  /** The interface to listen on. The compose network in production; loopback elsewhere. */
  host: string;
  release: string;
  commit: string;
  isProduction: boolean;
  operatorDatabaseUrl: string;
  /** The verified path: this process's own audience. Null only outside production. */
  operatorAuth: OperatorAuthConfig | null;
  /** The development stand-in; refused in production. */
  operatorSecret: string | null;
}

const NON_PRODUCTION_ENVS = new Set(['development', 'test']);

/** Credentials and keys that belong to OTHER processes; this one must not be handed any. */
const FOREIGN_SECRETS = [
  'DATABASE_URL',
  'WORKER_DATABASE_URL',
  'SETTLEMENT_DATABASE_URL',
  'VAULT_KEY',
  'MATCH_KEY',
  'CONNECTION_KEY',
  'OTP_PEPPER',
  'REKODA_API_SECRET',
  'PAYSTACK_SECRET_KEY',
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
    throw new OperatorConfigError(
      `${key} must be 1 to 64 letters, digits, dots, dashes or underscores`,
    );
  }
  return value;
}

function port(env: NodeJS.ProcessEnv, isProduction: boolean): number {
  const raw = env['PORT'];
  if (raw === undefined || raw === '') return 3002;
  /* 0 (any free port) is for tests; in production Caddy needs the one it is told. */
  const min = isProduction ? 1 : 0;
  if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) < min || Number(raw) > 65535) {
    throw new OperatorConfigError(`PORT must be a whole number from ${min} to 65535`);
  }
  return Number(raw);
}

function httpsUrl(name: string, value: string, isProduction: boolean): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OperatorConfigError(`${name} must be an https URL`);
  }
  if (url.protocol !== 'https:') throw new OperatorConfigError(`${name} must be an https URL`);
  /* A local identity provider would let whoever runs it sign operator tokens (G-72). */
  if (
    isProduction &&
    /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|0\.0\.0\.0)/.test(
      url.hostname,
    )
  ) {
    throw new OperatorConfigError(`${name} must be a public https URL in production`);
  }
}

export function loadOperatorConfig(env: NodeJS.ProcessEnv = process.env): OperatorProcessConfig {
  const nodeEnv = env['NODE_ENV'];
  const isProduction = nodeEnv !== undefined && nodeEnv !== '' && !NON_PRODUCTION_ENVS.has(nodeEnv);

  const operatorDatabaseUrl = env['OPERATOR_DATABASE_URL'];
  if (!operatorDatabaseUrl) {
    throw new OperatorConfigError(
      'OPERATOR_DATABASE_URL (the rekoda_billing_operator role) is required: the operator process runs plan changes only under it',
    );
  }
  if (!/^postgres(ql)?:\/\//.test(operatorDatabaseUrl)) {
    throw new OperatorConfigError('OPERATOR_DATABASE_URL must be a postgres:// URL');
  }

  /* One credential, and nothing that belongs to another process. In production a foreign secret
   * in this environment is a deployment mistake that would quietly undo the separation, so it is
   * refused by name (never by value). Elsewhere a developer's shared .env is tolerated. */
  if (isProduction) {
    const foreign = FOREIGN_SECRETS.filter((key) => (env[key] ?? '') !== '');
    if (foreign.length > 0) {
      throw new OperatorConfigError(
        `the operator process must not be given ${foreign.join(', ')}: it holds the billing-operator credential and nothing else (OD-51)`,
      );
    }
  }
  for (const key of ['DATABASE_URL', 'WORKER_DATABASE_URL', 'SETTLEMENT_DATABASE_URL'] as const) {
    if (env[key] && env[key] === operatorDatabaseUrl) {
      throw new OperatorConfigError(`OPERATOR_DATABASE_URL must be its own credential, not ${key}`);
    }
  }

  const issuer = env['OPERATOR_OIDC_ISSUER'];
  const jwksUrl = env['OPERATOR_OIDC_JWKS_URL'];
  /* This process's OWN audience. A token minted for the API (`OPERATOR_OIDC_AUDIENCE`) is not a
   * token for plan changes: the API sees those tokens on every other operator route, and one it
   * could replay here would make the API an authority again. */
  const audience = env['OPERATOR_BILLING_OIDC_AUDIENCE'];
  const present = [issuer, jwksUrl, audience].filter(Boolean).length;
  let operatorAuth: OperatorAuthConfig | null = null;
  if (present === 0) {
    if (isProduction) {
      throw new OperatorConfigError(
        'the operator process needs a verified identity in production: set OPERATOR_OIDC_ISSUER, ' +
          'OPERATOR_OIDC_JWKS_URL and OPERATOR_BILLING_OIDC_AUDIENCE',
      );
    }
  } else if (present < 3) {
    throw new OperatorConfigError(
      'operator identity needs all of OPERATOR_OIDC_ISSUER, OPERATOR_OIDC_JWKS_URL and ' +
        'OPERATOR_BILLING_OIDC_AUDIENCE, or none of them',
    );
  } else {
    httpsUrl('OPERATOR_OIDC_ISSUER', issuer!, isProduction);
    httpsUrl('OPERATOR_OIDC_JWKS_URL', jwksUrl!, isProduction);
    if (audience === env['OPERATOR_OIDC_AUDIENCE']) {
      throw new OperatorConfigError(
        'OPERATOR_BILLING_OIDC_AUDIENCE must differ from OPERATOR_OIDC_AUDIENCE: a token the API accepts must not be accepted for plan changes (OD-51)',
      );
    }
    operatorAuth = {
      issuer: issuer!,
      audience: audience!,
      jwksUrl: jwksUrl!,
      /* Blank is how the compose file passes a name .env does not set: it means the default. */
      scopeClaim: env['OPERATOR_OIDC_SCOPE_CLAIM'] || 'scope',
      /* A token that also names the API's audience could be replayed by the API (OD-51.1). */
      exclusiveAudience: true,
    };
  }

  const secret = env['REKODA_OPERATOR_SECRET'];
  let operatorSecret: string | null = null;
  if (secret) {
    if (isProduction) {
      throw new OperatorConfigError(
        'REKODA_OPERATOR_SECRET is a development stand-in and must not be set in production; the operator process uses OPERATOR_OIDC_* there',
      );
    }
    if (secret.length < 32) {
      throw new OperatorConfigError('REKODA_OPERATOR_SECRET must be at least 32 characters');
    }
    operatorSecret = secret;
  }

  return {
    port: port(env, isProduction),
    host: env['REKODA_OPERATOR_HOST'] || (isProduction ? '0.0.0.0' : '127.0.0.1'),
    release: label(env, 'REKODA_RELEASE', 'unversioned'),
    commit: label(env, 'REKODA_COMMIT', 'unknown'),
    isProduction,
    operatorDatabaseUrl,
    operatorAuth,
    operatorSecret,
  };
}
