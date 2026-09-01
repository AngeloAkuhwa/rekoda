/**
 * The row-level security invariants, asserted against the real catalogue.
 *
 * The R1 schema audit confirmed that 89 tables have RLS both ENABLEd and
 * FORCEd. The R2 adversarial audit then leaned on that fact for most of its
 * negative results — "no reachable cross-tenant write" is only true while the
 * policies are what they claim to be — and recorded, honestly, that neither
 * audit had re-derived the policy PREDICATES.
 *
 * This closes that. Not as a document, which describes one moment, but as a
 * test that fails the next time somebody weakens it.
 *
 * It reads `pg_policy` rather than the migrations for the same reason both
 * audits did: a migration says what was intended, and the catalogue says what
 * is there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';
import { migrate, requireUrls, type Urls } from './testing.js';

let urls: Urls;
let owner: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  const created = createDb(urls.owner, { max: 2 });
  owner = created.db;
  close = created.close;
});

afterAll(async () => {
  await close();
});

/**
 * The canonical tenant predicate. Every tenant policy is this, character for
 * character, and that uniformity is the point: a policy that is ALMOST this
 * one is the shape a leak hides in.
 */
const TENANT_PREDICATE =
  "(business_id = (NULLIF(current_setting('app.business_id'::text, true), ''::text))::uuid)";

/**
 * Tables carrying `business_id` with no tenant policy, each with a reason.
 *
 * This list is the executable half of `docs/rls-exemption-register.md`. A new
 * table with `business_id` and no policy fails the first test below until it
 * is added here, which forces the reason to be written down rather than
 * discovered by a later audit.
 */
const EXEMPT = new Map<string, string>([
  ['sessions', 'resolved before the tenant is known; unguessable hashed token'],
  ['magic_links', 'resolved before the tenant is known; unguessable hashed token'],
  ['retention_deletions', 'the row outlives the tenant it names (0022)'],
  ['platform_cost_events', "Rekoda's own cost ledger; app holds INSERT only (0124)"],
  ['migration_manifest_items', 'no grants to either application role'],
]);

describe('row-level security, across the whole schema', () => {
  it('gives every table carrying business_id a tenant policy, or a written exemption', async () => {
    const rows = await owner.execute<{ relname: string }>(sql`
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM information_schema.columns col
                      WHERE col.table_schema = 'public' AND col.table_name = c.relname
                        AND col.column_name = 'business_id')
         AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) = 0
       ORDER BY c.relname
    `);
    const unpoliced = [...rows].map((r) => r.relname);

    /* Not a count. Naming them means a new one reads as itself in the failure
     * rather than as "expected 6 to be 7", and the fix is to write down why
     * rather than to bump a number. */
    expect(unpoliced.filter((t) => !EXEMPT.has(t))).toEqual([]);
  });

  it('leaves no exemption in the list that no longer needs one', async () => {
    const rows = await owner.execute<{ relname: string }>(sql`
      SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relkind = 'r' AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) = 0
    `);
    const unpoliced = new Set([...rows].map((r) => r.relname));

    /* The list decays in the other direction too: a table that GAINS a policy
     * should lose its exemption, or the register slowly becomes a list of
     * things that used to be true. */
    expect([...EXEMPT.keys()].filter((t) => !unpoliced.has(t))).toEqual([]);
  });

  it('enables AND forces row-level security wherever it enables it', async () => {
    const rows = await owner.execute<{ relname: string }>(sql`
      SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE c.relkind = 'r' AND c.relrowsecurity AND NOT c.relforcerowsecurity
       ORDER BY c.relname
    `);

    /* ENABLE without FORCE exempts the table OWNER, and Rekoda's migration
     * role is a superuser. A half-configured table reads as protected in
     * every catalogue listing and is not, which is the worst of both. */
    expect([...rows].map((r) => r.relname)).toEqual([]);
  });

  it('keeps every permissive policy on the worker, never the application', async () => {
    const rows = await owner.execute<{ relname: string; polname: string; roles: string }>(sql`
      SELECT c.relname, p.polname,
             CASE WHEN p.polroles = '{0}' THEN 'PUBLIC'
                  ELSE (SELECT string_agg(r.rolname::text, ',') FROM pg_roles r
                         WHERE r.oid = ANY (p.polroles)) END AS roles
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE pg_get_expr(p.polqual, p.polrelid) = 'true'
       ORDER BY c.relname, p.polname
    `);

    /* `USING (true)` is the estate-wide grant. The worker needs it — it sweeps
     * across tenants by design and often after the tenant is gone. The
     * APPLICATION must never hold one, and neither must PUBLIC: either would
     * silently undo every tenant policy on that table for ordinary requests. */
    const wrong = [...rows]
      .filter((r) => r.roles !== 'rekoda_worker')
      .map((r) => `${r.relname}.${r.polname} -> ${r.roles}`);
    expect(wrong).toEqual([]);
  });

  it('writes the tenant predicate the same way every time', async () => {
    const rows = await owner.execute<{ relname: string; polname: string; qual: string }>(sql`
      SELECT c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) AS qual
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE pg_get_expr(p.polqual, p.polrelid) <> 'true'
       ORDER BY c.relname, p.polname
    `);

    /* Four predicates are legitimately not the tenant one, each pinned by
     * POLICY rather than by table so a fourth cannot arrive unnoticed:
     *
     *   businesses.tenant_self                       its own `id` IS the tenant key
     *   memberships.membership_self                  read BEFORE a business can be pinned
     *   shops.shop_public_read                       the storefront, gated on being published
     *   external_events.app_records_unattributed_ingress
     *                                                the unattributed backlog, which
     *                                                belongs to no tenant yet (0130)
     *
     * Keyed by policy because a table-level excuse is too coarse: every one
     * of these tables ALSO carries an ordinary tenant policy, and excusing
     * the table would stop checking that one too. */
    const KNOWN_EXCEPTIONS = new Set([
      'businesses.tenant_self',
      'memberships.membership_self',
      'shops.shop_public_read',
      'external_events.app_records_unattributed_ingress',
    ]);
    const offBrand = [...rows]
      .filter(
        (r) => r.qual !== TENANT_PREDICATE && !KNOWN_EXCEPTIONS.has(`${r.relname}.${r.polname}`),
      )
      .map((r) => `${r.relname}.${r.polname}: ${r.qual}`);
    expect(offBrand).toEqual([]);
  });

  it('never lets a policy write more widely than it reads', async () => {
    const rows = await owner.execute<{ relname: string; polname: string; check: string }>(sql`
      SELECT c.relname, p.polname, pg_get_expr(p.polwithcheck, p.polrelid) AS check
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE p.polwithcheck IS NOT NULL
         AND pg_get_expr(p.polwithcheck, p.polrelid)
             IS DISTINCT FROM pg_get_expr(p.polqual, p.polrelid)
       ORDER BY c.relname
    `);

    /* A WITH CHECK that differs from its USING means the write side and the
     * read side disagree about which rows belong to the tenant. Every policy
     * here either omits WITH CHECK — in which case PostgreSQL applies USING —
     * or repeats it exactly. A deliberate divergence would need its own
     * reasoning, and would fail here until somebody wrote it. */
    expect([...rows].map((r) => `${r.relname}.${r.polname}: ${r.check}`)).toEqual([]);
  });
});
