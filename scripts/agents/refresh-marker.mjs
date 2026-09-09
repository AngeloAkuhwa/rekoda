#!/usr/bin/env node
/**
 * Creates the DURABLE review-refresh generation (X3): before any forced
 * fresh review starts, trusted control-plane authority posts the signed
 * REKODA_REVIEW_REFRESH marker for (PR, HEAD, contract snapshot, role),
 * generation = current + 1. From that durable moment, evidence from
 * every earlier generation is invalid whatever happens next — AI
 * failure, signer failure, job cancellation, a concurrent ordinary
 * finalizer, or re-posted comment text — and nothing "clears" the
 * generation: only fresh evidence binding it can make the gate green.
 *
 * Run inside the role's per-(PR, role) issuance lane, with the role's
 * signing key (the same environment the evidence publisher uses — a
 * trusted deterministic job; the AI never holds this key).
 *
 *   node scripts/agents/refresh-marker.mjs --repo o/n --pr 55 \
 *     --role technical|acceptance --sign-env CLAUDE_REVIEWER_SIGNING_KEY
 *   → posts the PR comment; prints refresh_generation=N to GITHUB_OUTPUT
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto';
import {
  canonicalRefreshPayload,
  buildRefreshMarkerLines,
  currentRefreshGeneration,
} from './evaluator.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};
const repo = args.repo;
const pr = Number(args.pr);
const role = args.role;
if (!repo || !Number.isInteger(pr) || !['technical', 'acceptance'].includes(role ?? ''))
  fail('Usage: refresh-marker.mjs --repo o/n --pr N --role technical|acceptance --sign-env NAME');
const keyPem = process.env[args['sign-env'] ?? ''];
if (!keyPem) fail('A refresh marker is control-plane-signed only; --sign-env must name a key.');
let privateKey;
try {
  privateKey = createPrivateKey(keyPem);
} catch (e) {
  fail(`Signing key is not a valid private key: ${e.message}`);
}
const ownPublicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });

// Fresh, complete state via the canonical normalizer — the refresh
// binds the CURRENT head and ACTIVE contract snapshot, both re-resolved
// here, never taken from the caller's earlier snapshot.
const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'rekoda-refresh-'));
try {
  const stateFile = join(tmp, 'state.json');
  execFileSync(
    process.execPath,
    [join(here, 'normalize.mjs'), '--repo', repo, '--pr', String(pr), '--out', stateFile],
    { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const ctxText = execFileSync(
    process.execPath,
    [join(here, 'run-gate.mjs'), '--state', stateFile, '--print-context'],
    { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } },
  );
  const ctx = Object.fromEntries(
    ctxText
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  if (ctx.contract_ok !== 'true')
    fail('No single authorized, unamended contract snapshot exists — nothing to refresh against.');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const target = {
    pr,
    headSha: ctx.head_sha,
    contractSnapshotSha256: ctx.contract_snapshot_sha256,
  };
  const candidates =
    role === 'technical' ? state.techEvidence?.candidates : state.geminiEvidence?.candidates;
  const current = currentRefreshGeneration({
    candidates,
    role,
    target,
    publicKey: ownPublicPem,
  });
  const m = {
    pr,
    headSha: target.headSha,
    contractSnapshotSha256: target.contractSnapshotSha256,
    role,
    refreshGeneration: current + 1,
  };
  const signature = cryptoSign(
    null,
    Buffer.from(canonicalRefreshPayload(m), 'utf8'),
    privateKey,
  ).toString('base64');
  const body = '```\n' + buildRefreshMarkerLines(m, signature).join('\n') + '\n```';
  execFileSync(
    'gh',
    ['api', '--method', 'POST', `repos/${repo}/issues/${pr}/comments`, '-f', `body=${body}`],
    { encoding: 'utf8' },
  );
  console.log(
    `Refresh generation ${m.refreshGeneration} is now current for PR #${pr} ${role} at ${target.headSha}.`,
  );
  console.log(`refresh_generation=${m.refreshGeneration}`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `refresh_generation=${m.refreshGeneration}\n`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
