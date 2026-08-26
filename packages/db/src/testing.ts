/**
 * Integration-test harness, published at `@rekoda/db/testing`.
 *
 * It lives in this package rather than in each test suite because it is the
 * only place allowed to open a connection at all: `apps/api` deliberately does
 * not depend on `postgres`, so the fixture reset has to be offered from here or
 * the boundary would have to be broken to test it.
 *
 * Three connection strings, because production has three: migrations run as
 * the schema OWNER, the application runs as `rekoda_app`, and background work
 * runs as `rekoda_worker`. Neither of the latter two is the owner and neither
 * has BYPASSRLS. Testing through a superuser would make every RLS assertion
 * vacuously pass — which is the specific failure mode this harness exists to
 * avoid.
 */
import postgres from 'postgres';
import { applyMigrations } from './migrate.js';

export interface Urls {
  /** Owner — DDL and fixture teardown. */
  owner: string;
  /** `rekoda_app` — everything the application itself does. */
  app: string;
  /**
   * `rekoda_worker` — the only role allowed to claim a job it has not yet
   * pinned a tenant for (migration 0004). Kept separate from `app` here for
   * the same reason it is separate in production: a test that claimed work
   * through the application's credentials would prove the opposite of what it
   * claims to.
   */
  worker: string;
}

/**
 * Missing configuration FAILS rather than skips.
 *
 * A skipped integration suite reports the same green tick as a passing one, so
 * the day the database disappears from CI is the day the tenancy proof
 * silently stops running. Better to be loudly red.
 */
export function requireUrls(): Urls {
  const owner = process.env['DATABASE_URL'];
  const app = process.env['APP_DATABASE_URL'];
  const worker = process.env['WORKER_DATABASE_URL'];
  if (!owner || !app || !worker) {
    throw new Error(
      'Integration tests need DATABASE_URL (owner), APP_DATABASE_URL (rekoda_app) ' +
        'and WORKER_DATABASE_URL (rekoda_worker). ' +
        'Start one with: docker compose -f docker-compose.dev.yml up -d',
    );
  }
  return { owner, app, worker };
}

export async function migrate(urls: Urls): Promise<void> {
  await applyMigrations(urls.owner);
}

/** Wipe tenant and identity fixtures between tests, as the owner. */
export async function truncateAll(urls: Urls): Promise<void> {
  const sql = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`
      TRUNCATE
        retention_deletions,
        subscription_charges,
        payment_intents, payment_connections,
        documents,
        audit_events,
        ledger_entries, ledger_transactions,
        payment_allocations, payments,
        invoice_items, invoices,
        doc_counters,
        command_drafts,
        ai_quota_counters, ai_global_counters,
        usage_events, usage_counters, pending_confirmations, idempotency_records,
        payment_verification_claims, payment_verification_revocations,
        payment_verifications, payment_evidence,
        jobs,
        conversation_messages, conversations,
        shops,
        business_entitlements,
        memberships, business_connections, products,
        customer_identities, customers,
        external_events, stranger_contacts,
        magic_links, sessions, otp_challenges,
        businesses, users
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await sql.end();
  }
}

/**
 * Time-travel for Pay-with-Transfer tests: age every live intent of one
 * business past its expiry, as the owner. The suites cannot reach the tables
 * directly (apps/api deliberately owns no SQL), and "the account lapsed" is
 * a state only the clock normally produces.
 */
export async function lapseTransferIntents(urls: Urls, businessId: string): Promise<void> {
  const sql = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    await sql`
      UPDATE payment_intents
      SET expires_at = now() - interval '1 minute',
          transfer_expires_at = now() - interval '1 minute'
      WHERE business_id = ${businessId}::uuid
        AND status NOT IN ('succeeded', 'failed', 'expired', 'cancelled')
    `;
  } finally {
    await sql.end();
  }
}

/**
 * More time-travel: make a business's intents look untouched for `seconds`,
 * so a verify-throttle window (fix-plan 7, H7b) that gates on `updated_at`
 * can be tested without sleeping through it.
 */
export async function agePaymentIntents(
  urls: Urls,
  businessId: string,
  seconds: number,
): Promise<void> {
  const sql = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    await sql`
      UPDATE payment_intents
      SET updated_at = now() - make_interval(secs => ${seconds})
      WHERE business_id = ${businessId}::uuid
    `;
  } finally {
    await sql.end();
  }
}
