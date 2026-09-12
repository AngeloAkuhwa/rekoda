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
 *      file (product code, a test file, or a harness), so a dead name cannot
 *      sit in the template pretending to matter.
 *
 * What counts as a read. Comments and string contents are removed first
 * (a name that survives only in a comment is not a read), then the
 * spellings of the environment object are normalised (`process?.env`,
 * `process.env!`, `(process.env as T)`, `process['env']`,
 * `globalThis.process.env`, a `node:process` import) and every alias is
 * resolved: a variable declared from it or from a copy of it (spread,
 * Object.assign, structuredClone), a parameter defaulted to it, a parameter
 * typed NodeJS.ProcessEnv (or a type alias of it, or its structural
 * spelling), a rest element of a destructuring, `const { env } = process`,
 * and `env` itself when the file touches process.env. On each of those:
 * `obj.X`, `obj['X']`, `helper(obj, 'X')`, destructuring, and every
 * non-literal access (`obj[name]`, `'X' in obj`, `Object.keys(obj)`,
 * `schema.parse(obj)`), which the guard cannot resolve and so treats every
 * inventory literal in that file as a read: members of arrays of uppercase
 * strings, keys of a schema object parsed against the environment, and
 * project-prefixed names. A plain assignment or a delete is a write, not a
 * read; compound assignments read first.
 *
 * Product code is every source tree a deployment runs plus the drizzle
 * config. Test files anywhere and the harness paths are scanned for rule 2
 * only. TypeScript 7 exposes no JavaScript syntax API, so this is a scanner
 * with a fixture test (check-env-example.test.mjs) pinning every form it
 * handles; when it cannot resolve a form it fails closed (demands more),
 * never open.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

/** Product code: every source tree a deployment runs, plus the package-level
 * executable configs (drizzle) that read the environment. */
export const PRODUCT = [
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
/** Harnesses and tooling: names read only here are legitimate template
 * entries under "test hooks", never required. Test files under the product
 * roots count as harnesses too. */
export const HARNESS = [
  'packages/db/src/testing.ts',
  'apps/web/playwright.config.ts',
  'apps/web/e2e',
  'scripts',
];
const HARNESS_FILES = new Set(HARNESS.map((h) => join(ROOT, h)));

const NAME = '[A-Z][A-Z0-9_]*';
/** Names a deployment of THIS product is likely to own; used only to decide
 * which loose literals in a computed-access file are demanded. */
const PROJECT_PREFIX =
  /^(?:REKODA|NEXT_PUBLIC|PAYSTACK|META|MONO|OPAY|KUDA|R2|AI|VOICE|IMAGE|FX|OPERATOR|PLANNING)_|^(?:DATABASE_URL|WORKER_DATABASE_URL|APP_DATABASE_URL|NODE_ENV|PORT|OTP_PEPPER|VAULT_KEY|MATCH_KEY|CONNECTION_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY)$/;

/**
 * Remove comments and the contents of string and template literals, keeping
 * the quotes so string arguments still read as boundaries. Quoted
 * environment-shaped names are kept: they are the one string content the
 * scan needs (`env['X']`, `helper(env, 'X')`, inventories). Template
 * expressions are code and are emitted outside the quotes. The scanner can
 * never swallow a file: a quote that does not close on its line is not a
 * string, a slash that does not close a regex on its line is a slash, and a
 * slash after `<` or `>` (a JSX closing tag) is never a regex.
 */
export function stripCommentsAndStrings(text) {
  let out = '';
  let i = 0;
  let lastSignificant = '';
  const n = text.length;
  const keepable = (raw) =>
    new RegExp(`^${NAME}$`).test(raw) || /^(?:env|(?:node:)?process)$/.test(raw);
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
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (j >= n || text[j] === '\n') {
        out += c; // an apostrophe in JSX text, not a string
        lastSignificant = c;
        i += 1;
        continue;
      }
      const raw = text.slice(i + 1, j);
      out += c + (keepable(raw) ? raw : '') + c;
      i = j + 1;
      lastSignificant = c;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let body = '';
      const expressions = [];
      while (j < n && text[j] !== '`') {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '$' && text[j + 1] === '{') {
          let depth = 1;
          let k = j + 2;
          let quote = null;
          while (k < n && depth > 0) {
            const ch = text[k];
            if (quote) {
              if (ch === '\\') k += 1;
              else if (ch === quote) quote = null;
            } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
            else if (ch === '{') depth += 1;
            else if (ch === '}') depth -= 1;
            k += 1;
          }
          expressions.push(text.slice(j + 2, k - 1));
          j = k;
          continue;
        }
        body += text[j];
        j += 1;
      }
      out += '`' + (expressions.length === 0 && keepable(body) ? body : '') + '`';
      for (const expression of expressions) out += ` (${stripCommentsAndStrings(expression)}) `;
      i = j + 1;
      lastSignificant = '`';
      continue;
    }
    if (c === '/' && /^[\s(,=:[!&|?{};+\-*%~^]?$/.test(lastSignificant)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') j += 2;
        else if (text[j] === '[') {
          inClass = true;
          j += 1;
        } else if (text[j] === ']') {
          inClass = false;
          j += 1;
        } else if (text[j] === '/' && !inClass) {
          closed = true;
          break;
        } else j += 1;
      }
      if (closed) {
        out += ' ';
        i = j + 1;
        lastSignificant = '/';
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
    i += 1;
  }
  return out;
}

/** One spelling for the environment object, so the accessors see one form. */
export function normalise(code) {
  return code
    .replace(/\b(?:globalThis|global)\s*\.\s*process\b/g, 'process')
    .replace(/\bprocess\s*\[\s*['"]env['"]\s*\]/g, 'process.env')
    .replace(/\bprocess\s*(?:\?\.|\.)\s*env\b!?/g, 'process.env')
    .replace(/\(\s*process\.env\s+as\s+[^()]*\)/g, 'process.env');
}

const escapeId = (id) => id.replace(/[.$]/g, '\\$&');

/** Every identifier that holds the environment object (or a copy) in this file. */
export function envObjects(code) {
  const ids = new Set();
  /* `env` is the environment object by convention unless this file declares
   * it as something else: an object literal, or a parameter of another type. */
  const envIsOther =
    /\b(?:const|let|var)\s+env\s*=\s*\{/.test(code) ||
    /\benv\s*:\s*(?!NodeJS\.ProcessEnv\b|Record<\s*string\s*,\s*string\s*\|\s*undefined\s*>)[A-Za-z_$]/.test(
      code,
    );
  if (!envIsOther) ids.add('env');
  /* The structural spelling is ProcessEnv's exact shape; a plain
   * Record<string, string> is any message map and is not the environment. */
  const envTypes = [
    'NodeJS\\.ProcessEnv',
    'Record<\\s*string\\s*,\\s*string\\s*\\|\\s*undefined\\s*>',
  ];
  for (const m of code.matchAll(/\btype\s+([A-Za-z_$][\w$]*)\s*=\s*NodeJS\.ProcessEnv\b/g)) {
    envTypes.push(escapeId(m[1]));
  }
  for (const m of code.matchAll(
    /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"](?:node:)?process['"]/g,
  )) {
    ids.add(`${m[1]}.env`);
  }
  for (const m of code.matchAll(
    /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*['"](?:node:)?process['"]/g,
  )) {
    ids.add(`${m[1]}.env`);
  }
  for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*['"](?:node:)?process['"]/g)) {
    for (const part of m[1].split(',')) {
      const [key, alias] = part.split(/\s+as\s+/).map((s) => s.trim());
      if (key === 'env') ids.add(alias || 'env');
    }
  }
  const typeRe = new RegExp(
    `\\b([A-Za-z_$][\\w$]*)\\s*:\\s*(?:${envTypes.join('|')})(?![\\w$])`,
    'g',
  );
  for (const m of code.matchAll(typeRe)) ids.add(m[1]);
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*process\.env\b(?![.[])/g))
    ids.add(m[1]);
  for (const m of code.matchAll(/\{([^}]*)\}\s*=\s*process\b(?![.[])/g)) {
    for (const part of m[1].split(',')) {
      const [key, alias] = part.split(':').map((s) => s.trim());
      if (key === 'env') ids.add(alias || 'env');
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of ['process.env', ...ids]) {
      const e = escapeId(id);
      const hops = [
        // const b = a; const b = { ...a }; const b = Object.assign({}, a);
        // const b = structuredClone(a) — the initialiser IS the alias or a copy of it
        new RegExp(
          `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:\\{\\s*\\.\\.\\.${e}\\s*\\}|Object\\.assign\\(\\s*\\{\\s*\\}\\s*,\\s*${e}\\s*\\)|structuredClone\\(\\s*${e}\\s*\\)|${e})\\s*(?:;|,|\\n|$|\\))`,
          'gm',
        ),
        // const { PATH, ...rest } = a
        new RegExp(`\\.\\.\\.([A-Za-z_$][\\w$]*)\\s*\\}\\s*=\\s*${e}\\b(?![.[])`, 'g'),
      ];
      for (const re of hops) {
        for (const m of code.matchAll(re)) {
          if (!ids.has(m[1])) {
            ids.add(m[1]);
            grew = true;
          }
        }
      }
    }
  }
  return [...ids].map(escapeId);
}

/** Environment names this file reads. */
export function readsInFile(source) {
  const code = normalise(stripCommentsAndStrings(source));
  const names = [];
  const objects = ['process\\.env', ...envObjects(code)];
  let computed = false;
  for (const obj of objects) {
    const start = `(?<![.\\w$])${obj}`;
    const dot = new RegExp(`${start}\\s*(?:\\?\\.|\\.)\\s*(${NAME})\\b`, 'g');
    const bracket = new RegExp(`${start}\\s*(?:\\?\\.)?\\[\\s*[\`'"](${NAME})[\`'"]\\s*\\]`, 'g');
    const isWrite = (m) =>
      /^\s*=(?!=)/.test(code.slice(m.index + m[0].length)) ||
      /\bdelete\s+$/.test(code.slice(0, m.index));
    const helper = new RegExp(`\\(\\s*${obj}\\s*,\\s*['"](${NAME})['"]`, 'g');
    const destructure = new RegExp(
      `\\{([^}]*)\\}\\s*(?:=\\s*${start}\\b(?![.[])|:\\s*NodeJS\\.ProcessEnv\\b)`,
      'g',
    );
    const computedAccess = new RegExp(
      `${start}\\s*(?:\\?\\.)?\\[(?!\\s*[\`'"]${NAME}[\`'"]\\s*\\])`,
    );
    const reflective = new RegExp(
      `(?:\\bin\\s+|Object\\.(?:entries|keys|values|fromEntries|getOwnPropertyNames)\\(\\s*|\\bwith\\s*\\(\\s*|\\.(?:parse|safeParse|strict)\\(\\s*)${obj}\\b|${start}\\.hasOwnProperty\\(`,
    );
    for (const re of [dot, bracket]) {
      for (const m of code.matchAll(re)) if (!isWrite(m)) names.push(m[1]);
    }
    for (const m of code.matchAll(helper)) names.push(m[1]);
    for (const m of code.matchAll(destructure)) {
      for (const part of m[1].split(',')) {
        const key = part.split(/[:=]/)[0].trim();
        if (new RegExp(`^${NAME}$`).test(key)) names.push(key);
      }
    }
    if (computedAccess.test(code) || reflective.test(code)) computed = true;
  }
  if (computed) {
    for (const m of code.matchAll(/\[\s*((?:['"][A-Z][A-Z0-9_]*['"]\s*,?\s*)+)\]/g)) {
      for (const member of m[1].matchAll(/['"]([A-Z][A-Z0-9_]*)['"]/g)) names.push(member[1]);
    }
    for (const m of code.matchAll(/['"]([A-Z][A-Z0-9_]*)['"]/g))
      if (PROJECT_PREFIX.test(m[1])) names.push(m[1]);
    if (/\.(?:parse|safeParse|strict)\(\s*process\.env\b/.test(code)) {
      for (const m of code.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)) names.push(m[1]);
    }
  }
  return names;
}

/** The template: name -> 'active' | 'commented', duplicates, and lines that
 * look like assignments but are not environment names. */
export function parseTemplate(text) {
  const example = new Map();
  const duplicates = new Set();
  const odd = [];
  let openQuote = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (openQuote) {
      if (raw.includes(openQuote)) openQuote = null;
      continue;
    }
    const m = raw.match(/^[ \t]*(#[ \t]*)?(?:export[ \t]+)?([A-Za-z_][\w]*)[ \t]*=(.*)$/);
    if (!m) continue;
    const [, comment, name, value] = m;
    if (!new RegExp(`^${NAME}$`).test(name)) {
      if (!comment) odd.push(name);
      continue;
    }
    const v = value.trim();
    if (!comment && /^["']/.test(v) && !v.slice(1).includes(v[0])) openQuote = v[0];
    if (!comment && example.get(name) === 'active') duplicates.add(name);
    if (!comment || !example.has(name)) example.set(name, comment ? 'commented' : 'active');
  }
  return { example, duplicates, odd };
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

const isSource = (file) => /\.(?:c|m)?[jt]sx?$/.test(file);
const isTest = (file) =>
  /\.(test|spec)\.(?:c|m)?[jt]sx?$/.test(file) || /[\\/](e2e|__tests__)[\\/]/.test(file);

export function scan() {
  const product = new Map();
  const harness = new Map();
  const record = (map, name, file) => {
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(relative(ROOT, file).replaceAll('\\', '/'));
  };
  for (const root of PRODUCT) {
    for (const file of walk(join(ROOT, root), []).filter(isSource)) {
      const target = isTest(file) || HARNESS_FILES.has(file) ? harness : product;
      for (const name of readsInFile(readFileSync(file, 'utf8'))) record(target, name, file);
    }
  }
  for (const root of HARNESS) {
    for (const file of walk(join(ROOT, root), []).filter(isSource)) {
      for (const name of readsInFile(readFileSync(file, 'utf8'))) record(harness, name, file);
    }
  }
  return { product, harness };
}

export function problemsFor({ product, harness }, { example, duplicates, odd }) {
  const problems = [];
  for (const name of [...duplicates].sort()) {
    problems.push(
      `documented more than once in .env.example (which value wins depends on the loader): ${name}`,
    );
  }
  for (const name of odd) {
    problems.push(`not an environment name (UPPER_SNAKE) in .env.example: ${name}`);
  }
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
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const reads = scan();
  const template = parseTemplate(readFileSync(join(ROOT, '.env.example'), 'utf8'));
  const problems = problemsFor(reads, template);
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
    `Environment template OK — ${reads.product.size} names read by code, ${template.example.size} documented, no drift.`,
  );
}
