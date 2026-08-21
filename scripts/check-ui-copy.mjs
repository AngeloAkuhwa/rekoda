#!/usr/bin/env node
/**
 * No em or en dashes in anything a user reads.
 *
 * Owner's rule (19 Aug 2026): product copy must read like a person wrote it
 * for another person, and the long dash is the single strongest tell that it
 * was not. This guard scans every surface that renders text to a human, which
 * includes the marketing site AND the WhatsApp reply/gate/PDF copy in
 * @rekoda/core, since chat is the product's biggest screen.
 *
 * Code comments are allowed to use any punctuation their author likes; the
 * scan strips them first. What remains is string literals and JSX text, which
 * is exactly the set of characters a user can end up seeing.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** Surfaces a human reads. Server-only helpers are out of scope on purpose. */
const SCAN = [
  'apps/web/src',
  'packages/core/src/replies.ts',
  'packages/core/src/gates.ts',
  'packages/core/src/invoice-layout.ts',
  'packages/core/src/words.ts',
  /* The chart of accounts and the statement layouts. These were missed for
   * months because they read like internals, and they are not: an account's
   * NAME is printed on the trial balance, the balance sheet, the PDF a
   * merchant sends their bank, and the workbook their accountant opens. */
  'packages/core/src/ledger.ts',
  'packages/core/src/statement-layout.ts',
  'packages/core/src/receipt-layout.ts',
  'packages/core/src/expenses.ts',
  'packages/core/src/sources.ts',
];

const DASHES = /[—–]/; // em dash, en dash

function* walk(path) {
  const full = join(ROOT, path);
  if (statSync(full).isFile()) {
    yield path;
    return;
  }
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (entry.isDirectory()) yield* walk(join(path, entry.name));
    else if (/\.(ts|tsx)$/.test(entry.name)) yield join(path, entry.name);
  }
}

/**
 * Strip comments, keep everything else with line structure intact.
 * Block comments are blanked (newlines preserved); line comments are cut at
 * `//` unless it is part of a URL scheme (`://`).
 */
function withoutComments(source) {
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlocks
    .split('\n')
    .map((line) => {
      const cut = line.search(/(?<!:)\/\/(?!\S*:\/\/)/);
      return cut === -1 ? line : line.slice(0, cut);
    })
    .join('\n');
}

const failures = [];
for (const path of SCAN) {
  for (const file of walk(path)) {
    const stripped = withoutComments(readFileSync(join(ROOT, file), 'utf8'));
    stripped.split('\n').forEach((line, i) => {
      if (DASHES.test(line)) failures.push(`${relative(ROOT, join(ROOT, file))}:${i + 1}`);
    });
  }
}

if (failures.length > 0) {
  console.error('Em/en dash found in user-facing copy (comments are fine, copy is not):');
  for (const f of failures) console.error(`  ${f}`);
  console.error('\nRewrite the sentence with a period, comma, colon or parentheses.');
  process.exit(1);
}
console.log('UI copy OK — no em/en dashes in anything a user reads.');
