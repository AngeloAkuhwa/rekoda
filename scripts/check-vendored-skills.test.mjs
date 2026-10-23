/**
 * Fixtures for the vendored-skills guard. Run with
 * `node --test scripts/check-vendored-skills.test.mjs` (CI does, before the
 * guard itself).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  IMPECCABLE_HASH,
  SENTINEL,
  folderHash,
  ignoredUnder,
  isIgnored,
  problemsIn,
} from './check-vendored-skills.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEGATION = '!/.claude/skills/**/data/';

function scratchRepo(gitignore) {
  const dir = mkdtempSync(join(tmpdir(), 'skills-guard-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), gitignore);
  mkdirSync(join(dir, dirname(SENTINEL)), { recursive: true });
  writeFileSync(join(dir, SENTINEL), '[]');
  return dir;
}

test('the repo-wide data/ rule alone swallows the Impeccable data files', () => {
  const real = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  assert.ok(real.includes(NEGATION), 'the negation this test guards is missing from .gitignore');
  const without = real
    .split('\n')
    .filter((l) => l.trim() !== NEGATION)
    .join('\n');
  const dir = scratchRepo(without);
  try {
    assert.equal(isIgnored(dir, SENTINEL), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with the negation the data files are kept, and other data/ folders stay ignored', () => {
  const dir = scratchRepo(readFileSync(join(ROOT, '.gitignore'), 'utf8'));
  try {
    assert.equal(isIgnored(dir, SENTINEL), false);
    assert.equal(isIgnored(dir, 'data/x'), true);
    assert.equal(isIgnored(dir, 'apps/api/data/x'), true);
    assert.equal(isIgnored(dir, '.claude/skills/x/data/.env'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('folderHash follows the installer: sorted by path, path then bytes', () => {
  const a = { relativePath: 'b.md', content: Buffer.from('two') };
  const b = { relativePath: 'a.md', content: Buffer.from('one') };
  assert.equal(folderHash([a, b]), folderHash([b, a]));
  assert.notEqual(
    folderHash([b]),
    folderHash([{ relativePath: 'a.md', content: Buffer.from('onE') }]),
  );
  assert.notEqual(folderHash([a, b]), folderHash([b]));
});

test('an ignored asset anywhere under .claude/skills is reported, not just the sentinel', () => {
  const dir = scratchRepo('*.png\n');
  try {
    assert.deepEqual(ignoredUnder(dir), []);
    mkdirSync(join(dir, '.claude/skills/x/assets'), { recursive: true });
    writeFileSync(join(dir, '.claude/skills/x/assets/hero.png'), 'png');
    assert.deepEqual(ignoredUnder(dir), [
      '.claude/skills/x/assets/hero.png is on disk but an ignore rule keeps it out of the commit',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a skill folder with no recorded hash is reported', () => {
  const dir = scratchRepo('');
  try {
    writeFileSync(join(dir, 'skills-lock.json'), JSON.stringify({ version: 1, skills: {} }));
    writeFileSync(join(dir, '.claude/skills/SOURCES.md'), `Impeccable: ${IMPECCABLE_HASH}\n`);
    mkdirSync(join(dir, '.claude/skills/newskill'), { recursive: true });
    writeFileSync(join(dir, '.claude/skills/newskill/SKILL.md'), '# new\n');
    mkdirSync(join(dir, '.claude/skills/_licenses'), { recursive: true });
    writeFileSync(join(dir, '.claude/skills/_licenses/MIT.txt'), 'MIT\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const problems = problemsIn(dir);
    assert.ok(
      problems.includes(
        '.claude/skills/newskill/ has no recorded hash in skills-lock.json or IMPECCABLE_HASH',
      ),
      problems.join('\n'),
    );
    assert.ok(!problems.some((p) => p.startsWith('.claude/skills/_licenses/')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a skill folder that no longer hashes to its recorded value is reported', () => {
  const dir = scratchRepo('');
  try {
    writeFileSync(join(dir, 'skills-lock.json'), JSON.stringify({ version: 1, skills: {} }));
    writeFileSync(join(dir, '.claude/skills/SOURCES.md'), `Impeccable: ${IMPECCABLE_HASH}\n`);
    mkdirSync(join(dir, '.claude/skills/impeccable'), { recursive: true });
    writeFileSync(join(dir, '.claude/skills/impeccable/SKILL.md'), '# edited\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const problems = problemsIn(dir);
    assert.ok(
      problems.some(
        (p) => p.startsWith('impeccable: hashes to ') && p.endsWith(`expected ${IMPECCABLE_HASH}`),
      ),
      problems.join('\n'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a committed skill file that matches an ignore rule is reported', () => {
  const dir = scratchRepo('*.png\n');
  const ignored = '.claude/skills/x/assets/hero.png';
  try {
    writeFileSync(join(dir, 'skills-lock.json'), JSON.stringify({ version: 1, skills: {} }));
    writeFileSync(join(dir, '.claude/skills/SOURCES.md'), `Impeccable: ${IMPECCABLE_HASH}\n`);
    mkdirSync(join(dir, dirname(ignored)), { recursive: true });
    writeFileSync(join(dir, ignored), 'png');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['add', '-f', '--', ignored], { cwd: dir });
    const problems = problemsIn(dir);
    assert.ok(
      problems.includes(`${ignored} is committed but matches an ignore rule`),
      problems.join('\n'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a skill folder without its SKILL.md entrypoint is reported', () => {
  const dir = scratchRepo('');
  try {
    writeFileSync(join(dir, 'skills-lock.json'), JSON.stringify({ version: 1, skills: {} }));
    writeFileSync(join(dir, '.claude/skills/SOURCES.md'), `Impeccable: ${IMPECCABLE_HASH}\n`);
    mkdirSync(join(dir, '.claude/skills/impeccable'), { recursive: true });
    writeFileSync(join(dir, '.claude/skills/impeccable/SKILL.m'), 'd# renamed\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const problems = problemsIn(dir);
    assert.ok(problems.includes('impeccable: missing tracked SKILL.md'), problems.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
