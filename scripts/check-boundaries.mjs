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
  {
    // Spec Appendix C.4, one half: domain and accounting code may not import
    // a provider SDK. The day @rekoda/core knows what OpenAI is, a model
    // change becomes an accounting change, and the boundary that lets a
    // provider be swapped without touching a posting is gone.
    name: 'provider SDK in domain code',
    matches: (spec) =>
      spec === 'openai' ||
      spec.startsWith('openai/') ||
      spec.startsWith('@anthropic-ai/') ||
      spec.startsWith('@aws-sdk/'),
    allowedIn: ['apps/api'],
    reason:
      'provider SDKs live behind adapters in apps/api (spec Appendix C.4); packages/core and packages/db must stay provider-blind',
  },
];

/**
 * Spec Appendix C.4, the mirrored half: AI adapters may not import financial
 * repositories or the accounting engine. Symbol-level rather than
 * specifier-level, because the financial repos and the AI quota repo ship
 * from the same `@rekoda/db` barrel — the specifier cannot tell a
 * transcription adapter reading its own ceiling from one issuing an invoice.
 *
 * Denied by NAME: the repositories that write financial truth, and the
 * `post*` posting builders that are the accounting engine's public face.
 */
const AI_ADAPTER_DIR = 'apps/api/src/ai/';
const FINANCIAL_SYMBOL =
  /^(issueRepo|settleRepo|paymentsRepo|ordersRepo|reportsRepo|stockRepo|catalogueRepo|provenanceRepo|outboxRepo|evidenceRetentionRepo|retentionRepo|spendRepo|bankRepo|billingRepo)$|^post[A-Z]/;
const NAMED_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](@rekoda\/(?:db|core))['"]/g;

function aiAdapterViolations(rel, body) {
  if (!rel.startsWith(AI_ADAPTER_DIR)) return [];
  const found = [];
  for (const [, clause, spec] of body.matchAll(NAMED_IMPORT)) {
    for (const raw of clause.split(',')) {
      const name = raw
        .replace(/\btype\b/, '')
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name && FINANCIAL_SYMBOL.test(name)) {
        found.push({
          rel,
          spec: `${name} from ${spec}`,
          rule: {
            name: 'financial code in an AI adapter',
            reason:
              'AI adapters may not import financial repositories or the accounting engine (spec Appendix C.4); the interpreter proposes, the command layer disposes',
          },
        });
      }
    }
  }
  return found;
}

/**
 * A1's completion gate (spec §25, build plan A1): no financial write occurs
 * outside the command layer. The fourteen commands own these writers; a
 * controller, job handler or sweep that calls one directly has built the
 * alternate cheaper path §25 exists to forbid. Member-access is what the
 * repos expose (`issueRepo.issueSale(...)`), so the scan is on call sites,
 * not import specifiers.
 */
const COMMAND_LAYER_DIR = 'apps/api/src/commands/';
const FINANCIAL_WRITER_CALL =
  /\.(issueSale|voidInvoice|recordMerchantPayment|recordPaymentByNumber|bookVerifiedPayment|recordExpense|recordPurchase|recordJournal|recordOpeningBalances|closeBooks|reopenBooks|importStatementLines|matchByHand|eraseAllIdentities|placeOrder|recordSaleMovements|recordDelivery|recordMovement|writePosting|appendVerification)\(/g;

function commandLayerViolations(rel, body) {
  if (!rel.startsWith('apps/api/src/')) return [];
  if (rel.startsWith(COMMAND_LAYER_DIR)) return [];
  const found = [];
  for (const m of body.matchAll(FINANCIAL_WRITER_CALL)) {
    found.push({
      rel,
      spec: `${m[1]}()`,
      rule: {
        name: 'financial write outside the command layer',
        reason:
          'every ingress converges on the command layer (spec §25); call the command work function in apps/api/src/commands instead of the repository writer',
      },
    });
  }
  return found;
}

/**
 * Spec §27: "Public contracts must not expose Drizzle table shapes. Contracts
 * live in packages/contracts and are versioned independently of the schema."
 *
 * Independence is a claim about imports before it is a claim about anything
 * else: a contract that can name a table type is one refactor away from
 * BEING the table type, and the day it is, a migration silently reshapes
 * somebody else's integration. The freeze test in
 * packages/contracts/src/public/v1/shape.test.ts guards the shapes; this
 * guards the reach.
 */
const CONTRACTS_DIR = 'packages/contracts/src/';
const SCHEMA_SPECIFIER = /^(@rekoda\/db(\/.*)?|drizzle-orm(\/.*)?)$/;

function contractViolations(rel, body) {
  if (!rel.startsWith(CONTRACTS_DIR)) return [];
  const found = [];
  for (const [, spec] of body.matchAll(SPECIFIER)) {
    if (!SCHEMA_SPECIFIER.test(spec)) continue;
    found.push({
      rel,
      spec,
      rule: {
        name: 'schema types in a wire contract',
        reason:
          'contracts are versioned independently of the schema (spec §27); describe the wire shape in zod rather than importing a table type',
      },
    });
  }
  return found;
}

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
    if (!isTestOrConfig) violations.push(...aiAdapterViolations(rel, body));
    if (!isTestOrConfig) violations.push(...commandLayerViolations(rel, body));
    if (!isTestOrConfig) violations.push(...contractViolations(rel, body));
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

console.log(`Boundaries OK — ${RULES.length + 2} rules, no violations.`);
