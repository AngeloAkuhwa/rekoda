#!/usr/bin/env node
/**
 * Contract-revision helper (docs/AUTONOMOUS-ENGINEERING.md §6): computes
 * the issue's contract snapshot — body hash PLUS the current risk and
 * builder labels, which are part of the signed contract (V3) — and
 * prints (or posts) the baseline/revision marker; --freeze posts the
 * signed amendment-freeze marker instead. Provenance rules (enforced by
 * the evaluator):
 *   - a baseline AUTHORED by the owner's human account is authorized
 *     as-is; a workflow-posted marker is authorized only when SIGNED by
 *     the contract-authority key (--sign-env, available only in the
 *     agent-contract-authority environment);
 *   - revisions and freezes are authority-SIGNED ONLY.
 * The builder holds neither, by design.
 *
 * OWNER-SNAPSHOT BINDING (revisions): a revision is signed only when the
 * freshly fetched proposed snapshot (issue, target revision, risk,
 * builder, body hash) still equals --expected-snapshot-hash — the exact
 * snapshot the OWNER authorized at dispatch time (obtained via
 * scripts/agents/amendment-context.mjs). Anything that drifted after
 * authorization refuses the signing; "latest state wins" is never the
 * amendment semantic.
 *
 *   node scripts/agents/contract-revision.mjs --repo o/n --issue 44 --baseline [--post] [--sign-env NAME]
 *   node scripts/agents/contract-revision.mjs --repo o/n --issue 44 --revision 2 --reason "…" \
 *     --expected-snapshot-hash <64hex> --sign-env NAME [--post]
 *   node scripts/agents/contract-revision.mjs --repo o/n --issue 44 --freeze --from 1 --target 2 --sign-env NAME [--post]
 */
import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import {
  normalizeBody,
  sha256Hex,
  canonicalContractPayload,
  canonicalFreezePayload,
  buildContractMarkerLines,
  buildFreezeMarkerLines,
  contractSnapshotHash,
  amendmentSignAllowed,
} from './evaluator.mjs';
import { parseContractRevisionCli } from './cli-args.mjs';

let args;
try {
  args = parseContractRevisionCli(process.argv.slice(2));
} catch (e) {
  console.error(`::error::${e.message}`);
  console.error(
    'Usage: contract-revision.mjs --repo owner/name --issue N (--baseline | --revision K --reason "…" --expected-snapshot-hash H | --freeze --from A --target B) [--post] [--sign-env NAME]',
  );
  process.exit(2);
}
const repo = args.repo;
const issue = Number(args.issue);
if (!repo || !Number.isInteger(issue)) {
  console.error('::error::--repo owner/name and an integer --issue are required.');
  process.exit(2);
}

const signWithEnv = (payload) => {
  if (!args['sign-env']) return undefined;
  const keyPem = process.env[args['sign-env']];
  if (!keyPem) {
    console.error(`Signing key env ${args['sign-env']} is empty.`);
    process.exit(1);
  }
  return cryptoSign(null, Buffer.from(payload, 'utf8'), createPrivateKey(keyPem)).toString(
    'base64',
  );
};

// Rendered through the SAME shared generators the parser is tested
// against — the emitted marker is exactly what the evaluator accepts.
let lines;
if (args.mode === 'freeze') {
  const fromRevision = Number(args.from);
  const targetRevision = Number(args.target);
  if (
    !Number.isInteger(fromRevision) ||
    !Number.isInteger(targetRevision) ||
    targetRevision !== fromRevision + 1
  ) {
    console.error('A freeze marker needs --from A and --target B with B = A + 1.');
    process.exit(2);
  }
  if (!args['sign-env']) {
    console.error('A freeze marker is authority-signed only; --sign-env is required.');
    process.exit(1);
  }
  const f = { issue, fromRevision, targetRevision };
  lines = buildFreezeMarkerLines(f, signWithEnv(canonicalFreezePayload(f)));
} else {
  const raw = JSON.parse(
    execFileSync('gh', ['api', `repos/${repo}/issues/${issue}`], { encoding: 'utf8' }),
  );
  const hash = sha256Hex(normalizeBody(raw.body ?? ''));
  // Risk and builder are part of the signed contract snapshot — a marker
  // cannot be produced for an issue whose labels are absent or ambiguous.
  const labels = (raw.labels ?? []).map((l) => l.name);
  const risks = labels.filter((l) => /^risk:R[0-3]$/.test(l));
  const builders = labels.filter((l) => /^builder:(claude|codex)$/.test(l));
  if (risks.length !== 1 || builders.length !== 1) {
    console.error(
      `Issue #${issue} must carry exactly one risk:R0..R3 and one builder:* label to record a contract (found risk: [${risks.join(', ')}], builder: [${builders.join(', ')}]).`,
    );
    process.exit(1);
  }

  let m;
  if (args.mode === 'baseline') {
    m = {
      kind: 'REKODA_CONTRACT_BASELINE',
      issue,
      revision: 1,
      risk: risks[0],
      builder: builders[0],
      bodySha256: hash,
      reason: '',
    };
  } else {
    const rev = Number(args.revision);
    if (!Number.isInteger(rev) || rev < 2) {
      console.error('A revision marker needs --revision K (K >= 2) and --reason.');
      process.exit(2);
    }
    const reason = String(args.reason ?? '')
      .replace(/\n/g, ' ')
      .trim();
    if (!reason) {
      console.error('A revision marker requires a non-empty --reason.');
      process.exit(2);
    }
    // The signer's last-instant guard: what is about to be signed must
    // be EXACTLY the snapshot the owner authorized — computed here from
    // the freshly fetched issue, compared to the hash carried from the
    // owner's dispatch. Drift (body, risk, or builder changed since
    // authorization) refuses; the freeze keeps linked PRs blocked and
    // the owner restarts the amendment against the new proposal.
    const freshSnapshotHash = contractSnapshotHash({
      issue,
      revision: rev,
      risk: risks[0],
      builder: builders[0],
      bodySha256: hash,
    });
    if (
      !amendmentSignAllowed({
        expectedSnapshotHash: String(args['expected-snapshot-hash'] ?? '').toLowerCase(),
        freshSnapshotHash,
      })
    ) {
      console.error(
        `::error::Refusing to sign revision ${rev}: the proposed snapshot is now ${freshSnapshotHash}, which is not the owner-authorized --expected-snapshot-hash (${args['expected-snapshot-hash'] ?? 'missing'}). The proposal changed after authorization — restart the amendment against the current state.`,
      );
      process.exit(1);
    }
    m = {
      kind: 'REKODA_CONTRACT_REVISION',
      issue,
      revision: rev,
      risk: risks[0],
      builder: builders[0],
      bodySha256: hash,
      reason,
    };
  }
  lines = buildContractMarkerLines(m, signWithEnv(canonicalContractPayload(m)));
}

const body = '```\n' + lines.join('\n') + '\n```';
if (args.post === true) {
  execFileSync(
    'gh',
    ['api', '--method', 'POST', `repos/${repo}/issues/${issue}/comments`, '-f', `body=${body}`],
    { encoding: 'utf8' },
  );
  console.log(`Posted to #${issue}:\n${lines.join('\n')}`);
} else {
  console.log(`Post this comment on #${issue} (or re-run with --post):\n\n${body}`);
}
