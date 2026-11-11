/**
 * OD-37 (migration 0202) and OD-51 (0209): the settlement and billing-operator credentials. Each is
 * required where it is used (settlement in the worker, the operator in the API), never silently
 * replaced by the application credential, and never the same string as a general credential. The
 * API process holds no settlement credential.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { BASE, SETTLEMENT_URL } from './env.fixtures.js';

const WORKER = {
  ...BASE,
  REKODA_WORKER: '1',
  WORKER_DATABASE_URL: 'postgres://rekoda_worker@127.0.0.1:5432/x',
  SETTLEMENT_DATABASE_URL: SETTLEMENT_URL,
} as NodeJS.ProcessEnv;

describe('the OD-37 principals in configuration', () => {
  it('a worker loads the settlement URL as given; an API process holds none (OD-51)', () => {
    expect(loadConfig({ ...WORKER }).settlementDatabaseUrl).toBe(SETTLEMENT_URL);
    const api = loadConfig({ ...BASE });
    expect(api.settlementDatabaseUrl).toBeNull();
    expect(api.operatorDatabaseUrl).toBe(BASE['OPERATOR_DATABASE_URL']);
  });

  it('refuses a worker process without the settlement credential', () => {
    const { SETTLEMENT_DATABASE_URL: _, ...without } = WORKER;
    expect(() => loadConfig(without)).toThrow(/SETTLEMENT_DATABASE_URL .* is required/);
    expect(() => loadConfig({ ...without, SETTLEMENT_DATABASE_URL: '' })).toThrow(
      /SETTLEMENT_DATABASE_URL .* is required/,
    );
  });

  it('an API process needs no settlement credential, and a production API given one refuses to start (OD-51)', () => {
    expect(
      loadConfig({ ...BASE, SETTLEMENT_DATABASE_URL: SETTLEMENT_URL }).settlementDatabaseUrl,
    ).toBeNull();
    const prodApi = {
      ...BASE,
      SETTLEMENT_DATABASE_URL: SETTLEMENT_URL,
      NODE_ENV: 'production',
      META_APP_SECRET: 'm'.repeat(40),
      META_VERIFY_TOKEN: 'v'.repeat(40),
      OPERATOR_OIDC_ISSUER: 'https://issuer.example.com',
      OPERATOR_OIDC_AUDIENCE: 'rekoda-ops',
      OPERATOR_OIDC_JWKS_URL: 'https://issuer.example.com/jwks',
      REKODA_TRUSTED_PROXIES: '172.30.10.10',
      REKODA_TRUSTED_WEB: '172.30.10.11',
    } as NodeJS.ProcessEnv;
    expect(() => loadConfig(prodApi)).toThrow(
      /SETTLEMENT_DATABASE_URL must not be set for an API process/,
    );
    expect(
      loadConfig({ ...prodApi, SETTLEMENT_DATABASE_URL: '' }).settlementDatabaseUrl,
    ).toBeNull();
  });

  it('refuses an API process without the operator credential; a worker needs none', () => {
    const { OPERATOR_DATABASE_URL: _, ...api } = BASE;
    expect(() => loadConfig(api)).toThrow(/OPERATOR_DATABASE_URL/);
    const { OPERATOR_DATABASE_URL: __, ...worker } = WORKER;
    expect(loadConfig(worker).operatorDatabaseUrl).toBeNull();
    // The production worker service blanks it (docker-compose.prod.yml): blank reads as absent.
    expect(loadConfig({ ...WORKER, OPERATOR_DATABASE_URL: '' }).operatorDatabaseUrl).toBeNull();
  });

  it('never accepts a general credential in place of a principal (no silent fallback)', () => {
    for (const key of ['SETTLEMENT_DATABASE_URL', 'OPERATOR_DATABASE_URL']) {
      expect(() => loadConfig({ ...WORKER, [key]: WORKER['DATABASE_URL'] })).toThrow(
        new RegExp(`${key} must be its own credential`),
      );
      expect(() => loadConfig({ ...WORKER, [key]: WORKER['WORKER_DATABASE_URL'] })).toThrow(
        new RegExp(`${key} must be its own credential`),
      );
    }
  });
});
