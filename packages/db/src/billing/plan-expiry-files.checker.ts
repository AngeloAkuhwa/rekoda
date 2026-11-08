/**
 * The G-62 / OD-37 plan-expiry file guard's checker: the patterns and functions, without the
 * reviewed lists. Split out of `plan-expiry-files.test.ts` (which keeps ALLOWED and PINS and the
 * repository checks) so the detection self-tests can live in their own file without importing a
 * test file. No database, no side effects: it reads the files it is given.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type Role = 'writer' | 'caller' | 'reader' | 'definition' | 'migration';

/** Why each file is permitted. Paths are repository-relative, with forward slashes. */
export interface Entry {
  role: Role;
  why: string;
  /** The file updates other columns of `businesses`, so the UPDATE hint is skipped (the SQL-assignment and INSERT checks still run). */
  writesOtherColumns?: boolean;
}

/** Both spellings, any case, so a camelCase property or a SQL column is caught. */
const MENTION = /plan_?expires/i;
// Whitespace or SQL comments (line comments or block comments) between tokens. A block comment ends at the
// FIRST `*/`: a lazy `[\s\S]*?` can extend past it, and on a large file that backtracks combinatorially.
const GAP = String.raw`(?:\s|--[^\n]*(?:\n|$)|/\*(?:[^*]|\*(?!/))*\*/)*`;
// The same, for JS and TS: `//` line comments and block comments, ended at the first `*/`.
const JS_GAP = String.raw`(?:\s|//[^\n]*(?:\n|$)|/\*(?:[^*]|\*(?!/))*\*/)*`;

/**
 * The three ways a column is assigned, built once and shared by the listed-file checks and the assignment
 * pins so the two cannot drift. `sql` is the column name as it appears in SQL, `key` as an object key
 * (either spelling).
 *  1. `SET col = x` or `, "t"."col" = x`, with SQL comments allowed before the column and before `=`.
 *     A `WHERE`/`AND` equality predicate, `<=`, `>=`, `!=` and `==` do not match.
 *  2. a tuple assignment `SET (a, col) = (x, y)`.
 *  3. a query-builder `.set({ ... })` where the column is a property KEY: first in the object or after a
 *     comma, possibly quoted, possibly after JS comments, shorthand included, and not a value (`x: col`).
 *     The prefix is bounded to one statement (no `;`) and 2,000 characters so it stays linear; a key later than
 *     that in one object literal is not seen (documented limit).
 */
function assignmentAlternatives(sql: string, key: string): { sql: string[]; builder: string } {
  const sqlAlts = [
    String.raw`(?:\bSET|,)${GAP}(?:"?\w+"?\.)?"?${sql}"?${GAP}=(?![=>])`,
    String.raw`(?:\bSET|,)${GAP}\([^)]*(?<![\w$])${sql}(?![\w$])[^)]*\)${GAP}=(?![=>])`,
  ];
  const builderAlts = [
    String.raw`\.set\(\s*\{(?:[^;]{0,2000}?,)?${JS_GAP}["'\x60]?${key}["'\x60]?${JS_GAP}[:,}]`,
  ];
  // A businesses INSERT that names `plan` writes it too. Only for `plan`: a new file inserting the expiry
  // already fails the name check, and the trial insert's expiry is held by the file list.
  if (sql === 'plan') {
    sqlAlts.push(
      String.raw`\bINSERT${GAP}INTO${GAP}(?:"?public"?${GAP}\.${GAP})?"?businesses"?${GAP}\([^)]*(?<![\w$])"?plan"?(?![\w$])[^)]*\)`,
    );
    builderAlts.push(
      String.raw`\.insert\(\s*(?:\w+\.)*businesses\s*\)${JS_GAP}\.values\(${JS_GAP}\[?${JS_GAP}\{(?:[^;]{0,2000}?,${JS_GAP}\{?)?${JS_GAP}["'\x60]?plan["'\x60]?${JS_GAP}[:,}]`,
    );
  }
  return { sql: sqlAlts, builder: builderAlts.join('|') };
}
const EXPIRY_ALT = assignmentAlternatives('plan_expires_at', 'plan_?expires_?at');
const SQL_ASSIGNMENT = new RegExp(EXPIRY_ALT.sql.join('|'), 'i');
const BUILDER_ASSIGNMENT = new RegExp(EXPIRY_ALT.builder, 'i');
/** Whole-file hints that the businesses table is written: an UPDATE or an INSERT, builder or raw. */
const UPDATE_HINT =
  /\.update\(\s*(?:\w+\.)*businesses\s*\)|\bUPDATE\s+(?:"?public"?\s*\.\s*)?"?businesses"?(?![\w$])/i;
const INSERT_HINT =
  /\.insert\(\s*(?:\w+\.)*businesses\s*\)|\bINSERT\s+INTO\s+(?:"?public"?\s*\.\s*)?"?businesses"?(?![\w$])/i;

/**
 * Assignment pins. A file-level list cannot see a second write INSIDE a listed
 * writer, and the expiry name alone does not cover `plan` (the lapse to
 * 'expired' assigns `plan` without touching the date). So the number of
 * assignments each file may contain is pinned; any other file must have none.
 * Changing a pin is a reviewed decision, like adding a writer.
 */
export interface Pin {
  /** SQL or builder assignments to `plan`. */
  plan: number;
  /** SQL or builder assignments to `plan_expires_at`. */
  expiry: number;
  /** Inserts into the businesses table, by the query builder or in SQL. */
  businessInserts: number;
  why: string;
}

/* Built once, from the same factory output the listed-file checks use (EXPIRY_ALT), so the pins and
 * those checks cannot drift. `String.prototype.match` with the `g` flag resets `lastIndex`, so
 * sharing these global patterns is safe. */
const PLAN_ALT = assignmentAlternatives('plan', 'plan');
const PLAN_ASSIGN_G = new RegExp([...PLAN_ALT.sql, PLAN_ALT.builder].join('|'), 'gi');
const EXPIRY_ASSIGN_G = new RegExp([...EXPIRY_ALT.sql, EXPIRY_ALT.builder].join('|'), 'gi');
const INSERT_HINT_G = new RegExp(INSERT_HINT.source, 'gi');

function count(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length;
}

/** Assignments to `plan` and to `plan_expires_at`, and businesses inserts, in one file's text. */
export function countAssignments(text: string): { plan: number; expiry: number; inserts: number } {
  return {
    plan: count(PLAN_ASSIGN_G, text),
    expiry: count(EXPIRY_ASSIGN_G, text),
    inserts: count(INSERT_HINT_G, text),
  };
}

/** Every non-test file against the pins. A file with no pin must assign neither column. */
export function checkAssignmentPins(
  files: readonly ScannedFile[],
  pins: Readonly<Record<string, Pin>>,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (isTestFile(f.path) || f.path.includes('/migrations/meta/')) continue;
    const pin = pins[f.path];
    if (pin) seen.add(f.path);
    const got = countAssignments(f.text);
    const want = pin ?? { plan: 0, expiry: 0, businessInserts: 0 };
    if (got.plan !== want.plan) {
      problems.push(`${f.path}: assigns plan ${got.plan} time(s), pinned at ${want.plan} (G-62).`);
    }
    if (got.expiry !== want.expiry) {
      problems.push(
        `${f.path}: assigns plan_expires_at ${got.expiry} time(s), pinned at ${want.expiry} (G-62).`,
      );
    }
    // Inserts are pinned only where a pin exists: other files are covered by the reader/caller checks.
    if (pin && got.inserts !== pin.businessInserts) {
      problems.push(
        `${f.path}: inserts into businesses ${got.inserts} time(s), pinned at ${pin.businessInserts} (G-62).`,
      );
    }
  }
  for (const path of Object.keys(pins)) {
    if (!seen.has(path))
      problems.push(`${path}: pinned but not found (moved or renamed). Update PINS.`);
  }
  return problems;
}

export const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|sql|sh)$/;
const SKIP_DIR = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', '.git']);

/** Fixtures and specs set the column up on purpose; they are not product paths. */
export function isTestFile(path: string): boolean {
  return /\.(?:test|spec)(?:\.[a-z]+)+$/.test(path) || path.split('/').includes('e2e');
}

export interface ScannedFile {
  path: string;
  text: string;
}

/**
 * The whole decision, as a pure function of (files, allowlist) so it can be
 * tested without the repository. Returns one message per problem.
 */
export function checkPlanExpiryFiles(
  files: readonly ScannedFile[],
  allowed: Readonly<Record<string, Entry>>,
): string[] {
  const problems: string[] = [];
  const mentioning = new Map<string, string>();
  for (const f of files) {
    if (isTestFile(f.path)) continue;
    if (f.path.includes('/migrations/meta/')) continue; // generated snapshots
    if (MENTION.test(f.text)) mentioning.set(f.path, f.text);
  }

  for (const [path, text] of mentioning) {
    const entry = allowed[path];
    if (!entry) {
      problems.push(
        `${path}: mentions plan_expires_at but is not on the reviewed list. If it is a move of an allowed file, update the list; if it writes the column, route it through writeSubscriptionState (G-62).`,
      );
      continue;
    }
    if (entry.role === 'reader' || entry.role === 'caller' || entry.role === 'definition') {
      if (SQL_ASSIGNMENT.test(text) || BUILDER_ASSIGNMENT.test(text)) {
        problems.push(`${path}: listed as ${entry.role} but assigns plan_expires_at in SQL.`);
      }
      if ((!entry.writesOtherColumns && UPDATE_HINT.test(text)) || INSERT_HINT.test(text)) {
        problems.push(
          `${path}: listed as ${entry.role} but writes the businesses table; a writer must be reviewed and listed as one.`,
        );
      }
    }
  }

  for (const path of Object.keys(allowed)) {
    if (!mentioning.has(path)) {
      problems.push(
        `${path}: listed but no longer mentions plan_expires_at (moved, renamed or cleaned up). Remove or update the entry.`,
      );
    }
  }
  return problems;
}

/** Walks a few roots, returning repository-relative source files. */
export function collectSourceFiles(root: string, roots: readonly string[]): ScannedFile[] {
  const out: ScannedFile[] = [];
  const walk = (dir: string): void => {
    // An unreadable root must fail the scan, never read as an empty tree.
    const names = readdirSync(dir);
    for (const name of names) {
      if (SKIP_DIR.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (SOURCE_EXT.test(name)) {
        out.push({
          path: relative(root, full).split(sep).join('/'),
          text: readFileSync(full, 'utf8'),
        });
      }
    }
  };
  for (const r of roots) walk(join(root, r));
  return out;
}

/** The directories the guard scans; the header and the two repository sweeps share it. */
export const SCAN_ROOTS = ['apps', 'packages', 'scripts', 'deploy'] as const;
