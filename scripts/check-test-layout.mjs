/**
 * Test layout guard.
 *
 * Hard rules (always fail):
 *   1. every test file ends in `.test.ts(x)`, `.integration.test.ts`,
 *      `.test.mjs` (scripts only) or `.spec.ts` (Playwright only);
 *   2. `.spec.ts` lives only in `apps/web/e2e/`, and nothing else lives there;
 *   3. a `.test.mjs` lives only in `scripts/`;
 *   4. every file path named in docs/TEST_MAP.md exists.
 *
 * Layout debt (reported; fails only with --strict):
 *   5. no test file sits directly in `packages/db/src/` (feature folders);
 *   6. no test file is longer than 600 lines.
 * `--strict` is switched on in CI once the debt is cleared.
 *
 *   node scripts/check-test-layout.mjs [--strict]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const MAX_LINES = 600;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mjs)$/;

/** Pure: the findings for a list of `{ path, lines }` and the map text. */
export function check(files, mapText, exists = existsSync) {
  const errors = [];
  const debt = [];
  for (const { path, lines } of files) {
    const ok =
      /\.integration\.test\.ts$/.test(path) ||
      /\.test\.tsx?$/.test(path) ||
      /\.spec\.ts$/.test(path) ||
      /\.test\.mjs$/.test(path);
    if (!ok) errors.push(`${path}: unrecognised test file suffix`);
    const inE2e = path.startsWith('apps/web/e2e/');
    if (/\.spec\./.test(path) && !inE2e)
      errors.push(`${path}: .spec files belong in apps/web/e2e/`);
    if (inE2e && !/\.spec\.ts$/.test(path))
      errors.push(`${path}: apps/web/e2e/ holds .spec.ts files only`);
    if (/\.test\.mjs$/.test(path) && !path.startsWith('scripts/')) {
      errors.push(`${path}: .test.mjs belongs in scripts/`);
    }
    if (/^packages\/db\/src\/[^/]+$/.test(path)) {
      debt.push(`${path}: sits directly in packages/db/src/; move it into a feature folder`);
    }
    if (lines > MAX_LINES)
      debt.push(`${path}: ${lines} lines (over ${MAX_LINES}); split by concern`);
  }
  for (const m of mapText.matchAll(/`([\w@./\[\]-]+\.(?:test|spec)\.(?:ts|tsx|mjs))`/g)) {
    if (!exists(m[1])) errors.push(`docs/TEST_MAP.md: ${m[1]} does not exist`);
  }
  return { errors, debt };
}

function main() {
  const strict = process.argv.includes('--strict');
  const listed = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64e6 })
    .split('\n')
    .filter((p) => TEST_FILE.test(p) && existsSync(p));
  const files = listed.map((path) => ({
    path,
    lines: readFileSync(path, 'utf8').split('\n').length,
  }));
  const { errors, debt } = check(files, readFileSync('docs/TEST_MAP.md', 'utf8'));
  for (const e of errors) console.error(`ERROR ${e}`);
  for (const d of debt) console.error(`${strict ? 'ERROR' : 'warn '} ${d}`);
  console.log(
    `test layout: ${files.length} test files, ${errors.length} errors, ${debt.length} layout-debt items` +
      (strict ? ' (strict)' : ' (debt reported only)'),
  );
  process.exit(errors.length || (strict && debt.length) ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
