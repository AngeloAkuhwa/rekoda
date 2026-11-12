/**
 * The operator process's configuration (OD-51.1): one database credential, its OWN token audience,
 * and a refusal, by name and never by value, of anything that belongs to another process.
 */
import { describe, expect, it } from 'vitest';
import { loadOperatorConfig, OperatorConfigError } from './config.js';

const URL = 'postgres://rekoda_billing_operator:hunter2hunter2hunter2hunter2@postgres:5432/rekoda';
const PRODUCTION = {
  NODE_ENV: 'production',
  PORT: '3002',
  REKODA_RELEASE: 'staging-abc1234',
  OPERATOR_DATABASE_URL: URL,
  OPERATOR_OIDC_ISSUER: 'https://idp.rekoda.app/',
  OPERATOR_OIDC_JWKS_URL: 'https://idp.rekoda.app/.well-known/jwks.json',
  OPERATOR_BILLING_OIDC_AUDIENCE: 'rekoda-operator-billing',
  OPERATOR_OIDC_AUDIENCE: 'rekoda-operator-plane',
  OPERATOR_OIDC_SCOPE_CLAIM: '',
} as NodeJS.ProcessEnv;

describe('the operator process configuration', () => {
  it('loads exactly what the production service is given, with its own audience', () => {
    const config = loadOperatorConfig({ ...PRODUCTION });
    expect(config).toMatchObject({
      port: 3002,
      host: '0.0.0.0',
      isProduction: true,
      operatorDatabaseUrl: URL,
      operatorSecret: null,
    });
    expect(config.operatorAuth).toEqual({
      issuer: 'https://idp.rekoda.app/',
      audience: 'rekoda-operator-billing',
      jwksUrl: 'https://idp.rekoda.app/.well-known/jwks.json',
      scopeClaim: 'scope',
      exclusiveAudience: true,
    });
  });

  it('requires its own credential', () => {
    const { OPERATOR_DATABASE_URL: _, ...noUrl } = PRODUCTION;
    expect(() => loadOperatorConfig(noUrl)).toThrow(/OPERATOR_DATABASE_URL .* is required/);
    expect(() => loadOperatorConfig({ ...PRODUCTION, OPERATOR_DATABASE_URL: 'mysql://x' })).toThrow(
      /must be a postgres:\/\/ URL/,
    );
  });

  it('in production requires a verified identity with an audience of its own', () => {
    const {
      OPERATOR_OIDC_ISSUER: _i,
      OPERATOR_OIDC_JWKS_URL: _j,
      OPERATOR_BILLING_OIDC_AUDIENCE: _a,
      ...none
    } = PRODUCTION;
    expect(() => loadOperatorConfig(none)).toThrow(/needs a verified identity in production/);
    const { OPERATOR_BILLING_OIDC_AUDIENCE: _b, ...noAudience } = PRODUCTION;
    expect(() => loadOperatorConfig(noAudience)).toThrow(/needs all of/);
    /* The API's audience is not this process's: a token the API accepts must not change a plan. */
    expect(() =>
      loadOperatorConfig({
        ...PRODUCTION,
        OPERATOR_BILLING_OIDC_AUDIENCE: PRODUCTION['OPERATOR_OIDC_AUDIENCE'],
      }),
    ).toThrow(/must differ from OPERATOR_OIDC_AUDIENCE/);
    expect(() =>
      loadOperatorConfig({ ...PRODUCTION, OPERATOR_OIDC_JWKS_URL: 'http://idp.rekoda.app/jwks' }),
    ).toThrow(/OPERATOR_OIDC_JWKS_URL must be an https URL/);
    expect(() =>
      loadOperatorConfig({ ...PRODUCTION, OPERATOR_OIDC_ISSUER: 'https://127.0.0.1/' }),
    ).toThrow(/must be a public https URL in production/);
  });

  it('refuses the development secret in production, and a short one anywhere', () => {
    expect(() =>
      loadOperatorConfig({ ...PRODUCTION, REKODA_OPERATOR_SECRET: 's'.repeat(40) }),
    ).toThrow(/development stand-in/);
    expect(() =>
      loadOperatorConfig({
        NODE_ENV: 'test',
        OPERATOR_DATABASE_URL: URL,
        REKODA_OPERATOR_SECRET: 'x',
      }),
    ).toThrow(/at least 32 characters/);
    const dev = loadOperatorConfig({
      NODE_ENV: 'test',
      OPERATOR_DATABASE_URL: URL,
      REKODA_OPERATOR_SECRET: 's'.repeat(40),
    });
    expect(dev).toMatchObject({ host: '127.0.0.1', operatorAuth: null, isProduction: false });
  });

  it.each([
    'DATABASE_URL',
    'WORKER_DATABASE_URL',
    'SETTLEMENT_DATABASE_URL',
    'VAULT_KEY',
    'MATCH_KEY',
    'CONNECTION_KEY',
    'OTP_PEPPER',
    'REKODA_API_SECRET',
    'PAYSTACK_SECRET_KEY',
    'META_APP_SECRET',
    'META_ACCESS_TOKEN',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'MONO_SECRET_KEY',
    'RESEND_API_KEY',
  ])('in production refuses %s, which belongs to another process', (name) => {
    const value = 'postgres://someone:topsecretvalue@postgres:5432/rekoda';
    let message = '';
    try {
      loadOperatorConfig({ ...PRODUCTION, [name]: value });
    } catch (error) {
      expect(error).toBeInstanceOf(OperatorConfigError);
      message = (error as Error).message;
    }
    expect(message).toContain(`must not be given ${name}`);
    expect(message).not.toContain('topsecretvalue');
  });

  it('never accepts another credential under its own name', () => {
    for (const key of ['DATABASE_URL', 'WORKER_DATABASE_URL', 'SETTLEMENT_DATABASE_URL']) {
      expect(() => loadOperatorConfig({ ...PRODUCTION, NODE_ENV: 'test', [key]: URL })).toThrow(
        new RegExp(`must be its own credential, not ${key}`),
      );
    }
  });

  it('parses its port fail-closed', () => {
    for (const value of ['0', '70000', '3002x']) {
      expect(() => loadOperatorConfig({ ...PRODUCTION, PORT: value }), value).toThrow(
        OperatorConfigError,
      );
    }
  });
});
