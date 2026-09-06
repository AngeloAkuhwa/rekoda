#!/usr/bin/env node
/**
 * The deterministic merge-policy evaluator for the autonomous engineering
 * control plane (docs/AUTONOMOUS-ENGINEERING.md §6, AGENTS.md §8–§9).
 *
 * PURE: no network, no filesystem, no environment. It takes normalized
 * GitHub state (scripts/agents/normalize.mjs produces it) and returns
 * PASS or BLOCK with machine-readable reasons. Every workflow gate calls
 * this module instead of reimplementing policy in shell, and
 * evaluator.test.mjs proves the negative cases fail CLOSED.
 *
 * Untrusted text (PR bodies, issue bodies, comments, review bodies) is
 * parsed here as data with anchored line grammars — never interpolated
 * into a shell.
 */
import { createHash } from 'node:crypto';

export const MARKERS = {
  codex: 'REKODA_CODEX_APPROVAL',
  claude: 'REKODA_CLAUDE_APPROVAL',
  gemini: 'REKODA_GEMINI_APPROVAL',
};

const SHA40 = /^[0-9a-f]{40}$/;
const RISK_RE = /^risk:R[0-3]$/;
const BUILDER_RE = /^builder:(claude|codex)$/;

// ---------------------------------------------------------------------------
// Text parsing (all input is untrusted data)
// ---------------------------------------------------------------------------

export function normalizeBody(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Closing references in a PR body: Closes/Fixes/Resolves #N. */
export function parseClosingRefs(body) {
  const refs = new Set();
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d{1,7})\b/gi;
  for (const m of normalizeBody(body).matchAll(re)) refs.add(Number(m[1]));
  return [...refs];
}

/**
 * Parse fixed-format approval marker blocks out of free text. A block is:
 *   <MARKER NAME>
 *   PR: <n>
 *   ISSUE: <n>
 *   HEAD_SHA: <40 hex>
 *   CONTRACT_REVISION: <n>
 *   VERDICT: APPROVE|BLOCK
 * Field order after the name is not significant; a block ends at VERDICT,
 * at the next marker name, or after 8 lines. Anything that starts a block
 * but does not parse completely is returned with malformed: true — a
 * malformed marker never counts as approval.
 */
export function parseMarkers(text, markerName) {
  const lines = normalizeBody(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== markerName) continue;
    const fields = {};
    let consumed = 0;
    for (let j = i + 1; j < lines.length && consumed < 8; j++, consumed++) {
      const line = lines[j].trim();
      if (line === markerName) break;
      const m = line.match(/^(PR|ISSUE|HEAD_SHA|CONTRACT_REVISION|VERDICT):\s*(.*)$/);
      if (m) fields[m[1]] = m[2].trim();
      if (m && m[1] === 'VERDICT') break;
    }
    const pr = /^\d{1,7}$/.test(fields.PR ?? '') ? Number(fields.PR) : null;
    const issue = /^\d{1,7}$/.test(fields.ISSUE ?? '') ? Number(fields.ISSUE) : null;
    const headSha = SHA40.test((fields.HEAD_SHA ?? '').toLowerCase())
      ? fields.HEAD_SHA.toLowerCase()
      : null;
    const contractRevision = /^\d{1,4}$/.test(fields.CONTRACT_REVISION ?? '')
      ? Number(fields.CONTRACT_REVISION)
      : null;
    const verdict =
      fields.VERDICT === 'APPROVE' || fields.VERDICT === 'BLOCK' ? fields.VERDICT : null;
    const malformed =
      pr === null ||
      issue === null ||
      headSha === null ||
      contractRevision === null ||
      verdict === null;
    out.push({ pr, issue, headSha, contractRevision, verdict, malformed });
  }
  return out;
}

/**
 * Contract-revision markers on the ISSUE (docs/AUTONOMOUS-ENGINEERING.md §6):
 *   REKODA_CONTRACT_BASELINE            REKODA_CONTRACT_REVISION
 *   ISSUE: <n>                          ISSUE: <n>
 *   REVISION: 1                         REVISION: <k>
 *   BODY_SHA256: <64 hex>               BODY_SHA256: <64 hex>
 *                                       REASON: <one line>
 */
export function parseRevisionMarkers(text) {
  const lines = normalizeBody(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].trim();
    if (name !== 'REKODA_CONTRACT_BASELINE' && name !== 'REKODA_CONTRACT_REVISION') continue;
    const fields = {};
    for (let j = i + 1; j < Math.min(i + 7, lines.length); j++) {
      const m = lines[j].trim().match(/^(ISSUE|REVISION|BODY_SHA256|REASON):\s*(.*)$/);
      if (m) fields[m[1]] = m[2].trim();
    }
    const issue = /^\d{1,7}$/.test(fields.ISSUE ?? '') ? Number(fields.ISSUE) : null;
    const revision = /^\d{1,4}$/.test(fields.REVISION ?? '') ? Number(fields.REVISION) : null;
    const bodySha256 = /^[0-9a-f]{64}$/.test((fields.BODY_SHA256 ?? '').toLowerCase())
      ? fields.BODY_SHA256.toLowerCase()
      : null;
    out.push({
      kind: name,
      issue,
      revision,
      bodySha256,
      reason: fields.REASON ?? '',
      malformed: issue === null || revision === null || bodySha256 === null,
    });
  }
  return out;
}

/**
 * Compute the issue's current contract revision from its comments.
 * Only markers authored by an authorized identity count. Fail closed:
 * no baseline → revision unknown; current body hash differing from the
 * highest-revision marker's recorded hash → unauthorized amendment.
 */
export function computeContractRevision({
  issueNumber,
  issueBody,
  issueComments,
  authorizedAuthors,
}) {
  const authorized = new Set(authorizedAuthors ?? []);
  const markers = [];
  for (const c of issueComments ?? []) {
    if (!authorized.has(c.author)) continue;
    for (const m of parseRevisionMarkers(c.body)) {
      if (!m.malformed && m.issue === issueNumber) markers.push(m);
    }
  }
  if (markers.length === 0) {
    return { revision: null, baselineFound: false, amended: false };
  }
  let top = markers[0];
  for (const m of markers) if (m.revision >= top.revision) top = m;
  const currentHash = sha256Hex(normalizeBody(issueBody));
  return {
    revision: top.revision,
    baselineFound: true,
    amended: currentHash !== top.bodySha256,
    expectedHash: top.bodySha256,
    currentHash,
  };
}

/**
 * Pick the governing verdict from marker-bearing candidates.
 * candidates: [{ author, body, createdAt }] in ascending createdAt order.
 * The LATEST fully-valid marker from an expected identity for the exact
 * (pr, issue, headSha, revision) governs — an explicit later verdict for
 * the same target supersedes an earlier one (docs §7); an old BLOCK never
 * dominates a later APPROVE for the same HEAD/revision. Anything less
 * than fully valid never counts as approval; the diagnosis explains the
 * best near-miss.
 */
export function resolveVerdict({
  candidates,
  markerName,
  expectedAuthors,
  forbiddenAuthors,
  target,
}) {
  const expected = new Set(expectedAuthors ?? []);
  const forbidden = new Set(forbiddenAuthors ?? []);
  let governing = null;
  let diagnosis = 'missing'; // missing | stale | wrong_pr | wrong_issue | wrong_revision | malformed
  let selfReview = false;
  let wrongReviewer = false;
  for (const c of candidates ?? []) {
    const found = parseMarkers(c.body, markerName);
    if (found.length === 0) continue;
    if (forbidden.has(c.author)) {
      selfReview = true;
      continue;
    }
    if (!expected.has(c.author)) {
      wrongReviewer = true;
      continue;
    }
    for (const m of found) {
      if (m.malformed) {
        diagnosis = 'malformed';
        continue;
      }
      if (m.headSha !== target.headSha) {
        diagnosis = 'stale';
        continue;
      }
      if (m.pr !== target.pr) {
        diagnosis = 'wrong_pr';
        continue;
      }
      if (m.issue !== target.issue) {
        diagnosis = 'wrong_issue';
        continue;
      }
      if (m.contractRevision !== target.contractRevision) {
        diagnosis = 'wrong_revision';
        continue;
      }
      governing = m.verdict; // ascending order → latest valid wins
    }
  }
  return { verdict: governing, diagnosis, selfReview, wrongReviewer };
}

// ---------------------------------------------------------------------------
// Issue-form field extraction
// ---------------------------------------------------------------------------

/** Extract the content under a GitHub issue-form section heading. */
export function issueFormField(body, label) {
  const lines = normalizeBody(body).split('\n');
  const idx = lines.findIndex((l) =>
    l.trim().toLowerCase().startsWith(`### ${label.toLowerCase()}`),
  );
  if (idx === -1) return null;
  const content = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('### ')) break;
    content.push(lines[i]);
  }
  const value = content.join('\n').trim();
  return value === '' || value === '_No response_' ? null : value;
}

// ---------------------------------------------------------------------------
// The evaluation
// ---------------------------------------------------------------------------

function one(labels, re) {
  const hits = (labels ?? []).filter((l) => re.test(l));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Evaluate the merge policy. Returns { pass, reasons: [{code, message}] }.
 * `mode` filters which reason families this gate is responsible for:
 *   'full'       — everything (tests, and the reference semantics)
 *   'policy'     — everything except TECH_* / GEMINI_* (those are the two
 *                  dedicated required checks; branch protection composes)
 *   'technical'  — prerequisites + TECH_*
 *   'acceptance' — prerequisites + GEMINI_*
 */
export function evaluate(state, mode = 'full') {
  const reasons = [];
  const add = (code, message) => reasons.push({ code, message });
  const cfg = state.config ?? {};

  const prRisk = one(state.pr?.riskLabels, RISK_RE);
  const prBuilder = one(state.pr?.builderLabels, BUILDER_RE);
  if (!prRisk) add('RISK_LABEL_INVALID', 'The PR must carry exactly one risk:R0..R3 label.');
  if (!prBuilder)
    add(
      'BUILDER_LABEL_INVALID',
      'The PR must carry exactly one builder:claude|builder:codex label.',
    );

  // Authoritative linked issue.
  const refs = parseClosingRefs(state.prBody);
  let issue = null;
  if (refs.length === 0) {
    add('LINKED_ISSUE_MISSING', 'The PR body must close exactly one issue (e.g. "Closes #123").');
  } else if (refs.length > 1) {
    add(
      'LINKED_ISSUE_AMBIGUOUS',
      `The PR body closes ${refs.length} issues (${refs.join(', ')}); exactly one is required.`,
    );
  } else if (!state.issue || state.issue.number !== refs[0] || !state.issue.exists) {
    add('ISSUE_NOT_FOUND', `Linked issue #${refs[0]} could not be resolved.`);
  } else {
    issue = state.issue;
  }

  let revision = null;
  if (issue) {
    if (!issue.agentTask)
      add('ISSUE_NOT_AGENT_TASK', `Issue #${issue.number} is not labelled agent-task.`);
    const issueRisk = one(issue.riskLabels, RISK_RE);
    const issueBuilder = one(issue.builderLabels, BUILDER_RE);
    if (!issueRisk)
      add('ISSUE_RISK_INVALID', `Issue #${issue.number} must carry exactly one risk:R0..R3 label.`);
    if (!issueBuilder)
      add('ISSUE_BUILDER_INVALID', `Issue #${issue.number} must carry exactly one builder label.`);
    if (prRisk && issueRisk && prRisk !== issueRisk)
      add('RISK_MISMATCH', `PR risk ${prRisk} does not match issue risk ${issueRisk}.`);
    if (prBuilder && issueBuilder && prBuilder !== issueBuilder)
      add(
        'BUILDER_MISMATCH',
        `PR builder ${prBuilder} does not match issue builder ${issueBuilder}.`,
      );
    if (
      (issue.labels ?? []).some(
        (l) => l === 'needs-owner-decision' || l === 'status:blocked-decision',
      )
    )
      add('DECISION_STATE_INVALID', `Issue #${issue.number} has an unresolved owner decision.`);

    const rev = computeContractRevision({
      issueNumber: issue.number,
      issueBody: issue.body,
      issueComments: issue.comments,
      authorizedAuthors: cfg.authorizedRevisionAuthors,
    });
    if (!rev.baselineFound) {
      add(
        'CONTRACT_BASELINE_MISSING',
        `Issue #${issue.number} has no REKODA_CONTRACT_BASELINE marker; run scripts/agents/contract-revision.mjs --issue ${issue.number} --baseline.`,
      );
    } else if (rev.amended) {
      add(
        'CONTRACT_AMENDED_UNAUTHORIZED',
        `Issue #${issue.number} body was changed without an authorized REKODA_CONTRACT_REVISION marker (expected ${rev.expectedHash}, found ${rev.currentHash}).`,
      );
    } else {
      revision = rev.revision;
    }
  }

  const target =
    revision !== null && issue
      ? {
          pr: state.pr.number,
          issue: issue.number,
          headSha: state.pr.headSha,
          contractRevision: revision,
        }
      : null;

  // Technical review — builder-aware; the builder never satisfies it.
  if (prBuilder && target) {
    const tech =
      prBuilder === 'builder:claude'
        ? resolveVerdict({
            candidates: state.techEvidence?.candidates,
            markerName: MARKERS.codex,
            expectedAuthors: [cfg.codexLogin],
            forbiddenAuthors: cfg.claudeSideAuthors ?? [],
            target,
          })
        : resolveVerdict({
            candidates: state.techEvidence?.candidates,
            markerName: MARKERS.claude,
            expectedAuthors: cfg.trustedMarkerAuthors ?? [],
            forbiddenAuthors: [state.pr.author, cfg.codexLogin].filter(Boolean),
            target,
          });
    if (tech.verdict === 'BLOCK') {
      add('TECH_BLOCK', 'The technical reviewer BLOCKED this HEAD/revision.');
    } else if (tech.verdict !== 'APPROVE') {
      if (tech.selfReview)
        add(
          'TECH_SELF_REVIEW',
          'A technical-review marker from a builder-side identity was rejected; the builder never reviews itself.',
        );
      if (tech.wrongReviewer)
        add(
          'TECH_WRONG_REVIEWER',
          'A technical-review marker from an unexpected identity was rejected.',
        );
      const map = {
        stale: [
          'TECH_APPROVAL_STALE',
          `No technical verdict for the current HEAD ${state.pr.headSha}; the latest marker names an older commit.`,
        ],
        wrong_pr: ['TECH_WRONG_PR', 'The technical marker names a different PR.'],
        wrong_issue: ['TECH_WRONG_ISSUE', 'The technical marker names a different issue.'],
        wrong_revision: [
          'TECH_WRONG_REVISION',
          `The technical marker names a different contract revision (current: ${revision}).`,
        ],
        malformed: [
          'TECH_MALFORMED',
          'The technical marker is malformed; a malformed approval never counts.',
        ],
        missing: ['TECH_APPROVAL_MISSING', 'No technical-review verdict exists for this PR.'],
      };
      add(...map[tech.diagnosis]);
    }
  }

  // Gemini system acceptance — always required.
  if (target) {
    const gem = resolveVerdict({
      candidates: state.geminiEvidence?.candidates,
      markerName: MARKERS.gemini,
      expectedAuthors: cfg.trustedMarkerAuthors ?? [],
      forbiddenAuthors: [state.pr.author].filter(Boolean),
      target,
    });
    if (gem.verdict === 'BLOCK') {
      add('GEMINI_BLOCK', 'Gemini system acceptance BLOCKED this HEAD/revision.');
    } else if (gem.verdict !== 'APPROVE') {
      if (gem.selfReview)
        add('GEMINI_SELF_REVIEW', 'A Gemini marker from the builder was rejected.');
      if (gem.wrongReviewer)
        add('GEMINI_WRONG_REVIEWER', 'A Gemini marker from an unexpected identity was rejected.');
      const map = {
        stale: [
          'GEMINI_APPROVAL_STALE',
          `No Gemini acceptance for the current HEAD ${state.pr.headSha}.`,
        ],
        wrong_pr: ['GEMINI_WRONG_PR', 'The Gemini marker names a different PR.'],
        wrong_issue: ['GEMINI_WRONG_ISSUE', 'The Gemini marker names a different issue.'],
        wrong_revision: [
          'GEMINI_WRONG_REVISION',
          `The Gemini marker names a different contract revision (current: ${revision}).`,
        ],
        malformed: [
          'GEMINI_MALFORMED',
          'The Gemini marker is malformed; a malformed approval never counts.',
        ],
        missing: [
          'GEMINI_APPROVAL_MISSING',
          'No Gemini system-acceptance verdict exists for this PR.',
        ],
      };
      add(...map[gem.diagnosis]);
    }
  }

  // Review threads.
  if ((state.unresolvedThreads ?? 0) > 0)
    add('THREADS_UNRESOLVED', `${state.unresolvedThreads} unresolved review thread(s).`);

  // R3: recorded owner decision + owner approval of the current HEAD.
  if (prRisk === 'risk:R3') {
    if (issue && !issueFormField(issue.body, 'Owner decision reference'))
      add(
        'R3_OWNER_DECISION_MISSING',
        `Issue #${issue.number} records no owner decision reference; R3 requires one before implementation.`,
      );
    const ownerApproved = (state.ownerReviews ?? []).some(
      (r) =>
        r.author === cfg.ownerLogin && r.state === 'APPROVED' && r.commitId === state.pr.headSha,
    );
    if (!ownerApproved)
      add(
        'R3_OWNER_APPROVAL_MISSING',
        `R3 requires @${cfg.ownerLogin}'s approving review of HEAD ${state.pr.headSha} (fresh after every push). This is additive — it never substitutes for the peer technical review.`,
      );
  }

  // Optional CI evidence (branch protection normally owns this).
  if (state.ci && state.ci.complete === false)
    add('CI_INCOMPLETE', 'Required CI evidence is missing or incomplete.');

  const filtered = filterByMode(reasons, mode);
  return { pass: filtered.length === 0, reasons: filtered };
}

const PREREQ_CODES = new Set([
  'RISK_LABEL_INVALID',
  'BUILDER_LABEL_INVALID',
  'LINKED_ISSUE_MISSING',
  'LINKED_ISSUE_AMBIGUOUS',
  'ISSUE_NOT_FOUND',
  'ISSUE_NOT_AGENT_TASK',
  'ISSUE_RISK_INVALID',
  'ISSUE_BUILDER_INVALID',
  'RISK_MISMATCH',
  'BUILDER_MISMATCH',
  'DECISION_STATE_INVALID',
  'CONTRACT_BASELINE_MISSING',
  'CONTRACT_AMENDED_UNAUTHORIZED',
]);

function filterByMode(reasons, mode) {
  if (mode === 'full') return reasons;
  const isTech = (c) => c.startsWith('TECH_');
  const isGem = (c) => c.startsWith('GEMINI_');
  if (mode === 'policy') return reasons.filter((r) => !isTech(r.code) && !isGem(r.code));
  if (mode === 'technical')
    return reasons.filter((r) => isTech(r.code) || PREREQ_CODES.has(r.code));
  if (mode === 'acceptance')
    return reasons.filter((r) => isGem(r.code) || PREREQ_CODES.has(r.code));
  throw new Error(`Unknown mode: ${mode}`);
}
