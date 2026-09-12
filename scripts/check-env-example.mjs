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
 * What counts as a read. Comments and string contents are removed first, so
 * a name that survives only in a comment is not a read. The environment
 * object is `process.env` and every alias of it in the file: a variable
 * declared from it (`const runtime = process.env`), a parameter defaulted
 * to it (`(env = process.env)`), a parameter typed `NodeJS.ProcessEnv`
 * (loadConfig and its helpers), and the conventional name `env`. On each of
 * those: `obj.X`, `obj['X']`, `helper(obj, 'X')`, destructuring
 * (`const { X } = obj`), and computed access (`obj[name]`), which the guard
 * cannot resolve and so treats every environment-shaped string literal in
 * that file as a read (the web boot gate walks its inventory that way; a
 * name added to the inventory is then demanded of the template).
 *
 * Product code is every source tree a deployment runs plus the drizzle
 * config; test files and the harness files are scanned for rule 2 only, so
 * a harness-only name may be documented under the test-hooks section but
 * its absence from the template is never demanded. TypeScript 7 exposes no
 * JavaScript syntax API, so this is a scanner, not a parser: it is exact on
 * every form the tree uses today and fails closed on the ones it cannot
 * resolve.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

/** Product code: every source tree a deployment runs, plus the package-level
 * executable configs (drizzle) that read the environment. Test files and the
 * harness files below are skipped here and scanned as harnesses instead. */
const PRODUCT = [
  'apps/api/src',
  'apps/web/src',
  'apps/web/legal-gate.mjs',
  'apps/web/next.config.mjs',
  'packages/db/src',
  'packages/db/drizzle.config.ts',
  'packages/core/src',
  'packages/contracts/src',
  'packages/shared/src',
];
/** Harnesses: names read only here are legitimate template entries under
 * "test hooks", never required. */
const HARNESS = ['packages/db/src/testing.ts', 'apps/web/playwright.config.ts', 'apps/web/e2e'];
const HARNESS_FILES = new Set(HARNESS.map((h) => join(ROOT, h)));

const NAME = '[A-Z][A-Z0-9_]+';
const ENV_SHAPED = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * Remove comments and the contents of string and template literals, keeping
 * the quotes so string arguments still read as `'…'` boundaries where the
 * accessor patterns need them. Quoted environment names are kept: they are
 * the one string content the scan needs (`env['X']`, `helper(env, 'X')`,
 * inventories). Regex literals are skipped when a `/` follows a token that
 * cannot end an expression.
 */
function stripCommentsAndStrings(text) {
  let out = '';
  let i = 0;
  let lastSignificant = '';
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      let body = '';
      while (j < n && text[j] !== quote) {
        if (text[j] === '\\') j += 1;
        else if (quote === '`' && text[j] === '$' && text[j + 1] === '{') {
          // Keep template expressions: they may contain reads.
          let depth = 1;
          let k = j + 2;
          while (k < n && depth > 0) {
            if (text[k] === '{') depth += 1;
            else if (text[k] === '}') depth -= 1;
            k += 1;
          }
          body += ` ${text.slice(j + 2, k - 1)} `;
          j = k;
          continue;
        } else body += text[j];
        j += 1;
      }
      const raw = text.slice(i + 1, j);
      out +=
        quote +
        (ENV_SHAPED.test(raw) || /^[A-Z][A-Z0-9_]+$/.test(raw)
          ? raw
          : body.replace(/[^\s${}()A-Za-z0-9_.,:[\]]/g, ' ').replace(/[A-Z][A-Z0-9_]*/g, '')) +
        quote;
      i = j + 1;
      lastSignificant = quote;
      continue;
    }
    if (c === '/' && /^[\s(,=:[!&|?{};+\-*%<>~^]?$/.test(lastSignificant)) {
      // A regex literal: skip to its end.
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        if (text[j] === '\\') j += 2;
        else if (text[j] === '[') {
          inClass = true;
          j += 1;
        } else if (text[j] === ']') {
          inClass = false;
          j += 1;
        } else if (text[j] === '/' && !inClass) break;
        else if (text[j] === '\n') break;
        else j += 1;
      }
      out += ' ';
      i = j + 1;
      lastSignificant = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i += 1;
  }
  return out;
}

/** Every identifier that holds the environment object in this file. */
function envObjects(code) {
  const ids = new Set(['env']);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\b/g))
    ids.add(m[1]);
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*process\.env\b(?![.[])/g))
    ids.add(m[1]);
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*NodeJS\.ProcessEnv\b/g)) ids.add(m[1]);
  return [...ids].map((id) => id.replace(/\$/g, '\\$'));
}

function readsInFile(code) {
  const names = [];
  const objects = ['process\\.env', ...envObjects(code)];
  let computed = false;
  for (const obj of objects) {
    const dot = new RegExp(`\\b${obj}\\.(${NAME})\\b`, 'g');
    const bracket = new RegExp(`\\b${obj}\\[\\s*['"](${NAME})['"]\\s*\\]`, 'g');
    const helper = new RegExp(`\\(\\s*${obj}\\s*,\\s*['"](${NAME})['"]`, 'g');
    const destructure = new RegExp(`\\{([^}]*)\\}\\s*=\\s*${obj}\\b(?![.[])`, 'g');
    const computedAccess = new RegExp(`\\b${obj}\\[\\s*[A-Za-z_$][\\w$]*\\s*\\]`);
    for (const re of [dot, bracket, helper]) for (const m of code.matchAll(re)) names.push(m[1]);
    for (const m of code.matchAll(destructure)) {
      for (const part of m[1].split(',')) {
        const key = part.split(/[:=]/)[0].trim();
        if (new RegExp(`^${NAME}$`).test(key)) names.push(key);
      }
    }
    if (computedAccess.test(code)) computed = true;
  }
  if (computed) {
    for (const m of code.matchAll(/['"]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"]/g)) names.push(m[1]);
  }
  return names;
}

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
      if (!includeTests && (isTest(file) || HARNESS_FILES.has(file))) continue;
      const code = stripCommentsAndStrings(readFileSync(file, 'utf8'));
      for (const name of readsInFile(code)) {
        if (!names.has(name)) names.set(name, new Set());
        names.get(name).add(relative(ROOT, file).replaceAll('\\', '/'));
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
