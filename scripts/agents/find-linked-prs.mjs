#!/usr/bin/env node
/**
 * Finds every open PR whose body closes the given issue, over the
 * EXHAUSTIVELY paginated open-PR listing — a linked PR is never silently
 * missed. Pagination ceiling hit or API failure → exit 1 (fail closed,
 * visibly). Prints one PR number per line.
 *
 *   GH_TOKEN=… node scripts/agents/find-linked-prs.mjs --repo o/n --issue 44
 */
import { selectLinkedPrs } from './evaluator.mjs';
import { ghPagedComplete } from './gh-lib.mjs';

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

const listing = ghPagedComplete(`repos/${repo}/pulls?state=open`);
const openPrs = listing.items.map((p) => ({ number: p.number, body: p.body ?? '' }));

const result = selectLinkedPrs({ openPrs, complete: listing.complete, issueNumber: issue });
if (!result.ok) {
  console.error(
    `::error::Cannot prove the open-PR listing complete (${result.reason}); refusing to risk missing a linked PR.`,
  );
  process.exit(1);
}
process.stdout.write(result.prs.join('\n') + (result.prs.length ? '\n' : ''));
