/**
 * G-62 guard: which files may touch `businesses.plan_expires_at`.
 *
 * The expiry date is the cycle's bookkeeping anchor. G-62 was a second code path
 * that moved a business onto a plan and wrote the date without the rest of the
 * cycle (pending downgrade, failed-renewal clock, plan-version pin, anchor day).
 * It was fixed in #281 by routing every plan change through
 * `subscriptions.writeSubscriptionState`.
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
 *  - A listed writer can gain a second write inside the same file. The behaviour
 *    is held by the integration tests (`operator-plan-change`, `subscriptions`),
 *    not by this test.
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
/** `SET plan_expires_at = x` or `, plan_expires_at = x` (quoted or qualified too). A `WHERE`/`AND` equality predicate, `<=`, `>=`, `!=` and `==` do not match. */
const SQL_ASSIGNMENT = new RegExp(
  [
    // SET plan_expires_at = x, or , "t"."plan_expires_at" = x
    String.raw`(?:\bSET|,)\s*(?:"?\w+"?\.)?"?plan_expires_at"?\s*=(?!=)`,
    // SET (a, plan_expires_at) = (x, y), a tuple assignment
    String.raw`(?:\bSET|,)\s*\([^)]*(?<![\w$])plan_expires_at(?![\w$])[^)]*\)\s*=(?!=)`,
  ].join('|'),
  'i',
);
/** Whole-file hints that the businesses table is written: an UPDATE or an INSERT, builder or raw. */
const UPDATE_HINT = /\.update\(\s*businesses\s*\)|\bUPDATE\s+(?:public\.)?"?businesses"?\b/i;
const INSERT_HINT = /\.insert\(\s*businesses\s*\)|\bINSERT\s+INTO\s+(?:public\.)?"?businesses"?\b/i;

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
      if (SQL_ASSIGNMENT.test(text)) {
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
