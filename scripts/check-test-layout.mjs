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
 *   5. no test file sits directly in `packages/db/src/` (feature folders);
 *   6. the size ratchet, against scripts/test-layout-baseline.json:
 *      - a test file over 600 lines that is not in the baseline fails;
 *      - a baselined file that grows past its recorded size fails;
 *      - a baselined file now at 600 lines or fewer, or no longer present,
 *        fails until its baseline entry is removed (the baseline only shrinks).
 *
 *   7. with `--base-ref <ref>` (CI passes the pull request's target branch), the
 *      baseline itself may not gain an entry or raise one compared with that
 *      ref's copy, so the ratchet cannot be loosened by editing its own file.
 *
 * Layout debt (reported; fails only with --strict): a baselined file still
 * over 600 lines. `--strict` is switched on in CI once the baseline is empty.
 *
 *   node scripts/check-test-layout.mjs [--strict] [--base-ref <ref>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_LINES = 600;
const BASELINE = 'scripts/test-layout-baseline.json';
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

/**
 * Pure: the findings for a list of `{ path, lines }`, the map text and the size
 * baseline (`{ path: lines }`, the oversized files that existed when the ratchet
 * was introduced).
 */
export function check(files, mapText, exists = existsSync, baseline = {}) {
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
      errors.push(
        `${path}: scripts/ holds .test.mjs files only; CI runs only the script tests .github/workflows/ci.yml names, so add a new one there`,
      );
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
      errors.push(`${path}: sits directly in packages/db/src/; move it into a feature folder`);
    }
    const allowed = Object.hasOwn(baseline, path) ? baseline[path] : undefined;
    if (allowed === undefined) {
      if (lines > MAX_LINES) {
        errors.push(
          `${path}: ${lines} lines (over ${MAX_LINES}); split it by concern (only files in ${BASELINE} may be larger)`,
        );
      }
    } else if (lines > allowed) {
      errors.push(
        `${path}: grew from ${allowed} to ${lines} lines; it is over ${MAX_LINES} already, so split it instead of adding to it`,
      );
    } else if (lines <= MAX_LINES) {
      errors.push(
        `${path}: now ${lines} lines, within ${MAX_LINES}; remove its entry from ${BASELINE}`,
      );
    } else {
      debt.push(`${path}: ${lines} lines (over ${MAX_LINES}); split by concern`);
    }
  }
  const present = new Set(files.map((x) => x.path));
  for (const path of Object.keys(baseline)) {
    if (!present.has(path))
      errors.push(`${BASELINE}: ${path} is not a test file any more; remove it`);
  }
  for (const m of mapText.matchAll(/`([\w@./\[\]-]+\.(?:test|spec)\.(?:ts|tsx|mjs))`/g)) {
    if (!exists(m[1])) errors.push(`docs/TEST_MAP.md: ${m[1]} does not exist`);
  }
  return { errors, debt };
}

/**
 * Pure: a proposed baseline against the target branch's. Entries may be removed or
 * lowered; an added entry or a raised value would let a file grow, so both fail.
 */
export function checkBaselineChange(base, next) {
  const errors = [];
  for (const [path, lines] of Object.entries(next)) {
    if (!Object.hasOwn(base, path)) {
      errors.push(
        `${BASELINE}: ${path} was added; the baseline only shrinks, so split the file instead`,
      );
    } else if (lines > base[path]) {
      errors.push(
        `${BASELINE}: ${path} was raised from ${base[path]} to ${lines}; the baseline only shrinks, so split the file instead`,
      );
    }
  }
  return errors;
}

/** The target branch's baseline, or null when that branch has none yet. Fails closed on an unreadable ref. */
function baselineAt(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      stdio: 'ignore',
    });
  } catch {
    throw new Error(`--base-ref ${ref} is not a commit this checkout has; fetch it first`);
  }
  let text;
  try {
    text = execFileSync('git', ['show', `${ref}:${BASELINE}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  return JSON.parse(text).oversized;
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
  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')).oversized : {};
  const { errors, debt } = check(
    files,
    readFileSync('docs/TEST_MAP.md', 'utf8'),
    existsSync,
    baseline,
  );
  const at = process.argv.indexOf('--base-ref');
  if (at !== -1) {
    const ref = process.argv[at + 1];
    if (!ref) throw new Error('--base-ref needs a ref');
    const base = baselineAt(ref);
    if (base !== null) errors.push(...checkBaselineChange(base, baseline));
  }
  for (const e of errors) console.error(`ERROR ${e}`);
  for (const d of debt) console.error(`${strict ? 'ERROR' : 'warn '} ${d}`);
  console.log(
    `test layout: ${files.length} test files, ${errors.length} errors, ${debt.length} layout-debt items` +
      (strict ? ' (strict)' : ' (debt reported only)'),
  );
  process.exit(errors.length || (strict && debt.length) ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
