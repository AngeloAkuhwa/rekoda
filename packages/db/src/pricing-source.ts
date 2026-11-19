/**
 * OD-51.6 (migration 0215): show or switch the ONE pricing source every process prices from.
 *
 * Run by an authorised release operator as the table OWNER (the migrate job's credential):
 *
 *   docker compose -f docker-compose.prod.yml run --rm -T migrate \
 *     sh /repo/deploy/migrate.sh pricing-source show
 *   docker compose -f docker-compose.prod.yml run --rm -T migrate \
 *     sh /repo/deploy/migrate.sh pricing-source set constants "<who>" "<why>"
 *
 * `show` prints the source in force as JSON and changes nothing. `set` switches it through
 * `rekoda_private.set_pricing_source`, which keeps the previous value in
 * `billing_pricing_source_history`. For `constants` the fingerprint recorded is the one compiled
 * into THIS release (`pricingConstantsFingerprint`), so every process must then run this release.
 *
 * Switch it only with the api, worker and settlement processes stopped, then set
 * `REKODA_PLAN_CATALOGUE_READS` to match (1 for catalogue, 0 for constants) before starting them:
 * a process whose setting differs from the source in force refuses to start, and a running one
 * that differs can open no charge.
 *
 *   exit 0  done
 *   exit 2  could not run (no URL, wrong arguments, migration 0215 missing, not the owner)
 */
import postgres from 'postgres';
import { pricingConstantsFingerprint } from '@rekoda/core';
import { isEntrypoint } from './entrypoint.js';

export interface PricingSourceReport {
  mode: 'catalogue' | 'constants';
  constantsFingerprint: string | null;
  setAt: string;
  setBy: string;
  reason: string;
  /** The fingerprint of the figures compiled into the release that ran this command. */
  thisReleaseConstantsFingerprint: string;
}

export class PricingSourceCannotRun extends Error {
  override readonly name = 'PricingSourceCannotRun';
}

async function read(sql: postgres.Sql | postgres.TransactionSql): Promise<PricingSourceReport> {
  const [present] = await sql<{ present: boolean }[]>`
    SELECT to_regclass('public.billing_pricing_source') IS NOT NULL AS present`;
  if (present?.present !== true) {
    throw new PricingSourceCannotRun('migration 0215 is not applied to this database');
  }
  const [row] = await sql<
    {
      mode: 'catalogue' | 'constants';
      constants_fingerprint: string | null;
      set_at: string;
      set_by: string;
      reason: string;
    }[]
  >`SELECT mode, constants_fingerprint, set_at::text, set_by, reason FROM billing_pricing_source`;
  if (!row) throw new PricingSourceCannotRun('billing_pricing_source holds no row');
  return {
    mode: row.mode,
    constantsFingerprint: row.constants_fingerprint,
    setAt: row.set_at,
    setBy: row.set_by,
    reason: row.reason,
    thisReleaseConstantsFingerprint: pricingConstantsFingerprint(),
  };
}

export async function showPricingSource(databaseUrl: string): Promise<PricingSourceReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    return await sql.begin('READ ONLY', (tx) => read(tx));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function setPricingSourceInForce(
  databaseUrl: string,
  input: { mode: string; actor: string; reason: string },
): Promise<PricingSourceReport> {
  if (input.mode !== 'catalogue' && input.mode !== 'constants') {
    throw new PricingSourceCannotRun('the mode is catalogue or constants');
  }
  if (input.actor.trim().length === 0 || input.reason.trim().length === 0) {
    throw new PricingSourceCannotRun('who is switching the source, and why, are both required');
  }
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    return await sql.begin(async (tx) => {
      const [role] = await tx<{ owner: boolean }[]>`
        SELECT pg_has_role(current_user,
                 (SELECT relowner FROM pg_class WHERE oid = to_regclass('public.businesses')),
                 'USAGE') AS owner`;
      if (role?.owner !== true) {
        throw new PricingSourceCannotRun('run this as the table owner (the migrate credential)');
      }
      await read(tx);
      await tx`SELECT rekoda_private.set_pricing_source(
        ${input.mode},
        ${input.mode === 'constants' ? pricingConstantsFingerprint() : null},
        ${input.actor}, ${input.reason})`;
      return read(tx);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/* Runnable directly: `node dist/pricing-source.js show | set <mode> <actor> <reason>` */
if (isEntrypoint(import.meta.url, process.argv[1])) {
  const url = process.env['DATABASE_URL'];
  const [command, mode, actor, reason] = process.argv.slice(2);
  try {
    if (!url) throw new PricingSourceCannotRun('DATABASE_URL (the owner) is required');
    if (command === 'show' && mode === undefined) {
      console.log(JSON.stringify(await showPricingSource(url), null, 2));
    } else if (command === 'set' && mode && actor && reason) {
      console.log(
        JSON.stringify(await setPricingSourceInForce(url, { mode, actor, reason }), null, 2),
      );
    } else {
      throw new PricingSourceCannotRun(
        'usage: pricing-source show | pricing-source set <catalogue|constants> <actor> <reason>',
      );
    }
    process.exit(0);
  } catch (error) {
    console.error(`pricing-source: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
