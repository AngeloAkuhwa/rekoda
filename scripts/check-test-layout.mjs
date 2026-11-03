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
import { pathToFileURL } from 'node:url';

const MAX_LINES = 600;
// Any tracked file that looks like a test, whatever its extension, so an unknown
// suffix (a.test.js) reaches check() and is rejected there instead of vanishing.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Pure: the test candidates among tracked paths. */
export function discover(paths) {
  return paths.filter((p) => TEST_FILE.test(p));
}

/** Pure: lines in a file, not counting the empty entry after a final newline. */
export function countLines(text) {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

// Where a test may live: a directory the runners discover. Every workspace unit and integration
// config includes `src/**`, Playwright's testDir is apps/web/e2e, and scripts/ has its own runner.
const TEST_HOME = /^(apps|packages)\/[^/]+\/src\/|^apps\/web\/e2e\/|^scripts\//;

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
    if (!TEST_HOME.test(path)) {
      errors.push(
        `${path}: outside src/ of an app or package, apps/web/e2e/ and scripts/ (the runners find tests only there)`,
      );
    }
    if (/\.integration\.test\./.test(path) && !/^(apps\/api|packages\/db)\/src\//.test(path)) {
      errors.push(
        `${path}: integration tests run only in apps/api and packages/db (the only packages with an integration runner)`,
      );
    }
    if (path.startsWith('scripts/') && !/\.test\.mjs$/.test(path)) {
      errors.push(`${path}: scripts/ holds .test.mjs files only (CI runs them with node --test)`);
    }
    if (/\.test\.tsx$/.test(path) && !path.startsWith('apps/web/')) {
      errors.push(`${path}: .test.tsx runs only in apps/web (other unit configs match *.test.ts)`);
    }
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
  const listed = discover(
    execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64e6 }).split('\0'),
  ).filter((p) => existsSync(p));
  const files = listed.map((path) => ({
    path,
    lines: countLines(readFileSync(path, 'utf8')),
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
