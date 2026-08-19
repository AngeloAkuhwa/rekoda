#!/usr/bin/env node
/**
 * Architectural boundaries, enforced (MASTER-PLAN 4.4 #1).
 *
 * `withBusiness()` is only a tenancy guarantee if it is the ONLY path to the
 * database. That is an architectural claim, and architectural claims decay
 * silently — one direct `postgres` import in a hurry and the guarantee is a
 * convention again, with nothing failing to say so.
 *
 * The plan calls for an ESLint `no-restricted-imports` rule. This repository
 * has no ESLint toolchain yet (`lint` is Prettier), and introducing one inside
 * a milestone about persistence would be a large, unrelated change. This is the
 * same rule with no new dependencies; fold it into ESLint when that lands.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

/** Each rule: forbidden module specifiers, where they are allowed, and why. */
const RULES = [
  {
    name: 'raw database driver',
    matches: (spec) =>
      spec === 'postgres' || spec === 'drizzle-orm' || spec.startsWith('drizzle-orm/'),
    allowedIn: ['packages/db'],
    reason:
      'query builders and the driver belong in packages/db, so every tenant-scoped query sits in one auditable place behind withBusiness()',
  },
  {
    name: 'database access from the web tier',
    matches: (spec) => spec === '@rekoda/db' || spec.startsWith('@rekoda/db/'),
    allowedIn: ['packages', 'apps/api'],
    // apps/web reaches identity only through apps/api. It holds no pool, no
    // signing secret and no tenant pin, so a mistake there cannot become a
    // cross-tenant read.
    reason: 'apps/web must reach data through apps/api, never the database directly',
  },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', 'migrations', '.git']);
const SOURCE = /\.(ts|tsx|mts|cts|mjs|js)$/;

/** Matches static imports, type-only imports, re-exports and dynamic import(). */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (SOURCE.test(entry)) yield full;
  }
}

const violations = [];
for (const dir of ['apps', 'packages']) {
  for (const file of sourceFiles(join(ROOT, dir))) {
    const rel = relative(ROOT, file).split(sep).join('/');
    // Tests and tooling configs legitimately reach for the harness they test.
    const isTestOrConfig = /\.(test|spec)\.[^/]+$|(^|\/)(vitest|playwright|drizzle)[.-]/.test(rel);

    const body = readFileSync(file, 'utf8');
    for (const [, spec] of body.matchAll(SPECIFIER)) {
      for (const rule of RULES) {
        if (!rule.matches(spec)) continue;
        if (rule.allowedIn.some((prefix) => rel.startsWith(`${prefix}/`))) continue;
        if (isTestOrConfig) continue;
        violations.push({ rel, spec, rule });
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Architectural boundary violations:\n');
  for (const { rel, spec, rule } of violations) {
    console.error(`  ${rel}`);
    console.error(`    imports "${spec}" — ${rule.name} is not allowed here`);
    console.error(`    ${rule.reason}\n`);
  }
  process.exit(1);
}

console.log(`Boundaries OK — ${RULES.length} rules, no violations.`);
