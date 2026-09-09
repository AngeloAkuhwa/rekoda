#!/usr/bin/env node
/**
 * Durable implementation-lane lease (Y3): the authority-signed claim /
 * release record that is the SECURITY truth of the single lane. The
 * status labels stay as UI projection and discovery index; a
 * compromised builder (issues:write, no signing key) can flip labels
 * but can neither mint a claim to admit itself nor mint a release to
 * free its lane.
 *
 *   --claim:   sign and post REKODA_IMPLEMENTATION_LANE_CLAIM (fresh
 *              claim id) on the issue. Idempotent: an existing active
 *              claim on the SAME issue is kept, not duplicated.
 *   --release: sign and post the release for the issue's active claims
 *              (owner/authority action).
 *   --status:  print lease_active / claim ids (verified with the
 *              committed authority public key).
 *
 *   node scripts/agents/lane-lease.mjs --repo o/n --issue 44 --claim \
 *     --snapshot-hash <64hex> --sign-env CONTRACT_AUTHORITY_SIGNING_KEY
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, sign as cryptoSign, randomBytes } from 'node:crypto';
import {
  canonicalLaneClaimPayload,
  canonicalLaneReleasePayload,
  buildLaneClaimMarkerLines,
  buildLaneReleaseMarkerLines,
  resolveLaneLease,
} from './evaluator.mjs';
import { ghPagedComplete } from './gh-lib.mjs';

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
    'Usage: lane-lease.mjs --repo o/n --issue N (--claim --snapshot-hash H | --release | --status) [--sign-env NAME]',
  );

const keyPath = join(dirname(fileURLToPath(import.meta.url)), 'keys', 'contract-authority.pub.pem');
const authorityPublicKey = existsSync(keyPath) ? readFileSync(keyPath, 'utf8') : null;

const history = ghPagedComplete(`repos/${repo}/issues/${issue}/comments`);
if (!history.complete)
  fail('The issue comment history could not be proven complete — lease state is unprovable.');
const comments = history.items.map((c) => ({
  author: c.user?.login ?? '',
  createdAt: c.created_at,
  id: c.id,
  body: c.body ?? '',
}));
const lease = resolveLaneLease({
  issueComments: comments,
  issueNumber: issue,
  authorityKey: authorityPublicKey,
});

if (args.status === 'true') {
  console.log(`lease_active=${lease.active}`);
  console.log(`claim_ids=${lease.claimIds.join(',')}`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `lease_active=${lease.active}\nclaim_ids=${lease.claimIds.join(',')}\n`,
    );
  process.exit(0);
}

const keyPem = process.env[args['sign-env'] ?? ''];
if (!keyPem) fail('Lane-lease markers are authority-signed only; --sign-env must name a key.');
const privateKey = createPrivateKey(keyPem);
const post = (lines) => {
  const body = '```\n' + lines.join('\n') + '\n```';
  execFileSync(
    'gh',
    ['api', '--method', 'POST', `repos/${repo}/issues/${issue}/comments`, '-f', `body=${body}`],
    { encoding: 'utf8' },
  );
};

if (args.claim === 'true') {
  const snapshotHash = String(args['snapshot-hash'] ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(snapshotHash))
    fail('--claim requires --snapshot-hash (the active contract snapshot being built).');
  if (lease.active) {
    console.log(
      `Issue #${issue} already holds an active lane claim (${lease.claimIds.join(', ')}) — idempotent no-op.`,
    );
    process.exit(0);
  }
  const m = {
    issue,
    contractSnapshotSha256: snapshotHash,
    claimId: randomBytes(16).toString('hex'),
  };
  const signature = cryptoSign(
    null,
    Buffer.from(canonicalLaneClaimPayload(m), 'utf8'),
    privateKey,
  ).toString('base64');
  post(buildLaneClaimMarkerLines(m, signature));
  console.log(`Lane claimed for issue #${issue} (claim ${m.claimId}).`);
} else if (args.release === 'true') {
  if (!lease.active) {
    console.log(`Issue #${issue} holds no active lane claim — nothing to release.`);
    process.exit(0);
  }
  for (const claimId of lease.claimIds) {
    const m = { issue, claimId };
    const signature = cryptoSign(
      null,
      Buffer.from(canonicalLaneReleasePayload(m), 'utf8'),
      privateKey,
    ).toString('base64');
    post(buildLaneReleaseMarkerLines(m, signature));
    console.log(`Lane claim ${claimId} released for issue #${issue}.`);
  }
} else {
  fail('One of --claim, --release, or --status is required.');
}
