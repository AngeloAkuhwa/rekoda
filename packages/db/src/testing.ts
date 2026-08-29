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
        refunds, payment_reversals, chargebacks,
        settlement_components, settlement_items, settlements,
        payment_charges, payment_attempts, payment_intents, payment_connections,
        waba_service_windows, waba_templates, waba_connections,
        documents,
        audit_events,
        journal_draft_lines, journal_drafts, receivable_recognition_policies,
        revenue_recognition_events, recognition_review_items,
        customer_credit_applications, customer_credits,
        ledger_entries, ledger_transactions, accounting_periods, exchange_rate_snapshots,
        payment_allocations, payments,
        accounts, financial_accounts,
        invoice_items, invoices,
        doc_counters,
        command_drafts,
        ai_quota_counters, ai_global_counters,
        doc_extraction_counters, doc_extraction_global_counters,
        voice_second_counters, voice_global_counters,
        usage_events, usage_counters, pending_confirmations, idempotency_records,
        evidence_legal_holds, outbox_events,
        payment_verification_claims, payment_verification_revocations,
        payment_verifications, payment_evidence,
        jobs,
        key_fingerprints,
        webhook_deliveries, webhook_endpoints,
        api_key_rate_windows, api_keys, api_applications,
        conversation_messages, conversations,
        shops,
        portability_exports,
        business_add_ons,
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
 * Restore the plan catalogue to its seeded version-1 state, as the owner.
 *
 * The catalogue is deliberately NOT in `truncateAll`: it is reference data
 * migration 0105 seeds once, like the entitlements catalogue. A test that
 * publishes a successor version or repricess therefore puts the catalogue
 * back with this - successor versions go, appended price rows go, every
 * seed row reopens - so the next test file starts from version 1 exactly
 * as a fresh database would.
 */
export async function resetPlanCatalogue(urls: Urls): Promise<void> {
  const sql = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`
      UPDATE businesses SET plan_version_id = NULL
        WHERE plan_version_id IN (SELECT id FROM plan_versions WHERE version > 1);
      DELETE FROM plan_version_entitlements
        WHERE plan_version_id IN (SELECT id FROM plan_versions WHERE version > 1);
      DELETE FROM allowance_versions
        WHERE plan_version_id IN (SELECT id FROM plan_versions WHERE version > 1);
      DELETE FROM plan_prices
        WHERE plan_version_id IN (SELECT id FROM plan_versions WHERE version > 1);
      DELETE FROM plan_versions WHERE version > 1;
      DELETE FROM plan_prices p USING plan_versions v
        WHERE v.id = p.plan_version_id AND p.effective_from <> v.effective_from;
      UPDATE plan_prices SET effective_to = NULL WHERE effective_to IS NOT NULL;
      UPDATE plan_versions SET effective_to = NULL WHERE effective_to IS NOT NULL;
      DELETE FROM usage_packs WHERE version > 1;
      UPDATE usage_packs SET effective_to = NULL WHERE effective_to IS NOT NULL;
      DELETE FROM add_ons WHERE version > 1;
      UPDATE add_ons SET effective_to = NULL WHERE effective_to IS NOT NULL;
      DELETE FROM add_on_grants WHERE add_on_id LIKE 'test_%';
      DELETE FROM add_ons WHERE add_on_id LIKE 'test_%';
    `);
  } finally {
    await sql.end();
  }
}

/**
 * Give a business standing capacity of a unit, the way production does
 * (PR-116).
 *
 * A CAPACITY unit is HELD, never spent, so there is no counter to credit:
 * the ceiling comes from an add-on the business holds. Suites that need
 * "this merchant may hold three applications" ask for it here rather than
 * crediting a monthly bonus, which is the exact confusion `check-boundaries`
 * refuses in source and this helper makes unnecessary in tests.
 *
 * The add-on is seeded as owner, because the catalogue is never written by
 * the application, and one add-on per quantity: a business holds a given
 * add-on once, which is what the live-holding index enforces.
 */
export async function grantCapacityAddOn(
  urls: Urls,
  businessId: string,
  unit: string,
  quantity: number,
): Promise<string> {
  const addOnId = `test_capacity_${unit.toLowerCase()}_${quantity}`;
  const sql = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    await sql`
      INSERT INTO add_ons
        (add_on_id, version, name, billing_interval, price_minor, currency, effective_from)
      VALUES (${addOnId}, 1, ${`${quantity} x ${unit}`}, 'monthly',
              500000, 'NGN', '2026-01-01T00:00:00Z')
      ON CONFLICT (add_on_id, version) DO NOTHING
    `;
    await sql`
      INSERT INTO add_on_grants (add_on_id, version, grant_kind, unit, quantity)
      SELECT ${addOnId}, 1, 'CAPACITY', ${unit}, ${quantity}
      WHERE NOT EXISTS (
        SELECT 1 FROM add_on_grants
         WHERE add_on_id = ${addOnId} AND version = 1 AND unit = ${unit}
      )
    `;
    await sql`
      INSERT INTO business_add_ons (business_id, add_on_id, version, started_at)
      VALUES (${businessId}::uuid, ${addOnId}, 1, now())
      ON CONFLICT DO NOTHING
    `;
  } finally {
    await sql.end();
  }
  return addOnId;
}

/**
 * Make a business hold a REAL catalogue add-on, as the owner.
 *
 * `grantCapacityAddOn` invents an add-on to prove a mechanism; this one
 * sells what the catalogue actually offers, which is what a suite wants
 * when the thing under test is the product rather than the plumbing. The
 * version is whichever is open now, exactly as a purchase would pin it.
 */
export async function holdAddOn(
  urls: Urls,
  businessId: string,
  addOnId: string,
  startedAt: Date = new Date(),
): Promise<number> {
  const sql = postgres(urls.owner, { max: 1, onnotice: () => {} });
  try {
    const open = await sql<{ version: number }[]>`
      SELECT version FROM add_ons
       WHERE add_on_id = ${addOnId} AND effective_to IS NULL
       ORDER BY version DESC LIMIT 1
    `;
    const version = open[0]?.version;
    if (version === undefined) throw new Error(`no open version of add-on ${addOnId}`);
    await sql`
      INSERT INTO business_add_ons (business_id, add_on_id, version, started_at)
      VALUES (${businessId}::uuid, ${addOnId}, ${version}, ${startedAt.toISOString()}::timestamptz)
      ON CONFLICT DO NOTHING
    `;
    return version;
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
