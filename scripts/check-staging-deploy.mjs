/**
 * The automatic staging deployment stays the runbook's deployment.
 *
 * .github/workflows/deploy-staging.yml hands the staging host
 * scripts/deploy-staging.sh, which performs docs/runbooks/deploy.md "Deploy a
 * release" for one exact commit. Three files, one procedure: this guard fails
 * CI when they drift apart, and when either automated file loses one of the
 * properties that make an unattended deploy safe (only after CI passed on
 * main, one at a time, a pinned host key, no secret in the repository, no
 * destructive command, staging only).
 *
 * Adding, removing or reordering a command in the runbook's "Deploy a
 * release" block fails here until STEPS below, and the script, say the same.
 *
 * Fixtures: check-staging-deploy.test.mjs, run in CI before this guard.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';

export const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

export const FILES = {
  runbook: 'docs/runbooks/deploy.md',
  script: 'scripts/deploy-staging.sh',
  workflow: '.github/workflows/deploy-staging.yml',
  ci: '.github/workflows/ci.yml',
};

/** The only secrets the workflow may read, all from the staging environment. */
export const ALLOWED_SECRETS = [
  'STAGING_HOST',
  'STAGING_KNOWN_HOSTS',
  'STAGING_SSH_PRIVATE_KEY',
  'STAGING_USER',
];
export const ENVIRONMENT = 'staging';
export const STAGING_API = 'https://staging-api.myrekoda.com';

/**
 * The runbook's "Deploy a release" block, command line by command line, and
 * the line in the script that performs it. The runbook deploys a tag and the
 * script a commit, so each pair is matched by meaning, not by text.
 */
export const STEPS = [
  {
    name: 'work in the checkout',
    runbook: /^cd \/opt\/rekoda$/,
    script: /^cd "\$REKODA_DIR"$/,
  },
  {
    name: 'fetch, then check out the release',
    runbook: /^git fetch\b.*&& git checkout\b/,
    script: /^git fetch --prune origin$/,
    then: /^git -c advice\.detachedHead=false checkout -q --detach "\$SHA"$/,
  },
  {
    name: 'set REKODA_RELEASE in .env',
    runbook: /^sed -i 's\/\^REKODA_RELEASE=\.\*\/REKODA_RELEASE=[^/]+\/' \.env$/,
    script: /^sed -i "s\/\^REKODA_RELEASE=\.\*\/REKODA_RELEASE=\$\{RELEASE\}\/" \.env$/,
  },
  {
    name: 'build with the commit',
    runbook: /^dc build --build-arg REKODA_COMMIT=/,
    script: /^dc build --build-arg REKODA_COMMIT="\$SHORT"$/,
  },
  {
    name: 'migrate as the owner',
    runbook: /^dc run --rm -T migrate$/,
    script: /^dc run --rm -T migrate$/,
  },
  {
    name: 'start the release and wait for health',
    runbook: /^dc up -d --wait$/,
    script: /^timeout \d+ dc up -d --wait --wait-timeout \d+$/,
  },
  {
    name: 'reload the Caddyfile',
    runbook: /^dc exec caddy caddy reload --config \/etc\/caddy\/Caddyfile$/,
    script: /^dc exec -T caddy caddy reload --config \/etc\/caddy\/Caddyfile$/,
  },
  {
    name: 'read /health',
    runbook: /^curl -fsS https:\/\/<api host>\/health$/,
    script: /^\s*if health=\$\(curl -fsS --max-time \d+ "\$API_URL\/health"\)/,
  },
];

/** What an unattended deploy must never run (each is in the runbook's never list, or worse). */
const SCRIPT_FORBIDDEN = [
  [/\bdown\b.*(\s-v\b|--volumes)/, 'deletes the database and the certificates (`down -v`)'],
  [
    /\b(image|system|builder|volume|container) prune\b|\bdocker rmi\b|\bimage rm\b/,
    'removes images, and with them the rollback',
  ],
  [/\bgit pull\b/, 'deploys whatever main is now, not the commit CI passed'],
  [/\breset --hard\b|\bgit clean\b|\bstash\b/, 'discards changes on the host instead of refusing'],
  [/--no-deps|--scale\b/, 'can start Caddy past the edge check (G-74)'],
  [/\bset -x\b|\bxtrace\b/, 'echoes every command, and so anything it expands'],
  [/secrets\//, 'touches secrets/, which the deploy never needs'],
];

const codeLines = (text) =>
  text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '' && !/^\s*#/.test(line));

/** The fenced bash block under "## Deploy a release", commands only. */
export function runbookDeployBlock(runbook) {
  const section = runbook.split(/^## /m).find((s) => s.startsWith('Deploy a release\n'));
  if (!section) return null;
  const block = section.match(/```bash\n([\s\S]*?)```/);
  if (!block) return null;
  return codeLines(block[1]).map((line) => line.replace(/\s+#.*$/, '').trim());
}

/**
 * The rollback baseline. PREV_SHA and PREV_RELEASE are the rollback a failed
 * run prints, so before anything changes the script must prove staging is
 * running them: /health healthy, naming PREV_RELEASE and a commit of at least
 * seven characters that PREV_SHA starts with, or the deploy is refused.
 */
const BASELINE_CALL = /^running=\$\(curl -fsS\b[^)]*"\$API_URL\/health"\) \|\|$/;
const BASELINE_REQUIRES = [
  [/--arg pr "\$PREV_RELEASE"/, 'hands it PREV_RELEASE'],
  [/--arg ps "\$PREV_SHA"/, 'hands it PREV_SHA'],
  [/\.status == "ok"/, 'requires status ok'],
  [/\.database == "up"/, 'requires database up'],
  [/\.release == \$pr\b/, 'requires the running release to be PREV_RELEASE'],
  [/\(\$c \| length\) >= 7/, 'requires a commit of at least seven characters'],
  [/\(\$ps \| startswith\(\$c\)\)/, 'requires PREV_SHA to start with the running commit'],
];
const BASELINE_BEFORE = [
  [/^PHASE=prepared$/, 'the prepared phase'],
  ...STEPS.slice(1).map((step) => [step.then ?? step.script, `"${step.name}"`]),
];

function baselineProblems(lines) {
  const problems = [];
  const at = lines.findIndex((line) => BASELINE_CALL.test(line));
  if (at < 0) {
    return [
      `${FILES.script} no longer checks /health for the running release before it deploys (the rollback baseline)`,
    ];
  }
  // The call's `|| fail`, then the jq test and its own `|| fail`.
  const block = lines.slice(at, at + 8);
  const end = block.findIndex((line, i) => i > 1 && /^\s*fail\b/.test(line));
  const check = (end < 0 ? block : block.slice(0, end + 1)).join('\n');
  if (!/^\s*fail\b/.test(lines[at + 1] ?? '')) {
    problems.push(`${FILES.script} must refuse the deploy when /health does not answer`);
  }
  if (end < 0 || !/^jq -e\b/.test(lines[at + 2] ?? '') || !/\|\|$/.test(block[end - 1])) {
    problems.push(
      `${FILES.script} must refuse the deploy when /health disagrees with the rollback baseline`,
    );
  }
  for (const [pattern, what] of BASELINE_REQUIRES) {
    if (!pattern.test(check))
      problems.push(`${FILES.script}'s rollback baseline no longer ${what}`);
  }
  for (const [pattern, what] of [
    [/^PREV_SHA=\$\(git rev-parse HEAD\)$/, 'PREV_SHA'],
    [/^PREV_RELEASE=\$\(sed -n 's\/\^REKODA_RELEASE=\/\/p' \.env\)$/, 'PREV_RELEASE'],
  ]) {
    const known = lines.findIndex((line) => pattern.test(line));
    if (known < 0 || known > at) {
      problems.push(`${FILES.script} checks the rollback baseline before it knows ${what}`);
    }
  }
  for (const [pattern, what] of BASELINE_BEFORE) {
    const change = lines.findIndex((line) => pattern.test(line));
    if (change >= 0 && change < at) {
      problems.push(`${FILES.script} checks the rollback baseline after ${what}`);
    }
  }
  return problems;
}

export function problemsFor({ runbook, script, workflow, ci }) {
  const problems = [];

  /* ---- The runbook and the script perform the same steps, in order. ---- */
  const block = runbookDeployBlock(runbook);
  if (!block) {
    problems.push(`${FILES.runbook} has no bash block under "## Deploy a release"`);
  } else {
    if (block.length !== STEPS.length) {
      problems.push(
        `${FILES.runbook} "Deploy a release" has ${block.length} commands and ${FILES.script} follows ${STEPS.length}; update STEPS in scripts/check-staging-deploy.mjs and the script together`,
      );
    }
    STEPS.forEach((step, i) => {
      if (!block[i] || !step.runbook.test(block[i])) {
        problems.push(
          `${FILES.runbook} "Deploy a release" command ${i + 1} is no longer "${step.name}" (found: ${block[i] ?? 'nothing'}); ${FILES.script} must follow it`,
        );
      }
    });
  }
  const lines = codeLines(script);
  let last = -1;
  for (const step of STEPS) {
    const at = lines.findIndex((line) => step.script.test(line));
    if (at < 0) {
      problems.push(`${FILES.script} does not perform "${step.name}" the way the runbook does`);
      continue;
    }
    if (at < last)
      problems.push(`${FILES.script} performs "${step.name}" out of the runbook's order`);
    last = at;
    if (step.then) {
      const next = lines.findIndex((line, j) => j > at && step.then.test(line));
      if (next < 0)
        problems.push(
          `${FILES.script} does not follow "${step.name}" with the exact commit's checkout`,
        );
      else last = next;
    }
  }

  /* ---- The script's own safety properties. ---- */
  const firstCode = lines.find((line) => !line.startsWith('#!'));
  if (!script.startsWith('#!/usr/bin/env bash\n') || firstCode !== 'set -Eeuo pipefail') {
    problems.push(`${FILES.script} must start with a bash shebang and then \`set -Eeuo pipefail\``);
  }
  for (const line of lines) {
    for (const [pattern, why] of SCRIPT_FORBIDDEN) {
      if (pattern.test(line)) problems.push(`${FILES.script}: \`${line.trim()}\` ${why}`);
    }
    if (/\bdocker compose\b/.test(line)) {
      const allowed =
        line === 'dc() { docker compose -f docker-compose.prod.yml "$@"; }' ||
        /^docker compose version\b/.test(line.trim());
      if (!allowed) {
        problems.push(
          `${FILES.script}: \`${line.trim()}\` calls compose directly; use dc, which names docker-compose.prod.yml alone`,
        );
      }
    }
    if (/\.env\b/.test(line)) {
      if (/\bsed -i\b/.test(line) && !/sed -i ["']s\/\^REKODA_RELEASE=\.\*\//.test(line)) {
        problems.push(
          `${FILES.script}: \`${line.trim()}\` edits .env beyond its REKODA_RELEASE line`,
        );
      }
      if (/>>?\s*\.env\b|\btee\b|\b(cp|mv|rm|install|truncate|chmod)\b[^|]*\.env\b/.test(line)) {
        problems.push(
          `${FILES.script}: \`${line.trim()}\` rewrites .env, which holds the host's secrets`,
        );
      }
    }
  }
  const scriptRequires = [
    [
      /^API_URL=https:\/\/staging-api\.myrekoda\.com$/m,
      `names ${STAGING_API} as the API it checks`,
    ],
    [/^REKODA_DIR=\/opt\/rekoda$/m, 'runs from /opt/rekoda'],
    [/\[\[ "\$SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/, 'accepts only a full 40-character SHA'],
    [
      /git status --porcelain --untracked-files=no/,
      'refuses a checkout with tracked local modifications',
    ],
    [
      /git merge-base --is-ancestor "\$SHA" origin\/main/,
      'refuses a commit that is not on origin/main',
    ],
    [/\[ "\$api_public" = "\$API_URL" \]/, "refuses a host whose .env is not staging's"],
    [/^RELEASE="staging-\$\{SHORT\}"$/m, 'names the release staging-<short sha>'],
    [/\bflock -n\b/, 'refuses a second deployment on the same host'],
    [/\.status == "ok"/, 'requires /health status ok'],
    [/\.database == "up"/, 'requires /health database up'],
    [/\.release == \$r/, 'requires /health to name the release'],
    [/\.commit == \$c/, 'requires /health to name the commit'],
    [/^dc ps$/m, 'prints the containers at the end'],
    // Parsed whole before it runs: the checkout rewrites the file under a
    // bash reading it from disk, and over SSH nothing is left on stdin for
    // compose or git to swallow.
    [/^set -Eeuo pipefail\n(\n|#.*\n)*\{\n/m, 'opens its body as one brace group'],
    [/\nexit 0\n\}\n$/, 'closes that brace group as its last line'],
  ];
  for (const [pattern, what] of scriptRequires) {
    if (!pattern.test(script)) problems.push(`${FILES.script} no longer ${what}`);
  }
  problems.push(...baselineProblems(lines));

  /* ---- The workflow. ---- */
  let wf;
  let ciName;
  try {
    wf = parse(workflow);
    ciName = parse(ci)?.name;
  } catch (error) {
    return [...problems, `a workflow does not parse: ${error.message}`];
  }
  const on = wf?.on ?? {};
  if (!isDeepStrictEqual(Object.keys(on).sort(), ['workflow_dispatch', 'workflow_run'])) {
    problems.push(
      `${FILES.workflow} must be triggered by workflow_run and workflow_dispatch only (found: ${Object.keys(on).join(', ') || 'none'})`,
    );
  }
  const run = on.workflow_run ?? {};
  if (!ciName || !isDeepStrictEqual(run.workflows, [ciName])) {
    problems.push(
      `${FILES.workflow} must follow the CI workflow by its name ("${ciName}") and nothing else`,
    );
  }
  if (!isDeepStrictEqual(run.types, ['completed']) || !isDeepStrictEqual(run.branches, ['main'])) {
    problems.push(`${FILES.workflow} must follow completed CI runs on main only`);
  }
  if (!wf?.concurrency?.group || wf.concurrency['cancel-in-progress'] !== false) {
    problems.push(
      `${FILES.workflow} must hold one workflow-level concurrency group that never cancels a running deploy`,
    );
  }
  for (const [scope, level] of Object.entries(wf?.permissions ?? {})) {
    if (level !== 'read' && level !== 'none') {
      problems.push(
        `${FILES.workflow} grants ${scope}: ${level}; a deploy needs to read, never write`,
      );
    }
  }
  if (!wf?.permissions) problems.push(`${FILES.workflow} must declare read-only permissions`);
  const jobs = Object.entries(wf?.jobs ?? {});
  if (jobs.length === 0) problems.push(`${FILES.workflow} has no job`);
  for (const [id, job] of jobs) {
    const env = typeof job.environment === 'string' ? job.environment : job.environment?.name;
    if (env !== ENVIRONMENT)
      problems.push(`${FILES.workflow} job ${id} must run in the "${ENVIRONMENT}" environment`);
    const cond = String(job.if ?? '');
    for (const needed of [
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
      'github.event.workflow_run.head_repository.full_name == github.repository',
    ]) {
      if (!cond.includes(needed))
        problems.push(`${FILES.workflow} job ${id} must require ${needed}`);
    }
    for (const step of job.steps ?? []) {
      if (typeof step.run === 'string' && step.run.includes('${{')) {
        problems.push(
          `${FILES.workflow} step "${step.name ?? step.run.slice(0, 40)}" pastes an expression into its script; pass it through env`,
        );
      }
    }
  }
  const secrets = [
    ...new Set([...workflow.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1])),
  ].sort();
  if (!isDeepStrictEqual(secrets, ALLOWED_SECRETS)) {
    problems.push(
      `${FILES.workflow} must read exactly ${ALLOWED_SECRETS.join(', ')} (found: ${secrets.join(', ') || 'none'}); every other secret stays on the host`,
    );
  }
  const workflowForbidden = [
    [/StrictHostKeyChecking\s*=?\s*(no|off|accept-new)\b/i, 'switches off host key verification'],
    [/UserKnownHostsFile\s*=?\s*\/dev\/null/, 'discards the pinned host key'],
    [/\bssh-keyscan\b/, 'learns the host key from the network instead of pinning it'],
    [/\bset -x\b|\bxtrace\b|ACTIONS_STEP_DEBUG/, 'echoes commands, and so what they expand'],
    [/\bgit pull\b/, 'deploys whatever main is now, not the commit CI passed'],
    [
      /docker-compose\.prod\.yml|docker compose/,
      'drives the stack itself; the host script does that',
    ],
  ];
  for (const [pattern, why] of workflowForbidden) {
    if (pattern.test(workflow)) problems.push(`${FILES.workflow} ${why}`);
  }
  const workflowRequires = [
    [/StrictHostKeyChecking=yes/, 'insists on the pinned host key'],
    [/github\.event\.workflow_run\.head_sha/, 'deploys the exact commit CI ran on'],
    [
      /<scripts\/deploy-staging\.sh$/m,
      "hands the host this commit's copy of scripts/deploy-staging.sh",
    ],
  ];
  for (const [pattern, what] of workflowRequires) {
    if (!pattern.test(workflow)) problems.push(`${FILES.workflow} no longer ${what}`);
  }

  /* ---- Staging only: every Rekoda hostname either file names is a staging one. ---- */
  for (const [key, text] of [
    ['script', script],
    ['workflow', workflow],
  ]) {
    for (const [host] of text.matchAll(/[a-z0-9.-]*myrekoda\.com/gi)) {
      if (!/^staging[.-]/i.test(host))
        problems.push(`${FILES[key]} names ${host}, which is not a staging host`);
    }
  }

  /* ---- The runbook documents the automation. ---- */
  for (const path of [FILES.script, FILES.workflow]) {
    if (!runbook.includes(path)) problems.push(`${FILES.runbook} must document ${path}`);
  }
  return problems;
}

export function readFiles(root = ROOT) {
  return Object.fromEntries(
    Object.entries(FILES).map(([key, path]) => [key, readFileSync(join(root, path), 'utf8')]),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = problemsFor(readFiles());
  if (problems.length > 0) {
    console.error('Staging deployment out of step:');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(
    `Staging deployment OK: ${FILES.workflow} and ${FILES.script} follow ${FILES.runbook} "Deploy a release".`,
  );
}
