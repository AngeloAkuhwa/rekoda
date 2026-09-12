/**
 * `.env.example` must agree with the code, in both directions.
 *
 * G-08: the template documented names no code read (`SESSION_SECRET`,
 * `APP_URL`, `PAYSTACK_PLAN_*`) and omitted names the code read (`MONO_*`,
 * the `REKODA_COMMAND_*` flags, two rate brakes, two public keys). A
 * deployment filled from such a template boots with the wrong knobs set and
 * the right ones absent, and finds out at the first real request. This guard
 * keeps the two in step the way check-boundaries keeps withBusiness() the
 * only path to the database: mechanically, in CI, on every change.
 *
 * Two rules:
 *   1. every variable PRODUCT code reads must be documented (active or as a
 *      commented `# NAME=` line, which is how optional knobs are shown);
 *   2. every variable the template documents must be read by SOME scanned
 *      file (product code or the named test harnesses), so a dead name
 *      cannot sit in the template pretending to matter.
 *
 * "Reads" are the accessor forms the code actually uses: `process.env.X`,
 * `process.env['X']`, `env['X']` and `helper(env, 'X')` in loadConfig, and
 * `env.X` in the web boot gate. Harness files (the integration test setup,
 * the Playwright config) are scanned for rule 2 only, so a harness-only
 * name may be documented under the test-hooks section but its absence from
 * the template is never demanded.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

/** Product code: what a deployment actually reads. */
const PRODUCT = [
  'apps/api/src',
  'apps/web/src',
  'apps/web/legal-gate.mjs',
  'apps/web/next.config.mjs',
  'packages/db/src/migrate.ts',
  'packages/db/src/client.ts',
];
/** Harnesses: names read only here are legitimate template entries under
 * "test hooks", never required. */
const HARNESS = ['packages/db/src/testing.ts', 'apps/web/playwright.config.ts', 'apps/web/e2e'];

const ACCESSORS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g,
  /\benv\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g,
  /\(\s*env\s*,\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /\benv\.([A-Z][A-Z0-9_]{2,})\b/g,
];

function walk(path, out) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return out;
  }
  if (stat.isFile()) {
    out.push(path);
    return out;
  }
  for (const entry of readdirSync(path)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    walk(join(path, entry), out);
  }
  return out;
}

const isSource = (file) => /\.(ts|tsx|mjs|js)$/.test(file);
const isTest = (file) => /\.test\.tsx?$/.test(file) || /[\\/]e2e[\\/]/.test(file);

function readsIn(paths, { includeTests }) {
  const names = new Map();
  for (const root of paths) {
    for (const file of walk(join(ROOT, root), []).filter(isSource)) {
      if (!includeTests && isTest(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const re of ACCESSORS) {
        for (const match of text.matchAll(re)) {
          const name = match[1];
          if (!names.has(name)) names.set(name, new Set());
          names.get(name).add(relative(ROOT, file).replaceAll('\\', '/'));
        }
      }
    }
  }
  return names;
}

const product = readsIn(PRODUCT, { includeTests: false });
const harness = readsIn(HARNESS, { includeTests: true });

const example = new Map();
for (const line of readFileSync(join(ROOT, '.env.example'), 'utf8').split('\n')) {
  const m = line.match(/^(#\s*)?([A-Z][A-Z0-9_]+)=/);
  if (m) example.set(m[2], m[1] ? 'commented' : 'active');
}

const problems = [];
for (const [name, files] of [...product].sort()) {
  if (!example.has(name)) {
    problems.push(
      `read by code but not in .env.example: ${name}  (${[...files].slice(0, 2).join(', ')})`,
    );
  }
}
for (const [name] of [...example].sort()) {
  if (!product.has(name) && !harness.has(name)) {
    problems.push(`in .env.example but read by no code or harness: ${name}`);
  }
}

if (problems.length > 0) {
  console.error('Environment template drift:');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nEvery name product code reads must be in .env.example (active or as `# NAME=`),\n' +
      'and every documented name must be read by product code or a test harness.',
  );
  process.exit(1);
}

console.log(
  `Environment template OK — ${product.size} names read by code, ${example.size} documented, no drift.`,
);
