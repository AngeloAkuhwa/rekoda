import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, countLines, discover } from './check-test-layout.mjs';

const f = (path, lines = 10) => ({ path, lines });
const run = (files, map = '', exists = () => true) => check(files, map, exists);

test('accepts the four recognised layers in their places', () => {
  const r = run([
    f('packages/core/src/money.test.ts'),
    f('packages/db/src/billing/usage.integration.test.ts'),
    f('apps/web/e2e/billing.spec.ts'),
    f('scripts/check-deploy.test.mjs'),
  ]);
  assert.deepEqual(r, { errors: [], debt: [] });
});

test('rejects an unknown suffix, a stray spec and a stray mjs test', () => {
  const r = run([
    f('packages/core/src/a.test.js'),
    f('apps/api/src/b.spec.ts'),
    f('apps/web/src/c.test.mjs'),
    f('apps/web/e2e/d.test.ts'),
  ]);
  assert.equal(r.errors.length, 4);
  assert.match(r.errors.join('\n'), /a\.test\.js: unrecognised/);
  assert.match(r.errors.join('\n'), /b\.spec\.ts: \.spec files belong/);
  assert.match(r.errors.join('\n'), /c\.test\.mjs: \.test\.mjs belongs/);
  assert.match(r.errors.join('\n'), /d\.test\.ts: apps\/web\/e2e\/ holds/);
});

test('reports a loose db test and an oversized file as debt, not errors', () => {
  const r = run([f('packages/db/src/usage.integration.test.ts', 700)]);
  assert.equal(r.errors.length, 0);
  assert.equal(r.debt.length, 2);
});

test('fails on a TEST_MAP path that no longer exists', () => {
  const map =
    'row `apps/api/src/billing/gone.integration.test.ts` and `packages/core/src/money.test.ts`';
  const r = run([], map, (p) => p.endsWith('money.test.ts'));
  assert.deepEqual(r.errors, [
    'docs/TEST_MAP.md: apps/api/src/billing/gone.integration.test.ts does not exist',
  ]);
});

test('the real repository has no hard-rule errors', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('node', ['scripts/check-test-layout.mjs'], { encoding: 'utf8' });
  assert.match(out, /0 errors/);
});

test('rejects .test.tsx outside apps/web and a top-level tests/ tree', () => {
  const r = run([
    f('apps/web/src/lib/a.test.tsx'),
    f('apps/api/src/billing/b.test.tsx'),
    f('packages/db/src/billing/c.test.tsx'),
    f('tests/d.test.ts'),
    f('apps/api/src/e.test.ts'),
  ]);
  const text = r.errors.join('\n');
  assert.equal(r.errors.length, 3);
  assert.match(text, /b\.test\.tsx: .test.tsx runs only in apps\/web/);
  assert.match(text, /c\.test\.tsx: .test.tsx runs only in apps\/web/);
  assert.match(text, /tests\/d\.test\.ts: outside src\//);
});

test('discovers candidates whatever their suffix, so a.test.js is not filtered away', () => {
  const paths = ['packages/core/src/a.test.js', 'x/y.spec.mts', 'src/readme.md', 'src/testing.ts'];
  assert.deepEqual(discover(paths), ['packages/core/src/a.test.js', 'x/y.spec.mts']);
});

test('counts lines, not the empty entry after a final newline', () => {
  assert.equal(countLines('a\nb\n'), 2);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines(''), 0);
  const body = `${'x\n'.repeat(600)}`;
  assert.equal(run([f('apps/api/src/z.test.ts', countLines(body))]).debt.length, 0);
});

test('the command line fails on an unknown suffix and runs from a path with a space', () => {
  const root = mkdtempSync(join(tmpdir(), 'layout cli '));
  try {
    const sh = (cmd) => {
      const r = spawnSync('bash', ['-c', cmd], { cwd: root, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    mkdirSync(join(root, 'docs'));
    mkdirSync(join(root, 'packages/core/src'), { recursive: true });
    writeFileSync(join(root, 'docs/TEST_MAP.md'), '');
    writeFileSync(join(root, 'packages/core/src/a.test.js'), 'x\n');
    sh('git init -q . && git add -A');
    const script = fileURLToPath(new URL('./check-test-layout.mjs', import.meta.url));
    const r = spawnSync('node', [script], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /a\.test\.js: unrecognised test file suffix/);
    assert.match(r.stdout, /1 test files, 1 errors/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a test outside a directory the runners discover (src/ or apps/web/e2e/)', () => {
  const r = run([
    f('apps/api/tests/a.test.ts'),
    f('packages/core/test/b.test.ts'),
    f('apps/web/src/lib/c.test.ts'),
    f('apps/web/e2e/d.spec.ts'),
    f('scripts/e.test.mjs'),
  ]);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors.join('\n'), /apps\/api\/tests\/a\.test\.ts: .*src\//);
  assert.match(r.errors.join('\n'), /packages\/core\/test\/b\.test\.ts: .*src\//);
});

test('the command line reads paths with non-ASCII names, which git quotes by default', () => {
  const root = mkdtempSync(join(tmpdir(), 'layout nonascii '));
  try {
    const sh = (cmd) => {
      const r = spawnSync('bash', ['-c', cmd], { cwd: root, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    mkdirSync(join(root, 'docs'));
    mkdirSync(join(root, 'apps/api/src'), { recursive: true });
    writeFileSync(join(root, 'docs/TEST_MAP.md'), '');
    writeFileSync(join(root, 'apps/api/src/état.test.js'), 'x\n');
    sh('git init -q . && git add -A');
    const script = fileURLToPath(new URL('./check-test-layout.mjs', import.meta.url));
    const r = spawnSync('node', [script], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /état\.test\.js: unrecognised test file suffix/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
