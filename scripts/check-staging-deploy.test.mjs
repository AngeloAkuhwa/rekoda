/**
 * Fixtures for the staging deployment guard. Each case takes the real
 * runbook, script and workflows, breaks one rule the way a hurried edit
 * would, and names the problem the guard must report. Run with
 * `node --test scripts/check-staging-deploy.test.mjs` (CI does, before the
 * guard).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { problemsFor, readFiles } from './check-staging-deploy.mjs';

const REAL = readFiles();

function problems(edit = {}) {
  return problemsFor({ ...REAL, ...edit });
}
/** Replace `from` with `to` in one of the real files, insisting it was there. */
function edited(key, from, to) {
  assert.ok(REAL[key].includes(from), `fixture text not found in ${key}: ${from}`);
  return { [key]: REAL[key].replace(from, () => to) };
}
const expectProblem = (found, pattern) =>
  assert.ok(
    found.some((p) => pattern.test(p)),
    `expected a problem matching ${pattern}, got:\n  ${found.join('\n  ') || '(none)'}`,
  );

test('the committed staging deployment follows the runbook', () => {
  assert.deepEqual(problems(), []);
});

/* ---- runbook and script drift ---- */

test('a new command in the runbook, not in the script', () => {
  const edit = edited(
    'runbook',
    'dc run --rm -T migrate                                             # expand-only migrations, as the owner\n',
    'dc run --rm -T migrate                                             # expand-only migrations, as the owner\ndc run --rm -T backup\n',
  );
  expectProblem(problems(edit), /"Deploy a release" has 9 commands/);
});

test('a runbook command changed, the script left behind', () => {
  const edit = edited(
    'runbook',
    'dc exec caddy caddy reload --config /etc/caddy/Caddyfile            #',
    'dc exec caddy caddy reload --config /etc/caddy/Caddyfile --force    #',
  );
  expectProblem(problems(edit), /command 7 is no longer "reload the Caddyfile"/);
});

test('the script skipping the migrate job', () => {
  const edit = edited('script', '\ndc run --rm -T migrate\n', '\n');
  expectProblem(problems(edit), /does not perform "migrate as the owner"/);
});

test('the script starting the release before migrating', () => {
  const up = 'dc up -d --wait --wait-timeout 300\n';
  const moved = edited('script', up, '').script.replace(
    "step 'migrate (expand-only, as the owner)'\n",
    () => `${up}step 'migrate (expand-only, as the owner)'\n`,
  );
  expectProblem(
    problems({ script: moved }),
    /performs "start the release and wait for health" out of the runbook's order/,
  );
});

test('the script checking out something other than the exact commit', () => {
  const edit = edited('script', 'checkout -q --detach "$SHA"', 'checkout -q origin/main');
  expectProblem(problems(edit), /exact commit's checkout/);
});

/* ---- the script's safety properties ---- */

/* ---- the rollback baseline ---- */

const BASELINE_START = "step 'the running release is the rollback baseline'\n";
const BASELINE_END = "\nstep 'fetch and verify the commit'\n";
const baseline = () => {
  const from = REAL.script.indexOf(BASELINE_START);
  const to = REAL.script.indexOf(BASELINE_END);
  assert.ok(from > 0 && to > from, 'fixture: the baseline block is not where expected');
  return REAL.script.slice(from, to);
};

test('deploying without proving the running release', () => {
  const edit = edited('script', baseline(), '');
  expectProblem(problems(edit), /no longer checks \/health for the running release/);
});

test('proving the running release only after the checkout changed', () => {
  const block = baseline();
  const anchor = 'step "build both images';
  const without = edited('script', block, '').script;
  assert.ok(without.includes(anchor), `fixture text not found in script: ${anchor}`);
  const moved = without.replace(anchor, () => `${block}${anchor}`);
  expectProblem(
    problems({ script: moved }),
    /checks the rollback baseline after "fetch, then check out the release"/,
  );
  expectProblem(problems({ script: moved }), /checks the rollback baseline after the prepared/);
});

test('an unanswered /health not refusing the deploy', () => {
  const edit = edited(
    'script',
    '"$API_URL/health") ||\n  fail "$API_URL/health did not answer',
    '"$API_URL/health") ||\n  echo "$API_URL/health did not answer',
  );
  expectProblem(problems(edit), /must refuse the deploy when \/health does not answer/);
});

test('a disagreeing /health not refusing the deploy', () => {
  const edit = edited(
    'script',
    '<<<"$running" >/dev/null ||\n  fail "$API_URL/health reports',
    '<<<"$running" >/dev/null ||\n  echo "$API_URL/health reports',
  );
  expectProblem(problems(edit), /must refuse the deploy when \/health disagrees/);
});

for (const [from, to, pattern] of [
  ['.status == "ok" and .database', '.database', /baseline no longer requires status ok/],
  ['.database == "up" and .release', '.release', /baseline no longer requires database up/],
  [
    ' and .release == $pr\n',
    '\n',
    /baseline no longer requires the running release to be PREV_RELEASE/,
  ],
  [
    ' and ($c | length) >= 7',
    '',
    /baseline no longer requires a commit of at least seven characters/,
  ],
  [
    ' and ($ps | startswith($c))',
    '',
    /baseline no longer requires PREV_SHA to start with the running commit/,
  ],
]) {
  test(`the rollback baseline losing ${from.trim()}`, () => {
    const block = baseline();
    assert.ok(block.includes(from), `fixture text not found in the baseline: ${from}`);
    const edit = edited(
      'script',
      block,
      block.replace(from, () => to),
    );
    expectProblem(problems(edit), pattern);
  });
}

test('the rollback baseline checked before PREV_SHA is known', () => {
  const prev = 'PREV_SHA=$(git rev-parse HEAD)\n';
  const moved = edited('script', prev, '').script.replace(
    "\nstep 'fetch and verify the commit'\n",
    () => `\n${prev}step 'fetch and verify the commit'\n`,
  );
  expectProblem(problems({ script: moved }), /before it knows PREV_SHA/);
});

/* ---- dc is a shell function ---- */

// Regression (Codex on #249): `timeout 600 dc up ...` exits 127, since an
// external command cannot run a shell function, so every deploy failed after
// migrating, before the new release started.
test('the dc function handed to timeout', () => {
  const edit = edited(
    'script',
    '\ndc up -d --wait --wait-timeout 300\n',
    '\ntimeout 600 dc up -d --wait --wait-timeout 300\n',
  );
  expectProblem(problems(edit), /hands the dc shell function to an external command/);
});

test('the dc function handed to another external command', () => {
  const edit = edited('script', '\ndc config -q\n', '\nnohup dc config -q\n');
  expectProblem(problems(edit), /`nohup dc config -q` hands the dc shell function/);
});

/* ---- paths no commit has, which the build context would include ---- */

// Regression (Codex on #249): --untracked-files=no hid files that `COPY . .`
// then built into staging although no commit held them and CI never saw them.
test('a checkout holding paths no commit has, not refused', () => {
  const edit = edited('script', '[ -z "$stray" ] ||\n  fail "', '[ -z "$stray" ] ||\n  echo "');
  expectProblem(problems(edit), /no longer refuses a checkout holding paths no commit has/);
});

test('the untracked check reading only what git does not ignore', () => {
  const edit = edited(
    'script',
    'ls-files --others --directory --no-empty-directory',
    'ls-files --others --exclude-standard --directory --no-empty-directory',
  );
  expectProblem(problems(edit), /no longer refuses a checkout holding paths no commit has/);
});

test('the host-local allowlist widened', () => {
  const edit = edited('script', '|storage|logs|backups)/', '|storage|logs|backups|tmp)/');
  expectProblem(problems(edit), /must allow exactly the host-local paths/);
});

test('paths no commit has checked only after the checkout changed', () => {
  const lines = REAL.script.split('\n');
  const from = lines.findIndex((line) => line.startsWith('HOST_LOCAL='));
  const block = `${lines.slice(from, from + 4).join('\n')}\n`;
  const without = edited('script', block, '').script;
  const anchor = 'step "build both images';
  assert.ok(without.includes(anchor), `fixture text not found in script: ${anchor}`);
  const moved = without.replace(anchor, () => `${block}${anchor}`);
  expectProblem(problems({ script: moved }), /paths no commit has only after the prepared phase/);
});

test('.dockerignore no longer excluding a host-local path the script allows', () => {
  const edit = edited('dockerignore', '\nbackups/\n', '\n');
  expectProblem(problems(edit), /\.dockerignore no longer excludes backups\//);
});

test('a volume-deleting down', () => {
  const edit = edited('script', '\ndc ps\n', '\ndc down -v\ndc ps\n');
  expectProblem(problems(edit), /`dc down -v` deletes the database/);
});

test('git pull instead of the commit', () => {
  const edit = edited(
    'script',
    'git fetch --prune origin\n',
    'git fetch --prune origin\ngit pull origin main\n',
  );
  expectProblem(problems(edit), /deploys whatever main is now/);
});

test('pruning the previous images', () => {
  const edit = edited('script', '\ndc ps\n', '\ndocker image prune -af\ndc ps\n');
  expectProblem(problems(edit), /removes images, and with them the rollback/);
});

test('a second compose file', () => {
  const edit = edited(
    'script',
    'dc() { docker compose -f docker-compose.prod.yml "$@"; }',
    'dc() { docker compose -f docker-compose.prod.yml -f override.yml "$@"; }',
  );
  expectProblem(problems(edit), /calls compose directly/);
});

test('appending to .env', () => {
  const edit = edited('script', '\ndc config -q\n', '\necho "FX_MODE=off" >> .env\ndc config -q\n');
  expectProblem(problems(edit), /rewrites .env, which holds the host's secrets/);
});

test('editing a secret line of .env', () => {
  const edit = edited(
    'script',
    '\ndc config -q\n',
    '\nsed -i "s/^VAULT_KEY=.*/VAULT_KEY=x/" .env\ndc config -q\n',
  );
  expectProblem(problems(edit), /edits .env beyond its REKODA_RELEASE line/);
});

test('touching secrets/', () => {
  const edit = edited(
    'script',
    '\ndc config -q\n',
    '\nchmod 644 secrets/postgres_owner_password\ndc config -q\n',
  );
  expectProblem(problems(edit), /touches secrets\//);
});

test('tracing every command', () => {
  const edit = edited('script', 'set -Eeuo pipefail\n', 'set -Eeuo pipefail\nset -x\n');
  expectProblem(problems(edit), /echoes every command/);
});

test('losing strict mode', () => {
  const edit = edited('script', 'set -Eeuo pipefail\n', 'set -e\n');
  expectProblem(problems(edit), /must start with a bash shebang and then `set -Eeuo pipefail`/);
});

test('deploying over tracked local modifications', () => {
  const edit = edited(
    'script',
    'git status --porcelain --untracked-files=no',
    'git status --porcelain',
  );
  expectProblem(problems(edit), /no longer refuses a checkout with tracked local modifications/);
});

test('deploying a commit that is not on main', () => {
  const edit = edited(
    'script',
    'git merge-base --is-ancestor "$SHA" origin/main || fail "commit $SHA is not on origin/main"\n',
    '',
  );
  expectProblem(problems(edit), /no longer refuses a commit that is not on origin\/main/);
});

test('deploying to a host that is not staging', () => {
  const edit = edited('script', '[ "$api_public" = "$API_URL" ] ||', 'true ||');
  expectProblem(problems(edit), /no longer refuses a host whose .env is not staging's/);
});

test('health passing without the commit', () => {
  const edit = edited('script', " and .commit == $c'", "'");
  expectProblem(problems(edit), /no longer requires \/health to name the commit/);
});

test('the script no longer read whole before it runs', () => {
  const edit = edited('script', '\nexit 0\n}\n', '\n');
  expectProblem(problems(edit), /closes that brace group/);
});

test('a production hostname in the script', () => {
  const edit = edited(
    'script',
    'API_URL=https://staging-api.myrekoda.com',
    'API_URL=https://api.myrekoda.com',
  );
  expectProblem(problems(edit), /names api\.myrekoda\.com, which is not a staging host/);
});

/* ---- the workflow ---- */

test('host key verification switched off', () => {
  const edit = edited('workflow', '-o StrictHostKeyChecking=yes', '-o StrictHostKeyChecking=no');
  expectProblem(problems(edit), /switches off host key verification/);
});

test('the host key learnt from the network', () => {
  const edit = edited(
    'workflow',
    '          install -d -m 700 "$RUNNER_TEMP/ssh"\n',
    '          install -d -m 700 "$RUNNER_TEMP/ssh"\n          ssh-keyscan "$STAGING_HOST" >>"$RUNNER_TEMP/ssh/known_hosts"\n',
  );
  expectProblem(problems(edit), /learns the host key from the network/);
});

test('a deploy on every push, CI or not', () => {
  const edit = edited('workflow', 'on:\n', 'on:\n  push:\n    branches: [main]\n');
  expectProblem(problems(edit), /triggered by workflow_run and workflow_dispatch only/);
});

test('a failed CI run deploying', () => {
  const edit = edited('workflow', "github.event.workflow_run.conclusion == 'success' &&\n", '');
  expectProblem(
    problems(edit),
    /must require github\.event\.workflow_run\.conclusion == 'success'/,
  );
});

test('a pull request run named main deploying', () => {
  const edit = edited('workflow', "github.event.workflow_run.event == 'push' &&\n", '');
  expectProblem(problems(edit), /must require github\.event\.workflow_run\.event == 'push'/);
});

test('following a workflow that is not CI', () => {
  const edit = edited('ci', 'name: CI\n', 'name: Checks\n');
  expectProblem(problems(edit), /must follow the CI workflow by its name \("Checks"\)/);
});

test('a newer deploy cancelling a running one', () => {
  const edit = edited('workflow', 'cancel-in-progress: false', 'cancel-in-progress: true');
  expectProblem(problems(edit), /never cancels a running deploy/);
});

test('an application secret moved into GitHub', () => {
  const edit = edited(
    'workflow',
    '          MODE: ${{ steps.commit.outputs.mode }}\n',
    '          MODE: ${{ steps.commit.outputs.mode }}\n          VAULT_KEY: ${{ secrets.VAULT_KEY }}\n',
  );
  expectProblem(problems(edit), /must read exactly STAGING_HOST.*found: .*VAULT_KEY/);
});

test('an expression pasted into a script', () => {
  const edit = edited(
    'workflow',
    'run: test "$(git rev-parse HEAD)" = "$DRIVER_SHA"',
    'run: test "$(git rev-parse HEAD)" = "${{ github.sha }}"',
  );
  expectProblem(problems(edit), /pastes an expression into its script/);
});

test('the job outside the staging environment', () => {
  const edit = edited('workflow', '      name: staging\n', '      name: production\n');
  expectProblem(problems(edit), /must run in the "staging" environment/);
});

test('a write permission', () => {
  const edit = edited('workflow', '  contents: read\n', '  contents: write\n');
  expectProblem(problems(edit), /grants contents: write/);
});

test('the workflow driving compose itself', () => {
  const edit = edited(
    'workflow',
    '"bash -s -- $MODE $SHA" <scripts/deploy-staging.sh',
    '"cd /opt/rekoda && docker compose -f docker-compose.prod.yml up -d"',
  );
  expectProblem(problems(edit), /drives the stack itself/);
  expectProblem(problems(edit), /no longer hands the host the driver's copy/);
});

/* ---- the driver: a revision that has passed CI on main ---- */

// Regression (Codex on #249): the workflow piped the deployed commit's own
// script, so redeploying an older commit also ran its older, less careful
// driver, without every safety fix added since.
test("an older commit's copy of the script driving a manual redeploy", () => {
  const edit = edited('workflow', '            driver=$REF_SHA\n', '            driver=$sha\n');
  expectProblem(problems(edit), /drive an automatic run with the commit CI passed/);
});

test('the checkout not being the driver', () => {
  const edit = edited(
    'workflow',
    '          ref: ${{ steps.commit.outputs.driver }}\n',
    '          ref: ${{ steps.commit.outputs.sha }}\n',
  );
  expectProblem(problems(edit), /must check out exactly the driver/);
});

test('a second checkout, of the deployed commit, beside the driver', () => {
  const edit = edited(
    'workflow',
    '      - name: The checkout is the driver',
    '      - name: Check out the commit\n        uses: actions/checkout@v7\n        with:\n          ref: ${{ steps.commit.outputs.sha }}\n\n      - name: The checkout is the driver',
  );
  expectProblem(problems(edit), /must check out exactly the driver/);
});

// Regression (Codex on #249): a manual run checked CI only for the commit it
// deployed, while the script it ran came from main's tip, whose CI could be
// pending or failed; and an automatic run drove with main's tip too, not the
// commit whose CI had just passed.
test('a manual run whose driver has not passed CI', () => {
  const edit = edited(
    'workflow',
    'for commit in "$SHA" "$DRIVER_SHA"; do',
    'for commit in "$SHA"; do',
  );
  expectProblem(
    problems(edit),
    /successful CI push run on main for both the commit and the driver/,
  );
});

test("an automatic run driven by main's tip rather than the commit CI passed", () => {
  const edit = edited('workflow', '            driver=$RUN_SHA\n', '            driver=$REF_SHA\n');
  expectProblem(problems(edit), /drive an automatic run with the commit CI passed/);
});

/* ---- automatic runs only go forward ---- */

// Regression (Codex on #249): the concurrency group serialises but does not
// order, so a delayed automatic run for an older commit could deploy after a
// newer one, rolling staging back silently.
test('an automatic run without --newer-only', () => {
  const edit = edited('workflow', '            mode=--newer-only\n', '            mode=\n');
  expectProblem(
    problems(edit),
    /drive an automatic run with the commit CI passed \(--newer-only\)/,
  );
});

test('the host never told the mode', () => {
  const edit = edited('workflow', '"bash -s -- $MODE $SHA"', '"bash -s -- $SHA"');
  expectProblem(problems(edit), /must pass the mode to the host/);
});

test('a skip reported as a failure, or every failure as a skip', () => {
  const edit = edited('workflow', 'if [ "$status" = 75 ]; then', 'if [ "$status" != 0 ]; then');
  expectProblem(problems(edit), /report its exit 75 \(and only that\) as skipped/);
});

test('a skipped run still asking /health for the commit it skipped', () => {
  const edit = edited('workflow', "        if: steps.deploy.outputs.skipped != 'true'\n", '');
  expectProblem(problems(edit), /unless the host skipped the deploy/);
});

test('the script deploying an older commit although --newer-only', () => {
  const edit = edited(
    'script',
    '  git merge-base --is-ancestor "$SHA" "$PREV_SHA"; then\n',
    '  false; then\n',
  );
  expectProblem(problems(edit), /no longer skips, changing nothing, a --newer-only commit older/);
});

test('the skip decided only after the checkout changed', () => {
  const lines = REAL.script.split('\n');
  const at = lines.findIndex((line) => line.startsWith('if [ "$NEWER_ONLY" = true ]'));
  const block = `${lines.slice(at, at + 6).join('\n')}\n`;
  const without = edited('script', block, '').script;
  const anchor = 'step "build both images';
  assert.ok(without.includes(anchor), `fixture text not found in script: ${anchor}`);
  const moved = without.replace(anchor, () => `${block}${anchor}`);
  expectProblem(problems({ script: moved }), /--newer-only skip only after the prepared phase/);
});

test('a failure able to exit with the "skipped" status', () => {
  const edit = edited('script', '  [ "$status" -ne "$SKIPPED" ] || exit 1\n', '');
  expectProblem(problems(edit), /keeps every failure off the "skipped" status/);
});

test('a second way to exit "skipped"', () => {
  const edit = edited(
    'script',
    '\ndc config -q\n',
    '\n[ -n "$RELEASE" ] || exit "$SKIPPED"\ndc config -q\n',
  );
  expectProblem(problems(edit), /exit "skipped" from the --newer-only check alone/);
});

test('a manual run from a branch other than main', () => {
  const edit = edited(
    'workflow',
    "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') ||",
    "github.event_name == 'workflow_dispatch' ||",
  );
  expectProblem(
    problems(edit),
    /must require \(github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'\)/,
  );
});

/* ---- the commit must know staging's schema ---- */

// Regression (Codex on #249): a manual redeploy could pick any older commit of
// main, and its /health reads ok against a newer schema, even one whose later
// contraction removed what that commit's code uses.
test('an older commit deployed without checking the schema it meets', () => {
  const lines = REAL.script.split('\n');
  const from = lines.findIndex((line) => line === 'step "the commit knows staging\'s schema"');
  const to = lines.findIndex((line, i) => i > from && /^\s*fail "commit \$SHA carries/.test(line));
  assert.ok(from > 0 && to > from, 'fixture: the schema check is not where expected');
  const edit = edited('script', `${lines.slice(from, to + 1).join('\n')}\n`, '');
  expectProblem(problems(edit), /no longer refuses a commit missing a running migration/);
  expectProblem(problems(edit), /no longer refuses a commit carrying fewer migrations/);
});

test('a commit missing a running migration, not refused', () => {
  const edit = edited('script', '[ -z "$unknown" ] ||\n  fail "', '[ -z "$unknown" ] ||\n  echo "');
  expectProblem(
    problems(edit),
    /refuses a commit missing a running migration: the check does not fail/,
  );
});

test('the schema compared by count alone', () => {
  const edit = edited(
    'script',
    "'[$run.entries[].tag] - [$new.entries[].tag]",
    "'[$run.entries | length] - [$new.entries | length]",
  );
  expectProblem(
    problems(edit),
    /no longer lists the running migrations the commit does not carry, by tag/,
  );
});

test('the schema checked only after the checkout changed', () => {
  const block = '[ "$MIGRATIONS" -ge "$APPLIED" ] ||\n';
  const lines = REAL.script.split('\n');
  const at = lines.indexOf(block.trimEnd());
  const both = `${block}${lines[at + 1]}\n`;
  const without = edited('script', both, '').script;
  const anchor = 'step "build both images';
  assert.ok(without.includes(anchor), `fixture text not found in script: ${anchor}`);
  const moved = without.replace(anchor, () => `${both}${anchor}`);
  expectProblem(
    problems({ script: moved }),
    /fewer migrations than the database has applied only after the prepared phase/,
  );
});

test('the runbook forgetting the automation', () => {
  const edit = {
    runbook: REAL.runbook.replaceAll('.github/workflows/deploy-staging.yml', 'the workflow'),
  };
  expectProblem(problems(edit), /must document \.github\/workflows\/deploy-staging\.yml/);
});
