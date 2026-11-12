/**
 * OD-37 (migration 0202) and OD-51 (0217): the settlement and billing-operator credentials in the
 * API and worker configuration. In production neither process may hold either one: settlement and
 * operator plan changes each run in their own process, on their own credential. Outside production
 * a single process may be handed them, and is never handed a general credential in their place.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { BASE, OPERATOR_URL, SETTLEMENT_URL } from './env.fixtures.js';

const WORKER = {
  ...BASE,
  REKODA_WORKER: '1',
  WORKER_DATABASE_URL: 'postgres://rekoda_worker@127.0.0.1:5432/x',
} as NodeJS.ProcessEnv;

const PRODUCTION = {
  NODE_ENV: 'production',
  META_APP_SECRET: 'm'.repeat(40),
  META_VERIFY_TOKEN: 'v'.repeat(40),
  OPERATOR_OIDC_ISSUER: 'https://issuer.example.com',
  OPERATOR_OIDC_AUDIENCE: 'rekoda-ops',
  OPERATOR_OIDC_JWKS_URL: 'https://issuer.example.com/jwks',
  REKODA_TRUSTED_PROXIES: '172.30.10.10',
  REKODA_TRUSTED_WEB: '172.30.10.11',
} as NodeJS.ProcessEnv;

describe('the privileged principals in the API and worker configuration (OD-51)', () => {
  it('neither process needs either credential: both are optional and read as absent', () => {
    const api = loadConfig({ ...BASE });
    expect(api.settlementDatabaseUrl).toBeNull();
    expect(api.operatorDatabaseUrl).toBeNull();
    const worker = loadConfig({ ...WORKER });
    expect(worker.settlementDatabaseUrl).toBeNull();
    expect(worker.operatorDatabaseUrl).toBeNull();
    /* Blank is how the production compose file withholds them: blank reads as absent. */
    const blanked = loadConfig({
      ...WORKER,
      SETTLEMENT_DATABASE_URL: '',
      OPERATOR_DATABASE_URL: '',
    });
    expect(blanked.settlementDatabaseUrl).toBeNull();
    expect(blanked.operatorDatabaseUrl).toBeNull();
  });

  it('a production API refuses the settlement credential and the operator credential, by name', () => {
    expect(() =>
      loadConfig({ ...BASE, ...PRODUCTION, SETTLEMENT_DATABASE_URL: SETTLEMENT_URL }),
    ).toThrow(/SETTLEMENT_DATABASE_URL must not be set for an API process/);
    expect(() =>
      loadConfig({ ...BASE, ...PRODUCTION, OPERATOR_DATABASE_URL: OPERATOR_URL }),
    ).toThrow(/OPERATOR_DATABASE_URL must not be set for an API process/);
    const clean = loadConfig({
      ...BASE,
      ...PRODUCTION,
      SETTLEMENT_DATABASE_URL: '',
      OPERATOR_DATABASE_URL: '',
    });
    expect(clean.settlementDatabaseUrl).toBeNull();
    expect(clean.operatorDatabaseUrl).toBeNull();
  });

  it('a production worker refuses them too: it no longer settles (0217)', () => {
    expect(() =>
      loadConfig({ ...WORKER, ...PRODUCTION, SETTLEMENT_DATABASE_URL: SETTLEMENT_URL }),
    ).toThrow(/SETTLEMENT_DATABASE_URL must not be set for a worker process/);
    expect(() =>
      loadConfig({ ...WORKER, ...PRODUCTION, OPERATOR_DATABASE_URL: OPERATOR_URL }),
    ).toThrow(/OPERATOR_DATABASE_URL must not be set for a worker process/);
    expect(loadConfig({ ...WORKER, ...PRODUCTION }).settlementDatabaseUrl).toBeNull();
  });

  it('the refusal never prints the credential', () => {
    const secret = 'postgres://rekoda_settlement:hunter2hunter2hunter2@db:5432/x';
    let message = '';
    try {
      loadConfig({ ...BASE, ...PRODUCTION, SETTLEMENT_DATABASE_URL: secret });
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toMatch(/SETTLEMENT_DATABASE_URL/);
    expect(message).not.toMatch(/hunter2/);
  });

  it('outside production one process may play the parts: a job runner takes the settlement credential, any process the operator one', () => {
    const worker = loadConfig({
      ...WORKER,
      SETTLEMENT_DATABASE_URL: SETTLEMENT_URL,
      OPERATOR_DATABASE_URL: OPERATOR_URL,
    });
    expect(worker.settlementDatabaseUrl).toBe(SETTLEMENT_URL);
    expect(worker.operatorDatabaseUrl).toBe(OPERATOR_URL);
    /* An API-only process runs no jobs, so it never opens the settlement credential. */
    const api = loadConfig({
      ...BASE,
      SETTLEMENT_DATABASE_URL: SETTLEMENT_URL,
      OPERATOR_DATABASE_URL: OPERATOR_URL,
    });
    expect(api.settlementDatabaseUrl).toBeNull();
    expect(api.operatorDatabaseUrl).toBe(OPERATOR_URL);
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
