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
 * It fails when any non-test file under `apps`, `packages`, `scripts` or `deploy`
 * (SCAN_ROOTS) with a `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.sql`
 * or `.sh` extension (SOURCE_EXT) mentions the column (either
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
 *  - Other directories (`.github`, `docs`, `design-system`) and other extensions
 *    (yml, json, python) are not scanned; none touches the column today.
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkAssignmentPins,
  checkPlanExpiryFiles,
  collectSourceFiles,
  countAssignments,
  isTestFile,
  SCAN_ROOTS,
  SOURCE_EXT,
  type Entry,
  type Pin,
  type ScannedFile,
} from './plan-expiry-files.checker.js';

export type { Entry, Pin, Role, ScannedFile } from './plan-expiry-files.checker.js';

export { ALLOWED } from './plan-expiry-files.allowed.js';
import { ALLOWED } from './plan-expiry-files.allowed.js';

export const PINS: Readonly<Record<string, Pin>> = {
  'packages/db/src/repos/subscriptions.ts': {
    plan: 0,
    expiry: 0,
    businessInserts: 0,
    why: 'OD-37: no direct assignment any more; writeSubscriptionState and expireSubscription call the 0200 database writers.',
  },
  'packages/db/src/testing.ts': {
    plan: 2,
    expiry: 2,
    businessInserts: 0,
    why: 'OD-37: setPlanAsOwner (one owner-role UPDATE) and test_fixture_set_plan (installed by the test harness only, owned by rekoda_plan_writer); both refused for the application roles in production databases, where the fixture writer does not exist.',
  },
  'packages/db/migrations/0197_staging_test_business_tools.sql': {
    plan: 0,
    expiry: 1,
    businessInserts: 0,
    why: 'OWN-77: staging_move_date, the one staging-only path, through rekoda_plan_writer (OD-37).',
  },
  'packages/db/migrations/0200_plan_writer_boundary.sql': {
    plan: 3,
    expiry: 2,
    businessInserts: 0,
    why: 'OD-37/OWN-87: subscription_apply_paid_charge (plan from the charge, and the date) and subscription_operator_set_plan (validated plan and date), plus subscription_expire_plan revalidated (plan only).',
  },
  'packages/db/migrations/0203_plan_duration_rules.sql': {
    plan: 3,
    expiry: 3,
    businessInserts: 0,
    why: 'OWN-89: the three writers re-created with the duration rules (operator writer: plan and date; provider writer: plan from the charge and the date; expiry writer: plan, and a future end clamped to now). All owned by rekoda_plan_writer.',
  },
  'packages/db/migrations/0206_paid_charge_bound_to_its_cycle.sql': {
    plan: 1,
    expiry: 1,
    businessInserts: 0,
    why: "OD-37 B3: the provider writer re-created, bound to the charge's frozen period (plan from the charge, and the date). Owned by rekoda_plan_writer.",
  },
  'packages/db/migrations/0207_operator_standard_periods.sql': {
    plan: 1,
    expiry: 1,
    businessInserts: 0,
    why: 'OD-50: the operator writer re-created so a paid plan or trial runs its standard period, computed by the database (validated plan and the date it computes). Owned by rekoda_plan_writer.',
  },
  'packages/db/migrations/0208_subscription_period_preflight.sql': {
    plan: 0,
    expiry: 1,
    businessInserts: 0,
    why: 'OD-49: correct_subscription_period, owner-only, sets the corrected end of one active business breaking the rules on an explicit call with an actor and a reason, audited; never the plan.',
  },
  'packages/db/migrations/0221_operator_writes_only_through_its_functions.sql': {
    plan: 1,
    expiry: 1,
    businessInserts: 0,
    why: 'OD-51 review fix: the 0207 operator writer re-created with the cycle recorded in SQL; plan and plan_expires_at assigned once each, exactly as before.',
  },
  'packages/db/migrations/0219_support_review_respects_later_schedule.sql': {
    plan: 1,
    expiry: 0,
    businessInserts: 0,
    why: 'OD-50 review follow-up: the 0213 resolution re-created with one more refusal; it still assigns the reviewed plan once and never the paid-through date.',
  },
  'packages/db/migrations/0213_support_review_plan_change.sql': {
    plan: 1,
    expiry: 0,
    businessInserts: 0,
    why: 'OD-50: subscription_operator_resolve_review assigns the reviewed plan once, for the open review of an active paid business, and never the paid-through date.',
  },
  'packages/db/migrations/0196_plan_fields_guard.sql': {
    plan: 2,
    expiry: 1,
    businessInserts: 0,
    why: 'OD-37: subscription_write_plan (plan and date together; dropped by 0200) and subscription_expire_plan (plan only, guarded on the previous plan; replaced by 0200). Applied history.',
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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe('G-62: files that may touch plan_expires_at', () => {
  it('the repository matches the reviewed list exactly', () => {
    const files = collectSourceFiles(REPO_ROOT, SCAN_ROOTS);
    expect(files.length).toBeGreaterThan(500); // the walk found the code, not an empty tree
    expect(checkPlanExpiryFiles(files, ALLOWED)).toEqual([]);
  });

  it('plan and plan_expires_at are assigned only as many times as each writer is pinned for', () => {
    const files = collectSourceFiles(REPO_ROOT, SCAN_ROOTS);
    expect(checkAssignmentPins(files, PINS)).toEqual([]);
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
      // OD-37: the owner-role fixture helper; the 0196 trigger refuses the application roles.
      'packages/db/src/testing.ts',
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
