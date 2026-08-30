#!/usr/bin/env node
/**
 * The published API reference must describe the routes that exist.
 *
 * `docs/openapi.json` is hand written, which is the only honest option here:
 * the controllers carry no schema decorators, and generating from them would
 * publish whatever the code happened to return rather than the contract we
 * chose to offer. Hand written means it can drift, and a reference that has
 * drifted is worse than none, because a developer builds against it.
 *
 * So this reads the routes out of the SOURCE and compares them to the spec's
 * paths. It reports both directions, because they fail differently: a route
 * with no spec entry is an undocumented endpoint somebody shipped, and a
 * spec entry with no route is a promise the API does not keep.
 *
 * Deliberately structural. It checks that the set of METHOD + PATH agrees,
 * not that every field of every schema does, because the schemas are pinned
 * where they are defined (`packages/contracts/src/public/v1/shape.test.ts`
 * freezes them) and a second, weaker copy of that check here would rot.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const CONTROLLERS = 'apps/api/src/api/public';
const SPEC = 'docs/openapi.json';

/** `@Controller('api/v1')` then `@Get('customers')` is GET /api/v1/customers. */
function routesInSource(dir) {
  const found = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (!entry.endsWith('.ts') || entry.includes('.test.')) continue;
    const text = readFileSync(join(ROOT, dir, entry), 'utf8');
    const base = /@Controller\(\s*'([^']*)'\s*\)/.exec(text)?.[1];
    /* A controller with no literal base path is not part of the versioned
     * surface this guard describes; the unsupported-version handler is one. */
    if (base !== 'api/v1') continue;
    for (const [, verb, path] of text.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*'([^']*)'\s*\)/g)) {
      /* Nest writes `:invoiceNumber`, OpenAPI writes `{invoiceNumber}`. */
      const openApiPath = `/${base}/${path}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      found.push(`${verb.toUpperCase()} ${openApiPath}`);
    }
  }
  return new Set(found);
}

function routesInSpec(file) {
  const spec = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  const found = [];
  for (const [path, operations] of Object.entries(spec.paths ?? {})) {
    for (const verb of Object.keys(operations)) {
      found.push(`${verb.toUpperCase()} ${path}`);
    }
  }
  return new Set(found);
}

try {
  statSync(join(ROOT, SPEC));
} catch {
  console.error(`${SPEC} is missing. The published API reference is part of the API.`);
  process.exit(1);
}

const source = routesInSource(CONTROLLERS);
const spec = routesInSpec(SPEC);

const undocumented = [...source].filter((route) => !spec.has(route)).sort();
const unkept = [...spec].filter((route) => !source.has(route)).sort();

if (undocumented.length > 0 || unkept.length > 0) {
  console.error('The API reference and the routes disagree.\n');
  for (const route of undocumented) {
    console.error(`  ${route} exists in the code and not in ${SPEC}`);
  }
  for (const route of unkept) {
    console.error(`  ${route} is promised by ${SPEC} and does not exist`);
  }
  console.error('\nA developer builds against the reference. Fix whichever is wrong.');
  process.exit(1);
}

console.log(`API reference OK — ${source.size} routes, documented and served.`);
