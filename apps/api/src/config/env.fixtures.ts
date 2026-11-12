/**
 * The smallest environment `loadConfig` accepts outside production, shared by
 * the tests in this folder. `config.ts` itself stays at `apps/api/src/`, where
 * its many importers expect it; only its tests live here.
 */
export const BASE = {
  DATABASE_URL: 'postgres://x@127.0.0.1:5432/x',
  OTP_PEPPER: 'p'.repeat(40),
  REKODA_API_SECRET: 's'.repeat(40),
  VAULT_KEY: 'a'.repeat(64),
  MATCH_KEY: 'b'.repeat(64),
} as NodeJS.ProcessEnv;

/**
 * The two privileged principals' URLs (OD-37, OD-51). Neither is part of the base environment: in
 * production each belongs to its own process (`settlement-main.ts`, `operator-main.ts`) and the
 * API and the worker refuse both. Outside production one process may be handed them.
 */
export const OPERATOR_URL = 'postgres://rekoda_billing_operator@127.0.0.1:5432/x';
export const SETTLEMENT_URL = 'postgres://rekoda_settlement@127.0.0.1:5432/x';
