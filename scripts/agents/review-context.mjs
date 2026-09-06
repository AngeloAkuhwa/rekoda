#!/usr/bin/env node
/**
 * The ONE trusted review contract for a PR — what Claude, Gemini, AND
 * native Codex all review against, so every reviewer assesses the SAME
 * authoritative contract snapshot (never live mutable issue text, which
 * may carry pending proposals):
 *
 *   node scripts/agents/review-context.mjs --repo o/n --pr 55 [--out snapshot.md]
 *
 * Prints key=value lines:
 *   pr, head_sha, issue, contract_revision, contract_ok, risk, builder,
 *   contract_body_sha256, contract_snapshot_sha256
 * then, when the contract is OK, the exact verdict-marker template a
 * reviewer must emit (native Codex copies it and fills in VERDICT).
 * With --out it also writes the ACTIVE contract snapshot body (hash-
 * verified) to that file — the text to review. If contract_ok is false
 * it exits 1: there is no authorized snapshot to review, and any review
 * produced anyway is unusable evidence.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKERS, SCHEME, normalizeBody, sha256Hex } from './evaluator.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const repo = args.repo;
const pr = Number(args.pr);
if (!repo || !Number.isInteger(pr)) {
  console.error('Usage: review-context.mjs --repo owner/name --pr N [--out snapshot.md]');
  process.exit(2);
}

// Normalize the full trusted state, then reuse the gate's own context
// computation — one code path decides contract_ok everywhere.
const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'rekoda-review-'));
const stateFile = join(tmp, 'state.json');
try {
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
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));

  for (const k of [
    'head_sha',
    'issue',
    'contract_revision',
    'contract_ok',
    'risk',
    'builder',
    'contract_body_sha256',
    'contract_snapshot_sha256',
  ]) {
    console.log(`${k}=${ctx[k] ?? ''}`);
  }
  console.log(`pr=${pr}`);

  if (ctx.contract_ok !== 'true') {
    console.error(
      '::error::No single authorized, unamended contract snapshot exists for this PR (pending proposal, diverged labels, amendment freeze, or missing baseline) — there is nothing valid to review.',
    );
    process.exit(1);
  }

  const body = state.issue?.body ?? '';
  const bodyHash = sha256Hex(normalizeBody(body));
  if (bodyHash !== ctx.contract_body_sha256) {
    console.error('::error::Issue body hash no longer matches the active contract — racing edit.');
    process.exit(1);
  }
  if (args.out) {
    writeFileSync(args.out, body);
    console.log(`snapshot_written=${args.out}`);
  }

  const markerName =
    ctx.builder === 'builder:claude'
      ? MARKERS.codex
      : ctx.builder === 'builder:codex'
        ? MARKERS.claude
        : MARKERS.codex;
  console.log('');
  console.log('--- verdict marker template (fill in VERDICT) ---');
  console.log(markerName);
  console.log(`SCHEME: ${SCHEME}`);
  console.log(`PR: ${pr}`);
  console.log(`ISSUE: ${ctx.issue}`);
  console.log(`HEAD_SHA: ${ctx.head_sha}`);
  console.log(`CONTRACT_REVISION: ${ctx.contract_revision}`);
  console.log(`CONTRACT_SNAPSHOT_SHA256: ${ctx.contract_snapshot_sha256}`);
  console.log('VERDICT: APPROVE|BLOCK');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
