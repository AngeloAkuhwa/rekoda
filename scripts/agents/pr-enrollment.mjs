#!/usr/bin/env node
/**
 * PR enrollment (X4): the trusted, authority-signed implementation-PR
 * relationship. Mutable "Closes #N" text in a PR body is DISCOVERY /
 * PROPOSAL only; the evaluator refuses every gate PASS for a PR that
 * holds no active REKODA_PR_ENROLLMENT record, so a body edit can never
 * make a PR implementation-governed by itself.
 *
 *   --enroll:  verify deterministic preconditions (PR open, same-repo,
 *              closes exactly this issue; issue has a valid current
 *              contract; no OTHER PR already holds the active
 *              enrollment), then sign and post the marker on the ISSUE.
 *   --release: sign and post a released-status marker (owner-driven).
 *   --list:    print the currently ACTIVE enrolled PRs (verified with
 *              the committed authority public key).
 *
 *   node scripts/agents/pr-enrollment.mjs --repo o/n --issue 44 --pr 55 \
 *     --enroll --sign-env CONTRACT_AUTHORITY_SIGNING_KEY
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import {
  canonicalEnrollmentPayload,
  buildEnrollmentMarkerLines,
  resolvePrEnrollment,
  parseClosingRefs,
  computeContractRevision,
} from './evaluator.mjs';
import { gh, ghPagedComplete } from './gh-lib.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? 'true'] : null))
    .filter(Boolean),
);
const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};
const repo = args.repo;
const issue = Number(args.issue);
if (!repo || !Number.isInteger(issue))
  fail(
    'Usage: pr-enrollment.mjs --repo o/n --issue N (--enroll --pr K | --release --pr K | --list) [--sign-env NAME]',
  );

const keyPath = join(dirname(fileURLToPath(import.meta.url)), 'keys', 'contract-authority.pub.pem');
const authorityPublicKey = existsSync(keyPath) ? readFileSync(keyPath, 'utf8') : null;

const issueRaw = gh(`repos/${repo}/issues/${issue}`);
const history = ghPagedComplete(`repos/${repo}/issues/${issue}/comments`);
if (!history.complete)
  fail('The issue comment history could not be proven complete — enrollment state is unprovable.');
const comments = history.items.map((c) => ({
  author: c.user?.login ?? '',
  createdAt: c.created_at,
  id: c.id,
  body: c.body ?? '',
}));

if (args.list === 'true') {
  const { activePrs } = resolvePrEnrollment({
    issueComments: comments,
    issueNumber: issue,
    prNumber: 0,
    authorityKey: authorityPublicKey,
  });
  process.stdout.write(activePrs.join('\n') + (activePrs.length ? '\n' : ''));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `active_prs=${JSON.stringify(activePrs)}\n`);
  process.exit(0);
}

const pr = Number(args.pr);
if (!Number.isInteger(pr)) fail('--pr is required for --enroll/--release.');
const keyPem = process.env[args['sign-env'] ?? ''];
if (!keyPem) fail('Enrollment markers are authority-signed only; --sign-env must name a key.');

// The active contract snapshot at enrollment time (recorded for audit;
// the relationship itself survives authorized revisions, which already
// detach all reviewer evidence).
const rev = computeContractRevision({
  issueNumber: issue,
  issueBody: issueRaw.body ?? '',
  issueComments: comments,
  issueLabels: (issueRaw.labels ?? []).map((l) => l.name),
  ownerLogin: process.env.OWNER_LOGIN || 'AngeloAkuhwa',
  contractAuthorityKey: authorityPublicKey,
});
if (rev.revision === null || rev.invalid || rev.amended || rev.labelsDiverged || rev.pendingFreeze)
  fail(
    `Issue #${issue} carries no single valid, current, authorized contract (${rev.invalid ?? (rev.amended ? 'amended' : rev.labelsDiverged ? 'labels diverged' : rev.pendingFreeze ? 'amendment freeze' : 'no baseline')}); enrollment refuses.`,
  );

const status = args.release === 'true' ? 'released' : 'active';
if (status === 'active') {
  const prRaw = gh(`repos/${repo}/pulls/${pr}`);
  if (prRaw.state !== 'open' || (prRaw.base?.repo?.full_name ?? '') !== repo)
    fail(`PR #${pr} is not an open PR of ${repo}; nothing to enroll.`);
  if ((prRaw.head?.repo?.full_name ?? repo) !== repo)
    fail(`PR #${pr} comes from a fork; agent-governed PRs are same-repository only.`);
  const refs = parseClosingRefs(prRaw.body ?? '');
  if (refs.length !== 1 || refs[0] !== issue)
    fail(
      `PR #${pr} does not close exactly issue #${issue} (found: ${refs.join(', ') || 'none'}); the closing-reference proposal must be unambiguous before enrollment.`,
    );
  const { activePrs } = resolvePrEnrollment({
    issueComments: comments,
    issueNumber: issue,
    prNumber: pr,
    authorityKey: authorityPublicKey,
  });
  const others = activePrs.filter((p) => p !== pr);
  if (others.length > 0)
    fail(
      `Issue #${issue} already has an active enrollment for PR ${others.map((p) => `#${p}`).join(', ')}; release it first — one implementation PR per issue.`,
    );
  if (activePrs.includes(pr)) {
    console.log(`PR #${pr} is already actively enrolled for issue #${issue} — idempotent no-op.`);
    process.exit(0);
  }
}

const m = { issue, pr, contractSnapshotSha256: rev.snapshotHash, status };
const signature = cryptoSign(
  null,
  Buffer.from(canonicalEnrollmentPayload(m), 'utf8'),
  createPrivateKey(keyPem),
).toString('base64');
const body = '```\n' + buildEnrollmentMarkerLines(m, signature).join('\n') + '\n```';
execFileSync(
  'gh',
  ['api', '--method', 'POST', `repos/${repo}/issues/${issue}/comments`, '-f', `body=${body}`],
  { encoding: 'utf8' },
);
console.log(`Enrollment ${status} recorded: issue #${issue} ↔ PR #${pr}.`);
