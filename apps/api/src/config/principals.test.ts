/**
 * OD-37 (migration 0202): the settlement and billing-operator credentials. Both are required where
 * they are used, never silently replaced by the application credential, and never the same string
 * as a general credential.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { BASE } from './env.fixtures.js';

const WORKER = {
  ...BASE,
  REKODA_WORKER: '1',
  WORKER_DATABASE_URL: 'postgres://rekoda_worker@127.0.0.1:5432/x',
} as NodeJS.ProcessEnv;

describe('the OD-37 principals in configuration', () => {
  it('loads both URLs as given', () => {
    const config = loadConfig({ ...BASE });
    expect(config.settlementDatabaseUrl).toBe(BASE['SETTLEMENT_DATABASE_URL']);
    expect(config.operatorDatabaseUrl).toBe(BASE['OPERATOR_DATABASE_URL']);
  });

  it('refuses to start without the settlement credential, in an API or a worker process', () => {
    for (const env of [BASE, WORKER]) {
      const { SETTLEMENT_DATABASE_URL: _, ...without } = env;
      expect(() => loadConfig(without)).toThrow(/SETTLEMENT_DATABASE_URL .* is required/);
      expect(() => loadConfig({ ...without, SETTLEMENT_DATABASE_URL: '' })).toThrow(
        /SETTLEMENT_DATABASE_URL .* is required/,
      );
    }
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
      expect(() => loadConfig({ ...BASE, [key]: BASE['DATABASE_URL'] })).toThrow(
        new RegExp(`${key} must be its own credential`),
      );
      expect(() => loadConfig({ ...WORKER, [key]: WORKER['WORKER_DATABASE_URL'] })).toThrow(
        new RegExp(`${key} must be its own credential`),
      );
    }
  });
});
