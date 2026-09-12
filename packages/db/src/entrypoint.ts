import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `metaUrl` is the script Node was started with.
 *
 * The two entrypoints (`apps/api/src/main.ts`, `packages/db/src/migrate.ts`)
 * must run their side effects only when executed directly, never when
 * imported by a test or another module. Comparing `import.meta.url` with the
 * string `` `file://${process.argv[1]}` `` did that on POSIX only: on Windows
 * `argv[1]` is `C:\...\main.js` while the URL is `file:///C:/.../main.js`,
 * and on any platform a space in the path is percent-encoded in the URL and
 * literal in `argv[1]`. Both entrypoints therefore never matched on this
 * repository's own checkout, `start:local` never started and `migrate:apply`
 * exited 0 having applied nothing (#237). Converting the URL to a path and
 * resolving `argv[1]` compares like with like on both platforms.
 *
 * Both sides are then compared by their REAL paths too. Node gives the main
 * module its real path, so a script reached through a symlink (`node
 * node_modules/@rekoda/db/dist/migrate.js` from an app that depends on the
 * package, which pnpm links into another directory) never matched the path
 * as typed, and the migrator exited 0 having applied nothing (found building
 * G-01). A path that does not exist keeps its resolved form, so the
 * comparison still answers.
 */
export function isEntrypoint(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  const module = fileURLToPath(metaUrl);
  const script = resolve(argv1);
  return module === script || real(module) === real(script);
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
