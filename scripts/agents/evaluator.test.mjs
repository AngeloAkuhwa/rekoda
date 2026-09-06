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
  SCHEME,
} from './evaluator.mjs';

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

/** Build a verdict marker body; sign with `key` unless key === null. */
function marker(
  name,
  {
    pr = 55,
    issue = 44,
    head = HEAD,
    rev = 1,
    verdict = 'APPROVE',
    key = undefined,
    dropSig = false,
  } = {},
) {
  const m = { name, pr, issue, headSha: head, contractRevision: rev, verdict };
  const lines = [
    `${name}`,
    `SCHEME: ${SCHEME}`,
    `PR: ${pr}`,
    `ISSUE: ${issue}`,
    `HEAD_SHA: ${head}`,
    `CONTRACT_REVISION: ${rev}`,
    `VERDICT: ${verdict}`,
  ];
  if (!dropSig && key) lines.push(`SIGNATURE: ${signWith(key, canonicalVerdictPayload(m))}`);
  return `Review done.\n\n${lines.join('\n')}\n`;
}

/** Contract marker comment; authorized by owner authorship or a signature. */
function contractComment({
  kind = 'REKODA_CONTRACT_BASELINE',
  issue = 44,
  revision = 1,
  body = ISSUE_BODY,
  reason = 'scope change',
  author = OWNER,
  key = null,
  createdAt = '2026-09-01T00:00:00Z',
  id = 1,
} = {}) {
  const m = { kind, issue, revision, bodySha256: sha256Hex(normalizeBody(body)), reason };
  const lines = [
    kind,
    `SCHEME: ${SCHEME}`,
    `ISSUE: ${issue}`,
    `REVISION: ${revision}`,
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
      comments: [contractComment()],
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
  s.techEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: '2026-09-02T00:00:00Z',
      id: 11,
      body: marker(MARKERS.claude, { key: CLAUDE_KEY }),
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

test('valid owner-authorized R3 passes only with decision reference AND owner approval of HEAD', () => {
  const s = validState();
  s.pr.riskLabels = ['risk:R3'];
  s.issue.riskLabels = ['risk:R3'];
  s.issue.body = ISSUE_BODY.replace('_No response_', 'docs/REKODA_OWNER_DECISIONS.md OWN-15');
  s.issue.comments = [contractComment({ body: s.issue.body })];
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
  // approvals still bind revision 1 → invalidated without any push
  const r = evaluate(s);
  assert.equal(r.pass, false);
  assert.ok(codes(r).includes('TECH_WRONG_REVISION') && codes(r).includes('GEMINI_WRONG_REVISION'));
  // fresh verdicts for revision 2 pass again
  s.techEvidence.candidates.push(
    codexReview({ id: 12, createdAt: 'z', body: marker(MARKERS.codex, { rev: 2 }) }),
  );
  s.geminiEvidence.candidates.push({
    author: ACTIONS,
    kind: 'comment',
    createdAt: 'z',
    id: 21,
    body: marker(MARKERS.gemini, { rev: 2, key: GEMINI_KEY }),
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

test('15g. contradictory contemporaneous verdicts across id domains fail closed', () => {
  const t = '2026-09-02T00:00:00Z';
  const s = codexBuiltState();
  s.techEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: t,
      id: 5,
      body: marker(MARKERS.claude, { key: CLAUDE_KEY, verdict: 'APPROVE' }),
    },
    {
      author: ACTIONS,
      kind: 'review',
      createdAt: t,
      id: 999999,
      body: marker(MARKERS.claude, { key: CLAUDE_KEY, verdict: 'BLOCK' }),
    },
  ];
  expectBlock(s, 'TECH_AMBIGUOUS_ORDER');
});

test('15h. contemporaneous agreeing verdicts across domains are fine; a later one still governs', () => {
  const t = '2026-09-02T00:00:00Z';
  const s = codexBuiltState();
  s.techEvidence.candidates = [
    {
      author: ACTIONS,
      kind: 'comment',
      createdAt: t,
      id: 5,
      body: marker(MARKERS.claude, { key: CLAUDE_KEY }),
    },
    {
      author: ACTIONS,
      kind: 'review',
      createdAt: t,
      id: 999999,
      body: marker(MARKERS.claude, { key: CLAUDE_KEY }),
    },
  ];
  assert.equal(evaluate(s).pass, true);
  s.techEvidence.candidates.push({
    author: ACTIONS,
    kind: 'comment',
    createdAt: '2026-09-03T00:00:00Z',
    id: 6,
    body: marker(MARKERS.claude, { key: CLAUDE_KEY, verdict: 'BLOCK' }),
  });
  expectBlock(s, 'TECH_BLOCK'); // clearly-later valid verdict wins
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

test('amendment transaction: publish only after EVERY linked PR is frozen', () => {
  const ok = amendmentTransaction({
    linkedPrs: [70, 73],
    freezeResults: { 70: true, 73: true },
    signOk: true,
    dispatchResults: { 70: true, 73: true },
  });
  assert.deepEqual(ok, {
    published: true,
    frozen: [70, 73],
    dispatched: [70, 73],
    stillBlocked: [],
  });
});

test('amendment transaction: a failed freeze forbids publication; frozen PRs stay safely blocked', () => {
  const r = amendmentTransaction({
    linkedPrs: [70, 73],
    freezeResults: { 70: true, 73: false },
    signOk: true,
    dispatchResults: {},
  });
  assert.equal(r.published, false);
  assert.deepEqual(r.frozen, [70]);
  assert.deepEqual(r.dispatched, []);
});

test('amendment transaction: freeze ok but signing fails → nothing published, PRs remain blocked, never re-green', () => {
  const r = amendmentTransaction({
    linkedPrs: [70],
    freezeResults: { 70: true },
    signOk: false,
    dispatchResults: {},
  });
  assert.equal(r.published, false);
  assert.deepEqual(r.frozen, [70]);
  assert.deepEqual(r.stillBlocked, [70]);
});

test('amendment transaction: dispatch failure after activation leaves the PR blocked (frozen), not green', () => {
  const r = amendmentTransaction({
    linkedPrs: [70, 73],
    freezeResults: { 70: true, 73: true },
    signOk: true,
    dispatchResults: { 70: true, 73: false },
  });
  assert.equal(r.published, true);
  assert.deepEqual(r.stillBlocked, [73]);
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
