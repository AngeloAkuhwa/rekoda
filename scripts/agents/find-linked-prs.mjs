#!/usr/bin/env node
/**
 * Finds every open PR whose body closes the given issue, over the
 * EXHAUSTIVELY paginated open-PR listing — a linked PR is never silently
 * missed. Pagination ceiling hit or API failure → exit 1 (fail closed,
 * visibly). Prints one PR number per line.
 *
 *   GH_TOKEN=… node scripts/agents/find-linked-prs.mjs --repo o/n --issue 44
 */
import { execFileSync } from 'node:child_process';
import { selectLinkedPrs } from './evaluator.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const repo = args.repo;
const issue = Number(args.issue);
if (!repo || !Number.isInteger(issue)) {
  console.error('Usage: find-linked-prs.mjs --repo owner/name --issue N');
  process.exit(2);
}

const MAX_PAGES = 30;
const openPrs = [];
let complete = false;
try {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const chunk = JSON.parse(
      execFileSync('gh', ['api', `repos/${repo}/pulls?state=open&per_page=100&page=${page}`], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
    openPrs.push(...chunk.map((p) => ({ number: p.number, body: p.body ?? '' })));
    if (chunk.length < 100) {
      complete = true;
      break;
    }
  }
} catch (e) {
  console.error(`::error::Open-PR listing failed: ${e.message}`);
  process.exit(1);
}

const result = selectLinkedPrs({ openPrs, complete, issueNumber: issue });
if (!result.ok) {
  console.error(
    `::error::Cannot prove the open-PR listing complete (${result.reason}); refusing to risk missing a linked PR.`,
  );
  process.exit(1);
}
process.stdout.write(result.prs.join('\n') + (result.prs.length ? '\n' : ''));
