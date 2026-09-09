#!/usr/bin/env node
/**
 * Deterministic behavioural evidence for the merge-policy evaluator —
 * the twenty §5.B block cases, the positive cases, and the provenance,
 * stickiness, history, WIP, and ordering properties the implementation
 * audit demanded. Nothing here mocks away the property under test: the
 * signatures are real Ed25519 signatures over the real canonical
 * payloads, verified by the real verifier. No network, no live GitHub.
 *
 * Run: node --test scripts/agents/evaluator.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARKERS,
  evaluate,
  parseMarkers,
  parseClosingRefs,
  computeContractRevision,
  canonicalVerdictPayload,
  canonicalContractPayload,
  verifySignature,
  sha256Hex,
  normalizeBody,
  issueFormField,
  isGoverned,
  isActorAuthorized,
  isContractAmendmentAuthorized,
  evaluateBuildAdmission,
  linkedOpenPrs,
  selectLinkedPrs,
  resolveWorkflowRunTarget,
  amendmentTransaction,
  buildVerdictMarkerLines,
  buildContractMarkerLines,
  buildFreezeMarkerLines,
  buildRefreshMarkerLines,
  buildEnrollmentMarkerLines,
  buildOwnerDecisionMarkerLines,
  buildLaneClaimMarkerLines,
  buildLaneReleaseMarkerLines,
  buildCodexVerdictTemplateLines,
  parseRevisionMarkers,
  parseFreezeMarkers,
  parseRefreshMarkers,
  parseEnrollmentMarkers,
  parseOwnerDecisionMarkers,
  parseLaneMarkers,
  canonicalFreezePayload,
  canonicalRefreshPayload,
  canonicalEnrollmentPayload,
  canonicalLaneClaimPayload,
  canonicalLaneReleasePayload,
  currentRefreshGeneration,
  resolvePrEnrollment,
  resolveOwnerDecision,
  resolveLaneLease,
  evaluateBuildStart,
  contractSnapshotHash,
  resolveVerdict,
  chooseCheckAction,
  readyPromotionAction,
  parsePrNumbersJson,
  orderCheckWrites,
  passingPublicationAllowed,
  authorizeForceReview,
  trustedDispatchRefAllowed,
  geminiRuntimeUntrackedAllowed,
  foldReviewThreadPages,
  amendmentSignAllowed,
  FREEZE_MARKER,
  GATE_PUBLISHER_APP_SLUG,
  SCHEME,
} from './evaluator.mjs';
import { parseContractRevisionCli } from './cli-args.mjs';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const OWNER = 'AngeloAkuhwa';
const CODEX = 'chatgpt-codex-connector[bot]';
const ACTIONS = 'github-actions[bot]';

// Real reviewer-specific signing authorities (ephemeral test keys).
const keyPair = () => generateKeyPairSync('ed25519');
const CLAUDE_KEY = keyPair();
const GEMINI_KEY = keyPair();
const AUTHORITY_KEY = keyPair();
const ROGUE_KEY = keyPair(); // an "unrelated workflow" that also signs things
const pem = (k) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const signWith = (k, payload) =>
  cryptoSign(null, Buffer.from(payload, 'utf8'), k.privateKey).toString('base64');

const ISSUE_BODY = [
  '### Outcome',
  'A working thing.',
  '### Owner decision reference (if required and resolved)',
  '_No response_',
].join('\n');

const BODY_HASH = sha256Hex(normalizeBody(ISSUE_BODY));

/**
 * The V3 authoritative contract-snapshot hash (issue, revision, risk,
 * builder, body) computed via the REAL production function.
 */
const snapHash = ({
  issue = 44,
  revision = 1,
  risk = 'risk:R1',
  builder = 'builder:claude',
  body = ISSUE_BODY,
} = {}) =>
  contractSnapshotHash({
    issue,
    revision,
    risk,
    builder,
    bodySha256: sha256Hex(normalizeBody(body)),
  });

/** The active-contract snapshot hash every default (claude-built) verdict binds. */
const CONTRACT_HASH = snapHash();
/** The active-contract snapshot hash for the codex-built default state. */
const CODEX_CONTRACT_HASH = snapHash({ builder: 'builder:codex' });

/**
 * Build a V4 verdict marker body; sign with `key` unless key === null.
 * Signed roles carry the signer-issuance fields (REFRESH_GENERATION,
 * EVIDENCE_SEQUENCE, EVIDENCE_ID); the native Codex marker carries only
 * the generation (its authenticated order is the platform's review
 * chronology).
 */
function marker(
  name,
  {
    pr = 55,
    issue = 44,
    head = HEAD,
    rev = 1,
    contractHash = CONTRACT_HASH,
    verdict = 'APPROVE',
    generation = 0,
    sequence = 1,
    evidenceId = 'e'.repeat(32),
    key = undefined,
    dropSig = false,
  } = {},
) {
  const isCodex = name === MARKERS.codex;
  const m = {
    name,
    pr,
    issue,
    headSha: head,
    contractRevision: rev,
    contractSnapshotSha256: contractHash,
    refreshGeneration: generation,
    evidenceSequence: sequence,
    evidenceId,
    verdict,
  };
  const lines = [
    `${name}`,
    `SCHEME: ${SCHEME}`,
    `PR: ${pr}`,
    `ISSUE: ${issue}`,
    `HEAD_SHA: ${head}`,
    `CONTRACT_REVISION: ${rev}`,
    `CONTRACT_SNAPSHOT_SHA256: ${contractHash}`,
    `REFRESH_GENERATION: ${generation}`,
  ];
  if (!isCodex) {
    lines.push(`EVIDENCE_SEQUENCE: ${sequence}`, `EVIDENCE_ID: ${evidenceId}`);
  }
  lines.push(`VERDICT: ${verdict}`);
  if (!dropSig && key) lines.push(`SIGNATURE: ${signWith(key, canonicalVerdictPayload(m))}`);
  return `Review done.\n\n${lines.join('\n')}\n`;
}

/** Authority-signed PR-enrollment comment (X4). */
function enrollmentComment({
  issue = 44,
  pr = 55,
  contractHash = CONTRACT_HASH,
  status = 'active',
  key = AUTHORITY_KEY,
  createdAt = '2026-09-01T00:30:00Z',
  id = 2,
} = {}) {
  const m = { issue, pr, contractSnapshotSha256: contractHash, status };
  const lines = buildEnrollmentMarkerLines(
    m,
    key ? signWith(key, canonicalEnrollmentPayload(m)) : undefined,
  );
  return { author: ACTIONS, createdAt, id, body: lines.join('\n') };
}

/** Control-plane-signed review-refresh comment (X3). */
function refreshComment({
  pr = 55,
  head = HEAD,
  contractHash = CONTRACT_HASH,
  role = 'technical',
  generation = 1,
  key = role === 'technical' ? CLAUDE_KEY : GEMINI_KEY,
  createdAt = '2026-09-03T00:00:00Z',
  id = 30,
} = {}) {
  const m = {
    pr,
    headSha: head,
    contractSnapshotSha256: contractHash,
    role,
    refreshGeneration: generation,
  };
  const lines = buildRefreshMarkerLines(
    m,
    key ? signWith(key, canonicalRefreshPayload(m)) : undefined,
  );
  return { author: ACTIONS, kind: 'comment', createdAt, id, body: lines.join('\n') };
}

/** Owner-authored R3 decision comment (X7). */
function ownerDecisionComment({
  issue = 44,
  contractHash,
  decision = 'APPROVE_IMPLEMENTATION',
  reference = 'docs/REKODA_OWNER_DECISIONS.md §2.9',
  author = OWNER,
  createdAt = '2026-09-01T00:10:00Z',
  id = 3,
} = {}) {
  const lines = buildOwnerDecisionMarkerLines({
    issue,
    contractSnapshotSha256: contractHash,
    decision,
    reference,
  });
  return { author, createdAt, id, body: lines.join('\n') };
}

/** Contract marker comment; authorized by owner authorship or a signature. */
function contractComment({
  kind = 'REKODA_CONTRACT_BASELINE',
  issue = 44,
  revision = 1,
  body = ISSUE_BODY,
  risk = 'risk:R1',
  builder = 'builder:claude',
  reason = 'scope change',
  author = OWNER,
  key = null,
  createdAt = '2026-09-01T00:00:00Z',
  id = 1,
} = {}) {
  const m = {
    kind,
    issue,
    revision,
    risk,
    builder,
    bodySha256: sha256Hex(normalizeBody(body)),
    reason,
  };
  const lines = [
    kind,
    `SCHEME: ${SCHEME}`,
    `ISSUE: ${issue}`,
    `REVISION: ${revision}`,
    `RISK: ${risk}`,
    `BUILDER: ${builder}`,
    `BODY_SHA256: ${m.bodySha256}`,
  ];
  if (kind === 'REKODA_CONTRACT_REVISION') lines.push(`REASON: ${reason}`);
  if (key) lines.push(`SIGNATURE: ${signWith(key, canonicalContractPayload(m))}`);
  return { author, createdAt, id, body: lines.join('\n') };
}

const codexReview = (over = {}) => ({
  author: CODEX,
  kind: 'review',
  reviewState: 'COMMENTED',
  commitId: HEAD,
  createdAt: '2026-09-02T00:00:00Z',
  id: 10,
  body: marker(MARKERS.codex),
  ...over,
});

/** A fully valid builder:claude R1 state. Mutate per test case. */
function validState(overrides = {}) {
  const state = {
    pr: {
      number: 55,
      headSha: HEAD,
      riskLabels: ['risk:R1'],
      builderLabels: ['builder:claude'],
      author: 'claude[bot]',
      enrollment: { everLabeledAgent: true, complete: true },
    },
    prBody: 'Closes #44',
    issue: {
      number: 44,
      exists: true,
      agentTask: true,
      labels: ['agent-task', 'risk:R1', 'builder:claude', 'status:in-review'],
      riskLabels: ['risk:R1'],
      builderLabels: ['builder:claude'],
      body: ISSUE_BODY,
      comments: [contractComment(), enrollmentComment()],
    },
    techEvidence: { candidates: [codexReview()] },
    geminiEvidence: {
      candidates: [
        {
          author: ACTIONS,
          kind: 'comment',
          createdAt: '2026-09-02T01:00:00Z',
          id: 20,
          body: marker(MARKERS.gemini, { key: GEMINI_KEY }),
        },
      ],
    },
    ownerReviews: [],
    unresolvedThreads: 0,
    openLanes: [{ issue: 44, status: 'status:in-review' }],
    config: {
      ownerLogin: OWNER,
      codexLogin: CODEX,
      publicKeys: {
        claudeReviewer: pem(CLAUDE_KEY),
        geminiReviewer: pem(GEMINI_KEY),
        contractAuthority: pem(AUTHORITY_KEY),
      },
    },
  };
  return deepMerge(state, overrides);
}

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over)) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      base[k] &&
      typeof base[k] === 'object' &&
      !Array.isArray(base[k])
    )
      deepMerge(base[k], v);
    else base[k] = v;
  }
  return base;
}

const codes = (r) => r.reasons.map((x) => x.code);
const expectBlock = (state, code, mode = 'full') => {
  const r = evaluate(state, mode);
  assert.equal(r.pass, false, `expected BLOCK, got PASS`);
  assert.ok(codes(r).includes(code), `expected reason ${code}, got ${codes(r).join(', ')}`);
};

/** Claude-built PR state variant: builder:codex with a signed Claude verdict. */
function codexBuiltState() {
  const s = validState();
  s.pr.builderLabels = ['builder:codex'];
  s.pr.author = OWNER; // Codex Cloud PRs are authored by the connected account
  s.issue.labels = ['agent-task', 'risk:R1', 'builder:codex', 'status:in-review'];
  s.issue.builderLabels = ['builder:codex'];
  // The signed contract records builder:codex — labels and snapshot agree.
  s.issue.comments = [
    contractComment({ builder: 'builder:codex' }),
    enrollmentComment({ contractHash: CODEX_CONTRACT_HASH }),
  ];
  s.techEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: '2026-09-02T00:00:00Z',
      id: 11,
      body: marker(MARKERS.claude, { key: CLAUDE_KEY, contractHash: CODEX_CONTRACT_HASH }),
    },
  ];
  s.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: '2026-09-02T01:00:00Z',
      id: 20,
      body: marker(MARKERS.gemini, { key: GEMINI_KEY, contractHash: CODEX_CONTRACT_HASH }),
    },
  ];
  return s;
}

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

test('valid R1 builder:claude passes', () => {
  assert.deepEqual(evaluate(validState()), { pass: true, reasons: [] });
});

test('valid R0 passes', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R0'];
  s.issue.riskLabels = ['risk:R0'];
  assert.equal(evaluate(s).pass, true);
});

test('valid R2 builder:codex passes with a SIGNED Claude technical verdict', () => {
  const s = codexBuiltState();
  s.pr.riskLabels = ['risk:R2'];
  s.issue.riskLabels = ['risk:R2'];
  assert.deepEqual(evaluate(s), { pass: true, reasons: [] });
});

test('valid owner-authorized R3 passes only with a snapshot-bound owner decision AND owner approval of HEAD', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R3'];
  s.issue.riskLabels = ['risk:R3'];
  s.issue.body = ISSUE_BODY.replace('_No response_', 'docs/REKODA_OWNER_DECISIONS.md OWN-15');
  s.issue.labels = ['agent-task', 'risk:R3', 'builder:claude', 'status:in-review'];
  // Verdicts, enrollment, and the owner decision all bind the ACTIVE
  // contract snapshot — here the R3 snapshot.
  const r3Hash = snapHash({ risk: 'risk:R3', body: s.issue.body });
  s.issue.comments = [
    contractComment({ body: s.issue.body, risk: 'risk:R3' }),
    enrollmentComment({ contractHash: r3Hash }),
    ownerDecisionComment({ contractHash: r3Hash }),
  ];
  s.techEvidence.candidates = [
    codexReview({ body: marker(MARKERS.codex, { contractHash: r3Hash }) }),
  ];
  s.geminiEvidence.candidates[0].body = marker(MARKERS.gemini, {
    key: GEMINI_KEY,
    contractHash: r3Hash,
  });
  s.ownerReviews = [{ author: OWNER, state: 'APPROVED', commitId: HEAD }];
  assert.deepEqual(evaluate(s), { pass: true, reasons: [] });
});

test('valid workflow-specific provenance succeeds (signature is what counts, not the author string)', () => {
  const s = validState();
  // even with an unexpected author, a correctly signed Gemini marker is valid evidence
  s.geminiEvidence.candidates = [
    {
      author: 'some-mirror-bot',
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.gemini, { key: GEMINI_KEY }),
    },
  ];
  assert.equal(evaluate(s).pass, true);
});

// ---------------------------------------------------------------------------
// BLOCKER 1 — forgery is technically impossible, not just forbidden
// ---------------------------------------------------------------------------

test('generic github-actions[bot] comment cannot forge Gemini approval (unsigned)', () => {
  const s = validState();
  s.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.gemini, { dropSig: true }),
    },
  ];
  expectBlock(s, 'GEMINI_UNAUTHORIZED');
});

test('generic github-actions[bot] comment cannot forge Claude approval (unsigned)', () => {
  const s = codexBuiltState();
  s.techEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.claude, { dropSig: true }),
    },
  ];
  expectBlock(s, 'TECH_UNAUTHORIZED');
});

test('a marker signed by the WRONG key (unrelated workflow with its own key) is rejected', () => {
  const s = validState();
  s.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.gemini, { key: ROGUE_KEY }),
    },
  ];
  expectBlock(s, 'GEMINI_UNAUTHORIZED');
  const s2 = codexBuiltState();
  // the builder's own signing attempt with a key it could plausibly hold (e.g. Gemini's) still fails Claude verification
  s2.techEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.claude, { key: GEMINI_KEY }),
    },
  ];
  expectBlock(s2, 'TECH_UNAUTHORIZED');
});

test('a tampered signed marker fails verification (signature binds every field)', () => {
  const s = validState();
  const good = marker(MARKERS.gemini, { key: GEMINI_KEY });
  const tampered = good.replace('VERDICT: APPROVE', 'VERDICT: BLOCK'); // flip after signing
  s.geminiEvidence.candidates = [
    { author: ACTIONS, kind: 'comment', createdAt: 'x', id: 1, body: tampered },
  ];
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('GEMINI_UNAUTHORIZED'));
});

test('missing public key fails closed (no key material → no valid approval possible)', () => {
  const s = validState();
  s.config.publicKeys.geminiReviewer = null;
  expectBlock(s, 'GEMINI_UNAUTHORIZED');
});

test('builder cannot authorize its own contract revision (unsigned bot marker ignored → amendment blocks)', () => {
  const s = validState();
  const newBody = ISSUE_BODY + '\n\nBuilder widened its own scope.';
  s.issue.body = newBody;
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: newBody,
      author: ACTIONS,
      key: null,
      id: 2,
    }),
  ];
  expectBlock(s, 'CONTRACT_AMENDED_UNAUTHORIZED');
});

test('unrelated workflow cannot authorize a contract revision with the wrong key', () => {
  const s = validState();
  const newBody = ISSUE_BODY + '\n\nRogue amendment.';
  s.issue.body = newBody;
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: newBody,
      author: ACTIONS,
      key: ROGUE_KEY,
      id: 2,
    }),
  ];
  expectBlock(s, 'CONTRACT_AMENDED_UNAUTHORIZED');
});

test('only contract-authority-SIGNED revisions are authoritative', () => {
  const s = validState();
  const newBody = ISSUE_BODY + '\n\nAuthorized change.';
  s.issue.body = newBody;
  s.issue.comments = [
    contractComment(),
    enrollmentComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: newBody,
      author: ACTIONS,
      key: AUTHORITY_KEY,
      id: 5,
      createdAt: 'y',
    }),
  ];
  // approvals still bind revision 1 → invalidated without any push
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_WRONG_REVISION') && codes(r).includes('GEMINI_WRONG_REVISION'));
  // fresh verdicts for revision 2 — binding the rev-2 snapshot hash — pass again
  const rev2Hash = snapHash({ revision: 2, body: newBody });
  s.techEvidence.candidates.push(
    codexReview({
      id: 12,
      createdAt: 'z',
      body: marker(MARKERS.codex, { rev: 2, contractHash: rev2Hash }),
    }),
  );
  s.geminiEvidence.candidates.push({
    author: ACTIONS,
    kind: 'comment',
    createdAt: 'z',
    id: 21,
    body: marker(MARKERS.gemini, { rev: 2, contractHash: rev2Hash, key: GEMINI_KEY }),
  });
  assert.equal(evaluate(s).pass, true);
});

// ---------------------------------------------------------------------------
// Codex provenance: marker AND review commit_id must bind the current HEAD
// ---------------------------------------------------------------------------

test('Codex marker claiming current HEAD inside a review of an OLD commit blocks', () => {
  const s = validState();
  s.techEvidence.candidates = [codexReview({ commitId: OLD_HEAD })]; // marker says HEAD, review binds OLD_HEAD
  expectBlock(s, 'TECH_APPROVAL_STALE');
});

test('a dismissed Codex review does not count', () => {
  const s = validState();
  s.techEvidence.candidates = [codexReview({ reviewState: 'DISMISSED' })];
  expectBlock(s, 'TECH_UNAUTHORIZED');
});

test('a Codex marker in a plain comment (not a review) does not count', () => {
  const s = validState();
  s.techEvidence.candidates = [
    { author: CODEX, kind: 'comment', createdAt: 'x', id: 1, body: marker(MARKERS.codex) },
  ];
  expectBlock(s, 'TECH_UNAUTHORIZED');
});

test('a Codex-named marker from any other identity does not count', () => {
  const s = validState();
  s.techEvidence.candidates = [codexReview({ author: 'claude[bot]' })];
  expectBlock(s, 'TECH_UNAUTHORIZED');
});

// ---------------------------------------------------------------------------
// The twenty §5.B negative cases (those not already covered above)
// ---------------------------------------------------------------------------

test('1. missing technical approval blocks', () => {
  expectBlock(validState({ techEvidence: { candidates: [] } }), 'TECH_APPROVAL_MISSING');
});

test('2. stale technical approval (old HEAD everywhere) blocks', () => {
  const s = validState();
  s.techEvidence.candidates = [
    codexReview({ commitId: OLD_HEAD, body: marker(MARKERS.codex, { head: OLD_HEAD }) }),
  ];
  expectBlock(s, 'TECH_APPROVAL_STALE');
});

test('4. malformed technical approval blocks', () => {
  const s = validState();
  s.techEvidence.candidates = [
    codexReview({ body: `${MARKERS.codex}\nPR: 55\nHEAD_SHA: ${HEAD}\nVERDICT: APPROVE` }),
  ];
  expectBlock(s, 'TECH_MALFORMED');
});

test('5. technical BLOCK verdict blocks', () => {
  const s = validState();
  s.techEvidence.candidates = [codexReview({ body: marker(MARKERS.codex, { verdict: 'BLOCK' }) })];
  expectBlock(s, 'TECH_BLOCK');
});

test('6.-8. Gemini missing / stale / BLOCK verdicts block', () => {
  expectBlock(validState({ geminiEvidence: { candidates: [] } }), 'GEMINI_APPROVAL_MISSING');
  const s = validState();
  s.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.gemini, { head: OLD_HEAD, key: GEMINI_KEY }),
    },
  ];
  expectBlock(s, 'GEMINI_APPROVAL_STALE');
  const s2 = validState();
  s2.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.gemini, { verdict: 'BLOCK', key: GEMINI_KEY }),
    },
  ];
  expectBlock(s2, 'GEMINI_BLOCK');
});

test('9.-11. approvals for wrong PR / issue / revision block', () => {
  const s = validState();
  s.techEvidence.candidates = [codexReview({ body: marker(MARKERS.codex, { pr: 99 }) })];
  expectBlock(s, 'TECH_WRONG_PR');
  const s2 = validState();
  s2.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.gemini, { issue: 999, key: GEMINI_KEY }),
    },
  ];
  expectBlock(s2, 'GEMINI_WRONG_ISSUE');
  const s3 = validState();
  s3.techEvidence.candidates = [codexReview({ body: marker(MARKERS.codex, { rev: 3 }) })];
  expectBlock(s3, 'TECH_WRONG_REVISION');
});

test('12. unauthorized contract amendment blocks (body edit, no authorized marker)', () => {
  const s = validState();
  s.issue.body = ISSUE_BODY + '\n\nQuietly widened scope.';
  expectBlock(s, 'CONTRACT_AMENDED_UNAUTHORIZED');
});

test('13.-14. issue/PR risk and builder mismatches block', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R2'];
  expectBlock(s, 'RISK_MISMATCH');
  const s2 = validState();
  s2.issue.builderLabels = ['builder:codex'];
  expectBlock(s2, 'BUILDER_MISMATCH');
});

test('15. missing / ambiguous / unresolvable authoritative issue blocks', () => {
  expectBlock(validState({ prBody: 'No closing reference here.' }), 'LINKED_ISSUE_MISSING');
  expectBlock(validState({ prBody: 'Closes #44 and closes #45' }), 'LINKED_ISSUE_AMBIGUOUS');
  const s = validState();
  s.issue.exists = false;
  expectBlock(s, 'ISSUE_NOT_FOUND');
});

test('16. unresolved blocking review threads block', () => {
  expectBlock(validState({ unresolvedThreads: 2 }), 'THREADS_UNRESOLVED');
});

test('17.-18. R3 without decision / without current owner approval blocks; owner approval never substitutes', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R3'];
  s.issue.riskLabels = ['risk:R3'];
  s.ownerReviews = [{ author: OWNER, state: 'APPROVED', commitId: HEAD }];
  expectBlock(s, 'R3_OWNER_DECISION_MISSING');
  const s2 = validState();
  s2.pr.riskLabels = ['risk:R3'];
  s2.issue.riskLabels = ['risk:R3'];
  s2.issue.body = ISSUE_BODY.replace('_No response_', 'OWN-15');
  s2.issue.comments = [contractComment({ body: s2.issue.body })];
  expectBlock(s2, 'R3_OWNER_APPROVAL_MISSING');
  s2.ownerReviews = [{ author: OWNER, state: 'APPROVED', commitId: OLD_HEAD }];
  expectBlock(s2, 'R3_OWNER_APPROVAL_MISSING');
  s2.ownerReviews = [{ author: OWNER, state: 'APPROVED', commitId: HEAD }];
  s2.techEvidence.candidates = [];
  expectBlock(s2, 'TECH_APPROVAL_MISSING'); // owner approval present, peer review still required
});

test('20. missing required CI evidence blocks when supplied', () => {
  expectBlock(validState({ ci: { complete: false } }), 'CI_INCOMPLETE');
});

// ---------------------------------------------------------------------------
// BLOCKER 2 — sticky governance: the Codex escape sequence
// ---------------------------------------------------------------------------

test('an enrolled PR cannot escape by removing labels and the closing reference', () => {
  const s = validState();
  // The escape: strip both labels, blank the closing reference.
  s.pr.riskLabels = [];
  s.pr.builderLabels = [];
  s.prBody = 'Docs touch-up.';
  s.issue = null;
  // Immutable label history keeps it governed…
  assert.equal(isGoverned(s), true);
  // …and evaluation then fails closed on every stripped element.
  const r = evaluate(s, 'policy');
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('RISK_LABEL_INVALID'));
  assert.ok(codes(r).includes('BUILDER_LABEL_INVALID'));
  assert.ok(codes(r).includes('LINKED_ISSUE_MISSING'));
});

test('a never-enrolled ordinary PR is not governed', () => {
  const s = validState();
  s.pr.riskLabels = [];
  s.pr.builderLabels = [];
  s.pr.enrollment = { everLabeledAgent: false, complete: true };
  s.prBody = 'Human PR.';
  s.issue = null;
  assert.equal(isGoverned(s), false);
});

test('8. replacing the authoritative issue with an unrelated one blocks', () => {
  const s = validState();
  s.prBody = 'Closes #77';
  s.issue = {
    number: 77,
    exists: true,
    agentTask: false,
    labels: [],
    riskLabels: [],
    builderLabels: [],
    body: 'unrelated',
    comments: [],
  };
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('ISSUE_NOT_AGENT_TASK'));
});

// ---------------------------------------------------------------------------
// IMPORTANT 1 — contract history semantics
// ---------------------------------------------------------------------------

test('baseline with revision != 1 is invalid history', () => {
  const s = validState();
  s.issue.comments = [contractComment({ revision: 3 })];
  expectBlock(s, 'CONTRACT_HISTORY_INVALID');
});

test('duplicate same-revision markers with different hashes are rejected', () => {
  const s = validState();
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: ISSUE_BODY + '\nA',
      key: AUTHORITY_KEY,
      id: 2,
    }),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: ISSUE_BODY + '\nB',
      key: AUTHORITY_KEY,
      id: 3,
    }),
  ];
  expectBlock(s, 'CONTRACT_HISTORY_INVALID');
});

test('a skipped revision is rejected (monotonic 1..N required)', () => {
  const s = validState();
  const newBody = ISSUE_BODY + '\nX';
  s.issue.body = newBody;
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 3,
      body: newBody,
      key: AUTHORITY_KEY,
      id: 2,
    }),
  ];
  expectBlock(s, 'CONTRACT_HISTORY_INVALID');
});

test('a revision marker without a REASON is malformed and does not count', () => {
  const rev = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [
      contractComment(),
      {
        author: OWNER,
        createdAt: 'y',
        id: 2,
        body: `REKODA_CONTRACT_REVISION\nISSUE: 44\nREVISION: 2\nBODY_SHA256: ${'0'.repeat(64)}`,
      },
    ],
    ownerLogin: OWNER,
    contractAuthorityKey: null,
  });
  assert.equal(rev.revision, 1); // the malformed marker was ignored
});

test('a replayed lower revision never lowers the current revision', () => {
  const v2 = ISSUE_BODY + '\nv2';
  const rev = computeContractRevision({
    issueNumber: 44,
    issueBody: v2,
    issueComments: [
      contractComment(),
      contractComment({
        kind: 'REKODA_CONTRACT_REVISION',
        revision: 2,
        body: v2,
        key: AUTHORITY_KEY,
        id: 2,
        createdAt: 'y',
      }),
      contractComment({ id: 3, createdAt: 'z' }), // baseline reposted later (same rev-1 hash)
    ],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.equal(rev.revision, 2);
  assert.equal(rev.amended, false);
});

test('missing contract baseline fails closed', () => {
  const s = validState();
  s.issue.comments = [];
  expectBlock(s, 'CONTRACT_BASELINE_MISSING');
});

// ---------------------------------------------------------------------------
// IMPORTANT 2 — deterministic global WIP
// ---------------------------------------------------------------------------

test('13g. two active implementation lanes are rejected', () => {
  const s = validState();
  s.openLanes = [
    { issue: 44, status: 'status:in-review' },
    { issue: 51, status: 'status:building' },
  ];
  expectBlock(s, 'WIP_VIOLATION', 'policy');
});

// ---------------------------------------------------------------------------
// IMPORTANT 5 — verdict ordering and evidence lifecycle
// ---------------------------------------------------------------------------

test('a later explicit APPROVE supersedes an earlier BLOCK for the same HEAD/revision (and vice versa)', () => {
  const s = validState();
  s.techEvidence.candidates = [
    codexReview({ id: 1, createdAt: '1', body: marker(MARKERS.codex, { verdict: 'BLOCK' }) }),
    codexReview({ id: 2, createdAt: '2', body: marker(MARKERS.codex, { verdict: 'APPROVE' }) }),
  ];
  assert.equal(evaluate(s).pass, true);
  const s2 = validState();
  s2.techEvidence.candidates = [
    codexReview({ id: 1, createdAt: '1', body: marker(MARKERS.codex, { verdict: 'APPROVE' }) }),
    codexReview({ id: 2, createdAt: '2', body: marker(MARKERS.codex, { verdict: 'BLOCK' }) }),
  ];
  expectBlock(s2, 'TECH_BLOCK');
});

test('14g. equal timestamps break ties deterministically by GitHub id', () => {
  const t = '2026-09-02T00:00:00Z';
  const s = validState();
  s.techEvidence.candidates = [
    codexReview({ id: 9, createdAt: t, body: marker(MARKERS.codex, { verdict: 'APPROVE' }) }),
    codexReview({ id: 3, createdAt: t, body: marker(MARKERS.codex, { verdict: 'BLOCK' }) }),
  ];
  // id 9 is later than id 3 at the same instant → APPROVE governs
  assert.equal(evaluate(s).pass, true);
});

test('malformed or unauthorized later evidence does not erase a previous valid verdict', () => {
  const s = validState();
  s.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: '1',
      id: 1,
      body: marker(MARKERS.gemini, { key: GEMINI_KEY }),
    },
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: '2',
      id: 2,
      body: marker(MARKERS.gemini, { verdict: 'BLOCK', dropSig: true }),
    },
  ];
  assert.equal(evaluate(s).pass, true); // the unsigned later BLOCK is not evidence
});

test('a new HEAD invalidates every prior approval', () => {
  const s = validState();
  s.pr.headSha = 'c'.repeat(40);
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_APPROVAL_STALE') && codes(r).includes('GEMINI_APPROVAL_STALE'));
});

// ---------------------------------------------------------------------------
// BLOCKER 4 — actor authorization threshold
// ---------------------------------------------------------------------------

test('10g. unauthorized actors are rejected; write+ actors are accepted', () => {
  for (const p of ['none', 'read', 'triage', '', undefined])
    assert.equal(isActorAuthorized(p), false, String(p));
  for (const p of ['write', 'maintain', 'admin']) assert.equal(isActorAuthorized(p), true, p);
});

// ---------------------------------------------------------------------------
// Structural and mode coverage
// ---------------------------------------------------------------------------

test('label integrity: both-or-neither builder labels block', () => {
  expectBlock(validState({ pr: { builderLabels: [] } }), 'BUILDER_LABEL_INVALID');
  expectBlock(
    validState({ pr: { builderLabels: ['builder:claude', 'builder:codex'] } }),
    'BUILDER_LABEL_INVALID',
  );
  expectBlock(validState({ pr: { riskLabels: ['risk:R1', 'risk:R2'] } }), 'RISK_LABEL_INVALID');
});

test('an issue with an unresolved owner-decision label blocks', () => {
  const s = validState();
  s.issue.labels.push('needs-owner-decision');
  expectBlock(s, 'DECISION_STATE_INVALID');
});

test('policy mode ignores reviewer verdicts but keeps structural failures', () => {
  const s = validState({ techEvidence: { candidates: [] }, geminiEvidence: { candidates: [] } });
  assert.equal(evaluate(s, 'policy').pass, true);
  const s2 = validState({ techEvidence: { candidates: [] }, unresolvedThreads: 1 });
  expectBlock(s2, 'THREADS_UNRESOLVED', 'policy');
});

test('technical and acceptance modes fail on their own family plus prerequisites only', () => {
  const s = validState({ geminiEvidence: { candidates: [] }, techEvidence: { candidates: [] } });
  assert.deepEqual(codes(evaluate(s, 'technical')), ['TECH_APPROVAL_MISSING']);
  assert.deepEqual(codes(evaluate(s, 'acceptance')), ['GEMINI_APPROVAL_MISSING']);
});

// ---------------------------------------------------------------------------
// Parser / primitive units
// ---------------------------------------------------------------------------

test('parseMarkers: valid signed block parses; junk fields are malformed', () => {
  const [m] = parseMarkers(marker(MARKERS.gemini, { key: GEMINI_KEY }), MARKERS.gemini);
  assert.equal(m.malformed, false);
  assert.equal(verifySignature(canonicalVerdictPayload(m), m.signature, pem(GEMINI_KEY)), true);
  const [bad] = parseMarkers(
    `${MARKERS.gemini}\nPR: x\nISSUE: 44\nHEAD_SHA: nope\nCONTRACT_REVISION: 1\nVERDICT: LGTM`,
    MARKERS.gemini,
  );
  assert.equal(bad.malformed, true);
});

test('parseClosingRefs finds distinct closing keywords only', () => {
  assert.deepEqual(parseClosingRefs('Closes #12, fixes #12, resolves #13; see #14'), [12, 13]);
  assert.deepEqual(parseClosingRefs('relates to #9'), []);
});

test('issueFormField extracts issue-form sections and treats _No response_ as empty', () => {
  assert.equal(issueFormField(ISSUE_BODY, 'Owner decision reference'), null);
  assert.equal(issueFormField(ISSUE_BODY, 'Outcome'), 'A working thing.');
});

// ---------------------------------------------------------------------------
// Protocol scheme/version (audit item 5)
// ---------------------------------------------------------------------------

test('16g. a marker without a SCHEME line is malformed and never counts', () => {
  const s = validState();
  const noScheme = marker(MARKERS.gemini, { key: GEMINI_KEY }).replace(`SCHEME: ${SCHEME}\n`, '');
  s.geminiEvidence.candidates = [
    { author: ACTIONS, kind: 'comment', createdAt: 'x', id: 1, body: noScheme },
  ];
  expectBlock(s, 'GEMINI_MALFORMED');
});

test('16h. an unknown/future scheme is rejected even with a valid-looking signature', () => {
  const s = validState();
  const future = marker(MARKERS.gemini, { key: GEMINI_KEY }).replace(
    `SCHEME: ${SCHEME}`,
    'SCHEME: REKODA_AGENT_EVIDENCE_V9',
  );
  s.geminiEvidence.candidates = [
    { author: ACTIONS, kind: 'comment', createdAt: 'x', id: 1, body: future },
  ];
  expectBlock(s, 'GEMINI_MALFORMED');
  const sc = validState();
  sc.techEvidence.candidates = [
    codexReview({ body: marker(MARKERS.codex).replace(`SCHEME: ${SCHEME}`, 'SCHEME: OTHER') }),
  ];
  expectBlock(sc, 'TECH_MALFORMED');
});

test('16i. a contract marker with a wrong scheme does not count', () => {
  const s = validState();
  const c = contractComment();
  c.body = c.body.replace(`SCHEME: ${SCHEME}`, 'SCHEME: NOPE');
  s.issue.comments = [c];
  expectBlock(s, 'CONTRACT_BASELINE_MISSING');
});

// ---------------------------------------------------------------------------
// Sticky governance: complete history or fail closed (audit item 10)
// ---------------------------------------------------------------------------

test('11g/12g. incomplete or failed enrollment history fails CLOSED, never neutral', () => {
  const s = validState();
  s.pr.riskLabels = [];
  s.pr.builderLabels = [];
  s.prBody = 'Nothing here.';
  s.issue = null;
  s.pr.enrollment = { everLabeledAgent: false, complete: false }; // pagination not exhausted / API failure
  assert.equal(isGoverned(s), true);
  expectBlock(s, 'ENROLLMENT_HISTORY_INCOMPLETE', 'policy');
  // reviewer gates also refuse while governance is unprovable
  expectBlock(s, 'ENROLLMENT_HISTORY_INCOMPLETE', 'technical');
  expectBlock(s, 'ENROLLMENT_HISTORY_INCOMPLETE', 'acceptance');
});

// ---------------------------------------------------------------------------
// Verdict ordering across id domains (audit item 15)
// ---------------------------------------------------------------------------

test('15g. two different signed issuances claiming ONE sequence fail closed (signer-integrity violation)', () => {
  const t = '2026-09-02T00:00:00Z';
  const s = codexBuiltState();
  s.techEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: t,
      id: 5,
      body: marker(MARKERS.claude, {
        key: CLAUDE_KEY,
        verdict: 'APPROVE',
        sequence: 7,
        evidenceId: 'a'.repeat(32),
        contractHash: CODEX_CONTRACT_HASH,
      }),
    },
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: '2026-09-03T00:00:00Z',
      id: 6,
      body: marker(MARKERS.claude, {
        key: CLAUDE_KEY,
        verdict: 'BLOCK',
        sequence: 7,
        evidenceId: 'b'.repeat(32),
        contractHash: CODEX_CONTRACT_HASH,
      }),
    },
  ];
  expectBlock(s, 'TECH_SEQUENCE_CONFLICT');
});

test('15h. replays of one issuance collapse; the HIGHER signed sequence governs wherever and whenever its text sits', () => {
  const s = codexBuiltState();
  const approveSeq1 = marker(MARKERS.claude, {
    key: CLAUDE_KEY,
    sequence: 1,
    evidenceId: 'a'.repeat(32),
    contractHash: CODEX_CONTRACT_HASH,
  });
  s.techEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: '2026-09-02T00:00:00Z',
      id: 5,
      body: approveSeq1,
    },
    // the SAME issuance re-posted later — a replay, not new evidence
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: '2026-09-04T00:00:00Z',
      id: 9,
      body: approveSeq1,
    },
  ];
  assert.equal(evaluate(s).pass, true);
  // A later ISSUANCE (higher sequence) governs even when its comment
  // timestamp is EARLIER than the replayed copy above.
  s.techEvidence.candidates.push({
    author: ACTIONS,
    kind: 'comment',
    createdAt: '2026-09-03T00:00:00Z',
    id: 6,
    body: marker(MARKERS.claude, {
      key: CLAUDE_KEY,
      verdict: 'BLOCK',
      sequence: 2,
      evidenceId: 'b'.repeat(32),
      contractHash: CODEX_CONTRACT_HASH,
    }),
  });
  expectBlock(s, 'TECH_BLOCK'); // the higher issuance sequence wins
});

// ---------------------------------------------------------------------------
// Build admission (audit items 8/11) — the no-secret preflight's brain
// ---------------------------------------------------------------------------

const OK_CONTRACT = { baselineFound: true, invalid: null, amended: false, revision: 1 };

const readyIssue = (over = {}) => ({
  number: 60,
  exists: true,
  state: 'open',
  agentTask: true,
  labels: ['agent-task', 'risk:R1', 'builder:claude', 'status:ready'],
  riskLabels: ['risk:R1'],
  builderLabels: ['builder:claude'],
  ...over,
});

test('a valid READY builder:claude issue is admitted when the lane is free', () => {
  const r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.deepEqual(r, { admit: true, reasons: [] });
});

test('6g. an unrelated/non-agent issue is rejected', () => {
  const r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: readyIssue({ agentTask: false, labels: ['status:ready'] }),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.equal(r.admit, false);
  assert.ok(r.reasons.some((x) => x.code === 'ADMIT_NOT_AGENT_TASK'));
});

test('7g. a builder:codex issue never admits the Claude builder', () => {
  const r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: readyIssue({
      builderLabels: ['builder:codex'],
      labels: ['agent-task', 'risk:R1', 'builder:codex', 'status:ready'],
    }),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.ok(r.reasons.some((x) => x.code === 'ADMIT_WRONG_BUILDER'));
});

test('8g. a closed or missing issue is rejected', () => {
  assert.ok(
    evaluateBuildAdmission({
      contract: OK_CONTRACT,
      issue: readyIssue({ state: 'closed' }),
      requiredBuilder: 'builder:claude',
      openLanes: [],
    }).reasons.some((x) => x.code === 'ADMIT_ISSUE_NOT_OPEN'),
  );
  assert.ok(
    evaluateBuildAdmission({
      contract: OK_CONTRACT,
      issue: null,
      requiredBuilder: 'builder:claude',
      openLanes: [],
    }).reasons.some((x) => x.code === 'ADMIT_ISSUE_NOT_FOUND'),
  );
});

test('9g. blocked-decision / needs-owner-decision issues are rejected', () => {
  const r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: readyIssue({
      labels: [
        'agent-task',
        'risk:R1',
        'builder:claude',
        'status:ready',
        'status:blocked-decision',
      ],
    }),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.ok(r.reasons.some((x) => x.code === 'ADMIT_BLOCKED_DECISION'));
});

test('a not-READY issue is rejected', () => {
  const r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: readyIssue({ labels: ['agent-task', 'risk:R1', 'builder:claude', 'backlog'] }),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.ok(r.reasons.some((x) => x.code === 'ADMIT_NOT_READY'));
});

test('13g2. an occupied implementation lane rejects a second admission', () => {
  const r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [{ issue: 44, status: 'status:in-review' }],
  });
  assert.ok(r.reasons.some((x) => x.code === 'ADMIT_LANE_OCCUPIED'));
});

// ---------------------------------------------------------------------------
// Contract-authority amendment authorization (audit item 12)
// ---------------------------------------------------------------------------

test('14g2. contract amendments are owner-only; write collaborators are rejected', () => {
  assert.equal(isContractAmendmentAuthorized(OWNER, OWNER), true);
  for (const actor of ['some-collaborator', ACTIONS, 'claude[bot]', '', undefined])
    assert.equal(isContractAmendmentAuthorized(actor, OWNER), false, String(actor));
});

// ---------------------------------------------------------------------------
// Authority/watch redispatch targeting (audit items 4/5)
// ---------------------------------------------------------------------------

test('4g. linkedOpenPrs finds exactly the open PRs closing the changed issue', () => {
  const prs = [
    { number: 70, body: 'Closes #44' },
    { number: 71, body: 'Fixes #45' },
    { number: 72, body: 'refs #44 only' },
    { number: 73, body: 'Resolves #44 and more text' },
  ];
  assert.deepEqual(linkedOpenPrs(prs, 44), [70, 73]);
  assert.deepEqual(linkedOpenPrs(prs, 99), []);
});

test('5g. a signed revision invalidates same-HEAD approvals regardless of comment-event delivery', () => {
  // The dispatch is direct (no reliance on GITHUB_TOKEN comment events);
  // the policy consequence is provable purely: same HEAD + revision 2 ⇒
  // both rev-1 approvals stale until re-issued.
  const s = validState();
  const newBody = ISSUE_BODY + '\n\nAuthorized change.';
  s.issue.body = newBody;
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: newBody,
      author: ACTIONS,
      key: AUTHORITY_KEY,
      id: 2,
      createdAt: 'y',
    }),
  ];
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_WRONG_REVISION') && codes(r).includes('GEMINI_WRONG_REVISION'));
});

// ---------------------------------------------------------------------------
// Phase-2: workflow_run target resolution (activation blocker 1)
// ---------------------------------------------------------------------------

const cand = (over = {}) => ({
  number: 90,
  state: 'open',
  headSha: HEAD,
  baseRepo: 'AngeloAkuhwa/rekoda',
  ...over,
});

test('workflow_run resolver: exactly one matching open candidate resolves', () => {
  assert.deepEqual(
    resolveWorkflowRunTarget({ headSha: HEAD, candidates: [cand()], repo: 'AngeloAkuhwa/rekoda' }),
    { pr: 90, status: 'ok' },
  );
});

test('workflow_run resolver: zero candidates → none (nothing to evaluate)', () => {
  assert.equal(
    resolveWorkflowRunTarget({ headSha: HEAD, candidates: [], repo: 'x/y' }).status,
    'none',
  );
  assert.equal(
    resolveWorkflowRunTarget({
      headSha: HEAD,
      candidates: [cand({ state: 'closed' })],
      repo: 'AngeloAkuhwa/rekoda',
    }).status,
    'none',
  );
});

test('workflow_run resolver: multiple open candidates → ambiguous, fail closed', () => {
  const r = resolveWorkflowRunTarget({
    headSha: HEAD,
    candidates: [cand(), cand({ number: 91 })],
    repo: 'AngeloAkuhwa/rekoda',
  });
  assert.deepEqual(r, { pr: null, status: 'ambiguous' });
});

test('workflow_run resolver: force-pushed candidate (current HEAD moved) → stale, do not evaluate', () => {
  const r = resolveWorkflowRunTarget({
    headSha: OLD_HEAD,
    candidates: [cand()], // candidate now at HEAD, run was for OLD_HEAD
    repo: 'AngeloAkuhwa/rekoda',
  });
  assert.deepEqual(r, { pr: 90, status: 'stale' });
});

test('workflow_run resolver: wrong-base-repo candidate is not a target', () => {
  const r = resolveWorkflowRunTarget({
    headSha: HEAD,
    candidates: [cand({ baseRepo: 'someone/else' })],
    repo: 'AngeloAkuhwa/rekoda',
  });
  assert.equal(r.status, 'none');
});

test('workflow_run resolver: malformed triggering SHA resolves nothing', () => {
  assert.equal(
    resolveWorkflowRunTarget({ headSha: 'not-a-sha', candidates: [cand()] }).status,
    'none',
  );
});

// ---------------------------------------------------------------------------
// Phase-2: signer-time independent revalidation (activation blocker 2)
// ---------------------------------------------------------------------------

test('an unsigned AI verdict cannot choose its target: only markers matching the FRESH target count', () => {
  // The signing job binds evidence to freshly re-resolved values; a
  // verdict naming an attacker-chosen PR/HEAD/revision is exactly a
  // mistargeted marker, which the evaluator rejects wholesale.
  const s = codexBuiltState();
  s.techEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'x',
      id: 1,
      body: marker(MARKERS.claude, { key: CLAUDE_KEY, pr: 999 }),
    },
  ];
  expectBlock(s, 'TECH_WRONG_PR');
});

test('HEAD moved between AI review and signing → the signed-late verdict is stale for the new HEAD', () => {
  const s = codexBuiltState();
  s.pr.headSha = 'd'.repeat(40); // push landed after the AI reviewed
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_APPROVAL_STALE'));
});

test('contract revision moved between AI review and signing → verdict binds the old revision and is rejected', () => {
  const s = codexBuiltState();
  const newBody = ISSUE_BODY + '\n\nRevised mid-review.';
  s.issue.body = newBody;
  s.issue.comments = [
    contractComment({ builder: 'builder:codex' }),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: newBody,
      builder: 'builder:codex',
      author: ACTIONS,
      key: AUTHORITY_KEY,
      id: 2,
      createdAt: 'y',
    }),
  ];
  expectBlock(s, 'TECH_WRONG_REVISION');
});

// ---------------------------------------------------------------------------
// Phase-2: baseline before admission (activation blocker 5)
// ---------------------------------------------------------------------------

test('admission without a contract baseline is refused — no lane claim, no builder', () => {
  const r = evaluateBuildAdmission({
    contract: { baselineFound: false, invalid: null, amended: false },
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.equal(r.admit, false);
  assert.ok(r.reasons.some((x) => x.code === 'ADMIT_BASELINE_MISSING'));
  const r2 = evaluateBuildAdmission({
    contract: undefined,
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.ok(r2.reasons.some((x) => x.code === 'ADMIT_BASELINE_MISSING'));
});

test('admission with an invalid or amended contract is refused', () => {
  const bad = evaluateBuildAdmission({
    contract: {
      baselineFound: true,
      invalid: 'conflicting markers for revision 2',
      amended: false,
    },
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.ok(bad.reasons.some((x) => x.code === 'ADMIT_CONTRACT_INVALID'));
  const amended = evaluateBuildAdmission({
    contract: { baselineFound: true, invalid: null, amended: true },
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.ok(amended.reasons.some((x) => x.code === 'ADMIT_CONTRACT_INVALID'));
});

test('admission with a valid baseline (and everything else) is granted', () => {
  const r = evaluateBuildAdmission({
    contract: { baselineFound: true, invalid: null, amended: false, revision: 1 },
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.deepEqual(r, { admit: true, reasons: [] });
});

// ---------------------------------------------------------------------------
// Phase-2: complete linked-PR pagination (activation blocker 4)
// ---------------------------------------------------------------------------

test('linked-PR selection finds PRs beyond the first page and fails closed on incomplete listings', () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, body: 'unrelated' }));
  const page2 = [{ number: 150, body: 'Closes #44' }];
  const all = [...page1, ...page2];
  assert.deepEqual(selectLinkedPrs({ openPrs: all, complete: true, issueNumber: 44 }), {
    ok: true,
    prs: [150],
  });
  assert.deepEqual(selectLinkedPrs({ openPrs: all, complete: true, issueNumber: 9999 }), {
    ok: true,
    prs: [],
  });
  const incomplete = selectLinkedPrs({ openPrs: page1, complete: false, issueNumber: 44 });
  assert.equal(incomplete.ok, false); // pagination ceiling / API failure → never silently miss a PR
});

// ---------------------------------------------------------------------------
// D1 — authoritative contract transitions and the freeze-before-mutate
// transaction (final Phase-2 audit)
// ---------------------------------------------------------------------------

test('an owner-authored UNSIGNED revision comment is a PROPOSAL, never the active contract', () => {
  const v2 = ISSUE_BODY + '\n\nProposed change.';
  // Unit: with the body unchanged, the owner-unsigned rev-2 marker does
  // not move the active revision.
  const rev = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [
      contractComment(),
      contractComment({
        kind: 'REKODA_CONTRACT_REVISION',
        revision: 2,
        body: v2,
        author: OWNER,
        id: 2,
      }),
    ],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.equal(rev.revision, 1);
  // Full gate: with the body ALSO edited, nothing silently transitions —
  // the previous contract stays active and the mismatch blocks.
  const s = validState();
  s.issue.body = v2;
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: v2,
      author: OWNER,
      id: 2,
    }),
  ];
  expectBlock(s, 'CONTRACT_AMENDED_UNAUTHORIZED');
});

test('a direct issue-body edit alone never replaces the active merge contract', () => {
  const s = validState();
  s.issue.body = ISSUE_BODY + '\n\nEdited without any transaction.';
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('CONTRACT_AMENDED_UNAUTHORIZED'));
  // and the reviewer approvals for revision 1 do not validate a new contract:
  assert.ok(!codes(r).includes('TECH_WRONG_REVISION')); // no rev-2 exists to bind to
});

test('unprovably complete comment history yields no revision and blocks', () => {
  const s = validState();
  s.issue.commentsComplete = false;
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('CONTRACT_HISTORY_INVALID'));
});

test('amendment transaction: sign only after the freeze marker is durable AND every barrier completed', () => {
  const ok = amendmentTransaction({
    linkedPrs: [70, 73],
    freezeMarkerPosted: true,
    barrierResults: { 70: true, 73: true },
    signOk: true,
    dispatchResults: { 70: true, 73: true },
  });
  assert.deepEqual(ok, {
    signed: true,
    barriered: [70, 73],
    dispatched: [70, 73],
    state: 'complete',
  });
});

test('amendment transaction: no durable freeze marker → nothing signed, nothing mutated', () => {
  const r = amendmentTransaction({
    linkedPrs: [70, 73],
    freezeMarkerPosted: false,
    barrierResults: {},
    signOk: true,
    dispatchResults: {},
  });
  assert.deepEqual(r, {
    signed: false,
    barriered: [],
    dispatched: [],
    state: 'aborted_before_freeze',
  });
});

test('amendment transaction: a failed barrier forbids signing; the freeze keeps every linked PR evaluator-blocked', () => {
  const r = amendmentTransaction({
    linkedPrs: [70, 73],
    freezeMarkerPosted: true,
    barrierResults: { 70: true, 73: false },
    signOk: true,
    dispatchResults: {},
  });
  assert.equal(r.signed, false);
  assert.equal(r.state, 'frozen_blocked');
  assert.deepEqual(r.barriered, [70]);
  assert.deepEqual(r.dispatched, []);
});

test('amendment transaction: barriers ok but signing fails → freeze stays active, PRs remain blocked, never re-green', () => {
  const r = amendmentTransaction({
    linkedPrs: [70],
    freezeMarkerPosted: true,
    barrierResults: { 70: true },
    signOk: false,
    dispatchResults: {},
  });
  assert.equal(r.signed, false);
  assert.equal(r.state, 'frozen_blocked');
});

test('amendment transaction: dispatch failure after signing leaves the PR blocked (wrong revision), not green', () => {
  const r = amendmentTransaction({
    linkedPrs: [70, 73],
    freezeMarkerPosted: true,
    barrierResults: { 70: true, 73: true },
    signOk: true,
    dispatchResults: { 70: true, 73: false },
  });
  assert.equal(r.signed, true);
  assert.equal(r.state, 'signed_awaiting_dispatch');
  assert.deepEqual(r.dispatched, [70]);
});

test('a baseline deep in a very large comment history is still found (position-independent)', () => {
  const noise = Array.from({ length: 350 }, (_, i) => ({
    author: 'someone',
    createdAt: `t${i}`,
    id: i + 100,
    body: `comment ${i}`,
  }));
  const rev = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [...noise, contractComment({ id: 9999 })],
    ownerLogin: OWNER,
    contractAuthorityKey: null,
  });
  assert.equal(rev.revision, 1);
  assert.equal(rev.amended, false);
});

// ---------------------------------------------------------------------------
// V2 evidence — verdicts bind the CONTRACT SNAPSHOT HASH, not just a number
// ---------------------------------------------------------------------------

test('a verdict binding a DIFFERENT contract snapshot hash blocks (wrong contract, right revision number)', () => {
  const s = validState();
  const foreign = sha256Hex(normalizeBody(ISSUE_BODY + '\n\nSomething else entirely.'));
  s.techEvidence.candidates = [
    codexReview({ body: marker(MARKERS.codex, { contractHash: foreign }) }),
  ];
  s.geminiEvidence.candidates[0].body = marker(MARKERS.gemini, {
    key: GEMINI_KEY,
    contractHash: foreign,
  });
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_WRONG_CONTRACT'));
  assert.ok(codes(r).includes('GEMINI_WRONG_CONTRACT'));
});

test('A→B→A: a verdict signed for snapshot B never authorizes after the contract returns to A', () => {
  // The issue body went A → B (authorized revision 2) → A (authorized
  // revision 3). A reviewer verdict produced under B binds B's hash and
  // revision 2; after the return to A it must not count — on EITHER axis.
  const bodyA = ISSUE_BODY;
  const bodyB = ISSUE_BODY + '\n\nTemporary requirement.';
  const hashB = snapHash({ revision: 2, body: bodyB });
  const s = validState();
  s.issue.body = bodyA;
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: bodyB,
      author: ACTIONS,
      key: AUTHORITY_KEY,
      id: 2,
      createdAt: 'y',
    }),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 3,
      body: bodyA,
      author: ACTIONS,
      key: AUTHORITY_KEY,
      id: 3,
      createdAt: 'z',
    }),
  ];
  s.techEvidence.candidates = [
    codexReview({ body: marker(MARKERS.codex, { rev: 2, contractHash: hashB }) }),
  ];
  s.geminiEvidence.candidates[0].body = marker(MARKERS.gemini, {
    rev: 2,
    contractHash: hashB,
    key: GEMINI_KEY,
  });
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_WRONG_REVISION') || codes(r).includes('TECH_WRONG_CONTRACT'));
  assert.ok(
    codes(r).includes('GEMINI_WRONG_REVISION') || codes(r).includes('GEMINI_WRONG_CONTRACT'),
  );
});

test('a V1-shaped marker (no CONTRACT_BODY_SHA256 line) is malformed evidence under V2', () => {
  const s = validState();
  const v1Lines = [
    MARKERS.gemini,
    `SCHEME: ${SCHEME}`,
    'PR: 55',
    'ISSUE: 44',
    `HEAD_SHA: ${HEAD}`,
    'CONTRACT_REVISION: 1',
    'VERDICT: APPROVE',
  ].join('\n');
  s.geminiEvidence.candidates = [
    { author: ACTIONS, kind: 'comment', createdAt: 'x', id: 1, body: v1Lines },
  ];
  expectBlock(s, 'GEMINI_MALFORMED');
});

test('a marker carrying the old V1 scheme string is rejected even with every V2 field present', () => {
  const s = validState();
  const oldScheme = marker(MARKERS.gemini, { key: GEMINI_KEY }).replace(
    `SCHEME: ${SCHEME}`,
    'SCHEME: REKODA_AGENT_EVIDENCE_V1',
  );
  s.geminiEvidence.candidates = [
    { author: ACTIONS, kind: 'comment', createdAt: 'x', id: 1, body: oldScheme },
  ];
  expectBlock(s, 'GEMINI_MALFORMED');
});

// ---------------------------------------------------------------------------
// END-TO-END with the REAL generators — the published bytes are the parsed
// bytes: generator → parser → verifier → policy, no hand-built fixtures
// ---------------------------------------------------------------------------

test('E2E: real baseline generator output → parseRevisionMarkers → signature → revision 1 → build admission', () => {
  // EXACTLY what contract-revision.mjs posts: the shared generator's
  // lines, signed over the canonical payload, wrapped in a code fence.
  const m = {
    kind: 'REKODA_CONTRACT_BASELINE',
    issue: 44,
    revision: 1,
    risk: 'risk:R1',
    builder: 'builder:claude',
    bodySha256: sha256Hex(normalizeBody(ISSUE_BODY)),
    reason: '',
  };
  const signature = signWith(AUTHORITY_KEY, canonicalContractPayload(m));
  const posted = '```\n' + buildContractMarkerLines(m, signature).join('\n') + '\n```';

  const parsed = parseRevisionMarkers(posted);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].malformed, false, 'the generated baseline must parse clean');
  assert.equal(parsed[0].scheme, SCHEME);
  assert.equal(parsed[0].kind, 'REKODA_CONTRACT_BASELINE');
  assert.equal(parsed[0].risk, 'risk:R1');
  assert.equal(parsed[0].builder, 'builder:claude');
  assert.ok(
    verifySignature(canonicalContractPayload(parsed[0]), parsed[0].signature, pem(AUTHORITY_KEY)),
    'the parsed marker must re-verify against the authority key',
  );

  const contract = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [{ author: ACTIONS, createdAt: 'x', id: 1, body: posted }],
    issueLabels: ['agent-task', 'risk:R1', 'builder:claude', 'status:ready'],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.equal(contract.revision, 1);
  assert.equal(contract.amended, false);
  assert.equal(contract.labelsDiverged, false);
  assert.equal(contract.invalid, null);
  assert.equal(contract.snapshotHash, CONTRACT_HASH);

  const admission = evaluateBuildAdmission({
    contract,
    issue: readyIssue({ number: 44 }),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.deepEqual(admission, { admit: true, reasons: [] });
});

test('E2E: real revision generator output advances the computed revision to 2', () => {
  const newBody = ISSUE_BODY + '\n\nAuthorized amendment.';
  const m2 = {
    kind: 'REKODA_CONTRACT_REVISION',
    issue: 44,
    revision: 2,
    risk: 'risk:R1',
    builder: 'builder:claude',
    bodySha256: sha256Hex(normalizeBody(newBody)),
    reason: 'scope change',
  };
  const posted2 =
    '```\n' +
    buildContractMarkerLines(m2, signWith(AUTHORITY_KEY, canonicalContractPayload(m2))).join('\n') +
    '\n```';
  const contract = computeContractRevision({
    issueNumber: 44,
    issueBody: newBody,
    issueComments: [contractComment(), { author: ACTIONS, createdAt: 'y', id: 2, body: posted2 }],
    issueLabels: ['agent-task', 'risk:R1', 'builder:claude', 'status:in-review'],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.equal(contract.revision, 2);
  assert.equal(contract.amended, false);
  assert.equal(contract.expectedHash, m2.bodySha256);
  assert.equal(contract.snapshotHash, snapHash({ revision: 2, body: newBody }));
});

test('E2E: real verdict generator output → parseMarkers → resolveVerdict APPROVE against the matching target', () => {
  // EXACTLY what sign-evidence.mjs prints: the shared generator's lines
  // in a fence, followed by the findings text.
  const m = {
    name: MARKERS.gemini,
    pr: 55,
    issue: 44,
    headSha: HEAD,
    contractRevision: 1,
    contractSnapshotSha256: CONTRACT_HASH,
    refreshGeneration: 0,
    evidenceSequence: 1,
    evidenceId: 'f'.repeat(32),
    verdict: 'APPROVE',
  };
  const signature = signWith(GEMINI_KEY, canonicalVerdictPayload(m));
  const posted = [
    '```',
    ...buildVerdictMarkerLines(m, signature),
    '```',
    '',
    'No blocking findings.',
  ].join('\n');

  const parsed = parseMarkers(posted, MARKERS.gemini);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].malformed, false, 'the generated verdict must parse clean');
  assert.equal(parsed[0].contractSnapshotSha256, CONTRACT_HASH);
  assert.equal(parsed[0].evidenceSequence, 1);

  const r = resolveVerdict({
    candidates: [{ author: ACTIONS, kind: 'comment', createdAt: 'x', id: 1, body: posted }],
    markerName: MARKERS.gemini,
    provenance: { kind: 'signature', publicKey: pem(GEMINI_KEY) },
    target: {
      pr: 55,
      issue: 44,
      headSha: HEAD,
      contractRevision: 1,
      contractSnapshotSha256: CONTRACT_HASH,
      refreshGeneration: 0,
    },
  });
  assert.equal(r.verdict, 'APPROVE');
});

test('E2E: the same real generator output resolves to NO verdict for a different contract snapshot', () => {
  const m = {
    name: MARKERS.gemini,
    pr: 55,
    issue: 44,
    headSha: HEAD,
    contractRevision: 1,
    contractSnapshotSha256: CONTRACT_HASH,
    refreshGeneration: 0,
    evidenceSequence: 1,
    evidenceId: 'f'.repeat(32),
    verdict: 'APPROVE',
  };
  const posted = [
    '```',
    ...buildVerdictMarkerLines(m, signWith(GEMINI_KEY, canonicalVerdictPayload(m))),
    '```',
  ].join('\n');
  const r = resolveVerdict({
    candidates: [{ author: ACTIONS, kind: 'comment', createdAt: 'x', id: 1, body: posted }],
    markerName: MARKERS.gemini,
    provenance: { kind: 'signature', publicKey: pem(GEMINI_KEY) },
    target: {
      pr: 55,
      issue: 44,
      headSha: HEAD,
      contractRevision: 1,
      contractSnapshotSha256: snapHash({ body: ISSUE_BODY + '\n\nMoved on.' }),
      refreshGeneration: 0,
    },
  });
  assert.equal(r.verdict ?? null, null);
  assert.equal(r.diagnosis, 'wrong_contract');
});

// ---------------------------------------------------------------------------
// workflow_run resolver — exhaustive-listing semantics (later pages)
// ---------------------------------------------------------------------------

test('resolver: an INCOMPLETE candidate listing is unprovable — fail closed, never guess', () => {
  const r = resolveWorkflowRunTarget({
    headSha: HEAD,
    candidates: [cand()],
    repo: 'AngeloAkuhwa/rekoda',
    complete: false,
  });
  assert.deepEqual(r, { pr: null, status: 'unprovable' });
});

test('resolver: the true candidate deep in a multi-page listing still resolves to exactly one PR', () => {
  const candidates = Array.from({ length: 250 }, (_, i) =>
    cand({ number: i + 1, state: 'closed', headSha: OLD_HEAD }),
  );
  candidates.push(cand({ number: 251 })); // the single open match, "page 3"
  assert.deepEqual(
    resolveWorkflowRunTarget({
      headSha: HEAD,
      candidates,
      repo: 'AngeloAkuhwa/rekoda',
      complete: true,
    }),
    { pr: 251, status: 'ok' },
  );
});

test('resolver: a second open candidate on a later page makes the request ambiguous over the COMPLETE set', () => {
  const candidates = Array.from({ length: 120 }, (_, i) =>
    cand({ number: i + 1, state: 'closed', headSha: OLD_HEAD }),
  );
  candidates[0] = cand({ number: 1 }); // page-1 open match
  candidates.push(cand({ number: 121 })); // page-2 open match
  assert.deepEqual(
    resolveWorkflowRunTarget({
      headSha: HEAD,
      candidates,
      repo: 'AngeloAkuhwa/rekoda',
      complete: true,
    }),
    { pr: null, status: 'ambiguous' },
  );
});

// ---------------------------------------------------------------------------
// chooseCheckAction — fail-closed upsert decision with app verification
// ---------------------------------------------------------------------------

test('check upsert: a failed lookup ABORTS a passing conclusion — absence of green already blocks; no blind duplicate-passing', () => {
  for (const conclusion of ['success', 'neutral']) {
    const d = chooseCheckAction({
      lookupOk: false,
      runs: [],
      name: 'Technical Review Gate',
      conclusion,
    });
    assert.equal(d.action, 'abort', `${conclusion} must abort on lookup failure`);
  }
});

test('check upsert: a failed lookup NEVER abandons a FAILURE — the revocation posts blind and the newest run governs', () => {
  // The stale-green scenario: an old SUCCESS exists on this HEAD, the
  // current state says BLOCK, and the read needed to find the old run
  // fails. Abandoning the write would leave the old green
  // merge-authorizing; instead the failure is POSTed blind — GitHub
  // evaluates the most recent run per (name, app), so the new failure
  // governs the required check.
  const d = chooseCheckAction({
    lookupOk: false,
    runs: [],
    name: 'Technical Review Gate',
    conclusion: 'failure',
  });
  assert.equal(d.action, 'post');
  assert.equal(d.degraded, true);
});

test('check upsert: an existing Rekoda Gate Publisher run of the same name is PATCHed in place', () => {
  const d = chooseCheckAction({
    lookupOk: true,
    runs: [
      { id: 7, name: 'Some other check', appSlug: GATE_PUBLISHER_APP_SLUG },
      { id: 9, name: 'Technical Review Gate', appSlug: GATE_PUBLISHER_APP_SLUG },
    ],
    name: 'Technical Review Gate',
  });
  assert.deepEqual(d, { action: 'patch', id: 9 });
});

test('check upsert: a same-name run from a FOREIGN app is never adopted — a fresh run is created', () => {
  // The generic GitHub Actions app is itself FOREIGN now (X6): a
  // same-named run any GITHUB_TOKEN workflow rendered is never adopted
  // by the dedicated publisher — and the ruleset's App source binding
  // means such a run can never satisfy the required check either.
  for (const appSlug of ['evil-third-party-app', 'github-actions']) {
    const d = chooseCheckAction({
      lookupOk: true,
      runs: [{ id: 13, name: 'Technical Review Gate', appSlug }],
      name: 'Technical Review Gate',
    });
    assert.deepEqual(d, { action: 'post' }, `${appSlug} run must not be adopted`);
  }
});

test('check upsert: no existing run at all → create', () => {
  assert.deepEqual(chooseCheckAction({ lookupOk: true, runs: [], name: 'Agent policy gate' }), {
    action: 'post',
  });
});

// ---------------------------------------------------------------------------
// readyPromotionAction — both label orderings promote; the decision reads
// the RE-FETCHED labels, never the single triggering event
// ---------------------------------------------------------------------------

test('READY promotion: builder label first, then status:ready — proceeds and dispatches Claude', () => {
  const d = readyPromotionAction({
    labels: ['agent-task', 'risk:R1', 'builder:claude', 'status:ready'],
  });
  assert.deepEqual(d, {
    proceed: true,
    dispatchClaude: true,
    risk: 'risk:R1',
    builder: 'builder:claude',
  });
});

test('READY promotion: status:ready first, then builder label — the later builder event still promotes', () => {
  // Same final label set regardless of arrival order; the builder:claude
  // "labeled" event re-fetches and sees status:ready already present.
  const d = readyPromotionAction({
    labels: ['status:ready', 'agent-task', 'risk:R2', 'builder:claude'],
  });
  assert.deepEqual(d, {
    proceed: true,
    dispatchClaude: true,
    risk: 'risk:R2',
    builder: 'builder:claude',
  });
});

test('READY promotion: builder:codex proceeds but never dispatches the Claude builder', () => {
  const d = readyPromotionAction({
    labels: ['agent-task', 'risk:R1', 'status:ready', 'builder:codex'],
  });
  assert.deepEqual(d, {
    proceed: true,
    dispatchClaude: false,
    risk: 'risk:R1',
    builder: 'builder:codex',
  });
});

test('READY promotion: missing pieces or ambiguous builders never proceed', () => {
  assert.equal(readyPromotionAction({ labels: ['agent-task', 'builder:claude'] }).proceed, false);
  assert.equal(readyPromotionAction({ labels: ['status:ready', 'builder:claude'] }).proceed, false);
  assert.equal(readyPromotionAction({ labels: ['agent-task', 'status:ready'] }).proceed, false);
  assert.equal(
    readyPromotionAction({
      labels: ['agent-task', 'status:ready', 'builder:claude', 'builder:codex'],
    }).proceed,
    false,
  );
});

// ---------------------------------------------------------------------------
// V4 — the native Codex marker contract (AGENTS.md documents EXACTLY this,
// rendered through the SAME template generator review-context.mjs prints)
// ---------------------------------------------------------------------------

test('the DOCUMENTED native Codex V4 block parses and resolves to APPROVE with platform provenance', () => {
  // Byte-for-byte the block AGENTS.md instructs native Codex to emit,
  // with values copied from review-context output — including the
  // CURRENT technical refresh generation.
  const documented = buildCodexVerdictTemplateLines({
    pr: 55,
    issue: 44,
    headSha: HEAD,
    contractRevision: 1,
    contractSnapshotSha256: CONTRACT_HASH,
    refreshGeneration: 0,
    verdict: 'APPROVE',
  }).join('\n');
  const r = resolveVerdict({
    candidates: [
      {
        author: CODEX,
        kind: 'review',
        reviewState: 'COMMENTED',
        commitId: HEAD,
        createdAt: 'x',
        id: 1,
        body: `Findings: none.\n\n${documented}`,
      },
    ],
    markerName: MARKERS.codex,
    provenance: { kind: 'codex', login: CODEX },
    target: {
      pr: 55,
      issue: 44,
      headSha: HEAD,
      contractRevision: 1,
      contractSnapshotSha256: CONTRACT_HASH,
      refreshGeneration: 0,
    },
  });
  assert.equal(r.verdict, 'APPROVE');
  // …and end-to-end through evaluate(): a full valid state whose only
  // technical evidence is the documented block.
  const s = validState();
  s.techEvidence.candidates = [
    codexReview({
      body: `${documented}\n`,
    }),
  ];
  assert.deepEqual(evaluate(s), { pass: true, reasons: [] });
});

test('the OLD documented Codex blocks (V3-shaped: no REFRESH_GENERATION) are malformed and block', () => {
  const v3Shaped = [
    'REKODA_CODEX_APPROVAL',
    `SCHEME: ${SCHEME}`,
    'PR: 55',
    'ISSUE: 44',
    `HEAD_SHA: ${HEAD}`,
    'CONTRACT_REVISION: 1',
    `CONTRACT_SNAPSHOT_SHA256: ${CONTRACT_HASH}`,
    'VERDICT: APPROVE',
  ].join('\n');
  const s = validState();
  s.techEvidence.candidates = [codexReview({ body: v3Shaped })];
  expectBlock(s, 'TECH_MALFORMED');
  const ancient = [
    'REKODA_CODEX_APPROVAL',
    'PR: 55',
    'ISSUE: 44',
    `HEAD_SHA: ${HEAD}`,
    'CONTRACT_REVISION: 1',
    'VERDICT: APPROVE',
  ].join('\n');
  s.techEvidence.candidates = [codexReview({ body: ancient })];
  expectBlock(s, 'TECH_MALFORMED');
});

test('a native Codex block binding the WRONG snapshot hash blocks (TECH_WRONG_CONTRACT)', () => {
  const s = validState();
  s.techEvidence.candidates = [
    codexReview({
      body: marker(MARKERS.codex, { contractHash: snapHash({ body: ISSUE_BODY + '\n\nOther.' }) }),
    }),
  ];
  expectBlock(s, 'TECH_WRONG_CONTRACT');
});

// ---------------------------------------------------------------------------
// V3 — risk/builder are part of the signed contract snapshot
// ---------------------------------------------------------------------------

test('a risk label change WITHOUT an authorized revision blocks even with issue and PR consistent', () => {
  const s = validState();
  // Someone flips BOTH issue and PR labels R1 → R2 consistently; the body
  // hash and revision are untouched, and old approvals bind them.
  s.pr.riskLabels = ['risk:R2'];
  s.issue.riskLabels = ['risk:R2'];
  s.issue.labels = ['agent-task', 'risk:R2', 'builder:claude', 'status:in-review'];
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('CONTRACT_LABELS_DIVERGED'));
  // and no mode is exempt — the finalizer computes all three from this state
  for (const mode of ['policy', 'technical', 'acceptance']) {
    assert.equal(evaluate(s, mode).pass, false, `mode ${mode} must block`);
  }
});

test('a builder label change WITHOUT an authorized revision blocks (old approvals cannot survive)', () => {
  const s = validState();
  s.pr.builderLabels = ['builder:codex'];
  s.issue.builderLabels = ['builder:codex'];
  s.issue.labels = ['agent-task', 'risk:R1', 'builder:codex', 'status:in-review'];
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('CONTRACT_LABELS_DIVERGED'));
});

test('an authorized revision RECORDING the new labels re-activates the contract — but demands fresh evidence', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R2'];
  s.issue.riskLabels = ['risk:R2'];
  s.issue.labels = ['agent-task', 'risk:R2', 'builder:claude', 'status:in-review'];
  s.issue.comments = [
    contractComment(),
    enrollmentComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      risk: 'risk:R2',
      author: ACTIONS,
      key: AUTHORITY_KEY,
      id: 2,
      createdAt: 'y',
    }),
  ];
  // The old rev-1 evidence no longer matches the rev-2 snapshot…
  const stale = evaluate(s);
  assert.equal(stale.pass, false);
  assert.ok(
    codes(stale).includes('TECH_WRONG_REVISION') || codes(stale).includes('TECH_WRONG_CONTRACT'),
  );
  // …fresh evidence binding the new snapshot passes.
  const h2 = snapHash({ revision: 2, risk: 'risk:R2' });
  s.techEvidence.candidates = [
    codexReview({
      id: 12,
      createdAt: 'z',
      body: marker(MARKERS.codex, { rev: 2, contractHash: h2 }),
    }),
  ];
  s.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'z',
      id: 21,
      body: marker(MARKERS.gemini, { rev: 2, contractHash: h2, key: GEMINI_KEY }),
    },
  ];
  assert.deepEqual(evaluate(s), { pass: true, reasons: [] });
});

// ---------------------------------------------------------------------------
// V3 — the amendment freeze is EVALUATOR state, not just red check writes
// ---------------------------------------------------------------------------

/** An authority-signed freeze comment via the REAL generator. */
function freezeComment({ issue = 44, from = 1, target = 2, key = AUTHORITY_KEY, id = 5 } = {}) {
  const f = { issue, fromRevision: from, targetRevision: target };
  const signature = key ? signWith(key, canonicalFreezePayload(f)) : undefined;
  return {
    author: ACTIONS,
    createdAt: 'f',
    id,
    body: '```\n' + buildFreezeMarkerLines(f, signature).join('\n') + '\n```',
  };
}

test('a signed amendment freeze blocks EVERY gate mode — a rev-N publisher cannot conclude green mid-amendment', () => {
  const s = validState(); // rev-1 contract, valid rev-1 evidence — would pass
  assert.equal(evaluate(s).pass, true);
  s.issue.comments = [...s.issue.comments, freezeComment()];
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('CONTRACT_AMENDMENT_IN_PROGRESS'));
  for (const mode of ['policy', 'technical', 'acceptance']) {
    assert.equal(evaluate(s, mode).pass, false, `mode ${mode} must refuse green mid-amendment`);
  }
});

test('a HIGHER revision with an UNCHANGED body hash still yields no merge window', () => {
  // The amendment changes only revision+reason: body hash identical at
  // rev 1 and rev 2. During the freeze every mode blocks; after the
  // rev-2 marker exists the freeze expires but rev-1 evidence fails on
  // revision AND snapshot (revision is inside the snapshot payload).
  const s = validState();
  s.issue.comments = [...s.issue.comments, freezeComment()];
  assert.equal(evaluate(s).pass, false); // frozen
  s.issue.comments = [
    ...s.issue.comments,
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      author: ACTIONS,
      key: AUTHORITY_KEY,
      id: 6,
      createdAt: 'g',
    }),
  ];
  const after = evaluate(s);
  assert.equal(after.pass, false); // freeze expired, but old evidence is dead
  assert.ok(
    codes(after).includes('TECH_WRONG_REVISION') || codes(after).includes('TECH_WRONG_CONTRACT'),
  );
  assert.ok(!codes(after).includes('CONTRACT_AMENDMENT_IN_PROGRESS'), 'the freeze must expire');
});

test('freeze markers are authority-signed ONLY — unsigned or rogue-signed freezes cannot block an issue', () => {
  const s = validState();
  s.issue.comments = [
    ...s.issue.comments,
    freezeComment({ key: null }),
    freezeComment({ key: ROGUE_KEY, id: 7 }),
  ];
  assert.equal(evaluate(s).pass, true);
});

test('E2E: real freeze generator output → parseFreezeMarkers → signature → pendingFreeze; expires at the target revision', () => {
  const c = freezeComment();
  const parsed = parseFreezeMarkers(c.body);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].malformed, false, 'the generated freeze must parse clean');
  assert.ok(
    verifySignature(canonicalFreezePayload(parsed[0]), parsed[0].signature, pem(AUTHORITY_KEY)),
  );
  const during = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [contractComment(), c],
    issueLabels: ['agent-task', 'risk:R1', 'builder:claude'],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.deepEqual(during.pendingFreeze, { fromRevision: 1, targetRevision: 2 });
  const after = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [
      contractComment(),
      c,
      contractComment({
        kind: 'REKODA_CONTRACT_REVISION',
        revision: 2,
        author: ACTIONS,
        key: AUTHORITY_KEY,
        id: 9,
        createdAt: 'h',
      }),
    ],
    issueLabels: ['agent-task', 'risk:R1', 'builder:claude'],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.equal(after.revision, 2);
  assert.equal(after.pendingFreeze, null);
});

test('build admission refuses mid-amendment (pendingFreeze) and on diverged labels', () => {
  const frozen = evaluateBuildAdmission({
    contract: { ...OK_CONTRACT, pendingFreeze: { fromRevision: 1, targetRevision: 2 } },
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.ok(frozen.reasons.some((x) => x.code === 'ADMIT_CONTRACT_INVALID'));
  const diverged = evaluateBuildAdmission({
    contract: { ...OK_CONTRACT, labelsDiverged: true },
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
  });
  assert.ok(diverged.reasons.some((x) => x.code === 'ADMIT_CONTRACT_INVALID'));
});

// ---------------------------------------------------------------------------
// V3 — baseline existence is a canonical computation, never a substring probe
// ---------------------------------------------------------------------------

test('a comment that merely CONTAINS the baseline marker name is NOT a baseline (cannot suppress the real one)', () => {
  const rev = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [
      {
        author: 'random-drive-by',
        createdAt: 'x',
        id: 1,
        body: 'lol REKODA_CONTRACT_BASELINE trust me this issue is done',
      },
    ],
    issueLabels: ['agent-task', 'risk:R1', 'builder:claude'],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.equal(rev.baselineFound, false);
  assert.equal(rev.invalid, null);
});

test('malformed, unsigned-bot, wrong-issue, and rogue-signed baselines all fail to count as existing', () => {
  const cases = [
    // structurally complete but authored by a bot WITHOUT a signature
    contractComment({ author: ACTIONS, key: null }),
    // wrong issue number
    contractComment({ issue: 999 }),
    // signed by the wrong key
    contractComment({ author: ACTIONS, key: ROGUE_KEY }),
    // malformed: marker name present, fields garbage
    { author: OWNER, createdAt: 'x', id: 4, body: 'REKODA_CONTRACT_BASELINE\nREVISION: banana' },
  ];
  for (const c of cases) {
    const rev = computeContractRevision({
      issueNumber: 44,
      issueBody: ISSUE_BODY,
      issueComments: [c],
      issueLabels: ['agent-task', 'risk:R1', 'builder:claude'],
      ownerLogin: OWNER,
      contractAuthorityKey: pem(AUTHORITY_KEY),
    });
    assert.equal(rev.baselineFound, false, `case ${c.id ?? c.body?.slice(0, 30)} must not count`);
  }
});

test('conflicting AUTHORIZED baselines are invalid history — fail closed, do not paper over with a new one', () => {
  const rev = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [
      contractComment(),
      contractComment({ body: ISSUE_BODY + '\n\nDifferent.', id: 2, createdAt: 'y' }),
    ],
    issueLabels: ['agent-task', 'risk:R1', 'builder:claude'],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.equal(rev.revision, null);
  assert.ok(rev.invalid);
});

test('two authorized markers for one revision that disagree only on RISK or BUILDER conflict', () => {
  const rev = computeContractRevision({
    issueNumber: 44,
    issueBody: ISSUE_BODY,
    issueComments: [contractComment(), contractComment({ risk: 'risk:R2', id: 2, createdAt: 'y' })],
    issueLabels: ['agent-task', 'risk:R1', 'builder:claude'],
    ownerLogin: OWNER,
    contractAuthorityKey: pem(AUTHORITY_KEY),
  });
  assert.equal(rev.revision, null);
  assert.ok(rev.invalid);
});

// ---------------------------------------------------------------------------
// Linked-PR JSON — [70,73] is 70 and 73, NEVER 7073
// ---------------------------------------------------------------------------

test('parsePrNumbersJson: [70,73] dispatches exactly 70 and 73 — never a concatenation', () => {
  assert.deepEqual(parsePrNumbersJson('[70,73]'), [70, 73]);
  assert.deepEqual(parsePrNumbersJson('[]'), []);
  assert.deepEqual(parsePrNumbersJson('[7073]'), [7073]); // a real single PR list stays itself
});

test('parsePrNumbersJson: anything but a JSON array of positive integers fails closed', () => {
  assert.equal(parsePrNumbersJson('7073'), null); // bare number is not a list
  assert.equal(parsePrNumbersJson('[70,"73"]'), null);
  assert.equal(parsePrNumbersJson('[70,0]'), null);
  assert.equal(parsePrNumbersJson('[70,-3]'), null);
  assert.equal(parsePrNumbersJson('[70,73.5]'), null);
  assert.equal(parsePrNumbersJson('70 73'), null);
  assert.equal(parsePrNumbersJson(''), null);
  assert.equal(parsePrNumbersJson(null), null);
});

// ---------------------------------------------------------------------------
// Governance is decided from CURRENT state — never a resolver-time snapshot
// ---------------------------------------------------------------------------

test('a PR ungoverned at resolve time that gains agent labels is governed on re-evaluation — never neutral-green', () => {
  // Resolver-time snapshot: a plain PR.
  const before = {
    pr: {
      riskLabels: [],
      builderLabels: [],
      enrollment: { everLabeledAgent: false, complete: true },
    },
    issue: null,
  };
  assert.equal(isGoverned(before), false);
  // The finalizer re-normalizes: the SAME PR now carries agent labels.
  const after = {
    ...before,
    pr: { ...before.pr, riskLabels: ['risk:R1'], builderLabels: ['builder:claude'] },
  };
  assert.equal(isGoverned(after), true);
  // …or now closes an agent-task issue.
  const viaIssue = { ...before, issue: { agentTask: true } };
  assert.equal(isGoverned(viaIssue), true);
  // …or its sticky label-event history is discovered late.
  const viaHistory = {
    ...before,
    pr: { ...before.pr, enrollment: { everLabeledAgent: true, complete: true } },
  };
  assert.equal(isGoverned(viaHistory), true);
  // Unprovable enrollment can never look neutral either.
  const unprovable = {
    ...before,
    pr: { ...before.pr, enrollment: { everLabeledAgent: false, complete: false } },
  };
  assert.equal(isGoverned(unprovable), true);
});

// ---------------------------------------------------------------------------
// Threat: a tampered PR-branch review-context helper cannot move the contract
// ---------------------------------------------------------------------------

test('THREAT: attacker-selected snapshot hash (tampered PR-branch helper) never validates — the target hash derives from issue state only', () => {
  // A Claude-built PR edits review-context.mjs to print an
  // attacker-chosen CONTRACT_SNAPSHOT_SHA256 with APPROVE instructions.
  // The gates compute the target snapshot hash from the ISSUE's signed
  // contract with trusted default-branch code — nothing in the PR's
  // file tree is an input to it — so a Codex marker binding the
  // attacker's hash is rejected, and only the true hash validates.
  const attackerHash = sha256Hex('attacker-selected value');
  const s = validState();
  s.techEvidence.candidates = [
    codexReview({ body: marker(MARKERS.codex, { contractHash: attackerHash }) }),
  ];
  expectBlock(s, 'TECH_WRONG_CONTRACT');
  // The true hash (issue-derived) still validates — proving the target
  // came from the issue contract, not from any reviewed file content.
  s.techEvidence.candidates = [codexReview({ body: marker(MARKERS.codex) })];
  assert.deepEqual(evaluate(s), { pass: true, reasons: [] });
});

// ---------------------------------------------------------------------------
// READY promotion — every participating label may arrive last
// ---------------------------------------------------------------------------

test('READY promotion: ALL label-arrival orders promote exactly at the completing event — including risk LAST', () => {
  const required = ['agent-task', 'status:ready', 'builder:claude', 'risk:R2'];
  // Every permutation: each proper prefix declines; the full set proceeds.
  const permute = (arr) =>
    arr.length <= 1
      ? [arr]
      : arr.flatMap((x, i) =>
          permute([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]),
        );
  for (const order of permute(required)) {
    for (let k = 1; k < order.length; k++) {
      assert.equal(
        readyPromotionAction({ labels: order.slice(0, k) }).proceed,
        false,
        `prefix ${order.slice(0, k).join(',')} must decline`,
      );
    }
    const full = readyPromotionAction({ labels: order });
    assert.equal(full.proceed, true, `full set ${order.join(',')} must promote`);
    assert.equal(full.dispatchClaude, true);
    assert.equal(full.risk, 'risk:R2');
  }
});

test('READY promotion: removing the blocking decision label is the completing transition', () => {
  const withBlock = [
    'agent-task',
    'status:ready',
    'builder:codex',
    'risk:R1',
    'needs-owner-decision',
  ];
  assert.equal(readyPromotionAction({ labels: withBlock }).proceed, false);
  const cleared = withBlock.filter((l) => l !== 'needs-owner-decision');
  assert.deepEqual(readyPromotionAction({ labels: cleared }), {
    proceed: true,
    dispatchClaude: false,
    risk: 'risk:R1',
    builder: 'builder:codex',
  });
});

// ---------------------------------------------------------------------------
// Static workflow-graph assertions — the dependency/trigger shape itself
// ---------------------------------------------------------------------------

const WORKFLOWS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.github',
  'workflows',
);
const gatesYml = readFileSync(join(WORKFLOWS_DIR, 'agent-gates.yml'), 'utf8');
const authorityYml = readFileSync(join(WORKFLOWS_DIR, 'agent-contract-authority.yml'), 'utf8');

/** The YAML text of one job, from its header to the next top-level job. */
function jobBlock(yml, jobId) {
  const m = yml.match(new RegExp(`\\n  ${jobId}:\\n([\\s\\S]*?)(?=\\n  [a-z_]+:\\n|$)`));
  assert.ok(m, `job ${jobId} must exist`);
  return m[0];
}

test('WORKFLOW GRAPH: both AI reviewer jobs depend on their refresh job AND invalidate, requiring SUCCESS', () => {
  for (const [job, refreshJob] of [
    ['technical_ai', 'refresh_technical'],
    ['acceptance_ai', 'refresh_acceptance'],
  ]) {
    const block = jobBlock(gatesYml, job);
    assert.ok(
      new RegExp(`needs:\\s*\\[resolve,\\s*${refreshJob},\\s*invalidate\\]`).test(block),
      `${job} must need [resolve, ${refreshJob}, invalidate]`,
    );
    assert.ok(
      block.includes("needs.invalidate.result == 'success'"),
      `${job} must require the invalidation to have SUCCEEDED before any fresh review starts`,
    );
    assert.ok(
      block.includes(`needs.${refreshJob}.result == 'success'`) &&
        block.includes(`needs.${refreshJob}.result == 'skipped'`),
      `${job} must never run after a FAILED durable refresh`,
    );
  }
});

test('WORKFLOW GRAPH (X3): the durable refresh jobs run BEFORE the AI, signed, in the issuance lane', () => {
  for (const [job, env, lane] of [
    ['refresh_technical', 'agents-claude-reviewer', 'rekoda-evidence-technical-pr-'],
    ['refresh_acceptance', 'agents-gemini-reviewer', 'rekoda-evidence-acceptance-pr-'],
  ]) {
    const block = jobBlock(gatesYml, job);
    assert.ok(block.includes(`environment: ${env}`), `${job} must hold the role signing key env`);
    assert.ok(block.includes(lane), `${job} must serialize in the role issuance lane`);
    assert.ok(block.includes('refresh-marker.mjs'), `${job} must post the signed durable marker`);
    assert.ok(
      block.includes("force_review == 'true'"),
      `${job} must run only on authenticated force`,
    );
  }
  // The finalizer never runs after a FAILED refresh — the run fails
  // visibly with the durable generation already current.
  const finalize = jobBlock(gatesYml, 'finalize');
  assert.ok(
    finalize.includes(
      "needs.refresh_technical.result == 'success' || needs.refresh_technical.result == 'skipped'",
    ) &&
      finalize.includes(
        "needs.refresh_acceptance.result == 'success' || needs.refresh_acceptance.result == 'skipped'",
      ),
    'finalize must be gated on refresh success-or-skipped',
  );
});

test('WORKFLOW GRAPH (X1): verdicts travel as bounded job outputs — no artifact archive reaches a publisher', () => {
  for (const job of ['technical', 'acceptance']) {
    const block = jobBlock(gatesYml, job);
    assert.ok(
      !block.includes('download-artifact'),
      `${job} publisher must never download an artifact archive`,
    );
    assert.ok(
      block.includes('VERDICT_B64') && block.includes('RUNNER_TEMP'),
      `${job} publisher must receive the verdict as bounded data written only into RUNNER_TEMP`,
    );
  }
  for (const job of ['technical_ai', 'acceptance_ai']) {
    const block = jobBlock(gatesYml, job);
    assert.ok(
      block.includes('verdict_b64') && !block.includes('upload-artifact'),
      `${job} must hand its verdict over as a job output, never an uploaded archive`,
    );
  }
});

test('WORKFLOW GRAPH: the finalizer refuses to run after a FAILED invalidation and never trusts resolver-time governance', () => {
  const finalize = jobBlock(gatesYml, 'finalize');
  assert.ok(
    finalize.includes(
      "needs.invalidate.result == 'success' || needs.invalidate.result == 'skipped'",
    ),
    'finalize must be gated on invalidation success-or-skipped',
  );
  assert.ok(
    !finalize.includes('needs.resolve.outputs.governed'),
    'finalize must not read resolver-time governance',
  );
  assert.ok(!/GOVERNED:/.test(finalize), 'finalize must carry no resolver-time GOVERNED env');
  // The neutral publication must come AFTER the fresh normalization.
  const normalizeAt = finalize.indexOf('normalize.mjs');
  const neutralAt = finalize.indexOf('Not agent-governed');
  assert.ok(
    normalizeAt > -1 && neutralAt > -1 && normalizeAt < neutralAt,
    'the neutral path must be decided only after re-normalizing CURRENT state',
  );
});

test('WORKFLOW GRAPH (X6): NO workflow holds checks:write on GITHUB_TOKEN — every check write uses the dedicated App token in the gate-publisher environment', () => {
  for (const f of readdirSync(WORKFLOWS_DIR)) {
    const yml = readFileSync(join(WORKFLOWS_DIR, f), 'utf8');
    // Line-anchored: a real `checks: write` permission grant, not prose
    // about its absence.
    assert.ok(
      !/^[ \t]*checks:[ \t]*write[ \t]*$/m.test(yml),
      `${f} must not grant checks: write to GITHUB_TOKEN — the dedicated Gate Publisher App is the only trusted check identity`,
    );
  }
  for (const job of ['ambiguity_revoke', 'invalidate', 'finalize']) {
    const block = jobBlock(gatesYml, job);
    assert.ok(
      block.includes('environment: agents-gate-publisher'),
      `${job} must run in the gate-publisher environment`,
    );
    assert.ok(block.includes('app-token.mjs'), `${job} must mint the dedicated App token`);
  }
  const barrier = jobBlock(authorityYml, 'barrier');
  assert.ok(
    barrier.includes('environment: agents-gate-publisher') && barrier.includes('app-token.mjs'),
    'the amendment barrier is a red-only invocation of the same gate-publisher identity',
  );
  for (const job of ['technical', 'acceptance']) {
    const block = jobBlock(gatesYml, job);
    assert.ok(!block.includes('post-check.mjs'), `${job} publisher must not write checks`);
  }
});

test('WORKFLOW GRAPH (X5): every gate-check writer serializes in the SHA-keyed authorization lane', () => {
  for (const job of ['ambiguity_revoke', 'invalidate', 'finalize']) {
    assert.ok(
      jobBlock(gatesYml, job).includes('rekoda-authorization-sha-'),
      `${job} must take the SHA-scoped authorization group`,
    );
  }
  assert.ok(
    jobBlock(authorityYml, 'barrier').includes('rekoda-authorization-sha-'),
    'the amendment barrier must take the SHA-scoped authorization group',
  );
  // No writer still uses the old PR-number-scoped check-write group.
  assert.ok(
    !gatesYml.includes('rekoda-gates-pr-') && !authorityYml.includes('rekoda-gates-pr-'),
    'PR-number serialization of check writes is gone — checks attach to the SHA',
  );
});

test('WORKFLOW GRAPH: baseline promotion triggers symmetrically on every participating label — risk included — and on decision-label removal', () => {
  const baseline = jobBlock(authorityYml, 'baseline');
  for (const needle of [
    "github.event.label.name == 'status:ready'",
    "github.event.label.name == 'agent-task'",
    "startsWith(github.event.label.name, 'builder:')",
    "startsWith(github.event.label.name, 'risk:')",
    "github.event.action == 'unlabeled'",
    "github.event.label.name == 'needs-owner-decision'",
    "github.event.label.name == 'status:blocked-decision'",
  ]) {
    assert.ok(baseline.includes(needle), `baseline trigger must include: ${needle}`);
  }
  assert.ok(
    /types:\s*\[labeled,\s*unlabeled\]/.test(authorityYml),
    'issues trigger must include unlabeled',
  );
});

// ---------------------------------------------------------------------------
// Failure-before-pass publication — the finalizer's write order contract
// ---------------------------------------------------------------------------

test('check publication: EVERY non-passing conclusion precedes EVERY passing conclusion, for all combinations', () => {
  const names = ['Agent policy gate', 'Technical Review Gate', 'Gemini Acceptance Gate'];
  for (let mask = 0; mask < 8; mask++) {
    const conclusions = names.map((name, i) => ({
      name,
      conclusion: mask & (1 << i) ? 'failure' : 'success',
    }));
    const ordered = orderCheckWrites(conclusions);
    assert.equal(ordered.length, 3);
    const firstPass = ordered.findIndex((c) => c.conclusion === 'success');
    const lastFail = ordered.map((c) => c.conclusion).lastIndexOf('failure');
    if (firstPass !== -1 && lastFail !== -1) {
      assert.ok(lastFail < firstPass, `mask ${mask}: a failure was ordered after a pass`);
    }
  }
});

test('check publication: the Codex scenario — policy PASS, technical BLOCK, gemini PASS — writes the revocation first', () => {
  const ordered = orderCheckWrites([
    { name: 'Agent policy gate', conclusion: 'success' },
    { name: 'Technical Review Gate', conclusion: 'failure' },
    { name: 'Gemini Acceptance Gate', conclusion: 'success' },
  ]);
  assert.deepEqual(
    ordered.map((c) => c.name),
    ['Technical Review Gate', 'Agent policy gate', 'Gemini Acceptance Gate'],
  );
  // …so a Policy PASS lookup abort (chooseCheckAction: success + failed
  // lookup → abort) can no longer strand the Technical FAILURE behind
  // it: the failure was already delivered, blind if necessary.
  assert.equal(
    chooseCheckAction({
      lookupOk: false,
      runs: [],
      name: 'Agent policy gate',
      conclusion: 'success',
    }).action,
    'abort',
  );
  assert.equal(
    chooseCheckAction({
      lookupOk: false,
      runs: [],
      name: 'Technical Review Gate',
      conclusion: 'failure',
    }).action,
    'post',
  );
});

test('check publication: neutral counts as passing for ordering (GitHub treats neutral as passing)', () => {
  const ordered = orderCheckWrites([
    { name: 'A', conclusion: 'neutral' },
    { name: 'B', conclusion: 'failure' },
  ]);
  assert.deepEqual(
    ordered.map((c) => c.name),
    ['B', 'A'],
  );
});

// ---------------------------------------------------------------------------
// Owner-authorized amendment snapshot binding
// ---------------------------------------------------------------------------

test('amendment signing: the signer refuses ANY drift from the owner-authorized snapshot', () => {
  const authorized = snapHash({ revision: 2 }); // owner reviewed body A, risk R1, builder claude
  // unchanged → sign
  assert.equal(
    amendmentSignAllowed({ expectedSnapshotHash: authorized, freshSnapshotHash: authorized }),
    true,
  );
  // collaborator edits the body during the barriers → refuse
  const bodyDrift = snapHash({ revision: 2, body: ISSUE_BODY + '\n\nInjected requirement.' });
  assert.equal(
    amendmentSignAllowed({ expectedSnapshotHash: authorized, freshSnapshotHash: bodyDrift }),
    false,
  );
  // risk or builder relabelled during the barriers → refuse
  assert.equal(
    amendmentSignAllowed({
      expectedSnapshotHash: authorized,
      freshSnapshotHash: snapHash({ revision: 2, risk: 'risk:R3' }),
    }),
    false,
  );
  assert.equal(
    amendmentSignAllowed({
      expectedSnapshotHash: authorized,
      freshSnapshotHash: snapHash({ revision: 2, builder: 'builder:codex' }),
    }),
    false,
  );
  // A→B→A: the final state IS byte-for-byte the authorized snapshot → sign
  const backToA = snapHash({ revision: 2, body: ISSUE_BODY });
  assert.equal(
    amendmentSignAllowed({ expectedSnapshotHash: authorized, freshSnapshotHash: backToA }),
    true,
  );
  // no/invalid authorization hash → never sign
  assert.equal(
    amendmentSignAllowed({ expectedSnapshotHash: '', freshSnapshotHash: authorized }),
    false,
  );
  assert.equal(
    amendmentSignAllowed({ expectedSnapshotHash: undefined, freshSnapshotHash: authorized }),
    false,
  );
});

// ---------------------------------------------------------------------------
// The REAL contract-revision CLI parser, with REAL argv arrays
// ---------------------------------------------------------------------------

test('REAL CLI: --baseline with --sign-env parses as the baseline mode (boolean flag takes no value)', () => {
  const a = parseContractRevisionCli([
    '--repo',
    'x/y',
    '--issue',
    '44',
    '--baseline',
    '--sign-env',
    'KEY',
  ]);
  assert.equal(a.mode, 'baseline');
  assert.equal(a.baseline, true);
  assert.equal(a['sign-env'], 'KEY');
  assert.equal(a.post, undefined);
});

test('REAL CLI: --freeze --from 1 --target 2 actually enters the freeze mode', () => {
  const a = parseContractRevisionCli([
    '--repo',
    'x/y',
    '--issue',
    '44',
    '--freeze',
    '--from',
    '1',
    '--target',
    '2',
    '--sign-env',
    'KEY',
  ]);
  assert.equal(a.mode, 'freeze');
  assert.equal(a.freeze, true);
  assert.equal(a.from, '1');
  assert.equal(a.target, '2');
});

test('REAL CLI: --revision 2 --reason … --expected-snapshot-hash … parses the revision mode; --post is boolean', () => {
  const h = 'a'.repeat(64);
  const a = parseContractRevisionCli([
    '--repo',
    'x/y',
    '--issue',
    '44',
    '--revision',
    '2',
    '--reason',
    'scope',
    '--expected-snapshot-hash',
    h,
    '--sign-env',
    'KEY',
    '--post',
  ]);
  assert.equal(a.mode, 'revision');
  assert.equal(a.revision, '2');
  assert.equal(a.reason, 'scope');
  assert.equal(a['expected-snapshot-hash'], h);
  assert.equal(a.post, true);
});

test('REAL CLI: unknown options, missing values, and invalid mode combinations FAIL loudly', () => {
  assert.throws(() => parseContractRevisionCli(['--repo', 'x/y', '--issue', '44', '--banana']));
  assert.throws(() =>
    parseContractRevisionCli(['--repo', 'x/y', '--issue', '44', '--revision', '--post']),
  ); // --revision swallowed an option token → missing value
  assert.throws(() => parseContractRevisionCli(['--repo', 'x/y', '--issue', '44'])); // no mode
  assert.throws(() =>
    parseContractRevisionCli(['--repo', 'x/y', '--issue', '44', '--baseline', '--freeze']),
  ); // two modes
  assert.throws(() =>
    parseContractRevisionCli(['--repo', 'x/y', '--issue', '44', '--baseline', '--revision', '2']),
  ); // baseline + revision
});

// ---------------------------------------------------------------------------
// Shared-HEAD SHA: passing publication requires a unique CURRENT association
// ---------------------------------------------------------------------------

test('passing publication: allowed ONLY when the current association is exactly this one open PR', () => {
  assert.equal(passingPublicationAllowed({ resolution: { status: 'ok', pr: 55 }, pr: 55 }), true);
  assert.equal(passingPublicationAllowed({ resolution: { status: 'ok', pr: '55' }, pr: 55 }), true);
  // a SECOND open PR appeared on the same SHA after resolve → refuse
  assert.equal(
    passingPublicationAllowed({ resolution: { status: 'ambiguous', pr: null }, pr: 55 }),
    false,
  );
  // the association moved to a different PR → refuse
  assert.equal(passingPublicationAllowed({ resolution: { status: 'ok', pr: 90 }, pr: 55 }), false);
  // gone, superseded, or unprovable → refuse
  assert.equal(
    passingPublicationAllowed({ resolution: { status: 'none', pr: null }, pr: 55 }),
    false,
  );
  assert.equal(
    passingPublicationAllowed({ resolution: { status: 'stale', pr: 55 }, pr: 55 }),
    false,
  );
  assert.equal(
    passingPublicationAllowed({ resolution: { status: 'unprovable', pr: null }, pr: 55 }),
    false,
  );
  assert.equal(passingPublicationAllowed({ resolution: null, pr: 55 }), false);
});

// ---------------------------------------------------------------------------
// Force review is OWNER-ONLY authenticated human intent — never transport
// ---------------------------------------------------------------------------

test('force review: not requested → plain reevaluation, no error (automatic dispatches are never force)', () => {
  assert.deepEqual(
    authorizeForceReview({
      requested: false,
      actor: 'github-actions[bot]',
      actorType: 'Bot',
      ownerLogin: OWNER,
    }),
    { force: false, error: null },
  );
  assert.deepEqual(
    authorizeForceReview({
      requested: undefined,
      actor: OWNER,
      actorType: 'User',
      ownerLogin: OWNER,
    }),
    { force: false, error: null },
  );
});

test('force review (Y2): EVERY bot/App identity is rejected — excluding github-actions[bot] alone is not sufficient', () => {
  // The trusted account TYPE decides, not a login denylist: a
  // write-permission GitHub App such as claude[bot] must be refused
  // exactly like the workflow identity.
  for (const [actor, actorType] of [
    ['github-actions[bot]', 'Bot'],
    ['claude[bot]', 'Bot'],
    ['chatgpt-codex-connector[bot]', 'Bot'],
    ['some-org-automation[bot]', 'Bot'],
    ['dependabot[bot]', 'Bot'],
  ]) {
    const r = authorizeForceReview({ requested: true, actor, actorType, ownerLogin: OWNER });
    assert.equal(r.force, false, `${actor} must never force paid review`);
    assert.ok(r.error, `${actor} refusal must be a visible error`);
  }
});

test('force review (Y2): a non-owner human — even write+/admin — is rejected; only the owner forces', () => {
  const writeHuman = authorizeForceReview({
    requested: true,
    actor: 'trusted-collaborator',
    actorType: 'User',
    ownerLogin: OWNER,
  });
  assert.equal(writeHuman.force, false);
  assert.ok(writeHuman.error);
  const spoofedType = authorizeForceReview({
    requested: 'true',
    actor: OWNER,
    actorType: 'Bot', // an App named like the owner is still a Bot
    ownerLogin: OWNER,
  });
  assert.equal(spoofedType.force, false);
  assert.ok(spoofedType.error);
  assert.deepEqual(
    authorizeForceReview({ requested: true, actor: OWNER, actorType: 'User', ownerLogin: OWNER }),
    { force: true, error: null },
  );
});

// ---------------------------------------------------------------------------
// Static workflow assertions for this pass
// ---------------------------------------------------------------------------

const watchYml = readFileSync(join(WORKFLOWS_DIR, 'agent-contract-watch.yml'), 'utf8');

test('WORKFLOW GRAPH: force_review is an explicit input (default false); resolve authenticates it OWNER-only; event_name appears only in the non-main-ref guard', () => {
  assert.ok(
    /force_review:\n[\s\S]{0,400}?default: false/.test(gatesYml),
    'force_review input must default false',
  );
  const resolve = jobBlock(gatesYml, 'resolve');
  assert.ok(
    resolve.includes('Authenticate forced-review intent (owner only)'),
    'resolve must authenticate force as owner-only',
  );
  assert.ok(resolve.includes('authorizeForceReview'), 'resolve must use the tested authorizer');
  assert.ok(
    resolve.includes('users/$ACTOR') && resolve.includes('.type'),
    'resolve must verify the trusted ACCOUNT TYPE, not just the login',
  );
  // event_name may appear ONLY to guard non-main dispatch refs — never
  // to infer force from the transport.
  const eventNameUses = gatesYml.split("github.event_name == 'workflow_dispatch'").length - 1;
  const refGuards = gatesYml.split('Refuse non-main dispatch refs').length - 1;
  assert.ok(
    eventNameUses <= refGuards,
    'every workflow_dispatch event_name conditional must be a non-main-ref guard, not force inference',
  );
  assert.ok(refGuards >= 1, 'the gates must refuse non-main dispatch refs');
});

test('WORKFLOW GRAPH (Y1): the watcher authorizes BEFORE any concurrency; nothing can cancel an authorized delivery', () => {
  assert.ok(watchYml.includes('-f force_review=false'), 'watcher must dispatch plain reevaluation');
  assert.ok(
    !watchYml.includes('cancel-in-progress: true'),
    'no watcher concurrency may cancel in progress — an unauthorized comment must never displace an authorized delivery',
  );
  const authorize = jobBlock(watchYml, 'authorize');
  assert.ok(
    !authorize.includes('concurrency:'),
    'the authorization preflight must have NO concurrency group — unauthorized events die in isolation',
  );
  const redispatch = jobBlock(watchYml, 'redispatch');
  assert.ok(
    redispatch.includes('needs: authorize') &&
      redispatch.includes("needs.authorize.outputs.proceed == 'true'"),
    'only authorized events reach the redispatch lane',
  );
  assert.ok(
    redispatch.includes('cancel-in-progress: false'),
    'authorized deliveries queue durably, never cancel each other',
  );
  assert.ok(
    authorityYml.includes('-f force_review=false'),
    'authority redispatch must be plain reevaluation',
  );
});

test('WORKFLOW GRAPH: ambiguity actively reds the shared SHA via the gate-publisher lane, and the finalizer orders failures → association re-check → passes', () => {
  const revoke = jobBlock(gatesYml, 'ambiguity_revoke');
  assert.ok(
    revoke.includes("status == 'ambiguous'") && revoke.includes('--conclusion failure'),
    'the ambiguity handler must actively fail a shared SHA',
  );
  const finalize = jobBlock(gatesYml, 'finalize');
  const failuresAt = finalize.indexOf('FAILURES FIRST');
  const assocAt = finalize.indexOf('ASSOCIATION RE-CHECK');
  const passesAt = finalize.indexOf('PASSES LAST');
  assert.ok(
    failuresAt > -1 && assocAt > failuresAt && passesAt > assocAt,
    'finalize must publish failures, then re-check association, then passes',
  );
  assert.ok(
    finalize.includes('passingPublicationAllowed'),
    'finalize must use the tested association gate',
  );
});

test('WORKFLOW GRAPH: the amendment carries the owner-authorized snapshot hash into the signer', () => {
  assert.ok(/expected_snapshot_hash:/.test(authorityYml), 'the dispatch input must exist');
  const sign = jobBlock(authorityYml, 'sign');
  assert.ok(
    sign.includes('--expected-snapshot-hash'),
    'the signer must receive the authorized hash',
  );
  const plan = jobBlock(authorityYml, 'plan');
  assert.ok(
    plan.includes('amendment-context.mjs'),
    'the plan job must recompute and compare the proposed snapshot',
  );
});

// ---------------------------------------------------------------------------
// X2 — replay-resistant V4 evidence: the exact audit scenario
// ---------------------------------------------------------------------------

test('X2: APPROVE seq10 → BLOCK seq11 → copied APPROVE seq10 in the NEWEST comment: BLOCK remains authoritative', () => {
  const s = codexBuiltState();
  const approveSeq10 = marker(MARKERS.claude, {
    key: CLAUDE_KEY,
    verdict: 'APPROVE',
    sequence: 10,
    evidenceId: 'a'.repeat(32),
    contractHash: CODEX_CONTRACT_HASH,
  });
  s.techEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: '2026-09-02T00:00:00Z',
      id: 5,
      body: approveSeq10,
    },
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: '2026-09-02T01:00:00Z',
      id: 6,
      body: marker(MARKERS.claude, {
        key: CLAUDE_KEY,
        verdict: 'BLOCK',
        sequence: 11,
        evidenceId: 'b'.repeat(32),
        contractHash: CODEX_CONTRACT_HASH,
      }),
    },
    // The attacker needs NO signing key for this: the exact signed
    // APPROVE text is copied verbatim into a brand-new comment with the
    // newest timestamp and highest comment id.
    {
      author: 'attacker',
      kind: 'comment',
      createdAt: '2026-09-09T00:00:00Z',
      id: 999,
      body: approveSeq10,
    },
  ];
  expectBlock(s, 'TECH_BLOCK');
});

test('X2: the same replay against the Gemini role also keeps the BLOCK', () => {
  const s = validState();
  const approve = marker(MARKERS.gemini, {
    key: GEMINI_KEY,
    verdict: 'APPROVE',
    sequence: 3,
    evidenceId: 'c'.repeat(32),
  });
  s.geminiEvidence.candidates = [
    { author: ACTIONS, kind: 'comment', createdAt: '2026-09-02T01:00:00Z', id: 20, body: approve },
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: '2026-09-02T02:00:00Z',
      id: 21,
      body: marker(MARKERS.gemini, {
        key: GEMINI_KEY,
        verdict: 'BLOCK',
        sequence: 4,
        evidenceId: 'd'.repeat(32),
      }),
    },
    {
      author: 'attacker',
      kind: 'comment',
      createdAt: '2026-09-09T00:00:00Z',
      id: 900,
      body: approve,
    },
  ];
  expectBlock(s, 'GEMINI_BLOCK');
});

test('X2: a signed marker WITHOUT issuance fields is malformed under V4 (no downgrade path)', () => {
  const s = validState();
  // V3-shaped signed Gemini marker: no generation/sequence/id lines.
  const m = {
    name: MARKERS.gemini,
    pr: 55,
    issue: 44,
    headSha: HEAD,
    contractRevision: 1,
    contractSnapshotSha256: CONTRACT_HASH,
    verdict: 'APPROVE',
  };
  const v3Lines = [
    MARKERS.gemini,
    `SCHEME: ${SCHEME}`,
    'PR: 55',
    'ISSUE: 44',
    `HEAD_SHA: ${HEAD}`,
    'CONTRACT_REVISION: 1',
    `CONTRACT_SNAPSHOT_SHA256: ${CONTRACT_HASH}`,
    'VERDICT: APPROVE',
    `SIGNATURE: ${signWith(GEMINI_KEY, canonicalVerdictPayload(m))}`,
  ];
  s.geminiEvidence.candidates = [
    { author: ACTIONS, kind: 'comment', createdAt: 'x', id: 20, body: v3Lines.join('\n') },
  ];
  expectBlock(s, 'GEMINI_MALFORMED');
});

// ---------------------------------------------------------------------------
// X3 — the durable refresh generation
// ---------------------------------------------------------------------------

test('X3: once the signed refresh marker exists, gen-0 evidence is invalid — AI/signer failure, cancellation, or a concurrent ordinary finalizer cannot restore it', () => {
  // The pre-refresh state passes.
  const s = validState();
  assert.equal(evaluate(s).pass, true);
  // The forced refresh posts the durable generation-1 marker. NOTHING
  // else happens (the AI fails / the signer fails / the job is
  // cancelled): the evaluator alone — which any ordinary finalizer
  // re-runs over current state — now refuses the old evidence.
  s.techEvidence.candidates = [...s.techEvidence.candidates, refreshComment({ role: 'technical' })];
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_REFRESH_REQUIRED'));
  // The generation is never "cleared": re-evaluating any number of
  // times yields the same refusal until qualifying evidence exists.
  assert.equal(evaluate(s, 'technical').pass, false);
});

test('X3: a fresh gen-1 BLOCK keeps the gate red; a fresh gen-1 APPROVE may pass', () => {
  const s = validState();
  s.techEvidence.candidates = [
    codexReview(), // old gen-0 approve — dead after the refresh
    refreshComment({ role: 'technical' }),
    codexReview({
      id: 40,
      createdAt: '2026-09-04T00:00:00Z',
      body: marker(MARKERS.codex, { generation: 1, verdict: 'BLOCK' }),
    }),
  ];
  expectBlock(s, 'TECH_BLOCK');
  s.techEvidence.candidates = [
    codexReview(),
    refreshComment({ role: 'technical' }),
    codexReview({
      id: 41,
      createdAt: '2026-09-04T01:00:00Z',
      body: marker(MARKERS.codex, { generation: 1 }),
    }),
  ];
  assert.deepEqual(evaluate(s), { pass: true, reasons: [] });
});

test('X3: the acceptance role has its own independent generation', () => {
  const s = validState();
  s.geminiEvidence.candidates = [
    ...s.geminiEvidence.candidates,
    refreshComment({ role: 'acceptance', id: 31 }),
  ];
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('GEMINI_REFRESH_REQUIRED'));
  assert.ok(!codes(r).includes('TECH_REFRESH_REQUIRED'), 'the technical role is untouched');
});

test('X3: refresh markers are control-plane-signed ONLY — unsigned/rogue/wrong-key markers bump nothing', () => {
  const s = validState();
  s.techEvidence.candidates = [
    ...s.techEvidence.candidates,
    refreshComment({ role: 'technical', key: ROGUE_KEY, id: 32 }),
    refreshComment({ role: 'technical', key: null, id: 33 }),
    // acceptance-key-signed marker claiming the technical role
    refreshComment({ role: 'technical', key: GEMINI_KEY, id: 34 }),
  ];
  assert.equal(evaluate(s).pass, true, 'no forged marker may invalidate current evidence');
});

test('X3: the refresh binds HEAD and snapshot — a marker for another head or contract does not touch this gate', () => {
  const s = validState();
  s.techEvidence.candidates = [
    ...s.techEvidence.candidates,
    refreshComment({ role: 'technical', head: OLD_HEAD, id: 35 }),
    refreshComment({
      role: 'technical',
      contractHash: snapHash({ body: ISSUE_BODY + '\nother' }),
      id: 36,
    }),
  ];
  assert.equal(evaluate(s).pass, true);
});

test('X3: currentRefreshGeneration takes the MAX valid generation', () => {
  const target = { pr: 55, headSha: HEAD, contractSnapshotSha256: CONTRACT_HASH };
  const gen = currentRefreshGeneration({
    candidates: [
      refreshComment({ generation: 1 }),
      refreshComment({ generation: 3, id: 37 }),
      refreshComment({ generation: 2, id: 38 }),
      refreshComment({ generation: 9, key: ROGUE_KEY, id: 39 }), // forged — ignored
    ],
    role: 'technical',
    target,
    publicKey: pem(CLAUDE_KEY),
  });
  assert.equal(gen, 3);
});

// ---------------------------------------------------------------------------
// X4 — authoritative PR enrollment
// ---------------------------------------------------------------------------

test('X4: a governed PR with a closing reference but NO active enrollment blocks in EVERY mode', () => {
  const s = validState();
  s.issue.comments = [contractComment()]; // no enrollment record
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('PR_NOT_ENROLLED'));
  for (const mode of ['policy', 'technical', 'acceptance']) {
    assert.equal(evaluate(s, mode).pass, false, `mode ${mode} must block without enrollment`);
  }
});

test('X4: a released enrollment blocks; a re-enrollment (latest event) reactivates', () => {
  const s = validState();
  s.issue.comments = [
    contractComment(),
    enrollmentComment({ createdAt: '2026-09-01T00:30:00Z', id: 2 }),
    enrollmentComment({ status: 'released', createdAt: '2026-09-01T01:00:00Z', id: 4 }),
  ];
  expectBlock(s, 'PR_NOT_ENROLLED');
  s.issue.comments.push(enrollmentComment({ createdAt: '2026-09-01T02:00:00Z', id: 6 }));
  assert.deepEqual(evaluate(s), { pass: true, reasons: [] });
});

test('X4: rogue-signed and unsigned enrollment markers count for nothing', () => {
  const s = validState();
  s.issue.comments = [
    contractComment(),
    enrollmentComment({ key: ROGUE_KEY }),
    enrollmentComment({ key: null, id: 7 }),
  ];
  expectBlock(s, 'PR_NOT_ENROLLED');
});

test('X4: an enrollment for a DIFFERENT PR does not enroll this one', () => {
  const s = validState();
  s.issue.comments = [contractComment(), enrollmentComment({ pr: 77 })];
  const r = evaluate(s);
  assert.ok(codes(r).includes('PR_NOT_ENROLLED'));
  const enr = resolvePrEnrollment({
    issueComments: s.issue.comments,
    issueNumber: 44,
    prNumber: 55,
    authorityKey: pem(AUTHORITY_KEY),
  });
  assert.deepEqual(enr, { enrolled: false, activePrs: [77] });
});

test('X4: a "Closes #N" body edit DURING an amendment gains nothing — after the freeze expires the latecomer PR still cannot pass', () => {
  // The latecomer PR: governed via the agent-task issue link it just
  // added, valid rev-2 contract, even fresh rev-2 verdicts — but no
  // enrollment, because only the authority can enroll and its per-issue
  // transaction was already in flight.
  const newBody = ISSUE_BODY + '\n\nAmended.';
  const rev2Hash = snapHash({ revision: 2, body: newBody });
  const s = validState({ pr: { number: 91 } });
  s.prBody = 'Closes #44';
  s.issue.body = newBody;
  s.issue.comments = [
    contractComment(),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: newBody,
      author: ACTIONS,
      key: AUTHORITY_KEY,
      id: 8,
      createdAt: 'y',
    }),
    // enrollment exists — for the REAL implementation PR #55, not #91
    enrollmentComment({ contractHash: rev2Hash, createdAt: 'z', id: 9 }),
  ];
  s.techEvidence.candidates = [
    codexReview({ body: marker(MARKERS.codex, { pr: 91, rev: 2, contractHash: rev2Hash }) }),
  ];
  s.geminiEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: 'z',
      id: 22,
      body: marker(MARKERS.gemini, { pr: 91, rev: 2, contractHash: rev2Hash, key: GEMINI_KEY }),
    },
  ];
  expectBlock(s, 'PR_NOT_ENROLLED');
});

test('X4 E2E: real enrollment generator output → parseEnrollmentMarkers → resolvePrEnrollment', () => {
  const m = { issue: 44, pr: 55, contractSnapshotSha256: CONTRACT_HASH, status: 'active' };
  const posted =
    '```\n' +
    buildEnrollmentMarkerLines(m, signWith(AUTHORITY_KEY, canonicalEnrollmentPayload(m))).join(
      '\n',
    ) +
    '\n```';
  const parsed = parseEnrollmentMarkers(posted);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].malformed, false);
  const r = resolvePrEnrollment({
    issueComments: [{ author: ACTIONS, createdAt: 'x', id: 1, body: posted }],
    issueNumber: 44,
    prNumber: 55,
    authorityKey: pem(AUTHORITY_KEY),
  });
  assert.deepEqual(r, { enrolled: true, activePrs: [55] });
});

// ---------------------------------------------------------------------------
// X7 — R3 owner authorization before build admission AND merge
// ---------------------------------------------------------------------------

test('X7: an R3 issue NEVER admits without a current owner decision; approval admits; R1 needs none', () => {
  const r3Issue = readyIssue({
    labels: ['agent-task', 'risk:R3', 'builder:claude', 'status:ready'],
    riskLabels: ['risk:R3'],
  });
  // missing
  let r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: r3Issue,
    requiredBuilder: 'builder:claude',
    openLanes: [],
    ownerDecision: { approved: false },
  });
  assert.equal(r.admit, false);
  assert.ok(r.reasons.some((x) => x.code === 'ADMIT_R3_DECISION_MISSING'));
  // approved → admitted
  r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: r3Issue,
    requiredBuilder: 'builder:claude',
    openLanes: [],
    ownerDecision: { approved: true },
  });
  assert.deepEqual(r, { admit: true, reasons: [] });
  // R1 issues never need one
  r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
    ownerDecision: { approved: false },
  });
  assert.deepEqual(r, { admit: true, reasons: [] });
});

test('X7: resolveOwnerDecision — snapshot-bound, owner-authored, latest-governs (REVOKE works), escalation invalidates', () => {
  const hash = snapHash({ risk: 'risk:R3' });
  const otherHash = snapHash({ risk: 'risk:R2' });
  // owner-authored, matching snapshot → approved
  assert.equal(
    resolveOwnerDecision({
      issueComments: [ownerDecisionComment({ contractHash: hash })],
      issueNumber: 44,
      snapshotHash: hash,
      ownerLogin: OWNER,
    }).approved,
    true,
  );
  // NOT owner-authored → never counts (a write collaborator or bot
  // cannot authorize R3)
  assert.equal(
    resolveOwnerDecision({
      issueComments: [ownerDecisionComment({ contractHash: hash, author: 'claude[bot]' })],
      issueNumber: 44,
      snapshotHash: hash,
      ownerLogin: OWNER,
    }).approved,
    false,
  );
  // decision bound to ANOTHER snapshot (old revision / pre-escalation
  // R2 state / edited body) → never counts for this one
  assert.equal(
    resolveOwnerDecision({
      issueComments: [ownerDecisionComment({ contractHash: otherHash })],
      issueNumber: 44,
      snapshotHash: hash,
      ownerLogin: OWNER,
    }).approved,
    false,
  );
  // latest decision governs: APPROVE then REVOKE → refused
  assert.equal(
    resolveOwnerDecision({
      issueComments: [
        ownerDecisionComment({ contractHash: hash, createdAt: 'a', id: 1 }),
        ownerDecisionComment({ contractHash: hash, decision: 'REVOKE', createdAt: 'b', id: 2 }),
      ],
      issueNumber: 44,
      snapshotHash: hash,
      ownerLogin: OWNER,
    }).approved,
    false,
  );
  // no snapshot hash (invalid contract) → never approved
  assert.equal(
    resolveOwnerDecision({
      issueComments: [ownerDecisionComment({ contractHash: hash })],
      issueNumber: 44,
      snapshotHash: null,
      ownerLogin: OWNER,
    }).approved,
    false,
  );
});

test('X7: the merge gate blocks R3 whose decision binds a superseded snapshot', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R3'];
  s.issue.riskLabels = ['risk:R3'];
  s.issue.labels = ['agent-task', 'risk:R3', 'builder:claude', 'status:in-review'];
  const r3Hash = snapHash({ risk: 'risk:R3' });
  s.issue.comments = [
    contractComment({ risk: 'risk:R3' }),
    enrollmentComment({ contractHash: r3Hash }),
    // decision recorded against the OLD R1 snapshot — not this contract
    ownerDecisionComment({ contractHash: CONTRACT_HASH }),
  ];
  s.techEvidence.candidates = [
    codexReview({ body: marker(MARKERS.codex, { contractHash: r3Hash }) }),
  ];
  s.geminiEvidence.candidates[0].body = marker(MARKERS.gemini, {
    key: GEMINI_KEY,
    contractHash: r3Hash,
  });
  s.ownerReviews = [{ author: OWNER, state: 'APPROVED', commitId: HEAD }];
  expectBlock(s, 'R3_OWNER_DECISION_MISSING');
});

// ---------------------------------------------------------------------------
// Y3 — lane pagination + the durable lease
// ---------------------------------------------------------------------------

test('Y3: an unprovably complete lane search BLOCKS admission', () => {
  const r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    openLanes: [],
    laneSearchComplete: false,
  });
  assert.equal(r.admit, false);
  assert.ok(r.reasons.some((x) => x.code === 'ADMIT_LANE_UNPROVABLE'));
});

test('Y3: an occupied lane blocks wherever it was found — a lease-discovered lane counts exactly like a labelled one', () => {
  const r = evaluateBuildAdmission({
    contract: OK_CONTRACT,
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    // e.g. discovered on page 2 of the label listing, or via the lease
    // scan of an issue whose labels a compromised builder stripped
    openLanes: [{ issue: 210, status: 'lease' }],
  });
  assert.equal(r.admit, false);
  assert.ok(r.reasons.some((x) => x.code === 'ADMIT_LANE_OCCUPIED'));
});

test('Y3: the lease is authority-signed both directions — a compromised builder can neither claim nor release', () => {
  const claim = { issue: 60, contractSnapshotSha256: CONTRACT_HASH, claimId: '1'.repeat(32) };
  const signedClaim = {
    author: ACTIONS,
    createdAt: 'a',
    id: 1,
    body: buildLaneClaimMarkerLines(
      claim,
      signWith(AUTHORITY_KEY, canonicalLaneClaimPayload(claim)),
    ).join('\n'),
  };
  // active claim, no release
  assert.equal(
    resolveLaneLease({
      issueComments: [signedClaim],
      issueNumber: 60,
      authorityKey: pem(AUTHORITY_KEY),
    }).active,
    true,
  );
  // a BUILDER-forged release (rogue key / unsigned) frees nothing
  const release = { issue: 60, claimId: claim.claimId };
  const forgedRelease = {
    author: 'claude[bot]',
    createdAt: 'b',
    id: 2,
    body: buildLaneReleaseMarkerLines(
      release,
      signWith(ROGUE_KEY, canonicalLaneReleasePayload(release)),
    ).join('\n'),
  };
  const unsignedRelease = {
    author: 'claude[bot]',
    createdAt: 'c',
    id: 3,
    body: buildLaneReleaseMarkerLines(release).join('\n'),
  };
  assert.equal(
    resolveLaneLease({
      issueComments: [signedClaim, forgedRelease, unsignedRelease],
      issueNumber: 60,
      authorityKey: pem(AUTHORITY_KEY),
    }).active,
    true,
    'only the authority can release a lane',
  );
  // the AUTHORITY release frees it
  const realRelease = {
    author: ACTIONS,
    createdAt: 'd',
    id: 4,
    body: buildLaneReleaseMarkerLines(
      release,
      signWith(AUTHORITY_KEY, canonicalLaneReleasePayload(release)),
    ).join('\n'),
  };
  assert.equal(
    resolveLaneLease({
      issueComments: [signedClaim, realRelease],
      issueNumber: 60,
      authorityKey: pem(AUTHORITY_KEY),
    }).active,
    false,
  );
  // a builder-forged CLAIM admits nothing either
  const forgedClaim = {
    author: 'claude[bot]',
    createdAt: 'e',
    id: 5,
    body: buildLaneClaimMarkerLines(
      claim,
      signWith(ROGUE_KEY, canonicalLaneClaimPayload(claim)),
    ).join('\n'),
  };
  assert.equal(
    resolveLaneLease({
      issueComments: [forgedClaim],
      issueNumber: 60,
      authorityKey: pem(AUTHORITY_KEY),
    }).active,
    false,
  );
});

test('Y3: evaluateBuildStart — the builder preflight requires the claim, the building state, and a valid contract', () => {
  const buildingIssue = readyIssue({
    labels: ['agent-task', 'risk:R1', 'builder:claude', 'status:building'],
  });
  // happy path
  assert.deepEqual(
    evaluateBuildStart({
      issue: buildingIssue,
      requiredBuilder: 'builder:claude',
      lease: { active: true },
      contract: OK_CONTRACT,
    }),
    { start: true, reasons: [] },
  );
  // no lease → refused (a manual dispatch against an unclaimed issue)
  let r = evaluateBuildStart({
    issue: buildingIssue,
    requiredBuilder: 'builder:claude',
    lease: { active: false },
    contract: OK_CONTRACT,
  });
  assert.equal(r.start, false);
  assert.ok(r.reasons.some((x) => x.code === 'START_LEASE_MISSING'));
  // not status:building → refused
  r = evaluateBuildStart({
    issue: readyIssue(),
    requiredBuilder: 'builder:claude',
    lease: { active: true },
    contract: OK_CONTRACT,
  });
  assert.equal(r.start, false);
  assert.ok(r.reasons.some((x) => x.code === 'START_NOT_BUILDING'));
  // contract went bad mid-flight → refused
  r = evaluateBuildStart({
    issue: buildingIssue,
    requiredBuilder: 'builder:claude',
    lease: { active: true },
    contract: { baselineFound: true, invalid: null, amended: true },
  });
  assert.equal(r.start, false);
  assert.ok(r.reasons.some((x) => x.code === 'START_CONTRACT_INVALID'));
});

// ---------------------------------------------------------------------------
// Y6 — review-thread completeness
// ---------------------------------------------------------------------------

test('Y6: thread 101 (page 2) is counted — one unresolved beyond the first page blocks', () => {
  const page1 = {
    nodes: Array.from({ length: 100 }, () => ({ isResolved: true })),
    pageInfo: { hasNextPage: true, endCursor: 'c1' },
  };
  const page2 = {
    nodes: [{ isResolved: false }],
    pageInfo: { hasNextPage: false, endCursor: null },
  };
  assert.deepEqual(foldReviewThreadPages([page1, page2]), { unresolved: 1, complete: true });
  // …and through the evaluator: that one thread blocks the merge.
  const s = validState();
  s.unresolvedThreads = 1;
  expectBlock(s, 'THREADS_UNRESOLVED');
});

test('Y6: an unexhausted or malformed listing is UNPROVABLE — never "0 unresolved"', () => {
  // last page still claims more
  assert.deepEqual(
    foldReviewThreadPages([
      { nodes: [{ isResolved: true }], pageInfo: { hasNextPage: true, endCursor: 'c' } },
    ]),
    { unresolved: null, complete: false },
  );
  // malformed node payload
  assert.deepEqual(
    foldReviewThreadPages([{ nodes: [{ isResolved: 'yes' }], pageInfo: { hasNextPage: false } }]),
    { unresolved: null, complete: false },
  );
  // missing nodes array / empty response
  assert.deepEqual(foldReviewThreadPages([{ pageInfo: { hasNextPage: false } }]), {
    unresolved: null,
    complete: false,
  });
  assert.deepEqual(foldReviewThreadPages([]), { unresolved: null, complete: false });
  assert.deepEqual(foldReviewThreadPages(null), { unresolved: null, complete: false });
});

// ---------------------------------------------------------------------------
// X8 — Gemini runtime integration: only the pinned action's known
// runtime files are tolerated as untracked
// ---------------------------------------------------------------------------

test('X8: the pinned action runtime files pass the integrity allowlist', () => {
  const r = geminiRuntimeUntrackedAllowed([
    '.gemini/settings.json',
    '.gemini/commands/review.toml',
    '.gemini/commands/nested/cmd.toml',
    '.gemini/telemetry.log',
    'gemini-artifacts/stdout.log',
    'gemini-artifacts/stderr.log',
  ]);
  assert.deepEqual(r, { ok: true, unexpected: [] });
});

test('X8: anything else untracked fails — .gemini is never a blanket exemption', () => {
  const r = geminiRuntimeUntrackedAllowed([
    '.gemini/settings.json',
    '.gemini/evil.sh',
    'packages/core/src/backdoor.ts',
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unexpected, ['.gemini/evil.sh', 'packages/core/src/backdoor.ts']);
});

test('X8/Y5 WORKFLOW: both Gemini lanes pin gemini_cli_version (never latest); the reviewer lane checks tracked files and the allowlist', () => {
  const plannerYml = readFileSync(join(WORKFLOWS_DIR, 'agent-gemini-planner.yml'), 'utf8');
  for (const [name, yml] of [
    ['gates', gatesYml],
    ['planner', plannerYml],
  ]) {
    const m = yml.match(/gemini_cli_version:\s*(\S+)/);
    assert.ok(m, `${name} must pin gemini_cli_version`);
    assert.notEqual(m[1], 'latest', `${name} must never review under latest`);
    assert.ok(/^\d+\.\d+\.\d+$/.test(m[1]), `${name} pin must be an exact semver`);
  }
  const stage = jobBlock(gatesYml, 'acceptance_ai');
  assert.ok(
    stage.includes('--untracked-files=no') && stage.includes('geminiRuntimeUntrackedAllowed'),
    'the acceptance lane must check tracked changes strictly and untracked paths against the tested allowlist',
  );
});

// ---------------------------------------------------------------------------
// workflow_dispatch trust — non-main refs are refused everywhere
// ---------------------------------------------------------------------------

test('trustedDispatchRefAllowed: refs/heads/main only', () => {
  assert.equal(trustedDispatchRefAllowed('refs/heads/main'), true);
  for (const ref of [
    'refs/heads/feature/evil',
    'refs/tags/main',
    'refs/heads/main2',
    'main',
    '',
    undefined,
  ]) {
    assert.equal(trustedDispatchRefAllowed(ref), false, `${ref} must be refused`);
  }
});

test('WORKFLOW: every privileged workflow_dispatch path refuses non-main refs explicitly', () => {
  for (const f of [
    'agent-gates.yml',
    'agent-contract-authority.yml',
    'agent-claude.yml',
    'agent-codex-lane.yml',
    'agent-gemini-planner.yml',
  ]) {
    const yml = readFileSync(join(WORKFLOWS_DIR, f), 'utf8');
    assert.ok(
      yml.includes('Refuse non-main dispatch refs') && yml.includes('refs/heads/main'),
      `${f} must reject non-main dispatch refs before anything privileged`,
    );
  }
});

// ---------------------------------------------------------------------------
// X6 — the dedicated Gate Publisher App source-identity model
// ---------------------------------------------------------------------------

test('X6: the dedicated App slug is the adopted identity; only the three writer jobs (and the barrier) hold the credential', () => {
  assert.equal(GATE_PUBLISHER_APP_SLUG, 'rekoda-gate-publisher');
  const envRefs = gatesYml.split('environment: agents-gate-publisher').length - 1;
  assert.equal(envRefs, 3, 'exactly ambiguity_revoke + invalidate + finalize in the gates');
  for (const job of ['technical_ai', 'acceptance_ai', 'technical', 'acceptance', 'resolve']) {
    assert.ok(
      !jobBlock(gatesYml, job).includes('agents-gate-publisher'),
      `${job} must never receive the gate-publisher credential`,
    );
  }
});
