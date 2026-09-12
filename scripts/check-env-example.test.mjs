/**
 * Fixtures for the environment-template guard: every read form the scanner
 * claims to handle, and every form it must NOT count. Run with
 * `node --test scripts/check-env-example.test.mjs` (CI does, before the
 * guard itself). A form is added here the moment it is handled, so the
 * scanner's reach is pinned rather than re-discovered by the next reviewer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NEVER_DEPLOYED,
  caddyNames,
  deploymentProblemsFor,
  interpolations,
  parseCompose,
  parseDockerfile,
  parseTemplate,
  problemsFor,
  readsInFile,
  stripCommentsAndStrings,
} from './check-env-example.mjs';

const reads = (source) => new Set(readsInFile(source));

const READ = [
  ['dot', `export const a = process.env.PROBE_A;`, 'PROBE_A'],
  ['bracket', `export const a = process.env['PROBE_B'];`, 'PROBE_B'],
  ['double-quoted bracket', `export const a = process.env["PROBE_B2"];`, 'PROBE_B2'],
  ['backtick bracket', 'export const a = process.env[`PROBE_B3`];', 'PROBE_B3'],
  ['optional chain', `export const a = process.env?.PROBE_C;`, 'PROBE_C'],
  ['optional on process', `export const a = process?.env?.PROBE_C2;`, 'PROBE_C2'],
  ['non-null env', `export const a = process.env!.PROBE_C3;`, 'PROBE_C3'],
  ['non-null value', `export const a = process.env.PROBE_C4!;`, 'PROBE_C4'],
  [
    'parenthesised cast',
    `export const a = (process.env as Record<string, string>).PROBE_C5;`,
    'PROBE_C5',
  ],
  ['spaced chain', `export const a = process . env . PROBE_C6;`, 'PROBE_C6'],
  ['multi-line chain', `export const a = process.env\n  .PROBE_C7;`, 'PROBE_C7'],
  ['globalThis', `export const a = globalThis.process.env.PROBE_D;`, 'PROBE_D'],
  ['bracket env', `export const a = process['env'].PROBE_D2;`, 'PROBE_D2'],
  [
    'namespace import',
    `import * as p from 'node:process';\nexport const a = p.env.PROBE_E;`,
    'PROBE_E',
  ],
  [
    'default import',
    `import process from 'node:process';\nexport const a = process.env.PROBE_E2;`,
    'PROBE_E2',
  ],
  [
    'named import',
    `import { env } from 'node:process';\nexport const a = env.PROBE_E3;`,
    'PROBE_E3',
  ],
  ['alias', `const runtime = process.env;\nexport const a = runtime.PROBE_F;`, 'PROBE_F'],
  [
    'alias hop',
    `const initial = process.env;\nconst runtime = initial;\nexport const a = runtime.PROBE_F2;`,
    'PROBE_F2',
  ],
  ['spread copy', `const copy = { ...process.env };\nexport const a = copy.PROBE_F3;`, 'PROBE_F3'],
  [
    'Object.assign copy',
    `const snap = Object.assign({}, process.env);\nexport const a = snap.PROBE_F4;`,
    'PROBE_F4',
  ],
  [
    'structuredClone copy',
    `const snap = structuredClone(process.env);\nexport const a = snap.PROBE_F5;`,
    'PROBE_F5',
  ],
  [
    'destructured env from process',
    `const { env: runtime } = process;\nexport const a = runtime.PROBE_G;`,
    'PROBE_G',
  ],
  [
    'destructured env from globalThis',
    `const { env: runtime } = globalThis.process;\nexport const a = runtime.PROBE_G2;`,
    'PROBE_G2',
  ],
  [
    'typed parameter',
    `export function load(settings: NodeJS.ProcessEnv) { return settings['PROBE_H']; }`,
    'PROBE_H',
  ],
  [
    'type alias parameter',
    `type Env = NodeJS.ProcessEnv;\nexport function load(e: Env) { return e.PROBE_H2; }`,
    'PROBE_H2',
  ],
  [
    'structural parameter',
    `export function load(vars: Record<string, string | undefined>) { return vars.PROBE_H3; }`,
    'PROBE_H3',
  ],
  [
    'defaulted parameter',
    `export const f = (runtime = process.env) => runtime.PROBE_H4;`,
    'PROBE_H4',
  ],
  [
    'helper call',
    `function required(env: NodeJS.ProcessEnv, key: string) { return env[key]; }\nexport const a = required(process.env, 'PROBE_I');`,
    'PROBE_I',
  ],
  ['destructuring', `const { PROBE_J } = process.env;\nexport const a = PROBE_J;`, 'PROBE_J'],
  [
    'destructuring renamed',
    `const { PROBE_J2: renamed } = process.env;\nexport const a = renamed;`,
    'PROBE_J2',
  ],
  [
    'destructured typed parameter',
    `export function load({ PROBE_J3 }: NodeJS.ProcessEnv) { return PROBE_J3; }`,
    'PROBE_J3',
  ],
  [
    'rest element',
    `const { PATH, ...rest } = process.env;\nexport const a = rest.PROBE_J4;`,
    'PROBE_J4',
  ],
  ['template expression', 'export const u = `host=${process.env.PROBE_K}`;', 'PROBE_K'],
  ['nested template', 'export const u = `a ${`b ${process.env.PROBE_K2}`}`;', 'PROBE_K2'],
  [
    'brace in string inside expression',
    'export const t = `${ "}" + process.env.PROBE_K3 } tail`;',
    'PROBE_K3',
  ],
  [
    'inventory array',
    `const NAMES = ['PROBE_L'];\nexport const m = NAMES.filter((name) => !process.env[name]);`,
    'PROBE_L',
  ],
  [
    'single-word inventory',
    `const KEYS = ['DEBUG'];\nexport const d = KEYS.map((name) => process.env[name]);`,
    'DEBUG',
  ],
  [
    'optional computed',
    `const NAMES = ['PROBE_L2'];\nexport const m = NAMES.filter((name) => !process.env?.[name]);`,
    'PROBE_L2',
  ],
  [
    'concatenated index',
    `export const a = process.env['PROBE_' + key];\nconst ALL = ['PROBE_L3'];`,
    'PROBE_L3',
  ],
  ['in operator', `export const has = 'REKODA_PROBE_M' in process.env;`, 'REKODA_PROBE_M'],
  [
    'hasOwnProperty',
    `export const has = process.env.hasOwnProperty('REKODA_PROBE_M2');`,
    'REKODA_PROBE_M2',
  ],
  [
    'Object.entries loop',
    `export const f = Object.entries(process.env).filter(([k]) => k === 'REKODA_PROBE_M3');`,
    'REKODA_PROBE_M3',
  ],
  [
    'zod schema',
    `const s = z.object({\n  PROBE_N: z.string(),\n});\nexport const c = s.parse(process.env);`,
    'PROBE_N',
  ],
  ['compound assignment reads', `process.env.PROBE_O ??= 'v';`, 'PROBE_O'],
  ['comparison', `export const c = process.env.PROBE_P === 'x';`, 'PROBE_P'],
  ['jsx attribute', `export const El = () => <div data-x={process.env.PROBE_Q} />;`, 'PROBE_Q'],
  [
    'read after jsx apostrophe',
    `export const El = () => <p>Merchant's records</p>;\nexport const a = process.env.PROBE_Q2;`,
    'PROBE_Q2',
  ],
  [
    'read after closing tag pair on one line',
    `export const El = () => <p><b>x</b> {process.env.PROBE_Q3}</p>;`,
    'PROBE_Q3',
  ],
  [
    'read after two closing tags and a slash',
    `export const El = () => <p><a href="/a">a</a> / <a href="/">b</a></p>;\nexport const a = process.env.PROBE_Q4;`,
    'PROBE_Q4',
  ],
  [
    'read after regex with quote',
    `export const t = (s: string) => /["']/.test(s);\nexport const a = process.env.PROBE_R;`,
    'PROBE_R',
  ],
  [
    'read after string containing comment marker',
    `const s = '*/ not a comment';\nexport const a = process.env.PROBE_R2;`,
    'PROBE_R2',
  ],
  ['crlf source', `export const a = process.env.PROBE_S;\r\nexport const b = 1;\r\n`, 'PROBE_S'],
  ['single letter', `export const a = process.env.X;`, 'X'],
];

const NOT_READ = [
  ['comment only', `// process.env.PROBE_NOT_A was removed\nexport const x = 1;`, 'PROBE_NOT_A'],
  ['block comment only', `/* process.env.PROBE_NOT_A2 */\nexport const x = 1;`, 'PROBE_NOT_A2'],
  ['string only', `export const s = 'see process.env.PROBE_NOT_B for history';`, 'PROBE_NOT_B'],
  ['template text only', 'export const s = `see PROBE_NOT_B2 ${1}`;', 'PROBE_NOT_B2'],
  [
    'dollar brace in plain string',
    `const s = '\${PROBE_NOT_B3}';\nexport const a = process.env.OTHER;`,
    'PROBE_NOT_B3',
  ],
  ['plain write', `process.env.PROBE_NOT_C = 'v';`, 'PROBE_NOT_C'],
  ['bracket write', `process.env['PROBE_NOT_C2'] = 'v';`, 'PROBE_NOT_C2'],
  ['delete', `delete process.env.PROBE_NOT_C3;`, 'PROBE_NOT_C3'],
  [
    'ordinary object destructuring',
    `const { PROBE_NOT_D } = { PROBE_NOT_D: 1 };\nexport const a = PROBE_NOT_D;`,
    'PROBE_NOT_D',
  ],
  [
    'env parameter of another type',
    `export function f(env: Ctx) { return env.PROBE_NOT_E; }`,
    'PROBE_NOT_E',
  ],
  [
    'env local object',
    `const env = { mode: 'test' };\nexport const a = translate(env, 'PROBE_NOT_E2');`,
    'PROBE_NOT_E2',
  ],
  [
    'destructuring another key of process',
    `const { argv: args } = process;\nexport const c = args.length;`,
    'ARGV',
  ],
  [
    'unrelated literal in computed file',
    `export const read = (key: string) => process.env[key];\nexport const CODE = 'SOME_ERROR_CODE';`,
    'SOME_ERROR_CODE',
  ],
  [
    'nested env of another object',
    `const cfg = { env: { PROBE_NOT_F: 1 } };\nexport const a = cfg.env.PROBE_NOT_F;`,
    'PROBE_NOT_F',
  ],
];

for (const [label, source, name] of READ) {
  test(`reads: ${label}`, () => {
    assert.ok(
      reads(source).has(name),
      `${label} should read ${name}: ${[...reads(source)].join(', ')}`,
    );
  });
}
for (const [label, source, name] of NOT_READ) {
  test(`does not read: ${label}`, () => {
    assert.ok(
      !reads(source).has(name),
      `${label} must not read ${name}: ${[...reads(source)].join(', ')}`,
    );
  });
}

test('the stripper never swallows the rest of a file', () => {
  const src = `export const El = () => <p><a href="/app">Go</a> · <a href="/">Home</a></p>;\nexport const a = process.env.PROBE_TAIL;`;
  assert.ok(reads(src).has('PROBE_TAIL'));
  const stripped = stripCommentsAndStrings(
    `const t = (s) => /["']/.test(s);\nexport const a = process.env.PROBE_TAIL2;`,
  );
  assert.match(stripped, /PROBE_TAIL2/);
});

test('template parsing: forms, duplicates, odd names, multi-line values, BOM', () => {
  const t = parseTemplate(
    '﻿NODE_ENV=development\n# OPTIONAL_ONE=\nexport EXPORTED_ONE=1\nSPACED_ONE = 1\n  INDENTED_ONE=1\nQUOTED_ONE="x y"\nMULTI_ONE="first\nFAKE_INSIDE_VALUE=x\nlast"\nlower_case=1\nNODE_ENV=production\n#   NODE_ENV=illustration\n',
  );
  for (const n of [
    'NODE_ENV',
    'OPTIONAL_ONE',
    'EXPORTED_ONE',
    'SPACED_ONE',
    'INDENTED_ONE',
    'QUOTED_ONE',
    'MULTI_ONE',
  ]) {
    assert.ok(t.example.has(n), `template should document ${n}`);
  }
  assert.equal(t.example.get('OPTIONAL_ONE'), 'commented');
  assert.ok(!t.example.has('FAKE_INSIDE_VALUE'), 'a line inside a quoted value is not a name');
  assert.deepEqual([...t.duplicates], ['NODE_ENV']);
  assert.deepEqual(t.odd, ['lower_case']);
});

// ── The deployment (rules 3 to 6, G-01) ─────────────────────────────────
// A minimal deployment that satisfies every rule; each test below breaks it
// one way and names the problem it must produce.

const BASE_COMPOSE = `
services:
  api:
    image: rekoda-app:\${REKODA_RELEASE:?set it}
    env_file: .env
  web:
    build:
      target: web
      args:
        NEXT_PUBLIC_SITE_URL: \${NEXT_PUBLIC_SITE_URL}
    environment:
      REKODA_API_URL: http://api:3001
  caddy:
    environment:
      REKODA_API_PUBLIC_URL: \${REKODA_API_PUBLIC_URL}
`;
const BASE_CADDY = `# {$IN_A_COMMENT} is not a read
{$REKODA_API_PUBLIC_URL} {
\treverse_proxy api:3001
}
`;
const BASE_DOCKERFILE = `ARG NODE_VERSION=24
FROM node:\${NODE_VERSION} AS web-build
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SITE_URL=\${NEXT_PUBLIC_SITE_URL}
FROM node:\${NODE_VERSION} AS web
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SITE_URL=\${NEXT_PUBLIC_SITE_URL}
USER node
`;
const PRODUCT_READS = {
  NEXT_PUBLIC_SITE_URL: 'apps/web/src/lib/site.ts',
  REKODA_API_URL: 'apps/web/src/server/api.ts',
  REKODA_E2E_REVEAL_OTP: 'apps/web/src/server/dev-otp.ts',
  VAULT_KEY: 'apps/api/src/config.ts',
};
const DOCUMENTED = [
  'REKODA_RELEASE',
  'NEXT_PUBLIC_SITE_URL',
  'REKODA_API_URL',
  'REKODA_API_PUBLIC_URL',
  'VAULT_KEY',
  ...NEVER_DEPLOYED,
];

function deploymentProblems({
  compose = BASE_COMPOSE,
  caddy = BASE_CADDY,
  dockerfile = BASE_DOCKERFILE,
  product = PRODUCT_READS,
  documented = DOCUMENTED,
} = {}) {
  const reads = {
    product: new Map(Object.entries(product).map(([n, f]) => [n, new Set([f])])),
    harness: new Map(),
  };
  const template = { example: new Map(documented.map((n) => [n, 'active'])) };
  return deploymentProblemsFor(reads, template, {
    compose: parseCompose(compose),
    caddy: caddyNames(caddy),
    dockerfile: parseDockerfile(dockerfile),
  });
}
const expectProblem = (problems, pattern) =>
  assert.ok(
    problems.some((p) => pattern.test(p)),
    `expected a problem matching ${pattern}, got:\n  ${problems.join('\n  ')}`,
  );

test('deployment: the base fixture has no problems', () => {
  assert.deepEqual(deploymentProblems(), []);
});

test('deployment: interpolation forms, escapes and nesting', () => {
  assert.deepEqual(interpolations('${A} ${B:-x} ${C:?err} ${D-y} $E $$NOT_ONE ${F:-${G}}'), [
    'A',
    'B',
    'C',
    'D',
    'F',
    'G',
    'E',
  ]);
});

test('rule 3: a compose interpolation the template does not document', () => {
  const compose = BASE_COMPOSE.replace('http://api:3001', '${REKODA_NEW_KNOB}');
  expectProblem(deploymentProblems({ compose }), /interpolates REKODA_NEW_KNOB/);
});

test('rule 3: comments and escaped dollars are not interpolations', () => {
  const compose = `${BASE_COMPOSE}# \${IN_A_COMMENT}\nx-note: 'costs $$5'\n`;
  assert.deepEqual(deploymentProblems({ compose }), []);
});

test('rule 2: a name only the deployment uses is not dead', () => {
  const reads = { product: new Map(), harness: new Map() };
  const template = parseTemplate('REKODA_ACME_EMAIL=\n');
  const t = { ...template, duplicates: new Set(), odd: [] };
  assert.deepEqual(problemsFor(reads, t, new Set(['REKODA_ACME_EMAIL'])), []);
  assert.equal(problemsFor(reads, t).length, 1, 'without the deployment it is dead');
});

test('rule 4: a Caddyfile placeholder the caddy service is not given', () => {
  const caddy = `${BASE_CADDY}{$REKODA_ACME_EMAIL}\n{env.REKODA_OTHER}\n`;
  const problems = deploymentProblems({ caddy });
  expectProblem(problems, /reads \{\$REKODA_ACME_EMAIL\}/);
  expectProblem(problems, /reads \{\$REKODA_OTHER\}/);
  assert.ok(!problems.some((p) => /IN_A_COMMENT/.test(p)));
});

test('rule 5: a public name the web code reads but the build does not pass', () => {
  const problems = deploymentProblems({
    product: { ...PRODUCT_READS, NEXT_PUBLIC_NEW: 'apps/web/src/app/page.tsx' },
    documented: [...DOCUMENTED, 'NEXT_PUBLIC_NEW'],
  });
  for (const where of [
    'the compose web build arguments',
    'the web-build stage ARGs',
    'the web-build stage ENV',
    'the web stage ARGs',
    'the web stage ENV',
  ]) {
    expectProblem(problems, new RegExp(`NEXT_PUBLIC_NEW, missing from ${where}`));
  }
});

test('rule 5: a public build argument no web code reads', () => {
  const dockerfile = BASE_DOCKERFILE.replace(
    'ARG NEXT_PUBLIC_SITE_URL\n',
    'ARG NEXT_PUBLIC_SITE_URL\nARG NEXT_PUBLIC_STALE\n',
  );
  expectProblem(deploymentProblems({ dockerfile }), /carry NEXT_PUBLIC_STALE, which no web code/);
});

test('rule 5: continuation lines are joined and comment lines ignored', () => {
  const dockerfile = BASE_DOCKERFILE.replace(
    'ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}\nFROM',
    'ENV A=1 \\\n    NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}\n# ARG NEXT_PUBLIC_IN_A_COMMENT\nFROM',
  );
  assert.deepEqual(deploymentProblems({ dockerfile }), []);
});

test('rule 5: the web service builds a target the Dockerfile does not define', () => {
  const compose = BASE_COMPOSE.replace('target: web', 'target: website');
  expectProblem(deploymentProblems({ compose }), /builds target website/);
});

test('rule 6: the web service is not given a name its code reads at run time', () => {
  const compose = BASE_COMPOSE.replace('      REKODA_API_URL: http://api:3001\n', '      {}\n');
  expectProblem(
    deploymentProblems({ compose: compose.replace('    environment:\n      {}\n', '') }),
    /reads REKODA_API_URL at run time/,
  );
});

test('rule 6: a secret given to the web service', () => {
  const compose = BASE_COMPOSE.replace(
    'REKODA_API_URL: http://api:3001',
    'REKODA_API_URL: http://api:3001\n      VAULT_KEY: ${VAULT_KEY}',
  );
  expectProblem(deploymentProblems({ compose }), /given VAULT_KEY, which no web code reads/);
});

test('rule 6: a public value overridden at run time, and an env_file on web', () => {
  const compose = BASE_COMPOSE.replace(
    'REKODA_API_URL: http://api:3001',
    'REKODA_API_URL: http://api:3001\n      NEXT_PUBLIC_SITE_URL: https://elsewhere',
  ).replace('  web:\n', '  web:\n    env_file: .env\n');
  const problems = deploymentProblems({ compose });
  expectProblem(problems, /overrides NEXT_PUBLIC_SITE_URL at run time/);
  expectProblem(problems, /loads an env_file/);
});

test('never deployed: a test hook anywhere in the deployment files', () => {
  const compose = BASE_COMPOSE.replace(
    'REKODA_API_URL: http://api:3001',
    'REKODA_API_URL: http://api:3001\n      REKODA_E2E_PLACEHOLDER_LEGAL: "1"',
  ).replace(
    '    env_file: .env\n',
    '    env_file: .env\n    environment:\n      - REKODA_REVEAL_OTP=1\n',
  );
  const dockerfile = `${BASE_DOCKERFILE}ENV REKODA_LOCAL_STORAGE=/data\n`;
  const caddy = `${BASE_CADDY}{$PAYSTACK_BASE_URL}\n`;
  const problems = deploymentProblems({
    compose: `${compose}x-fake: \${MONO_BASE_URL}\n`,
    dockerfile,
    caddy,
  });
  expectProblem(
    problems,
    /REKODA_E2E_PLACEHOLDER_LEGAL must never be deployed, but is set on the web/,
  );
  expectProblem(problems, /REKODA_REVEAL_OTP must never be deployed, but is set on the api/);
  expectProblem(problems, /REKODA_LOCAL_STORAGE must never be deployed, but is in the web stage/);
  expectProblem(problems, /PAYSTACK_BASE_URL must never be deployed, but is read by/);
  expectProblem(problems, /MONO_BASE_URL must never be deployed, but is interpolated/);
});

test('never deployed: every listed name is one the template documents', () => {
  expectProblem(
    deploymentProblems({ documented: DOCUMENTED.filter((n) => n !== 'REKODA_REVEAL_OTP') }),
    /NEVER_DEPLOYED names REKODA_REVEAL_OTP/,
  );
});
