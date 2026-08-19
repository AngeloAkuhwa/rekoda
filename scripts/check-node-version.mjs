#!/usr/bin/env node
/**
 * One Node version, and it must be an LTS (owner standard, 19 Aug 2026).
 *
 * `.nvmrc` is the single source of truth. Everything else — `engines.node`,
 * every `@types/node`, the version actually running — is checked against it,
 * because a project can be "consistent" in four files and still be tested on a
 * fifth version nobody declared.
 *
 * The failure this exists to prevent is quiet. Types describing a NEWER Node
 * than the one you run let code call an API that does not exist yet: it
 * typechecks, it passes CI, and it throws in production. Types describing an
 * OLDER one just make correct code look wrong. Neither is caught by any test,
 * because both are about the description rather than the behaviour.
 *
 *   node scripts/check-node-version.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

const problems = [];

/* ── the source of truth ────────────────────────────────────────────────── */

const declared = read('.nvmrc').trim();
if (!/^\d+$/.test(declared)) {
  problems.push(`.nvmrc should be a bare major version like "24", not ${JSON.stringify(declared)}`);
}
const major = Number(declared);

/**
 * Node promotes EVEN majors to LTS; odd ones never become LTS and are
 * unsupported within months. This catches the whole class rather than a
 * hard-coded list that would go stale — a list would need editing every
 * October, and the edit is exactly what gets forgotten.
 */
if (major % 2 !== 0) {
  problems.push(
    `Node ${major} is an odd major and will never be LTS. ` +
      `Rekoda runs LTS only — use the current even-numbered LTS.`,
  );
}

/* ── everything that must agree with it ─────────────────────────────────── */

const engines = readJson('package.json').engines?.node;
if (engines !== `>=${major}`) {
  problems.push(`package.json engines.node is ${JSON.stringify(engines)}, expected ">=${major}"`);
}

/** Every workspace that declares @types/node must declare the same major. */
function* manifests(dir) {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const pkg = join(dir, entry, 'package.json');
    try {
      if (statSync(join(ROOT, pkg)).isFile()) yield pkg;
    } catch {
      /* not a workspace */
    }
  }
}

for (const manifest of [...manifests('apps'), ...manifests('packages')]) {
  const types = readJson(manifest).devDependencies?.['@types/node'];
  if (types === undefined) continue;
  if (types !== `^${major}`) {
    problems.push(
      `${manifest} has @types/node ${types}, expected "^${major}". ` +
        `Types ahead of the runtime let code call APIs that do not exist yet — ` +
        `it typechecks, CI passes, and it throws in production.`,
    );
  }
}

/**
 * And the Node actually running this. A developer or a container on the wrong
 * major is how "works on my machine" starts, and it is invisible until
 * something behaves differently in CI.
 */
const running = Number(process.versions.node.split('.')[0]);
if (running !== major) {
  problems.push(
    `running Node ${process.versions.node}, but .nvmrc says ${major}. ` +
      `Run \`nvm use\` (or rebuild the container) so you are testing what ships.`,
  );
}

if (problems.length > 0) {
  console.error(`Node version drift (.nvmrc says ${declared}):\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(`Node ${major} LTS — .nvmrc, engines, @types/node and the running version all agree.`);
