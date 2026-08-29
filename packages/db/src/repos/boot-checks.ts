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
