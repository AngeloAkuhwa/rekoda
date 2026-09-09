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
import { normalizeBody, sha256Hex, buildCodexVerdictTemplateLines } from './evaluator.mjs';

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
    'tech_refresh_generation',
    'gemini_refresh_generation',
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

  // Native Codex template: SCHEME/target fields plus the CURRENT
  // technical refresh generation — Codex copies every value verbatim.
  // (The signed Claude/Gemini roles never use a template; their signer
  // creates the issuance fields itself.)
  console.log('');
  console.log('--- verdict marker template (fill in VERDICT) ---');
  for (const line of buildCodexVerdictTemplateLines({
    pr,
    issue: ctx.issue,
    headSha: ctx.head_sha,
    contractRevision: ctx.contract_revision,
    contractSnapshotSha256: ctx.contract_snapshot_sha256,
    refreshGeneration: ctx.tech_refresh_generation ?? 0,
  })) {
    console.log(line);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
