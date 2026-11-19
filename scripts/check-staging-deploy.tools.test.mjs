/**
 * G-119 / OWN-77: the staging tools flag never appears in the production compose file. G-74 and
 * OWN-93: `--no-deps` stays refused in the deploy script except on the one-off template check. Run with
 * `node --test scripts/check-staging-deploy.tools.test.mjs` (CI does, beside the staging guard).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { problemsFor, readFiles } from './check-staging-deploy.mjs';

const REAL = readFiles();

test('the committed production compose file does not name REKODA_STAGING_TOOLS', () => {
  assert.ok(!/REKODA_STAGING_TOOLS/.test(REAL.compose));
  assert.deepEqual(problemsFor(REAL), []);
});

for (const line of [
  '      REKODA_STAGING_TOOLS: "1"',
  '      REKODA_STAGING_TOOLS: "0"',
  '      - REKODA_STAGING_TOOLS=${REKODA_STAGING_TOOLS:-0}',
]) {
  test(`a compose file that names the flag is refused: ${line.trim()}`, () => {
    const found = problemsFor({ ...REAL, compose: `${REAL.compose}\n${line}\n` });
    assert.ok(
      found.some((p) => /REKODA_STAGING_TOOLS/.test(p)),
      `expected a problem, got:\n  ${found.join('\n  ') || '(none)'}`,
    );
  });
}

const CHECK =
  'template_report=$(dc run --rm -T --no-deps api node dist/template-check.js) || template_rc=$?';

test('OWN-93: the deploy runs the one-off template check with --no-deps, and the guard allows that line only', () => {
  assert.ok(REAL.script.split('\n').some((l) => l.trim() === CHECK));
  for (const line of [
    'dc up -d --no-deps api',
    'dc run --rm -T --no-deps migrate',
    `${CHECK} ; dc up -d --no-deps caddy`,
    'dc up -d --scale api=2',
  ]) {
    const found = problemsFor({ ...REAL, script: `${REAL.script}\n${line}\n` });
    assert.ok(
      found.some((p) => p.includes('can start Caddy past the edge check')),
      `expected ${line} to be refused, got:\n  ${found.join('\n  ') || '(none)'}`,
    );
  }
});
