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
  const lines = [kind, `ISSUE: ${issue}`, `REVISION: ${revision}`, `BODY_SHA256: ${m.bodySha256}`];
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
      everLabeledAgent: true,
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

test('contract-authority-signed and owner-authored revisions ARE authorized', () => {
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
  s.pr.everLabeledAgent = false;
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
      id: 2,
    }),
    contractComment({
      kind: 'REKODA_CONTRACT_REVISION',
      revision: 2,
      body: ISSUE_BODY + '\nB',
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
    contractComment({ kind: 'REKODA_CONTRACT_REVISION', revision: 3, body: newBody, id: 2 }),
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
        id: 2,
        createdAt: 'y',
      }),
      contractComment({ id: 3, createdAt: 'z' }), // baseline reposted later (same rev-1 hash)
    ],
    ownerLogin: OWNER,
    contractAuthorityKey: null,
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
