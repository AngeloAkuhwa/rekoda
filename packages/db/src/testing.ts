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
        usage_events, usage_counters,
        jobs,
        conversation_messages, conversations,
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
