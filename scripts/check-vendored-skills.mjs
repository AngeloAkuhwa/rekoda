/**
 * The vendored design skills under `.claude/skills/` stay what was reviewed.
 *
 * They are third-party instructions and scripts an agent reads (PR #317,
 * `.claude/skills/SOURCES.md`). Two ways they can drift without anyone
 * noticing, both of which happened once before review caught them:
 *   1. a file is edited, added or dropped, so the folder no longer equals the
 *      upstream commit it claims to be. Each skill must hash to the value in
 *      `skills-lock.json` (Impeccable, copied by hand, to IMPECCABLE_HASH,
 *      which `SOURCES.md` also records);
 *   2. a repo-wide ignore rule swallows part of a skill. The `data/` rule did
 *      exactly that to Impeccable's `scripts/data/` until the negation
 *      `!/.claude/skills/**\/data/` was added. No path under `.claude/skills`
 *      may match an ignore rule.
 *
 * The hash is the `skills@1.7.4` installer's: SHA-256 over the folder's
 * files sorted by relative path (`localeCompare`), feeding each path and then
 * its bytes, skipping `.git` and `node_modules`. Only tracked files count, so
 * the check proves what is committed, not what happens to be on disk.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILLS_DIR = '.claude/skills';
export const IMPECCABLE_HASH = 'fb28833d2d55b7de536436e9e6f2b56138ad713598092249272e503f2aa54fb6';
// The file the `data/` rule once dropped; named so the failure is specific.
export const SENTINEL = '.claude/skills/impeccable/scripts/data/font-index-failures.json';

/** files: [{ relativePath, content: Buffer }] → hex digest, installer order. */
export function folderHash(files) {
  const sorted = [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const hash = createHash('sha256');
  for (const f of sorted) {
    hash.update(f.relativePath);
    hash.update(f.content);
  }
  return hash.digest('hex');
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function trackedFiles(root, skill) {
  const prefix = `${SKILLS_DIR}/${skill}/`;
  return git(root, ['ls-files', '-z', '--', prefix])
    .split('\0')
    .filter(Boolean)
    .filter((p) => !p.split('/').some((seg) => seg === '.git' || seg === 'node_modules'))
    .map((p) => ({ relativePath: p.slice(prefix.length), content: readFileSync(join(root, p)) }));
}

/** True when git would ignore `path` under the working tree's rules. */
export function isIgnored(root, path) {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '-q', '--', path], { cwd: root });
    return true;
  } catch (err) {
    if (err.status === 1) return false;
    throw err;
  }
}

export function problemsIn(root) {
  const problems = [];
  const lock = JSON.parse(readFileSync(join(root, 'skills-lock.json'), 'utf8'));
  const expected = Object.fromEntries(
    Object.entries(lock.skills).map(([k, v]) => [k, v.computedHash]),
  );
  expected.impeccable = IMPECCABLE_HASH;

  for (const [skill, want] of Object.entries(expected)) {
    const files = trackedFiles(root, skill);
    if (files.length === 0) {
      problems.push(`${skill}: no tracked files under ${SKILLS_DIR}/${skill}/`);
      continue;
    }
    const got = folderHash(files);
    if (got !== want) problems.push(`${skill}: hashes to ${got}, expected ${want}`);
  }

  if (!readFileSync(join(root, SKILLS_DIR, 'SOURCES.md'), 'utf8').includes(IMPECCABLE_HASH)) {
    problems.push(`SOURCES.md does not record the Impeccable hash ${IMPECCABLE_HASH}`);
  }

  const ignoredTracked = git(root, [
    'ls-files',
    '-z',
    '-ci',
    '--exclude-standard',
    '--',
    SKILLS_DIR,
  ])
    .split('\0')
    .filter(Boolean);
  for (const p of ignoredTracked) problems.push(`${p} is committed but matches an ignore rule`);
  if (isIgnored(root, SENTINEL)) problems.push(`${SENTINEL} matches an ignore rule`);

  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const problems = problemsIn(root);
  if (problems.length > 0) {
    console.error('Vendored skills differ from what was reviewed:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('See .claude/skills/SOURCES.md ("Verifying integrity", "Updating").');
    process.exit(1);
  }
  console.log(
    'Vendored skills match skills-lock.json and SOURCES.md; nothing under .claude/skills is ignored.',
  );
}
