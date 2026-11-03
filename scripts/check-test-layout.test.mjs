import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from './check-test-layout.mjs';

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
