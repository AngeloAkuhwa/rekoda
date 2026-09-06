#!/usr/bin/env node
/**
 * Contract-revision helper (docs/AUTONOMOUS-ENGINEERING.md §6): computes
 * the body hash of an issue and prints (or posts) the baseline/revision
 * marker the policy gate requires. Auditable and hard to get wrong — the
 * hash is computed from the live issue body, never typed by hand.
 *
 *   node scripts/agents/contract-revision.mjs --repo o/n --issue 44 --baseline [--post]
 *   node scripts/agents/contract-revision.mjs --repo o/n --issue 44 --revision 2 --reason "scope change" [--post]
 */
import { execFileSync } from 'node:child_process';
import { normalizeBody, sha256Hex } from './evaluator.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? 'true'] : null))
    .filter(Boolean),
);
const repo = args.repo;
const issue = Number(args.issue);
if (!repo || !Number.isInteger(issue)) {
  console.error(
    'Usage: contract-revision.mjs --repo owner/name --issue N (--baseline | --revision K --reason "…") [--post]',
  );
  process.exit(2);
}

const raw = JSON.parse(
  execFileSync('gh', ['api', `repos/${repo}/issues/${issue}`], { encoding: 'utf8' }),
);
const hash = sha256Hex(normalizeBody(raw.body ?? ''));

let marker;
if (args.baseline === 'true') {
  marker = `REKODA_CONTRACT_BASELINE\nISSUE: ${issue}\nREVISION: 1\nBODY_SHA256: ${hash}`;
} else {
  const rev = Number(args.revision);
  if (!Number.isInteger(rev) || rev < 2) {
    console.error('A revision marker needs --revision K (K >= 2) and --reason.');
    process.exit(2);
  }
  const reason =
    String(args.reason ?? '')
      .replace(/\n/g, ' ')
      .trim() || '(none given)';
  marker = `REKODA_CONTRACT_REVISION\nISSUE: ${issue}\nREVISION: ${rev}\nBODY_SHA256: ${hash}\nREASON: ${reason}`;
}

const body = '```\n' + marker + '\n```';
if (args.post === 'true') {
  execFileSync(
    'gh',
    ['api', '--method', 'POST', `repos/${repo}/issues/${issue}/comments`, '-f', `body=${body}`],
    {
      encoding: 'utf8',
    },
  );
  console.log(`Posted to #${issue}:\n${marker}`);
} else {
  console.log(`Post this comment on #${issue} (or re-run with --post):\n\n${body}`);
}
