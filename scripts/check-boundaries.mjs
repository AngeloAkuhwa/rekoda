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

/**
 * A CAPACITY unit may never reach the monthly meter (owner ruling, 28 Aug
 * 2026; `UNIT_KIND` in @rekoda/core).
 *
 * `consumeUnit` spends something and resets at the month boundary. A held
 * thing is not spent, so putting a capacity unit through it produces a bug
 * a merchant feels rather than one a test catches: they delete every
 * application they hold and still cannot register another until the month
 * turns over. PR-113 shipped exactly that, which is why this is a rule now
 * and not a convention.
 *
 * Matched on the literal in the call, because the unit always arrives as
 * one: `consumeUnit(tx, id, period, 'API_APPLICATIONS', n)`.
 *
 * The one rule here that TESTS are not exempt from. Every other rule guards
 * a dependency direction a suite has a legitimate reason to cross; this one
 * guards the meaning of a unit, and a suite that credits a month's bonus to
 * buy capacity is asserting the wrong model however green it runs. PR-113's
 * suites did exactly that and passed.
 */
const CAPACITY_UNITS = [
  'ACCOUNTANT_USERS',
  'PAYMENT_CONNECTIONS',
  'FINANCIAL_ACCOUNT_CONNECTIONS',
  'API_APPLICATIONS',
];
const CONSUME_CALL = /\b(?:consumeUnit|refundUnit|creditBonus)\s*\(([\s\S]{0,240}?)\)/g;

function capacityMeterViolations(rel, body) {
  if (!rel.startsWith('apps/') && !rel.startsWith('packages/')) return [];
  const found = [];
  for (const match of body.matchAll(CONSUME_CALL)) {
    for (const unit of CAPACITY_UNITS) {
      if (!match[1].includes(`'${unit}'`)) continue;
      found.push({
        rel,
        spec: `${unit} in a monthly meter call`,
        rule: {
          verb: 'passes',
          name: 'capacity unit through the monthly meter',
          reason:
            'CAPACITY units are held, not spent (UNIT_KIND in @rekoda/core): check the ceiling against how many currently exist, so deleting one frees the slot',
        },
      });
    }
  }
  return found;
}

/**
 * A HIGH_RISK command's ceremony is not a configuration choice (spec §25,
 * Appendix D; `COMMAND_RISK` in @rekoda/core).
 *
 * The rule above guards one layer down: no ingress may call a repository
 * WRITER directly. This one guards the layer above it. A controller that
 * calls `reopenPeriodWork(tx, input)` has stayed inside the command layer
 * and still skipped the confirmation, the reason, the exact phrase and the
 * audit record that make the command HIGH_RISK. That is exactly the shape
 * the rollout flags shipped in A1: `if (!config.commandReopenPeriod) return
 * reopenPeriodWork(tx, input)`, which let a default deployment reopen a
 * filed month with no ceremony at all.
 *
 * So a HIGH_RISK work function may only ever be HANDED to the bus. In
 * practice that is always the thunk `() => reopenPeriodWork(tx, input)`
 * passed as `CommandBus.run`'s second argument; a direct `await` or
 * `return` of it is the bypass. Matching on the thunk rather than trying to
 * recognise the bus call is deliberate: it needs no multi-line parsing and
 * it fails closed, because every new way of calling the function directly
 * is a way that is not `() =>`.
 *
 * `DORMANT` names a HIGH_RISK command that is classified and has no work
 * function and no ingress. Those are the cheapest ones to get wrong later:
 * nothing to review, nothing to test, and the day somebody adds a refund
 * endpoint the tier is already declared and nothing enforces it. Naming
 * them here means the day a dormant command appears in `apps/api/src`, this
 * fails until whoever added it says how the ceremony is enforced.
 *
 * Context-elevated invocations (`AdjustInventory` when destructive,
 * `PostJournal` when manual, `ConfirmReconciliation` when overriding,
 * `DeactivateAccount` for a mandatory role) are deliberately NOT here. Their
 * base tier is STANDARD, so the work function has legitimate direct callers
 * and no static rule can tell the two apart. Their guarantee is behavioural,
 * pinned in the integration suites.
 */
const DORMANT = Symbol('classified HIGH_RISK, no work function and no ingress');
const HIGH_RISK_INGRESS = {
  RefundPayment: DORMANT,
  RevokePaymentVerification: DORMANT,
  ChangePostingAccountPolicy: DORMANT,
  DisconnectPaymentConnection: DORMANT,
  ChangePaymentConnectionCredential: DORMANT,
  ChangePaymentConnectionProvider: DORMANT,
  ReopenAccountingPeriod: 'reopenPeriodWork',
  VoidReceipt: 'voidReceiptWork',
  EraseData: 'eraseDataWork',
};

const COMMAND_LAYER = 'apps/api/src/commands/';
const RISK_TABLE = 'packages/core/src/risk.ts';

/** The HIGH_RISK rows of `COMMAND_RISK`, read from the table itself. */
function highRiskCommands() {
  const body = readFileSync(join(ROOT, RISK_TABLE), 'utf8');
  const table = body.slice(body.indexOf('COMMAND_RISK'));
  return [...table.matchAll(/^\s*(\w+): 'HIGH_RISK',/gm)].map((m) => m[1]);
}

const dormantSightings = [];

function highRiskViolations(rel, body) {
  if (!rel.startsWith('apps/api/src/')) return [];
  if (rel.startsWith(COMMAND_LAYER)) return [];
  const found = [];

  for (const [command, ingress] of Object.entries(HIGH_RISK_INGRESS)) {
    if (ingress === DORMANT) {
      if (new RegExp(`\\b${command}\\b`).test(body)) dormantSightings.push({ rel, command });
      continue;
    }
    for (const match of body.matchAll(new RegExp(`\\b${ingress}\\s*\\(`, 'g'))) {
      const before = body.slice(0, match.index).trimEnd();
      if (before.endsWith('=>')) continue;
      found.push({
        rel,
        spec: `${ingress}()`,
        rule: {
          verb: 'calls',
          name: `${command}'s work function directly`,
          reason: `${command} is HIGH_RISK (COMMAND_RISK in @rekoda/core), so its work function may only be handed to CommandBus.run as \`() => ${ingress}(...)\`; calling it directly skips the confirmation ceremony the tier exists for`,
        },
      });
    }
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
    if (!isTestOrConfig) violations.push(...highRiskViolations(rel, body));
    violations.push(...capacityMeterViolations(rel, body));
  }
}

/* Every HIGH_RISK command must be named above. A new one classified in
 * `COMMAND_RISK` and left out of `HIGH_RISK_INGRESS` is a tier nobody
 * decided how to enforce, which is the state this rule exists to end. */
for (const command of highRiskCommands()) {
  if (command in HIGH_RISK_INGRESS) continue;
  violations.push({
    rel: RISK_TABLE,
    spec: command,
    rule: {
      verb: 'classifies',
      name: 'a HIGH_RISK command with no declared enforcement',
      reason:
        'add it to HIGH_RISK_INGRESS in scripts/check-boundaries.mjs: either DORMANT (no work function, no ingress) or the name of the work function that must always be handed to CommandBus.run',
    },
  });
}

for (const { rel, command } of dormantSightings) {
  violations.push({
    rel,
    spec: command,
    rule: {
      verb: 'reaches',
      name: 'a HIGH_RISK command declared to have no ingress',
      reason: `${command} is HIGH_RISK and was recorded as DORMANT in scripts/check-boundaries.mjs. Giving it an ingress means deciding how its ceremony is enforced first: add its work function to HIGH_RISK_INGRESS so the thunk rule covers it`,
    },
  });
}

if (violations.length > 0) {
  console.error('Architectural boundary violations:\n');
  for (const { rel, spec, rule } of violations) {
    console.error(`  ${rel}`);
    console.error(`    ${rule.verb ?? 'imports'} "${spec}": ${rule.name} is not allowed here`);
    console.error(`    ${rule.reason}\n`);
  }
  process.exit(1);
}

console.log(`Boundaries OK — ${RULES.length + 5} rules, no violations.`);
