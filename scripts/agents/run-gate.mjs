#!/usr/bin/env node
/**
 * Gate CLI over the pure evaluator: reads a normalized state JSON, runs
 * evaluate() in the given mode, prints the reasons, exits 0 on PASS and
 * 1 on BLOCK. --print-context exposes constrained values (numbers,
 * enums, hex) for workflow steps — no untrusted free text ever reaches
 * a shell through these outputs.
 *
 * Usage: node scripts/agents/run-gate.mjs --state /tmp/state.json --mode policy|technical|acceptance|full
 */
import { readFileSync, appendFileSync } from 'node:fs';
import {
  evaluate,
  computeContractRevision,
  resolveVerdict,
  currentRefreshGeneration,
  resolvePrEnrollment,
  isGoverned,
  MARKERS,
} from './evaluator.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] ?? 'true'] : null))
    .filter(Boolean),
);
const state = JSON.parse(readFileSync(args.state, 'utf8'));
const mode = args.mode ?? 'full';

if (args['print-context'] === 'true') {
  const cfg = state.config;
  const keys = cfg.publicKeys ?? {};
  const rev = state.issue
    ? computeContractRevision({
        issueNumber: state.issue.number,
        issueBody: state.issue.body,
        issueComments: state.issue.comments,
        issueLabels: state.issue.labels ?? [],
        ownerLogin: cfg.ownerLogin,
        contractAuthorityKey: keys.contractAuthority ?? null,
      })
    : { revision: null };
  const builder = state.pr.builderLabels.length === 1 ? state.pr.builderLabels[0] : '';
  const risk = state.pr.riskLabels.length === 1 ? state.pr.riskLabels[0] : '';
  const target =
    rev.revision !== null && state.issue
      ? {
          pr: state.pr.number,
          issue: state.issue.number,
          headSha: state.pr.headSha,
          contractRevision: rev.revision,
          contractSnapshotSha256: rev.snapshotHash,
        }
      : null;
  // Durable refresh generations (X3): the CURRENT signed generation per
  // role — evidence from any other generation never satisfies a gate.
  const techGeneration = target
    ? currentRefreshGeneration({
        candidates: state.techEvidence?.candidates,
        role: 'technical',
        target,
        publicKey: keys.claudeReviewer ?? null,
      })
    : 0;
  const geminiGeneration = target
    ? currentRefreshGeneration({
        candidates: state.geminiEvidence?.candidates,
        role: 'acceptance',
        target,
        publicKey: keys.geminiReviewer ?? null,
      })
    : 0;
  const verdictOf = (candidates, markerName, provenance, refreshGeneration) =>
    target
      ? (resolveVerdict({
          candidates,
          markerName,
          provenance,
          target: { ...target, refreshGeneration },
        }).verdict ?? 'none')
      : 'none';
  const techVerdict =
    builder === 'builder:claude'
      ? verdictOf(
          state.techEvidence?.candidates,
          MARKERS.codex,
          { kind: 'codex', login: cfg.codexLogin },
          techGeneration,
        )
      : builder === 'builder:codex'
        ? verdictOf(
            state.techEvidence?.candidates,
            MARKERS.claude,
            { kind: 'signature', publicKey: keys.claudeReviewer ?? null },
            techGeneration,
          )
        : 'none';
  const geminiVerdict = verdictOf(
    state.geminiEvidence?.candidates,
    MARKERS.gemini,
    { kind: 'signature', publicKey: keys.geminiReviewer ?? null },
    geminiGeneration,
  );
  // contract_ok: the issue currently carries ONE authorized, unamended,
  // provably complete contract whose risk/builder labels still match the
  // signed snapshot and with NO amendment freeze in progress — the
  // precondition for exporting a snapshot to reviewers and for a
  // publisher to sign against it.
  const contractOk =
    rev.revision !== null &&
    rev.baselineFound === true &&
    !rev.invalid &&
    rev.amended !== true &&
    rev.labelsDiverged !== true &&
    !rev.pendingFreeze &&
    state.issue?.commentsComplete !== false;
  // X4: the trusted implementation-PR relationship — closing-reference
  // text is discovery only; only an authority-signed active enrollment
  // makes this PR reviewable/mergeable for the issue.
  const enrolled = state.issue
    ? resolvePrEnrollment({
        issueComments: state.issue.comments,
        issueNumber: state.issue.number,
        prNumber: state.pr.number,
        authorityKey: keys.contractAuthority ?? null,
      }).enrolled
    : false;
  const ctx = {
    governed: isGoverned(state) ? 'true' : 'false',
    enrolled: enrolled ? 'true' : 'false',
    issue: state.issue?.number ?? '',
    head_sha: state.pr.headSha,
    contract_revision: rev.revision ?? '',
    contract_ok: contractOk ? 'true' : 'false',
    contract_body_sha256: contractOk ? rev.expectedHash : '',
    contract_snapshot_sha256: contractOk ? rev.snapshotHash : '',
    risk,
    builder,
    draft: state.pr.draft ? 'true' : 'false',
    fork: state.pr.fork ? 'true' : 'false',
    tech_verdict: techVerdict,
    gemini_verdict: geminiVerdict,
    tech_refresh_generation: techGeneration,
    gemini_refresh_generation: geminiGeneration,
  };
  for (const [k, v] of Object.entries(ctx)) {
    console.log(`${k}=${v}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  }
  process.exit(0);
}

const result = evaluate(state, mode);
for (const r of result.reasons) console.error(`::error::[${r.code}] ${r.message}`);
if (result.pass) {
  console.log(`Gate mode '${mode}' PASSED for PR #${state.pr.number} at ${state.pr.headSha}.`);
  process.exit(0);
}
console.error(
  `::error::Gate mode '${mode}' BLOCKED (${result.reasons.length} reason(s)) — docs/AUTONOMOUS-ENGINEERING.md §6.`,
);
process.exit(1);
