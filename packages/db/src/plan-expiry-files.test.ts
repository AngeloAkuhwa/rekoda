/**
 * G-62 guard: which files may touch `businesses.plan_expires_at`.
 *
 * The expiry date is the cycle's bookkeeping anchor. G-62 was a second code path
 * that moved a business onto a plan and wrote the date without the rest of the
 * cycle (pending downgrade, failed-renewal clock, plan-version pin, anchor day).
 * It was fixed in #281 by routing every plan change through
 * `subscriptions.writeSubscriptionState`.
 *
 * INVARIANT PROTECTED: a business's `plan` and `plan_expires_at` are assigned
 * only by (1) `subscriptions.writeSubscriptionState`, the single statement that
 * moves a business onto a plan together with the rest of the cycle, (2) the
 * lapse transition to 'expired' in the same file, and (3) the trial insert in
 * `identity.createBusinessWithOwner`. Two checks hold it: the FILE LIST below
 * (who may mention the expiry) and the ASSIGNMENT PINS (how many writes each
 * listed writer may contain, and that nothing else assigns `plan`).
 *
 * This guard is deliberately simple and FILE-LEVEL. It does not parse anything.
 * It fails when any non-test source or SQL file mentions the column (either
 * spelling) and is not on the reviewed list below, and when a listed file no
 * longer mentions it. A new writer therefore cannot appear, and a writer cannot
 * be moved or renamed, without a reviewer seeing this list change.
 *
 * What it can and cannot promise is written down in docs/REKODA_LAUNCH_READINESS.md
 * (G-62 row) and in the LIMITATIONS block at the end of this header:
 *
 * LIMITATIONS (not a proof that only one writer exists):
 *  - It is a tripwire on the NAME. A name built at run time ('plan_' + 'expires_at')
 *    or a dynamic column list is invisible to it.
 *  - Inside a listed file it cannot tell a new write from a new read. Listed
 *    non-writer files get two extra whole-file checks (a SQL assignment to the
 *    column, or an `.update(businesses)` / `.insert(businesses)` call), which
 *    catch the obvious cases only.
 *  - Test files (`*.test.*`, `*.spec.*`, `e2e/`) are not scanned: they set up
 *    fixtures. A production file given a test-looking name would escape it.
 *  - A listed writer can gain a second write only if it is not an assignment the
 *    patterns know: the pins catch a new `plan` or `plan_expires_at` assignment,
 *    not a new write to another cycle column (`pending_plan`, `plan_version_id`).
 *    Behaviour is held by the integration tests (`operator-plan-change`,
 *    `subscriptions`), not by this test.
 * The stronger alternative, a database trigger that refuses a change to the
 * column unless the transaction opted in through the single writer, is
 * recorded in the G-62 row as a follow-up. It needs a migration on the
 * subscription path, so it is not slipped into a test-only change.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

export type Role = 'writer' | 'caller' | 'reader' | 'definition' | 'migration';

/** Why each file is permitted. Paths are repository-relative, with forward slashes. */
export interface Entry {
  role: Role;
  why: string;
  /** The file updates other columns of `businesses`, so the UPDATE hint is skipped (the SQL-assignment and INSERT checks still run). */
  writesOtherColumns?: boolean;
}

export const ALLOWED: Readonly<Record<string, Entry>> = {
  'packages/db/src/repos/subscriptions.ts': {
    role: 'writer',
    why: 'writeSubscriptionState is the single UPDATE that sets plan, expiry and the rest of the cycle together (G-62); the same file reads the date for sweeps and renewals.',
  },
  'packages/db/src/repos/identity.ts': {
    role: 'writer',
    why: 'createBusinessWithOwner inserts the new business with its 14-day trial expiry; the trial clock starts exactly once, here.',
  },
  'packages/db/src/repos/billing.ts': {
    role: 'caller',
    why: 'setPlan (operator plan change) reads the date and passes it in the state object to writeSubscriptionState; it holds no UPDATE of its own (fixed in #281).',
  },
  'packages/db/src/repos/retention.ts': {
    role: 'reader',
    why: 'selects lapsed businesses by the date for the retention sweep; its one UPDATE on businesses sets retention_notified_at, not the expiry.',
    writesOtherColumns: true,
  },
  'packages/db/src/repos/usage.ts': {
    role: 'reader',
    why: 'reads plan and date to decide whether a trial is still running.',
  },
  'packages/db/src/schema/tenancy.ts': {
    role: 'definition',
    why: 'the Drizzle column definition.',
  },
  'packages/core/src/billing.ts': {
    role: 'reader',
    why: 'pure rules over a cycle value (no IO): decides whether a cycle is a standard monthly one.',
  },
  'apps/api/src/billing/billing.service.ts': {
    role: 'reader',
    why: 'derives renewal and trial state from the stored date; every write goes through the repo.',
  },
  'apps/api/src/billing/billing-checkout.service.ts': {
    role: 'reader',
    why: 'checks whether the cycle has ended before offering checkout.',
  },
  'apps/api/src/health/ops.controller.ts': {
    role: 'reader',
    why: 'shows the renewal date in the operator subscription view.',
  },
  'packages/db/migrations/0000_init.sql': {
    role: 'migration',
    why: 'creates the column (applied; immutable).',
  },
  'packages/db/migrations/0017_trial_expiry.sql': {
    role: 'migration',
    why: 'one-off backfill of the trial expiry for existing rows, plus the index (applied; immutable).',
  },
  'packages/db/migrations/0020_subscriptions.sql': {
    role: 'migration',
    why: 'subscription columns and constraints (applied; immutable).',
  },
  'packages/db/migrations/0022_retention.sql': {
    role: 'migration',
    why: 'retention sweep function reads the date (applied; immutable).',
  },
  'packages/db/migrations/0109_security_hardening.sql': {
    role: 'migration',
    why: 'function definition reads the date (applied; immutable).',
  },
  'packages/db/migrations/0118_tenant_scoped_retention_users.sql': {
    role: 'migration',
    why: 'retention function reads the date (applied; immutable).',
  },
  'packages/db/migrations/0122_pending_object_deletions.sql': {
    role: 'migration',
    why: 'retention function reads the date (applied; immutable).',
  },
  'packages/db/migrations/0160_ever_paid.sql': {
    role: 'migration',
    why: 'ever-paid backfill reads the date (applied; immutable).',
  },
  'packages/db/migrations/0161_retention_lock_business.sql': {
    role: 'migration',
    why: 'retention function reads the date (applied; immutable).',
  },
  'packages/db/migrations/0181_sweep_trial_candidates.sql': {
    role: 'migration',
    why: 'trial-notice candidate function reads the date (applied; immutable).',
  },
};

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
  return {
    sql: [
      String.raw`(?:\bSET|,)${GAP}(?:"?\w+"?\.)?"?${sql}"?${GAP}=(?!=)`,
      String.raw`(?:\bSET|,)${GAP}\([^)]*(?<![\w$])${sql}(?![\w$])[^)]*\)${GAP}=(?!=)`,
    ],
    builder: String.raw`\.set\(\s*\{(?:[^;]{0,2000}?,)?${JS_GAP}["'\x60]?${key}["'\x60]?${JS_GAP}[:,}]`,
  };
}
const EXPIRY_ALT = assignmentAlternatives('plan_expires_at', 'plan_?expires_?at');
const SQL_ASSIGNMENT = new RegExp(EXPIRY_ALT.sql.join('|'), 'i');
const BUILDER_ASSIGNMENT = new RegExp(EXPIRY_ALT.builder, 'i');
/** Whole-file hints that the businesses table is written: an UPDATE or an INSERT, builder or raw. */
const UPDATE_HINT =
  /\.update\(\s*(?:\w+\.)*businesses\s*\)|\bUPDATE\s+(?:public\.)?"?businesses"?\b/i;
const INSERT_HINT =
  /\.insert\(\s*(?:\w+\.)*businesses\s*\)|\bINSERT\s+INTO\s+(?:public\.)?"?businesses"?\b/i;

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
  /** `.insert(businesses)` or `INSERT INTO businesses` statements. */
  businessInserts: number;
  why: string;
}

export const PINS: Readonly<Record<string, Pin>> = {
  'packages/db/src/repos/subscriptions.ts': {
    plan: 2,
    expiry: 1,
    businessInserts: 0,
    why: 'writeSubscriptionState (plan and date together) and the lapse to expired (plan only, guarded on the previous plan).',
  },
  'packages/db/migrations/0017_trial_expiry.sql': {
    plan: 0,
    expiry: 1,
    businessInserts: 0,
    why: 'one-off backfill of the trial expiry for rows that existed then (applied; immutable).',
  },
  'packages/db/src/repos/identity.ts': {
    plan: 0,
    expiry: 0,
    businessInserts: 1,
    why: 'createBusinessWithOwner: the one insert, which starts the trial clock; the plan comes from the column default.',
  },
};

const ASSIGN = (col: 'plan' | 'plan_expires_at'): string => {
  const alt =
    col === 'plan'
      ? assignmentAlternatives('plan', 'plan')
      : assignmentAlternatives('plan_expires_at', 'plan_?expires_?at');
  return [...alt.sql, alt.builder].join('|');
};

function count(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length;
}

/** Assignments to `plan` and to `plan_expires_at`, and businesses inserts, in one file's text. */
export function countAssignments(text: string): { plan: number; expiry: number; inserts: number } {
  return {
    plan: count(new RegExp(ASSIGN('plan'), 'gi'), text),
    expiry: count(new RegExp(ASSIGN('plan_expires_at'), 'gi'), text),
    inserts: count(new RegExp(INSERT_HINT.source, 'gi'), text),
  };
}

/** Every non-test file against the pins. A file with no pin must assign neither column. */
export function checkAssignmentPins(
  files: readonly ScannedFile[],
  pins: Readonly<Record<string, Pin>> = PINS,
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
  return /\.(?:test|spec)\.[a-z]+$/.test(path) || path.split('/').includes('e2e');
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
  allowed: Readonly<Record<string, Entry>> = ALLOWED,
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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('G-62: files that may touch plan_expires_at', () => {
  it('the repository matches the reviewed list exactly', () => {
    const files = collectSourceFiles(REPO_ROOT, ['apps', 'packages', 'scripts', 'deploy']);
    expect(files.length).toBeGreaterThan(500); // the walk found the code, not an empty tree
    expect(checkPlanExpiryFiles(files)).toEqual([]);
  });

  it('plan and plan_expires_at are assigned only as many times as each writer is pinned for', () => {
    const files = collectSourceFiles(REPO_ROOT, ['apps', 'packages', 'scripts', 'deploy']);
    expect(checkAssignmentPins(files)).toEqual([]);
  });

  it('every entry explains itself', () => {
    for (const [path, e] of Object.entries(ALLOWED)) {
      expect(e.why.length, path).toBeGreaterThan(20);
    }
    const writers = Object.entries(ALLOWED)
      .filter(([, e]) => e.role === 'writer')
      .map(([p]) => p)
      .sort();
    // Adding a writer is a decision: it changes this line on purpose.
    expect(writers).toEqual([
      'packages/db/src/repos/identity.ts',
      'packages/db/src/repos/subscriptions.ts',
    ]);
  });
});

describe('checkPlanExpiryFiles (detection behaviour)', () => {
  const allowed = {
    'src/writer.ts': { role: 'writer' as const, why: 'the single writer of the date' },
    'src/reader.ts': { role: 'reader' as const, why: 'reads the date for display only' },
  };
  const writer: ScannedFile = {
    path: 'src/writer.ts',
    text: 'UPDATE businesses SET plan_expires_at = $1',
  };
  const reader: ScannedFile = {
    path: 'src/reader.ts',
    text: 'SELECT plan_expires_at FROM businesses',
  };
  const run = (files: ScannedFile[]) => checkPlanExpiryFiles(files, allowed);

  it('passes when the files are exactly the listed ones', () => {
    expect(run([writer, reader])).toEqual([]);
  });

  it('fails for a new file that writes the column', () => {
    const out = run([
      writer,
      reader,
      { path: 'src/rogue.ts', text: 'sql`UPDATE businesses SET plan_expires_at = now()`' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('src/rogue.ts');
  });

  it('fails for a new file that only spells the property in camelCase', () => {
    const out = run([
      writer,
      reader,
      { path: 'src/other.ts', text: 'tx.update(businesses).set({ planExpiresAt: d })' },
    ]);
    expect(out.join('\n')).toContain('src/other.ts');
  });

  it('cannot be bypassed by moving a listed file: the new path is unlisted and the old one is stale', () => {
    const moved = { path: 'src/moved/writer.ts', text: writer.text };
    const out = run([moved, reader]);
    expect(out.some((m) => m.startsWith('src/moved/writer.ts'))).toBe(true);
    expect(out.some((m) => m.startsWith('src/writer.ts') && m.includes('no longer mentions'))).toBe(
      true,
    );
  });

  it('cannot be bypassed by copying the writer into a second file', () => {
    const out = run([writer, reader, { path: 'src/copy.ts', text: writer.text }]);
    expect(out.some((m) => m.startsWith('src/copy.ts'))).toBe(true);
  });

  it('flags a listed file that has been emptied of the column, so an entry cannot sit unused', () => {
    const out = run([writer, { path: 'src/reader.ts', text: 'export {}' }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('no longer mentions');
  });

  it('flags a reader that starts assigning the column in SQL', () => {
    const out = run([writer, { path: 'src/reader.ts', text: 'UPDATE x SET plan_expires_at = $1' }]);
    expect(out.join('\n')).toContain('assigns plan_expires_at');
  });

  it('flags a reader that starts writing the businesses table through the builder', () => {
    const out = run([
      writer,
      {
        path: 'src/reader.ts',
        text: 'const d = row.planExpiresAt; await tx.update(businesses).set(x);',
      },
    ]);
    expect(out.join('\n')).toContain('writes the businesses table');
  });

  it('a reader marked as updating other columns skips the table hint but not the SQL-assignment check', () => {
    const a = {
      ...allowed,
      'src/reader.ts': { ...allowed['src/reader.ts'], writesOtherColumns: true },
    };
    const ok = checkPlanExpiryFiles(
      [writer, { path: 'src/reader.ts', text: 'plan_expires_at; UPDATE businesses SET x = 1' }],
      a,
    );
    expect(ok).toEqual([]);
    const bad = checkPlanExpiryFiles(
      [writer, { path: 'src/reader.ts', text: 'UPDATE businesses SET plan_expires_at = 1' }],
      a,
    );
    expect(bad.join('\n')).toContain('assigns plan_expires_at');
  });

  it('a reader that updates other columns still fails if it gains an insert into businesses', () => {
    const a = {
      ...allowed,
      'src/reader.ts': { ...allowed['src/reader.ts'], writesOtherColumns: true },
    };
    for (const text of [
      'plan_expires_at; await tx.insert(businesses).values(v)',
      'plan_expires_at; INSERT INTO businesses (id, plan_expires_at) VALUES ($1, $2)',
    ]) {
      expect(
        checkPlanExpiryFiles([writer, { path: 'src/reader.ts', text }], a).join('\n'),
      ).toContain('writes the businesses table');
    }
  });

  it('scans shell scripts, which can carry SQL for psql', () => {
    const sh: ScannedFile = {
      path: 'scripts/x.sh',
      text: 'psql -c "UPDATE businesses SET plan_expires_at = now()"',
    };
    expect(SOURCE_EXT.test(sh.path)).toBe(true);
    expect(run([writer, reader, sh]).join('\n')).toContain('scripts/x.sh');
  });

  it('catches a quoted or qualified assignment, and ignores an equality predicate', () => {
    const a = {
      ...allowed,
      'src/reader.ts': { ...allowed['src/reader.ts'], writesOtherColumns: true },
    };
    const hit = (text: string) =>
      checkPlanExpiryFiles([writer, { path: 'src/reader.ts', text }], a).join('\n');
    expect(hit('x SET "plan_expires_at" = $1')).toContain('assigns plan_expires_at');
    expect(hit('x SET plan = $1, b.plan_expires_at = $2')).toContain('assigns plan_expires_at');
    expect(hit('x SET\n  plan = $1,\n  "plan_expires_at"=$2')).toContain('assigns plan_expires_at');
    expect(hit('SELECT 1 WHERE plan_expires_at = $1')).toBe('');
    expect(hit('SELECT 1 WHERE a = 1 AND "plan_expires_at" = $1')).toBe('');
  });

  it('catches a tuple assignment that includes the column', () => {
    const a = {
      ...allowed,
      'src/reader.ts': { ...allowed['src/reader.ts'], writesOtherColumns: true },
    };
    const hit = (text: string) =>
      checkPlanExpiryFiles([writer, { path: 'src/reader.ts', text }], a).join('\n');
    expect(
      hit('UPDATE businesses SET (retention_notified_at, plan_expires_at) = (now(), now())'),
    ).toContain('assigns plan_expires_at');
    expect(hit('UPDATE businesses SET a = 1, ("plan_expires_at", b) = ($1, $2)')).toContain(
      'assigns plan_expires_at',
    );
    expect(hit('SELECT 1 WHERE (a, plan_expires_at) = ($1, $2)')).toBe('');
  });

  it('matches the whole column name inside a tuple, not a longer identifier', () => {
    const a = {
      ...allowed,
      'src/reader.ts': { ...allowed['src/reader.ts'], writesOtherColumns: true },
    };
    const hit = (text: string) =>
      checkPlanExpiryFiles([writer, { path: 'src/reader.ts', text }], a).join('\n');
    expect(
      hit('plan_expires_at; UPDATE businesses SET (a, plan_expires_at_backup) = ($1, $2)'),
    ).toBe('');
    expect(hit('plan_expires_at; UPDATE businesses SET (a, x_plan_expires_at) = ($1, $2)')).toBe(
      '',
    );
    expect(hit('UPDATE businesses SET (a, "plan_expires_at") = ($1, $2)')).toContain(
      'assigns plan_expires_at',
    );
  });

  it('sees an assignment separated from SET or a comma by SQL comments', () => {
    const a = {
      ...allowed,
      'src/reader.ts': { ...allowed['src/reader.ts'], writesOtherColumns: true },
    };
    const hit = (text: string) =>
      checkPlanExpiryFiles([writer, { path: 'src/reader.ts', text }], a).join('\n');
    expect(hit('UPDATE businesses SET /* why */ plan_expires_at = $1')).toContain(
      'assigns plan_expires_at',
    );
    expect(hit('UPDATE businesses SET a = 1,\n -- note\n plan_expires_at = $1')).toContain(
      'assigns plan_expires_at',
    );
    expect(hit('UPDATE businesses SET /* x */ (a, plan_expires_at) = ($1, $2)')).toContain(
      'assigns plan_expires_at',
    );
  });

  it('catches a builder assignment in a reader that updates other columns, whatever the table is called', () => {
    const a = {
      ...allowed,
      'src/reader.ts': { ...allowed['src/reader.ts'], writesOtherColumns: true },
    };
    const hit = (text: string) =>
      checkPlanExpiryFiles([writer, { path: 'src/reader.ts', text }], a).join('\n');
    expect(hit('plan_expires_at; await tx.update(businesses).set({ planExpiresAt: d })')).toContain(
      'assigns plan_expires_at',
    );
    expect(
      hit('plan_expires_at; await tx.update(schema.businesses).set({ a: 1, planExpiresAt: d })'),
    ).toContain('assigns plan_expires_at');
    expect(hit('plan_expires_at; await tx.update(biz).set({ a: 1 })')).toBe('');
  });

  it('does not treat an == after a SET or comma prefix as an assignment', () => {
    const hit = (text: string) =>
      checkPlanExpiryFiles([writer, { path: 'src/reader.ts', text }], allowed).join('\n');
    expect(hit('x SET plan_expires_at == $1')).toBe('');
    expect(hit('x SET a = 1, plan_expires_at == $1')).toBe('');
  });

  it('sees a comment between the column and the equals sign', () => {
    const a = {
      ...allowed,
      'src/reader.ts': { ...allowed['src/reader.ts'], writesOtherColumns: true },
    };
    const hit = (text: string) =>
      checkPlanExpiryFiles([writer, { path: 'src/reader.ts', text }], a).join('\n');
    expect(hit('UPDATE businesses SET plan_expires_at /* why */ = now()')).toContain(
      'assigns plan_expires_at',
    );
    expect(hit('UPDATE businesses SET (a, plan_expires_at) -- note\n = ($1, $2)')).toContain(
      'assigns plan_expires_at',
    );
    expect(hit('x SET plan_expires_at /* c */ == $1')).toBe('');
  });

  it('matches the builder property, not a value that mentions the column', () => {
    const a = {
      ...allowed,
      'src/reader.ts': { ...allowed['src/reader.ts'], writesOtherColumns: true },
    };
    const hit = (text: string) =>
      checkPlanExpiryFiles([writer, { path: 'src/reader.ts', text }], a).join('\n');
    expect(hit('plan_expires_at; tx.update(other).set({ scheduledAt: planExpiresAt })')).toBe('');
    expect(hit('plan_expires_at; tx.update(other).set({ a: planExpiresAt, b: 1 })')).toBe('');
    expect(hit('plan_expires_at; tx.update(x).set({ planExpiresAt })')).toContain(
      'assigns plan_expires_at',
    );
    expect(hit('plan_expires_at; tx.update(x).set({ a: 1, planExpiresAt })')).toContain(
      'assigns plan_expires_at',
    );
    expect(
      hit('plan_expires_at; tx.update(x).set({ a: planExpiresAt, planExpiresAt: d })'),
    ).toContain('assigns plan_expires_at');
  });

  it('recognises quoted and comment-separated builder keys', () => {
    const a = {
      ...allowed,
      'src/reader.ts': { ...allowed['src/reader.ts'], writesOtherColumns: true },
    };
    const hit = (text: string) =>
      checkPlanExpiryFiles([writer, { path: 'src/reader.ts', text }], a).join('\n');
    expect(hit('plan_expires_at; tx.update(x).set({ "planExpiresAt": d })')).toContain(
      'assigns plan_expires_at',
    );
    expect(hit("plan_expires_at; tx.update(x).set({ 'planExpiresAt': d })")).toContain(
      'assigns plan_expires_at',
    );
    expect(hit('plan_expires_at; tx.update(x).set({ /* reason */ planExpiresAt: d })')).toContain(
      'assigns plan_expires_at',
    );
    expect(hit('plan_expires_at; tx.update(x).set({ a: 1, // why\n planExpiresAt: d })')).toContain(
      'assigns plan_expires_at',
    );
    expect(hit('plan_expires_at; tx.update(x).set({ scheduledAt: "planExpiresAt" })')).toBe('');
  });

  it('fails when a scan root cannot be read instead of treating it as empty', () => {
    expect(() => collectSourceFiles(REPO_ROOT, ['no-such-root-for-g62'])).toThrow();
  });

  it('does not mistake a comparison for an assignment', () => {
    const text =
      'WHERE plan_expires_at <= now() AND plan_expires_at >= a AND plan_expires_at != b AND plan_expires_at == c';
    expect(run([writer, { path: 'src/reader.ts', text }])).toEqual([]);
  });

  it('is conservative: a mention in a comment still needs a listed file', () => {
    const out = run([
      writer,
      reader,
      { path: 'src/note.ts', text: '// plan_expires_at is set elsewhere' },
    ]);
    expect(out.join('\n')).toContain('src/note.ts');
  });

  it('ignores test files and generated migration snapshots', () => {
    const out = run([
      writer,
      reader,
      { path: 'src/a.test.ts', text: 'plan_expires_at = 1' },
      { path: 'src/a.integration.test.ts', text: 'planExpiresAt' },
      { path: 'apps/web/e2e/x.spec.ts', text: 'plan_expires_at = 1' },
      { path: 'packages/db/migrations/meta/0001_snapshot.json', text: 'plan_expires_at' },
    ]);
    expect(out).toEqual([]);
  });

  it('flags an unreviewed migration that touches the column', () => {
    const out = run([
      writer,
      reader,
      {
        path: 'packages/db/migrations/0999_x.sql',
        text: 'UPDATE businesses SET plan_expires_at = now();',
      },
    ]);
    expect(out.join('\n')).toContain('0999_x.sql');
  });

  it('isTestFile only matches test and spec names or an e2e directory', () => {
    expect(isTestFile('a/b.test.ts')).toBe(true);
    expect(isTestFile('a/b.spec.tsx')).toBe(true);
    expect(isTestFile('apps/web/e2e/b.ts')).toBe(true);
    expect(isTestFile('a/contest.ts')).toBe(false);
    expect(isTestFile('a/b.ts')).toBe(false);
  });
});

describe('checkAssignmentPins (detection behaviour)', () => {
  const pins = {
    'src/writer.ts': { plan: 2, expiry: 1, businessInserts: 0, why: 'the pinned writer' },
  };
  const WRITER = [
    'UPDATE businesses SET plan = $1, plan_expires_at = $2 WHERE id = $3;',
    "UPDATE businesses SET plan = 'expired' WHERE id = $1;",
  ].join('\n');
  const run = (files: ScannedFile[]) => checkAssignmentPins(files, pins);
  const writer: ScannedFile = { path: 'src/writer.ts', text: WRITER };

  it('passes when the writer holds exactly its pinned assignments', () => {
    expect(run([writer, { path: 'src/other.ts', text: 'SELECT plan FROM businesses' }])).toEqual(
      [],
    );
  });

  it('flags a new file that assigns plan alone, which the expiry-name check cannot see', () => {
    const out = run([writer, { path: 'src/new.ts', text: "UPDATE businesses SET plan = 'chat'" }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('src/new.ts');
  });

  it('flags a builder assignment of plan in a new file', () => {
    const out = run([writer, { path: 'src/new.ts', text: "tx.update(b).set({ plan: 'chat' })" }]);
    expect(out.join('\n')).toContain('src/new.ts');
  });

  it('flags a second write added INSIDE the pinned writer', () => {
    const grown = {
      ...writer,
      text: `${WRITER}\nUPDATE businesses SET plan = 'chat' WHERE id = $1;`,
    };
    const out = run([grown]);
    expect(out.join('\n')).toContain('assigns plan 3 time(s), pinned at 2');
  });

  it('flags a new expiry assignment inside the pinned writer', () => {
    const grown = { ...writer, text: `${WRITER}\nUPDATE businesses SET plan_expires_at = now();` };
    expect(run([grown]).join('\n')).toContain('assigns plan_expires_at 2 time(s), pinned at 1');
  });

  it('flags a writer that lost one of its writes, so a pin cannot rot', () => {
    const shrunk = { ...writer, text: WRITER.split('\n')[0] ?? '' };
    expect(run([shrunk]).join('\n')).toContain('assigns plan 1 time(s), pinned at 2');
  });

  it('flags a pinned file that has moved', () => {
    expect(run([{ path: 'src/moved.ts', text: WRITER }]).join('\n')).toContain(
      'src/writer.ts: pinned but not found',
    );
  });

  it('does not mistake pending_plan, plan_decided_at or a plan predicate for assigning plan', () => {
    const readers = [
      "UPDATE businesses SET pending_plan = 'chat', plan_decided_at = now() WHERE plan = 'trial'",
      'UPDATE businesses SET plan_version_id = $1 WHERE id = $2 AND plan = $3',
      'SELECT id FROM businesses WHERE plan = $1 AND plan_expires_at > now()',
    ].join('\n');
    expect(run([writer, { path: 'src/ok.ts', text: readers }])).toEqual([]);
  });

  it('catches a tuple assignment of plan and a quoted one', () => {
    const out = run([
      writer,
      { path: 'src/a.ts', text: 'UPDATE businesses SET (plan, updated_at) = ($1, now())' },
      { path: 'src/b.ts', text: 'UPDATE businesses SET "plan" = $1' },
    ]);
    expect(out.some((m) => m.startsWith('src/a.ts'))).toBe(true);
    expect(out.some((m) => m.startsWith('src/b.ts'))).toBe(true);
  });

  it('ignores test files', () => {
    expect(
      run([writer, { path: 'src/x.test.ts', text: "UPDATE businesses SET plan = 'chat'" }]),
    ).toEqual([]);
  });

  it('pins the insert count where a pin names one', () => {
    const idPins = { 'src/id.ts': { plan: 0, expiry: 0, businessInserts: 1, why: 'trial insert' } };
    const one = { path: 'src/id.ts', text: 'tx.insert(businesses).values(x)' };
    expect(checkAssignmentPins([one], idPins)).toEqual([]);
    const two = { ...one, text: `${one.text}; tx.insert(businesses).values(y)` };
    expect(checkAssignmentPins([two], idPins).join('\n')).toContain('inserts into businesses 2');
  });
});

describe('assignment patterns stay linear on large files', () => {
  it('scans a 300 KB file with many block comments in well under a second', () => {
    // Consecutive block comments after a comma: with a lazy comment pattern this hung (50 repeats never finished).
    const chunk = ', /* a */ /* b */ /* c */ /* d */ z;\n';
    const text = chunk.repeat(6_000);
    const started = Date.now();
    const got = countAssignments(text);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(got.plan).toBe(0);
  });
});

describe('builder assignments and comment patterns (review of 073f828)', () => {
  const hit = (text: string) => countAssignments(text).plan;

  it('catches shorthand, spread, quoted and nested-object forms of a plan assignment', () => {
    expect(hit('tx.update(b).set({ updatedAt: d, plan })')).toBe(1);
    expect(hit('tx.update(b).set({ ...rest, plan })')).toBe(1);
    expect(hit('tx.update(b).set({ "plan": x })')).toBe(1);
    expect(hit('tx.update(b).set({ meta: { a: 1 }, plan: x })')).toBe(1);
    expect(hit('tx.update(b).set({ u: sql`${a}`, plan: x })')).toBe(1);
  });

  it('does not read pending_plan, plan_decided_at or a later statement as a plan assignment', () => {
    expect(hit('tx.update(b).set({ pendingPlan: x, planDecidedAt: d })')).toBe(0);
    expect(hit('tx.update(b).set({ a: 1 });\nfoo(plan, y);')).toBe(0);
    expect(hit('tx.update(b).set({ a: obj.plan })')).toBe(0);
  });

  it('stays linear on adjacent block comments in a builder call and on many later comments', () => {
    const adjacent = `x.set({ ${'/* a */ '.repeat(60)}y: 1 }); plan_expires_at`;
    const many = `${'.set({ /* note */ y: 1 });\n'.repeat(300)}${'/* z */\n'.repeat(300)}`;
    const started = Date.now();
    const reader: ScannedFile = { path: 'src/r.ts', text: adjacent };
    const allowed = { 'src/r.ts': { role: 'reader' as const, why: 'reads the date for display' } };
    checkPlanExpiryFiles([reader], allowed);
    checkPlanExpiryFiles([{ path: 'src/r.ts', text: `${many}plan_expires_at` }], allowed);
    countAssignments(adjacent + many);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('shared assignment patterns (review of 073f828)', () => {
  const counts = (text: string) => countAssignments(text);

  it('sees SQL comments between the column and the equals sign, for both columns', () => {
    expect(counts('UPDATE businesses SET plan /* why */ = $1').plan).toBe(1);
    expect(counts('UPDATE businesses SET plan_expires_at -- why\n = $1').expiry).toBe(1);
  });

  it('sees quoted, shorthand and commented keys for both columns', () => {
    expect(counts("tx.update(b).set({ 'plan_expires_at': x })").expiry).toBe(1);
    expect(counts('tx.update(b).set({ plan_expires_at })').expiry).toBe(1);
    expect(counts('tx.update(b).set({ /* why */ plan_expires_at: x })').expiry).toBe(1);
    expect(counts('tx.update(b).set({ /* why */ plan: x })').plan).toBe(1);
  });

  it('does not read a VALUE named plan or plan_expires_at as a key', () => {
    expect(counts('tx.update(b).set({ x: plan })')).toMatchObject({ plan: 0 });
    expect(counts('tx.update(b).set({ x: plan, y: z })')).toMatchObject({ plan: 0 });
    expect(counts('tx.update(b).set({ x: plan_expires_at })')).toMatchObject({ expiry: 0 });
  });
});

describe('long builder objects and qualified table names (review of 81f18b1)', () => {
  it('sees a plan key after a long run of other keys in one .set() object', () => {
    const others = Array.from({ length: 60 }, (_, i) => `field${i}: value${i}`).join(', ');
    expect(others.length).toBeGreaterThan(400);
    expect(countAssignments(`tx.update(b).set({ ${others}, plan: x })`).plan).toBe(1);
  });

  it('counts a businesses insert or update through a qualified table name', () => {
    const idPins = { 'src/id.ts': { plan: 0, expiry: 0, businessInserts: 1, why: 'trial insert' } };
    const two = {
      path: 'src/id.ts',
      text: 'tx.insert(businesses).values(x); tx.insert(schema.businesses).values(y)',
    };
    expect(checkAssignmentPins([two], idPins).join('\n')).toContain('inserts into businesses 2');
    const allowed = { 'src/r.ts': { role: 'reader' as const, why: 'reads the date for display' } };
    const reader = {
      path: 'src/r.ts',
      text: 'row.planExpiresAt; tx.update(schema.businesses).set(x)',
    };
    expect(checkPlanExpiryFiles([reader], allowed).join('\n')).toContain(
      'writes the businesses table',
    );
  });
});
