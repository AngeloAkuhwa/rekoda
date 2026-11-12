/**
 * The settlement process's configuration (OD-51.2): one database credential, the platform Paystack
 * key and the vault key, and a refusal, by name and never by value, of anything that belongs to
 * another process.
 */
import { describe, expect, it } from 'vitest';
import { loadSettlementConfig, SettlementConfigError } from './config.js';

const URL = 'postgres://rekoda_settlement:hunter2hunter2hunter2hunter2@postgres:5432/rekoda';
const PRODUCTION = {
  NODE_ENV: 'production',
  PORT: '3003',
  REKODA_RELEASE: 'staging-abc1234',
  SETTLEMENT_DATABASE_URL: URL,
  VAULT_KEY: 'a'.repeat(64),
  PAYSTACK_SECRET_KEY: 'sk_live_placeholder',
} as NodeJS.ProcessEnv;

describe('the settlement process configuration', () => {
  it('loads exactly what the production service is given', () => {
    const config = loadSettlementConfig({ ...PRODUCTION });
    expect(config).toMatchObject({
      port: 3003,
      isProduction: true,
      settlementDatabaseUrl: URL,
      paystackBaseUrl: 'https://api.paystack.co',
      planCatalogueReads: true,
      concurrency: 2,
    });
    /* Blank is how compose passes an optional name that .env does not set. */
    expect(
      loadSettlementConfig({
        ...PRODUCTION,
        REKODA_PLAN_CATALOGUE_READS: '',
        REKODA_SETTLEMENT_CONCURRENCY: '',
      }).concurrency,
    ).toBe(2);
  });

  it('requires its own credential and the vault key', () => {
    const { SETTLEMENT_DATABASE_URL: _, ...noUrl } = PRODUCTION;
    expect(() => loadSettlementConfig(noUrl)).toThrow(/SETTLEMENT_DATABASE_URL .* is required/);
    expect(() =>
      loadSettlementConfig({ ...PRODUCTION, SETTLEMENT_DATABASE_URL: 'mysql://x' }),
    ).toThrow(/must be a postgres:\/\/ URL/);
    expect(() => loadSettlementConfig({ ...PRODUCTION, VAULT_KEY: 'short' })).toThrow(/VAULT_KEY/);
  });

  it.each([
    'DATABASE_URL',
    'WORKER_DATABASE_URL',
    'OPERATOR_DATABASE_URL',
    'MATCH_KEY',
    'CONNECTION_KEY',
    'OTP_PEPPER',
    'REKODA_API_SECRET',
    'REKODA_OPERATOR_SECRET',
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
      loadSettlementConfig({ ...PRODUCTION, [name]: value });
    } catch (error) {
      expect(error).toBeInstanceOf(SettlementConfigError);
      message = (error as Error).message;
    }
    expect(message).toContain(`must not be given ${name}`);
    expect(message).not.toContain('topsecretvalue');
  });

  it('never accepts another credential under its own name', () => {
    for (const key of ['DATABASE_URL', 'WORKER_DATABASE_URL', 'OPERATOR_DATABASE_URL']) {
      expect(() => loadSettlementConfig({ ...PRODUCTION, NODE_ENV: 'test', [key]: URL })).toThrow(
        new RegExp(`must be its own credential, not ${key}`),
      );
    }
  });

  it('in production sends the Paystack key to Paystack only', () => {
    expect(() =>
      loadSettlementConfig({ ...PRODUCTION, PAYSTACK_BASE_URL: 'http://127.0.0.1:4010' }),
    ).toThrow(/PAYSTACK_BASE_URL must not be set in production/);
    expect(
      loadSettlementConfig({ ...PRODUCTION, PAYSTACK_BASE_URL: 'https://api.paystack.co' })
        .paystackBaseUrl,
    ).toBe('https://api.paystack.co');
    expect(
      loadSettlementConfig({
        ...PRODUCTION,
        NODE_ENV: 'test',
        PAYSTACK_BASE_URL: 'http://127.0.0.1:4010',
      }).paystackBaseUrl,
    ).toBe('http://127.0.0.1:4010');
  });

  it('parses its numbers and switches fail-closed', () => {
    for (const [key, value] of [
      ['PORT', '0'],
      ['PORT', '70000'],
      ['PORT', '3003x'],
      ['REKODA_SETTLEMENT_CONCURRENCY', '0'],
      ['REKODA_SETTLEMENT_CONCURRENCY', '17'],
      ['REKODA_SETTLEMENT_CONCURRENCY', '2.5'],
      ['REKODA_PLAN_CATALOGUE_READS', 'yes'],
      ['REKODA_RELEASE', 'has space'],
    ] as const) {
      expect(
        () => loadSettlementConfig({ ...PRODUCTION, [key]: value }),
        `${key}=${value}`,
      ).toThrow(SettlementConfigError);
    }
    expect(
      loadSettlementConfig({ ...PRODUCTION, REKODA_PLAN_CATALOGUE_READS: '0' }).planCatalogueReads,
    ).toBe(false);
  });

  it('tolerates a developer’s shared environment outside production', () => {
    expect(
      loadSettlementConfig({
        ...PRODUCTION,
        NODE_ENV: 'development',
        DATABASE_URL: 'postgres://rekoda_app@localhost:5432/rekoda',
        OTP_PEPPER: 'p'.repeat(40),
      }).isProduction,
    ).toBe(false);
  });
});
