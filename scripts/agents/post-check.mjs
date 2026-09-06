#!/usr/bin/env node
/**
 * Publishes a stable-named check run bound to an exact commit SHA via the
 * Checks API — UPSERTING in place: if a check run with this name already
 * exists on the SHA (GitHub's list endpoint defaults to filter=latest,
 * one per name+app), it is PATCHed rather than duplicated, so one
 * name+SHA normally never carries duplicate same-name conclusions and a
 * same-HEAD contract-revision redispatch deterministically flips the
 * SAME required check rather than racing a duplicate. The single
 * exception is the degraded revocation path (see below): when the
 * lookup fails after retries and the conclusion is NON-GREEN, a newer
 * run is posted blind — GitHub's newest-run-per-(name,app) semantics
 * make it govern, so an unreachable old green can never stay
 * merge-authorizing. Requires checks: write.
 *
 *   node scripts/agents/post-check.mjs --repo o/n --name "Technical Review Gate" \
 *     --sha <head> --conclusion success|failure|neutral --title "…" --summary "…"
 */
import { execFileSync } from 'node:child_process';
import { chooseCheckAction } from './evaluator.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const { repo, name, sha, conclusion } = args;
if (
  !repo ||
  !name ||
  !/^[0-9a-f]{40}$/i.test(sha ?? '') ||
  !['success', 'failure', 'neutral'].includes(conclusion)
) {
  console.error(
    'Usage: post-check.mjs --repo o/n --name N --sha <40hex> --conclusion success|failure|neutral [--title T --summary S]',
  );
  process.exit(2);
}

const gh = (ghArgs) => execFileSync('gh', ghArgs, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

// Fail-closed upsert decision (chooseCheckAction — the asymmetry is
// deliberate): with a healthy lookup, upsert in place (only a
// GitHub-Actions-app run is adopted as "ours"); when the lookup fails
// after retries, a SUCCESS write ABORTS (a missing green already blocks
// the merge — never risk an ambiguous duplicate green), while a
// NON-GREEN write POSTs BLIND: a revocation must never be abandoned
// because a READ failed while an old same-HEAD green stays
// merge-authorizing. GitHub evaluates the MOST RECENT run per
// (name, app), so the blind-posted newer non-green run governs, and the
// next healthy upsert PATCHes that latest run.
let lookupOk = false;
let runs = [];
let lastErr = '';
for (let attempt = 1; attempt <= 3 && !lookupOk; attempt++) {
  try {
    const list = JSON.parse(
      gh([
        'api',
        `repos/${repo}/commits/${sha.toLowerCase()}/check-runs?check_name=${encodeURIComponent(name)}&per_page=10`,
      ]),
    );
    runs = (list.check_runs ?? []).map((c) => ({ id: c.id, name: c.name, appSlug: c.app?.slug }));
    lookupOk = true;
  } catch (e) {
    lastErr = e.message;
    console.error(
      `::warning::Check-run lookup attempt ${attempt}/3 failed for '${name}' on ${sha}: ${e.message}`,
    );
  }
}

const decision = chooseCheckAction({ lookupOk, runs, name, conclusion });
if (decision.action === 'abort') {
  console.error(
    `::error::Refusing to publish ${conclusion} for '${name}' without a provable current state (${decision.reason}; last error: ${lastErr}); the required check stays non-green — fail closed, not fail duplicate-passing.`,
  );
  process.exit(1);
}
if (decision.degraded) {
  console.error(
    `::warning::Lookup for '${name}' on ${sha} failed (${lastErr}) — posting the ${conclusion} conclusion BLIND so the revocation lands; the newest run per name+app governs.`,
  );
}
const existingId = decision.action === 'patch' ? decision.id : null;

const fields = [
  '-f',
  `status=completed`,
  '-f',
  `conclusion=${conclusion}`,
  '-f',
  `output[title]=${(args.title ?? name).slice(0, 250)}`,
  '-f',
  `output[summary]=${(args.summary ?? '').slice(0, 60000)}`,
];
if (existingId) {
  gh(['api', '--method', 'PATCH', `repos/${repo}/check-runs/${existingId}`, ...fields]);
  console.log(`Check '${name}' → ${conclusion} on ${sha} (updated in place, id ${existingId}).`);
} else {
  gh([
    'api',
    '--method',
    'POST',
    `repos/${repo}/check-runs`,
    '-f',
    `name=${name}`,
    '-f',
    `head_sha=${sha.toLowerCase()}`,
    ...fields,
  ]);
  console.log(`Check '${name}' → ${conclusion} on ${sha} (created).`);
}
