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
