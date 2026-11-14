/**
 * OD-49 release preflight: subscription records Rekoda's duration rules would not accept.
 *
 * READ-ONLY. Run by an authorised release operator against the database a release is about to
 * serve, as the table OWNER (the migrate job's credential), after the release's migrations:
 *
 *   docker compose -f docker-compose.prod.yml run --rm -T migrate \
 *     node packages/db/dist/preflight-subscriptions.js
 *
 * or anywhere with `DATABASE_URL` naming the owner: `node dist/preflight-subscriptions.js`.
 *
 * It reads `rekoda_private.subscription_period_preflight()` (migration 0208) inside a READ ONLY
 * transaction and prints one JSON report: every business whose dates break the rule, split into
 * ACTIVE (a paid plan or trial that has not ended) and INACTIVE (ended, or expired), with the
 * business id, the plan, the reason code and the dates. No name, phone or other personal detail
 * is read or printed.
 *
 *   exit 0  PASS: no active record breaks the rules (inactive ones are reported, not blocking)
 *   exit 1  FAIL: at least one active record breaks the rules; correct each one with
 *           `rekoda_private.correct_subscription_period` (docs/runbooks/deploy.md) before release
 *   exit 2  the check could not run (no URL, a role that cannot see every tenant, 0208 missing)
 *
 * It refuses a role without SUPERUSER or BYPASSRLS: every tenant table forces row-level security,
 * so such a role would see no rows and report a false PASS.
 */
import postgres from 'postgres';
import { isEntrypoint } from './entrypoint.js';

export interface PreflightRow {
  businessId: string;
  plan: string;
  status: 'active' | 'inactive';
  reason: string;
  planExpiresAt: string | null;
  cycleStartedAt: string | null;
  billingInterval: string | null;
  trialStartedAt: string | null;
}

export interface PreflightReport {
  check: 'subscription_periods';
  result: 'PASS' | 'FAIL';
  checkedAt: string;
  activeViolations: number;
  inactiveViolations: number;
  active: PreflightRow[];
  inactive: PreflightRow[];
}

export class PreflightCannotRun extends Error {
  override readonly name = 'PreflightCannotRun';
}

export async function subscriptionPeriodPreflight(databaseUrl: string): Promise<PreflightReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    return await sql.begin('READ ONLY', async (tx) => {
      const [role] = await tx<{ unrestricted: boolean }[]>`
        SELECT (rolsuper OR rolbypassrls) AS unrestricted FROM pg_roles WHERE rolname = current_user`;
      if (role?.unrestricted !== true) {
        throw new PreflightCannotRun(
          'run the preflight as the table owner (SUPERUSER or BYPASSRLS): row-level security would ' +
            'hide every tenant from this role and the check would pass for the wrong reason',
        );
      }
      const [fn] = await tx<{ present: boolean }[]>`
        SELECT to_regprocedure('rekoda_private.subscription_period_preflight(timestamptz)') IS NOT NULL
          AS present`;
      if (fn?.present !== true) {
        throw new PreflightCannotRun('migration 0208 is not applied to this database');
      }
      const [clock] = await tx<{ at: string }[]>`SELECT now()::text AS at`;
      const rows = await tx<
        {
          business_id: string;
          plan: string;
          status: 'active' | 'inactive';
          reason: string;
          plan_expires_at: string | null;
          cycle_started_at: string | null;
          billing_interval: string | null;
          trial_started_at: string | null;
        }[]
      >`
        SELECT business_id, plan, status, reason, plan_expires_at::text, cycle_started_at::text,
               billing_interval, trial_started_at::text
        FROM rekoda_private.subscription_period_preflight(now())`;
      const shaped = rows.map((r): PreflightRow => ({
        businessId: r.business_id,
        plan: r.plan,
        status: r.status,
        reason: r.reason,
        planExpiresAt: r.plan_expires_at,
        cycleStartedAt: r.cycle_started_at,
        billingInterval: r.billing_interval,
        trialStartedAt: r.trial_started_at,
      }));
      const active = shaped.filter((r) => r.status === 'active');
      const inactive = shaped.filter((r) => r.status === 'inactive');
      return {
        check: 'subscription_periods' as const,
        result: active.length === 0 ? ('PASS' as const) : ('FAIL' as const),
        checkedAt: clock!.at,
        activeViolations: active.length,
        inactiveViolations: inactive.length,
        active,
        inactive,
      };
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/* Runnable directly: `node dist/preflight-subscriptions.js` */
if (isEntrypoint(import.meta.url, process.argv[1])) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('preflight: DATABASE_URL (the owner) is required');
    process.exit(2);
  }
  try {
    const report = await subscriptionPeriodPreflight(url);
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.result === 'PASS' ? 0 : 1);
  } catch (error) {
    console.error(
      `preflight: could not run: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
