/**
 * Migration runner.
 *
 * `drizzle-kit migrate` needs `dist/` built and a drizzle-kit install; ops
 * running a deploy should need neither. This reads the same journal drizzle
 * writes, applies each file in order, and records what it applied — so
 * generated and hand-written migrations (0001_rls, 0002_identity) travel by
 * exactly one mechanism.
 *
 * Runs as the OWNER, not `rekoda_app`. The application role is deliberately
 * not allowed to reshape the schema it is constrained by.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export interface JournalEntry {
  idx: number;
  tag: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** dist/migrate.js and src/migrate.ts are both one level below the package. */
export const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

export async function applyMigrations(
  databaseUrl: string,
  migrationsDir = MIGRATIONS_DIR,
): Promise<string[]> {
  const journal = JSON.parse(
    await readFile(join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  try {
    await assertCanReachEveryTenant(sql);

    await sql`
      CREATE TABLE IF NOT EXISTS rekoda_migrations (
        tag text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`;

    for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
      const done = await sql`SELECT 1 FROM rekoda_migrations WHERE tag = ${entry.tag}`;
      if (done.length > 0) continue;

      const body = await readFile(join(migrationsDir, `${entry.tag}.sql`), 'utf8');
      // One simple-protocol call per file. Splitting on ';' would tear apart the
      // DO $$ ... $$ blocks in 0001_rls, and drizzle's own
      // `--> statement-breakpoint` markers are comments the server ignores.
      await sql.unsafe(body).simple();
      await sql`INSERT INTO rekoda_migrations (tag) VALUES (${entry.tag})`;
      applied.push(entry.tag);
    }
  } finally {
    await sql.end();
  }
  return applied;
}

/* Runnable directly: `node dist/migrate.js` */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const applied = await applyMigrations(url);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'already up to date');
}

/**
 * Refuse to migrate as a role that cannot see across tenants.
 *
 * Every tenant table is under FORCE ROW LEVEL SECURITY, which applies to the
 * table owner as well, and the policies key on a GUC no migration sets. A
 * data migration run by a role without superuser or BYPASSRLS therefore
 * matches NOTHING and reports success: 0017 would leave every trial without
 * an expiry, 0024 would leave every expense unlinked from its posting, and
 * nobody would learn about it until a merchant read a wrong figure.
 *
 * In development the owner happens to be a superuser, which is exactly why
 * this cannot be left to be noticed later. Failing here costs a deploy; not
 * failing here costs silent data.
 *
 * A migration may still opt out of RLS explicitly for one statement (0035
 * does), and that is a different thing: deliberate, scoped and visible in the
 * file. This is about the migrations that never think to.
 */
async function assertCanReachEveryTenant(sql: postgres.Sql): Promise<void> {
  const rows = await sql<{ unrestricted: boolean }[]>`
    SELECT (rolsuper OR rolbypassrls) AS unrestricted
    FROM pg_roles WHERE rolname = current_user`;
  if (rows[0]?.unrestricted !== true) {
    throw new Error(
      'migrations must run as a role with superuser or BYPASSRLS: every tenant table ' +
        'forces row-level security, so a data migration run without it silently ' +
        'updates no rows. Grant it with ALTER ROLE <role> BYPASSRLS.',
    );
  }
}
