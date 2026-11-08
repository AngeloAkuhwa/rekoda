/**
 * G-119 / OWN-77: the staging tools flag never appears in the production compose file. Run with
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
