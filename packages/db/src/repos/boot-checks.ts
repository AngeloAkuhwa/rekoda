/**
 * Production invariants checked at process start (remediation A5, A6).
 *
 * Both checks exist for the same reason: the failure they catch is silent
 * in every request and catastrophic in aggregate. A database role that can
 * bypass row-level security turns every missed WHERE clause from "zero
 * rows" into "another tenant's ledger"; a wrong vault key does not error,
 * it just decrypts nothing and encrypts new secrets under a key the old
 * data does not share. Boot is the one moment an operator is watching.
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../client.js';

/**
 * The configured role must not be SUPERUSER and must not hold BYPASSRLS
 * (remediation A5). FORCE ROW LEVEL SECURITY is the architecture; a role
 * that walks through it makes every policy in the schema decorative.
 *
 * Checked live against pg_roles rather than trusted from documentation,
 * because the documented role and the deployed credential drift exactly
 * once — the day somebody points production at an owner URL "temporarily".
 */
export async function assertRoleCannotBypassRls(db: Db, label: string): Promise<void> {
  const rows = await db.execute<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(sql`
    SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
  `);
  const role = [...rows][0];
  if (!role) throw new Error(`RLS boot check: could not read pg_roles for the ${label} role`);
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `the ${label} database role "${role.rolname}" is ` +
        `${role.rolsuper ? 'SUPERUSER' : 'BYPASSRLS'} — it can walk through row-level ` +
        'security, which makes tenant isolation decorative. Point this process at its ' +
        'least-privilege role (rekoda_app / rekoda_worker), never an owner credential.',
    );
  }
}

/**
 * The plan-field guard's authority is a role (`rekoda_plan_writer`, migration 0196): a connection
 * that can become it can write a business's plan and paid-to date outside the two sanctioned
 * functions. Migration 0196 refuses such a membership when it runs; this refuses it on every boot,
 * so a later `GRANT` is caught before the process serves anything. Checked live against the
 * catalogue for the role the process is connected as (membership of any kind, direct or through
 * another role). A database without the role yet (before 0196) has nothing to check.
 */
export async function assertRoleCannotAssumePlanWriter(db: Db, label: string): Promise<void> {
  const rows = await db.execute<{ rolname: string; member: boolean }>(sql`
    SELECT current_user::text AS rolname,
           CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rekoda_plan_writer')
                THEN pg_has_role(current_user, 'rekoda_plan_writer', 'MEMBER')
                ELSE false END AS member
  `);
  const role = [...rows][0];
  if (!role) throw new Error(`plan-writer boot check: could not read the ${label} role`);
  if (role.member) {
    throw new Error(
      `the ${label} database role "${role.rolname}" is a member of rekoda_plan_writer, so it can ` +
        'SET ROLE and write plan fields outside the sanctioned functions (OD-37). Revoke the ' +
        'membership: REVOKE rekoda_plan_writer FROM ' +
        `${role.rolname}.`,
    );
  }
}

/** The writers OD-37 reserves to one principal each (migrations 0202, 0203). */
export const SETTLEMENT_WRITER = 'public.subscription_apply_paid_charge(uuid,text,timestamptz)';
export const OPERATOR_WRITER =
  'public.subscription_operator_set_plan(uuid,text,timestamptz,text,text)';
export type DatabasePrincipal = 'rekoda_settlement' | 'rekoda_billing_operator';

interface PrincipalFacts {
  rolname: string;
  super: boolean;
  bypass: boolean;
  settlement_writer: boolean | null;
  operator_writer: boolean | null;
  in_settlement: boolean | null;
  in_operator: boolean | null;
  in_worker: boolean | null;
  in_app: boolean | null;
  in_plan_writer: boolean | null;
  /** Can act as the owner of the guarded tables, which every OD-37 guard exempts. */
  in_table_owner: boolean | null;
  creates_in_public: boolean;
  /** The OD-37 guard triggers present and enabled (plan fields, settlement, pack credit). */
  guards_enabled: number;
}

/* Each fact is NULL when the role or function it names does not exist (migrations not applied):
 * every check below treats NULL as a failure for what must hold. */
async function principalFacts(db: Db): Promise<PrincipalFacts> {
  const rows = await db.execute<PrincipalFacts & Record<string, unknown>>(sql`
    SELECT r.rolname::text AS rolname, r.rolsuper AS super, r.rolbypassrls AS bypass,
      CASE WHEN to_regprocedure(${SETTLEMENT_WRITER}) IS NULL THEN NULL
           ELSE has_function_privilege(current_user, to_regprocedure(${SETTLEMENT_WRITER}), 'EXECUTE') END
        AS settlement_writer,
      CASE WHEN to_regprocedure(${OPERATOR_WRITER}) IS NULL THEN NULL
           ELSE has_function_privilege(current_user, to_regprocedure(${OPERATOR_WRITER}), 'EXECUTE') END
        AS operator_writer,
      CASE WHEN to_regrole('rekoda_settlement') IS NULL THEN NULL
           ELSE pg_has_role(current_user, 'rekoda_settlement', 'MEMBER') END AS in_settlement,
      CASE WHEN to_regrole('rekoda_billing_operator') IS NULL THEN NULL
           ELSE pg_has_role(current_user, 'rekoda_billing_operator', 'MEMBER') END AS in_operator,
      CASE WHEN to_regrole('rekoda_worker') IS NULL THEN NULL
           ELSE pg_has_role(current_user, 'rekoda_worker', 'MEMBER') END AS in_worker,
      CASE WHEN to_regrole('rekoda_app') IS NULL THEN NULL
           ELSE pg_has_role(current_user, 'rekoda_app', 'USAGE') END AS in_app,
      CASE WHEN to_regrole('rekoda_plan_writer') IS NULL THEN NULL
           ELSE pg_has_role(current_user, 'rekoda_plan_writer', 'MEMBER') END AS in_plan_writer,
      -- The cycle-input guard's test exemption keys on a function in public existing (0206), so no
      -- runtime role may create one there (PostgreSQL 15+ grants PUBLIC no CREATE on it).
      has_schema_privilege(current_user, 'public', 'CREATE') AS creates_in_public,
      -- to_regclass, never a ::regclass literal: an unmigrated database reads NULL here (and fails
      -- the check by name) instead of raising "relation does not exist".
      CASE WHEN to_regclass('public.subscription_charges') IS NULL THEN NULL
           ELSE pg_has_role(current_user,
                  (SELECT relowner FROM pg_class WHERE oid = to_regclass('public.subscription_charges')),
                  'USAGE') END AS in_table_owner,
      (SELECT count(*)::int FROM pg_trigger t
        WHERE t.tgenabled IN ('O', 'A') AND (t.tgname, t.tgrelid) IN (
          ('businesses_plan_fields_guard', to_regclass('public.businesses')),
          ('businesses_plan_fields_insert_guard', to_regclass('public.businesses')),
          ('businesses_cycle_fields_guard', to_regclass('public.businesses')),
          ('subscription_charges_applied_once_guard', to_regclass('public.subscription_charges')),
          ('subscription_charges_settlement_guard', to_regclass('public.subscription_charges')),
          ('usage_counters_bonus_guard', to_regclass('public.usage_counters')))) AS guards_enabled
    FROM pg_roles r WHERE r.rolname = current_user
  `);
  const facts = [...rows][0];
  if (!facts) throw new Error('principal boot check: could not read pg_roles for this connection');
  return facts;
}

/** The OD-37 guard triggers a running database must have, all enabled (0196, 0200, 0202, 0206). */
const GUARD_TRIGGERS = 6;

/**
 * OD-37 (0206): the integration harness's fixture plan writer is never in a database a process
 * serves. Its presence is also the test-only exemption of the cycle-input guard, so a database that
 * has it would let the application credential write a subscription's pricing inputs.
 */
export async function assertNoTestFixtureWriter(db: Db): Promise<void> {
  const rows = await db.execute<{ present: boolean }>(sql`
    SELECT to_regprocedure('public.test_fixture_set_plan(uuid,text,timestamptz)') IS NOT NULL
      AS present`);
  if ([...rows][0]?.present !== false) {
    throw new Error(
      'the database holds the test-only fixture plan writer (test_fixture_set_plan): this is a test ' +
        'database, or one tampered with; refusing to serve from it (OD-37, migration 0206).',
    );
  }
}

/**
 * OD-37 (0202): the general application and worker credentials hold neither reserved writer and
 * cannot become either reserved principal. Checked live on every boot, so a later GRANT is caught
 * before the process serves anything. A database without the principals yet (migrations not
 * applied) fails: this release needs them.
 */
export async function assertRoleHoldsNoReservedWriter(db: Db, label: string): Promise<void> {
  const f = await principalFacts(db);
  const problems: string[] = [];
  if (f.settlement_writer !== false) problems.push(`can run ${SETTLEMENT_WRITER}`);
  if (f.operator_writer !== false) problems.push(`can run ${OPERATOR_WRITER}`);
  if (f.in_settlement !== false) problems.push('can become rekoda_settlement');
  if (f.in_operator !== false) problems.push('can become rekoda_billing_operator');
  if (f.in_table_owner !== false) problems.push('can act as the owner of the guarded tables');
  if (f.creates_in_public !== false) problems.push('can create objects in schema public');
  if (f.guards_enabled !== GUARD_TRIGGERS) {
    problems.push('runs against a database whose OD-37 guard triggers are missing or disabled');
  }
  if (problems.length > 0) {
    throw new Error(
      `the ${label} database role "${f.rolname}" ${problems.join(', ')}: settlement and operator ` +
        'plan changes must stay with their own principals (OD-37). Apply migrations 0202 to 0206 ' +
        'and revoke any extra grant or membership.',
    );
  }
}

/**
 * OD-37 (0202): a settlement or operator connection is exactly its principal. It must log in as
 * that role (never the application role, never an owner), hold its own writer and not the other,
 * act with the application's ordinary rights (it inherits `rekoda_app`) and nothing more: not the
 * worker, not the other principal, not the plan writer, no RLS bypass.
 */
export async function assertDatabasePrincipal(
  db: Db,
  label: string,
  expected: DatabasePrincipal,
): Promise<void> {
  const f = await principalFacts(db);
  if (f.rolname !== expected) {
    throw new Error(
      `the ${label} connection logs in as "${f.rolname}", not ${expected}: point it at its own ` +
        'credential (OD-37); it never falls back to the application or owner role.',
    );
  }
  const mine = expected === 'rekoda_settlement' ? f.settlement_writer : f.operator_writer;
  const other = expected === 'rekoda_settlement' ? f.operator_writer : f.settlement_writer;
  const otherMember = expected === 'rekoda_settlement' ? f.in_operator : f.in_settlement;
  const problems: string[] = [];
  if (f.super || f.bypass) problems.push(f.super ? 'is SUPERUSER' : 'is BYPASSRLS');
  if (mine !== true) problems.push('cannot run its own writer');
  if (other !== false) problems.push("can run the other principal's writer");
  if (otherMember !== false) problems.push('can become the other principal');
  if (f.in_worker !== false) problems.push('can become rekoda_worker');
  if (f.in_plan_writer !== false) problems.push('can become rekoda_plan_writer');
  if (f.in_app !== true) problems.push("does not act with rekoda_app's rights");
  if (f.in_table_owner !== false) problems.push('can act as the owner of the guarded tables');
  if (f.creates_in_public !== false) problems.push('can create objects in schema public');
  if (f.guards_enabled !== GUARD_TRIGGERS) {
    problems.push('runs against a database whose OD-37 guard triggers are missing or disabled');
  }
  if (problems.length > 0) {
    throw new Error(
      `the ${label} database role ${expected} ${problems.join(', ')} (OD-37, migration 0202).`,
    );
  }
}

/**
 * A NON-SECRET fingerprint of a key (remediation A6).
 *
 * SHA-256 over a versioned domain separator plus the key, truncated: enough
 * to tell two keys apart with certainty, useless for recovering either. Safe
 * to log, safe to store, never the key.
 */
export function fingerprintKey(key: string): string {
  return createHash('sha256').update(`rekoda-key-fingerprint-v1:${key}`).digest('hex').slice(0, 16);
}

export class KeyFingerprintMismatch extends Error {
  override readonly name = 'KeyFingerprintMismatch';
}

/**
 * Refuse to run with a DIFFERENT key than the one this database was
 * enrolled with (remediation A6).
 *
 * The first boot records the fingerprint; every later boot compares. A
 * mismatch means the deployment is holding the wrong key — a paste error, a
 * stale secret store, a restore into the wrong environment — and starting
 * anyway would split the estate in two: old rows unreadable, new rows
 * written under the impostor. The error names both fingerprints (never a
 * key) so the operator can tell WHICH side is wrong against the runbook's
 * recorded value.
 *
 * Deliberate rotation goes through docs/runbooks/key-rotation.md, which
 * updates the enrolled fingerprint as the owner in the same change that
 * re-wraps the data.
 */
export async function assertKeyUnchanged(db: Db, keyName: string, key: string): Promise<void> {
  const fingerprint = fingerprintKey(key);
  const rows = await db.execute<{ fingerprint: string }>(sql`
    SELECT fingerprint FROM key_fingerprints WHERE key_name = ${keyName}
  `);
  const enrolled = [...rows][0]?.fingerprint;

  if (enrolled === undefined) {
    await db.execute(sql`
      INSERT INTO key_fingerprints (key_name, fingerprint)
      VALUES (${keyName}, ${fingerprint})
      ON CONFLICT (key_name) DO NOTHING
    `);
    // A racing twin process may have inserted first; re-read and fall through
    // to the comparison so both processes agree on one enrolled value.
    const reread = await db.execute<{ fingerprint: string }>(sql`
      SELECT fingerprint FROM key_fingerprints WHERE key_name = ${keyName}
    `);
    const now = [...reread][0]?.fingerprint;
    if (now !== undefined && now !== fingerprint) {
      throw new KeyFingerprintMismatch(
        `${keyName} does not match the key this database was just enrolled with ` +
          `(enrolled ${now}, this process holds ${fingerprint}).`,
      );
    }
    return;
  }

  if (enrolled !== fingerprint) {
    throw new KeyFingerprintMismatch(
      `${keyName} is NOT the key this database was enrolled with ` +
        `(enrolled ${enrolled}, this process holds ${fingerprint}). Starting anyway would ` +
        'write new secrets under a key the existing data does not share. If this is a ' +
        'deliberate rotation, follow docs/runbooks/key-rotation.md; otherwise fix the ' +
        'deployed secret.',
    );
  }
}
