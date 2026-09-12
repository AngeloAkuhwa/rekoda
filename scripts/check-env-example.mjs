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
 * Two rules for the code:
 *   1. every variable PRODUCT code reads must be documented (active or as a
 *      commented `# NAME=` line, which is how optional knobs are shown);
 *   2. every variable the template documents must be read by SOME scanned
 *      file (product code, a test file, a harness, or a deployment file), so
 *      a dead name cannot sit in the template pretending to matter.
 *
 * And four for the deployment (G-01), which reads the environment too and
 * whose names would otherwise look dead to rule 2 or go missing silently:
 *   3. every `${NAME}` docker-compose.prod.yml interpolates is documented,
 *      because the operator supplies it in the same `.env`;
 *   4. every `{$NAME}` the Caddyfile reads is in the caddy service's
 *      environment, or Caddy sees it blank;
 *   5. every NEXT_PUBLIC_* name the web code reads is a build argument of
 *      the compose web build and of the image's web stages, and baked into
 *      the web image; no other NEXT_PUBLIC_* name is. Next inlines them at
 *      build, so a name missing here ships blank with nothing to say so;
 *   6. the web container's environment is exactly the other names the web
 *      code reads: missing, the site boots blind; extra, a secret has
 *      reached a process that never needed it.
 * No test hook or development-only name (NEVER_DEPLOYED) may appear in any
 * deployment file at all.
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
import { parse as parseYaml } from 'yaml';

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

export function problemsFor(
  { product, harness },
  { example, duplicates, odd },
  deployed = new Set(),
) {
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
    if (!product.has(name) && !harness.has(name) && !deployed.has(name)) {
      problems.push(`in .env.example but read by no code, harness or deployment file: ${name}`);
    }
  }
  return problems;
}

// ── The deployment (rules 3 to 6, G-01) ─────────────────────────────────

/** The files a deployment reads the environment through. */
export const DEPLOY = {
  compose: 'docker-compose.prod.yml',
  caddyfile: 'deploy/Caddyfile',
  dockerfile: 'Dockerfile',
};
/** The compose services and image stage the site is built and run in. */
export const WEB_SERVICE = 'web';
export const CADDY_SERVICE = 'caddy';
export const WEB_BUILD_STAGE = 'web-build';
/** The web code: the roots of PRODUCT that apps/web runs. */
const WEB_CODE = /^apps\/web\//;
/**
 * Names the template marks as test hooks or development-only. A deployment
 * that carries one has switched off a gate (the legal facts, the OTP reveal)
 * or pointed a provider at a fake, so no deployment file may name them.
 */
export const NEVER_DEPLOYED = [
  'REKODA_REVEAL_OTP',
  'REKODA_E2E_REVEAL_OTP',
  'REKODA_E2E_PLACEHOLDER_LEGAL',
  'REKODA_OPERATOR_SECRET',
  'REKODA_LOCAL_STORAGE',
  'PAYSTACK_BASE_URL',
  'MONO_BASE_URL',
];

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';

/** `${NAME}`, `${NAME:-x}`, `${NAME:?x}` and `$NAME`; `$$` is a literal dollar. */
export function interpolations(value) {
  const names = [];
  const text = String(value).replace(/\$\$/g, '');
  for (const m of text.matchAll(new RegExp(`\\$\\{(${IDENT})`, 'g'))) names.push(m[1]);
  for (const m of text.matchAll(new RegExp(`\\$(${IDENT})`, 'g'))) names.push(m[1]);
  return names;
}

function keyed(value) {
  if (value === undefined || value === null) return new Map();
  if (Array.isArray(value)) {
    return new Map(
      value.map((entry) => {
        const [key, ...rest] = String(entry).split('=');
        return [key.trim(), rest.length > 0 ? rest.join('=') : null];
      }),
    );
  }
  return new Map(
    Object.entries(value).map(([key, v]) => [
      key,
      v === null || v === undefined ? null : String(v),
    ]),
  );
}

/**
 * The compose file: every interpolated name, and each service's environment,
 * build arguments, target and env files. Comments never count: the YAML is
 * parsed and only its values are scanned.
 */
export function parseCompose(text) {
  const doc = parseYaml(text, { merge: true }) ?? {};
  const interpolated = new Set();
  const visit = (node) => {
    if (typeof node === 'string') for (const name of interpolations(node)) interpolated.add(name);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') Object.values(node).forEach(visit);
  };
  visit(doc);
  const services = new Map();
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    const envFiles = [svc?.env_file]
      .flat()
      .filter(Boolean)
      .map((entry) => (typeof entry === 'string' ? entry : entry.path));
    services.set(name, {
      environment: keyed(svc?.environment),
      buildArgs: keyed(svc?.build?.args),
      target: svc?.build?.target ?? null,
      envFiles,
    });
  }
  /* What rule 2 may count as a read: an interpolation that reaches a consumer
   * the other rules check (an image tag, a build argument, Caddy's
   * environment). A pass-through into the api's environment reaches code that
   * reads the name or nothing, so it keeps no dead name alive. */
  const consumed = new Set();
  for (const [name, svc] of Object.entries(doc.services ?? {})) {
    const sources = [svc?.image, ...keyed(svc?.build?.args).values()];
    if (name === CADDY_SERVICE) sources.push(...keyed(svc?.environment).values());
    for (const value of sources) {
      for (const n of interpolations(value ?? '')) consumed.add(n);
    }
  }
  return { doc, interpolated, consumed, services };
}

/** `{$NAME}`, `{$NAME:default}` and `{env.NAME}`, outside comments. */
export function caddyNames(text) {
  const names = new Set();
  const re = new RegExp(`\\{\\$(${IDENT})(?::[^}]*)?\\}|\\{env\\.(${IDENT})\\}`, 'g');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '$1');
    for (const m of line.matchAll(re)) names.add(m[1] ?? m[2]);
  }
  return names;
}

/**
 * The Dockerfile's stages, each with its ARGs, the names it sets with ENV,
 * its base, its last USER and its instructions. Continuation lines are
 * joined first; comment lines never count.
 */
export function parseDockerfile(text) {
  const globalArgs = new Map();
  const stages = new Map();
  const argRe = new RegExp(`^ARG\\s+(${IDENT})(?:=(.*))?$`, 'i');
  let current = null;
  for (const raw of text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const from = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
    if (from) {
      current = {
        name: from[2] ?? `#${stages.size}`,
        base: from[1],
        args: new Map(),
        env: new Set(),
        user: null,
        lines: [],
      };
      stages.set(current.name, current);
      continue;
    }
    const arg = line.match(argRe);
    if (!current) {
      if (arg) globalArgs.set(arg[1], arg[2] ?? null);
      continue;
    }
    current.lines.push(line);
    if (arg) current.args.set(arg[1], arg[2] ?? null);
    const env = line.match(/^ENV\s+(.*)$/i);
    if (env) {
      for (const m of env[1].matchAll(/(?:^|\s)([A-Z_][A-Z0-9_]*)=/g)) current.env.add(m[1]);
    }
    const user = line.match(/^USER\s+(\S+)/i);
    if (user) current.user = user[1];
  }
  return { globalArgs, stages };
}

export function deploymentFiles(root = ROOT) {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  return {
    compose: parseCompose(read(DEPLOY.compose)),
    caddy: caddyNames(read(DEPLOY.caddyfile)),
    dockerfile: parseDockerfile(read(DEPLOY.dockerfile)),
  };
}

const sorted = (set) => [...set].sort();

export function deploymentProblemsFor({ product }, { example }, deployment) {
  const problems = [];
  const { compose, caddy, dockerfile } = deployment;
  const web = compose.services.get(WEB_SERVICE);
  const caddyService = compose.services.get(CADDY_SERVICE);

  // Rule 3: the operator supplies every interpolated name, from the template.
  for (const name of sorted(compose.interpolated)) {
    if (!example.has(name)) {
      problems.push(`${DEPLOY.compose} interpolates ${name}, which .env.example does not document`);
    }
  }

  // Rule 4: Caddy reads only what its service is given, and is given only
  // what it reads (a pass-through would also keep a dead template name alive).
  if (!caddyService) problems.push(`${DEPLOY.compose} has no ${CADDY_SERVICE} service`);
  for (const name of sorted(caddy)) {
    if (!caddyService?.environment.has(name)) {
      problems.push(
        `${DEPLOY.caddyfile} reads {$${name}}, which the ${CADDY_SERVICE} service is not given`,
      );
    }
  }
  for (const name of sorted(caddyService?.environment.keys() ?? [])) {
    if (!caddy.has(name)) {
      problems.push(
        `the ${CADDY_SERVICE} service is given ${name}, which ${DEPLOY.caddyfile} never reads`,
      );
    }
  }

  // The names the web code reads, split into build time and run time.
  const webReads = new Set(
    [...product].filter(([, files]) => [...files].some((f) => WEB_CODE.test(f))).map(([n]) => n),
  );
  const publicNames = new Set([...webReads].filter((n) => n.startsWith('NEXT_PUBLIC_')));
  const runtimeNames = new Set(
    [...webReads].filter((n) => !n.startsWith('NEXT_PUBLIC_') && !NEVER_DEPLOYED.includes(n)),
  );

  // Rule 5: every public name reaches the build and is baked into the image.
  if (!web) problems.push(`${DEPLOY.compose} has no ${WEB_SERVICE} service`);
  const webTarget = web?.target ? dockerfile.stages.get(web.target) : undefined;
  const webBuild = dockerfile.stages.get(WEB_BUILD_STAGE);
  if (web && !webTarget) {
    problems.push(
      `the ${WEB_SERVICE} service builds target ${web.target ?? '(none)'}, which ${DEPLOY.dockerfile} does not define`,
    );
  }
  if (!webBuild) problems.push(`${DEPLOY.dockerfile} has no ${WEB_BUILD_STAGE} stage`);
  const targetName = web?.target ?? WEB_SERVICE;
  const places = [
    ['the compose web build arguments', new Set(web?.buildArgs.keys() ?? [])],
    [`the ${WEB_BUILD_STAGE} stage ARGs`, new Set(webBuild?.args.keys() ?? [])],
    [`the ${WEB_BUILD_STAGE} stage ENV`, webBuild?.env ?? new Set()],
    [`the ${targetName} stage ARGs`, new Set(webTarget?.args.keys() ?? [])],
    [`the ${targetName} stage ENV`, webTarget?.env ?? new Set()],
  ];
  for (const [where, names] of places) {
    for (const name of sorted(publicNames)) {
      if (!names.has(name)) problems.push(`web code reads ${name}, missing from ${where}`);
    }
    for (const name of sorted(names)) {
      if (name.startsWith('NEXT_PUBLIC_') && !publicNames.has(name)) {
        problems.push(`${where} carry ${name}, which no web code reads`);
      }
    }
  }

  // Rule 6: the web container gets exactly its run-time names, and no public
  // one (those are the image's, so the legal gate checks what the pages show).
  if (web) {
    for (const name of sorted(runtimeNames)) {
      if (!web.environment.has(name)) {
        problems.push(
          `web code reads ${name} at run time; the ${WEB_SERVICE} service is not given it`,
        );
      }
    }
    for (const name of sorted(web.environment.keys())) {
      if (name.startsWith('NEXT_PUBLIC_')) {
        problems.push(
          `the ${WEB_SERVICE} service overrides ${name} at run time; it is baked into the image`,
        );
      } else if (!runtimeNames.has(name) && !NEVER_DEPLOYED.includes(name)) {
        problems.push(`the ${WEB_SERVICE} service is given ${name}, which no web code reads`);
      }
    }
    if (web.envFiles.length > 0) {
      problems.push(
        `the ${WEB_SERVICE} service loads an env_file; list its names instead (rule 6)`,
      );
    }
  }

  // Never deployed: not interpolated, set, passed or baked anywhere.
  for (const name of NEVER_DEPLOYED) {
    if (!example.has(name)) {
      problems.push(`NEVER_DEPLOYED names ${name}, which .env.example does not document`);
    }
    const found = [];
    if (compose.interpolated.has(name)) found.push(`interpolated by ${DEPLOY.compose}`);
    for (const [service, svc] of compose.services) {
      if (svc.environment.has(name)) found.push(`set on the ${service} service`);
      if (svc.buildArgs.has(name)) found.push(`a build argument of the ${service} service`);
    }
    if (caddy.has(name)) found.push(`read by ${DEPLOY.caddyfile}`);
    for (const [stage, st] of dockerfile.stages) {
      if (st.args.has(name) || st.env.has(name)) found.push(`in the ${stage} stage`);
    }
    if (dockerfile.globalArgs.has(name)) found.push(`a global ARG of ${DEPLOY.dockerfile}`);
    for (const place of found) problems.push(`${name} must never be deployed, but is ${place}`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const reads = scan();
  const template = parseTemplate(readFileSync(join(ROOT, '.env.example'), 'utf8'));
  const deployment = deploymentFiles();
  const problems = [
    ...problemsFor(reads, template, deployment.compose.consumed),
    ...deploymentProblemsFor(reads, template, deployment),
  ];
  if (problems.length > 0) {
    console.error('Environment template drift:');
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      '\nEvery name product code reads must be in .env.example (active or as `# NAME=`),\n' +
        'every documented name must be read by product code, a test harness or a deployment\n' +
        'file, and the deployment files must agree with the code (rules 3 to 6 above).',
    );
    process.exit(1);
  }
  console.log(
    `Environment template OK — ${reads.product.size} names read by code, ${deployment.compose.consumed.size} by the deployment, ${template.example.size} documented, no drift.`,
  );
}
