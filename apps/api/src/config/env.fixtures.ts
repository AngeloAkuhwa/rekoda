/**
 * The smallest environment `loadConfig` accepts outside production, shared by
 * the tests in this folder. `config.ts` itself stays at `apps/api/src/`, where
 * its many importers expect it; only its tests live here.
 */
export const BASE = {
  DATABASE_URL: 'postgres://x@127.0.0.1:5432/x',
  // OD-37 (migration 0202): required, each its own credential.
  SETTLEMENT_DATABASE_URL: 'postgres://rekoda_settlement@127.0.0.1:5432/x',
  OPERATOR_DATABASE_URL: 'postgres://rekoda_billing_operator@127.0.0.1:5432/x',
  OTP_PEPPER: 'p'.repeat(40),
  REKODA_API_SECRET: 's'.repeat(40),
  VAULT_KEY: 'a'.repeat(64),
  MATCH_KEY: 'b'.repeat(64),
} as NodeJS.ProcessEnv;
