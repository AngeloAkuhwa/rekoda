/**
 * Document-year guard for integration tests.
 *
 * Rekoda numbers a document with the Lagos year of the instant it is issued
 * (`INV-2026-000001`). An integration test that issues a document at "now"
 * and then asserts a literal year passes today and fails on 1 January, with
 * nothing broken. This guard stops new ones:
 *
 *   with `--base-ref <ref>` (CI passes the pull request's target branch), a
 *   line ADDED or changed since that ref, in an `*.integration.test.ts` or
 *   `*.fixtures.ts` file, that holds a document number with a year
 *   (`INV-2026-`, `RCT-2027-`, `PO-2026-` …) fails unless the statement block
 *   it belongs to is annotated with one of:
 *
 *     // fixed date: <why>   the test issued it at an instant it passed in
 *     // not issued: <why>   an input, a stored fixture or a not-found probe
 *
 *   The block is the run of non-blank lines the literal sits in: the
 *   annotation may be on the literal's own line or on any line above it
 *   before the previous blank line.
 *
 * Lines already on the base ref are never flagged, so existing fixtures need
 * no churn. Comment lines are ignored (they assert nothing), and so are format
 * patterns (`INV-\d{4}-`) and calendar dates (`'2026-08-03'`): a date literal
 * is a different question, answered by the code that compares it with now.
 * Unit tests are out of scope: their numbers are always inputs.
 *
 * Without `--base-ref` it reports every unannotated literal in the tree and
 * exits 0, for audits.
 *
 *   node scripts/check-test-years.mjs [--base-ref <ref>]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** A document number with a four-digit year: a prefix of capitals, a dash, 20NN, a dash. */
export const DOCUMENT_YEAR = /\b[A-Z]{2,5}-20\d\d-/;
const ANNOTATION = /\/\/\s*(fixed date|not issued):/;
const SCOPE = /\.(integration\.test|fixtures)\.ts$/;

/** Pure: is this path one the guard reads? */
export function inScope(path) {
  return SCOPE.test(path);
}

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** Pure: is the literal on line index `i` covered by an annotation in its block? */
export function annotated(lines, i) {
  for (let j = i; j >= 0; j -= 1) {
    if (ANNOTATION.test(lines[j])) return true;
    if (j < i && lines[j].trim() === '') return false;
  }
  return false;
}

/**
 * Pure: the unannotated document-year literals in one file. `only`, when
 * given, is the set of 1-based line numbers to look at (the added ones).
 */
export function findings(path, text, only) {
  if (!inScope(path)) return [];
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (only && !only.has(i + 1)) return;
    if (isComment(line) || !DOCUMENT_YEAR.test(line)) return;
    if (annotated(lines, i)) return;
    out.push({ path, line: i + 1, text: line.trim() });
  });
  return out;
}

/** Pure: the added line numbers per file from `git diff --unified=0` output. */
export function addedLines(diff) {
  const files = new Map();
  let current = null;
  for (const line of diff.split('\n')) {
    const file = /^\+\+\+ b\/(.+)$/.exec(line);
    if (file) {
      current = file[1];
      files.set(current, new Set());
      continue;
    }
    if (line.startsWith('+++ ')) {
      current = null; // a deleted file
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let n = start; n < start + count; n += 1) files.get(current).add(n);
    }
  }
  return files;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64e6 });
}

function main() {
  const at = process.argv.indexOf('--base-ref');
  const ref = at === -1 ? null : process.argv[at + 1];
  if (at !== -1 && !ref) throw new Error('--base-ref needs a ref');

  let found = [];
  if (ref) {
    try {
      git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    } catch {
      throw new Error(`--base-ref ${ref} is not a commit this checkout has; fetch it first`);
    }
    const diff = git([
      'diff',
      '--unified=0',
      '--no-color',
      '--no-ext-diff',
      '--diff-filter=AMR',
      ref,
      '--',
      '*.integration.test.ts',
      '*.fixtures.ts',
    ]);
    for (const [path, lines] of addedLines(diff)) {
      found = found.concat(findings(path, readFileSync(path, 'utf8'), lines));
    }
  } else {
    const paths = git(['ls-files', '-z']).split('\0').filter(inScope);
    for (const path of paths) found = found.concat(findings(path, readFileSync(path, 'utf8')));
  }

  for (const f of found) {
    console.log(`${ref ? 'error' : 'note '} ${f.path}:${f.line}: ${f.text}`);
  }
  if (ref) {
    if (found.length) {
      console.log(
        `\n${found.length} new document-year literal(s). A document issued at "now" is numbered ` +
          'in the current Lagos year, so assert the number the test issued, not a literal ' +
          "(read it back from what the writer returned). If the year really is fixed, say why on the block: '// fixed date: …' " +
          "or '// not issued: …'.",
      );
    }
    console.log(`test years: ${found.length} error(s) on lines added since ${ref}`);
    process.exit(found.length ? 1 : 0);
  }
  console.log(`test years: ${found.length} unannotated document-year literal(s) (report only)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
