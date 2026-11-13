/**
 * OD-48 (OWN-86): scripts/deploy-staging.sh stops the api and worker before it applies a migration
 * the running release cannot work against (0196), proves they stopped, and never advises restarting
 * the previous release once such a migration is applied. The real script runs against a throwaway
 * git checkout with a fake `docker` and `curl`. Run with
 * `node --test scripts/deploy-staging-compat.test.mjs` (CI does).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SCRIPT = readFileSync(new URL('./deploy-staging.sh', import.meta.url), 'utf8');
const API = 'https://staging-api.test.invalid';
const BREAKING = '0196_plan_fields_guard';

const sh = (cwd, cmd) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd}\n${r.stderr}`);
  return r.stdout.trim();
};

/** A host whose second commit adds the given migration tags to the journal. */
/* The OD-37 principals' URLs a host has once runbook step 1 is done (placeholder passwords). */
const PRINCIPAL_ENV =
  'SETTLEMENT_DATABASE_URL=postgres://rekoda_settlement:placeholder@postgres:5432/rekoda\n' +
  'OPERATOR_DATABASE_URL=postgres://rekoda_billing_operator:placeholder@postgres:5432/rekoda\n';

/* Staging always holds a Paystack TEST key (OWN-70); the deploy refuses a host without one. The
 * placeholder keys are built at run time so no key-shaped literal sits in the source (secret scan). */
const TEST_KEY = ['sk', 'test', 'placeholderkey'].join('_');
const LIVE_KEY = ['sk', 'live', 'placeholderkey'].join('_');
const PAYSTACK_ENV = `PAYSTACK_SECRET_KEY=${TEST_KEY}\n`;

function host(extraTags, extraEnv = PRINCIPAL_ENV, paystackEnv = PAYSTACK_ENV) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-compat-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const dir = join(root, 'rekoda');
  const fake = join(root, 'fake');
  mkdirSync(fake);
  sh(root, `git init -q --bare -b main ${origin} && git init -q -b main ${work}`);
  const commit = (n, tags) => {
    mkdirSync(join(work, 'packages/db/migrations/meta'), { recursive: true });
    // Names the real compose file interpolates from the shell or .env: the script must leave .env
    // the only source for them.
    writeFileSync(
      join(work, 'docker-compose.prod.yml'),
      `# ${n}\nx-interpolated: ['\${PAYSTACK_SECRET_KEY:-}', '\${VAULT_KEY:?}', '\${REKODA_RELEASE:?}'${
        n === 2 ? ", '\${ONLY_IN_TARGET:-}'" : ''
      }]\n`,
    );
    writeFileSync(
      join(work, 'packages/db/migrations/meta/_journal.json'),
      JSON.stringify({ entries: tags.map((tag) => ({ tag })) }),
    );
    sh(
      work,
      `git add -A && git -c user.name=t -c user.email=t@t commit -q -m c${n} && git push -q ${origin} main`,
    );
    return sh(work, 'git rev-parse HEAD');
  };
  const prev = commit(1, ['0000_init']);
  const next = commit(2, ['0000_init', ...extraTags]);
  sh(root, `git clone -q ${origin} ${dir}`);
  sh(dir, `git checkout -q --detach ${prev}`);
  writeFileSync(
    join(dir, '.env'),
    `REKODA_API_PUBLIC_URL=${API}\nREKODA_RELEASE=staging-${prev.slice(0, 7)}\n${paystackEnv}${extraEnv}`,
  );
  mkdirSync(join(dir, 'secrets'));
  const health = (sha, migrations) =>
    JSON.stringify({
      status: 'ok',
      database: 'up',
      release: `staging-${sha.slice(0, 7)}`,
      commit: sha.slice(0, 7),
      migrations,
    });
  writeFileSync(join(fake, 'health.json'), health(prev, 1));
  writeFileSync(join(fake, 'next-health.json'), health(next, 1 + extraTags.length));
  writeFileSync(join(fake, 'free-kb'), '20000000');
  writeFileSync(join(fake, 'meminfo'), 'MemTotal: 4000000 kB\nMemAvailable: 3000000 kB\n');
  const bin = (name, body) => {
    writeFileSync(join(fake, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(fake, name), 0o755);
  };
  bin('curl', `cat "${fake}/health.json"`);
  bin(
    'df',
    `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfake 1 1 %s 1%% /\\n' "$(cat "${fake}/free-kb")"`,
  );
  // `ps --status running --services` lists what the test says is still running.
  bin(
    'docker',
    `echo "$*" >> "${fake}/docker.log"
case "$*" in *"-f docker-compose.prod.yml"*) echo "PAYSTACK_SECRET_KEY=\${PAYSTACK_SECRET_KEY-unset} VAULT_KEY=\${VAULT_KEY-unset} ONLY_IN_TARGET=\${ONLY_IN_TARGET-unset}" >> "${fake}/shell-env.log" ;; esac
case "$*" in
  *"stop api worker"*) [ -e "${fake}/stop-fails" ] && exit 1; [ -e "${fake}/hang-stop" ] && sleep 60 ;;
  *"ps --status running --services"*) [ -e "${fake}/ps-fails" ] && exit 1; cat "${fake}/running" 2>/dev/null ;;
  *"info --format"*) echo "${fake}" ;;
  *"run --rm -T migrate"*) [ -e "${fake}/hang-migrate" ] && sleep 60; [ -e "${fake}/fail-migrate" ] && exit 1 ;;
  *"exec -T postgres psql"*) [ -e "${fake}/smoke-errors" ] && exit 1; if [ -e "${fake}/smoke-fails" ]; then echo f; else echo t; fi ;;
  *" up "*) [ -e "${fake}/fail-up" ] && exit 1; cp "${fake}/next-health.json" "${fake}/health.json" ;;
  *network\\ inspect*) echo '172.30.10.1 false' ;;
esac
exit 0`,
  );
  const script = join(root, 'deploy.sh');
  writeFileSync(
    script,
    SCRIPT.replaceAll('/opt/rekoda', dir)
      .replaceAll('https://staging-api.myrekoda.com', API)
      .replaceAll('/proc/meminfo', join(fake, 'meminfo')),
  );
  const run = (shellEnv = {}) =>
    spawnSync('bash', [script, next], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, ...shellEnv },
    });
  /** What compose would have read from the deploy's own shell, one line per call that reads the compose file. */
  const shellEnvSeen = () =>
    existsSync(join(fake, 'shell-env.log'))
      ? readFileSync(join(fake, 'shell-env.log'), 'utf8').trim().split('\n')
      : [];
  /** The script as a process GROUP that a test can terminate part-way, as a cancelled workflow or a
   * dropped ssh session does: the signal reaches the script and whatever it is waiting on. */
  const runInterrupted = async (waitFor, signal = 'SIGTERM') => {
    const child = spawn('bash', [script, next], {
      cwd: dir,
      detached: true,
      env: { ...process.env, PATH: `${fake}:${process.env.PATH}` },
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const closed = new Promise((resolve) =>
      child.on('close', (code, sig) => resolve({ code, sig })),
    );
    const deadline = Date.now() + 20_000;
    while (!calls().some((c) => c.includes(waitFor))) {
      assert.ok(Date.now() < deadline, `never reached: ${waitFor}\n${stderr}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    process.kill(-child.pid, signal);
    const { code, sig } = await closed;
    return { code, sig, stderr };
  };
  const calls = () =>
    existsSync(join(fake, 'docker.log'))
      ? readFileSync(join(fake, 'docker.log'), 'utf8').split('\n').filter(Boolean)
      : [];
  const at = (needle) => calls().findIndex((c) => c.includes(needle));
  return { fake, run, runInterrupted, calls, at, shellEnvSeen };
}

test('a release carrying 0196 stops the api and worker, proves it, then migrates, then starts', () => {
  const h = host([BREAKING]);
  const r = h.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const stop = h.at('stop api worker');
  const verify = h.at('ps --status running --services');
  const migrate = h.at('run --rm -T migrate');
  const up = h.at(' up ');
  assert.ok(stop >= 0, 'api and worker were never stopped');
  assert.ok(stop < verify && verify < migrate && migrate < up, h.calls().join('\n'));
});

test('migration is refused while the api or worker is still running', () => {
  const h = host([BREAKING]);
  writeFileSync(join(h.fake, 'running'), 'worker\nweb\n');
  const r = h.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must be stopped before migrating 0196_plan_fields_guard.*worker/);
  assert.equal(h.at('run --rm -T migrate'), -1, 'migrate must not run');
});

test('a release without a compatibility-breaking migration does not stop anything', () => {
  const h = host(['0198_something_additive']);
  const r = h.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(h.at('stop api worker'), -1);
  assert.ok(h.at('run --rm -T migrate') >= 0);
});

test('a failed migrate after the stop tells the operator 0196 may already be applied', () => {
  const h = host([BREAKING]);
  writeFileSync(join(h.fake, 'fail-migrate'), '');
  const r = h.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /api and worker were stopped for 0196_plan_fields_guard/);
  assert.match(r.stderr, /MAY already be applied/);
});

test('a failed migrate never prints rollback commands: 0196 may already have committed (OWN-86)', () => {
  // migrate applies each file in its own transaction, so a later file (0197) or the ledger insert
  // can fail after 0196 committed. The script cannot know, so it must not hand out the commands
  // that restart the previous release.
  const h = host([BREAKING]);
  writeFileSync(join(h.fake, 'fail-migrate'), '');
  const r = h.run();
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /git checkout [0-9a-f]{40}/);
  assert.doesNotMatch(r.stderr, /To roll back/);
  assert.match(r.stderr, /rekoda_migrations/);
  assert.match(r.stderr, /pg_trigger/); // the database object, not only the ledger row
  assert.match(r.stderr, /Fix forward/);
  // The by-hand fix-forward never leads around the OWN-86 pre-start smoke.
  assert.match(r.stderr, /do NOT run `dc up` unless it prints t/);
  assert.match(r.stderr, /Pre-start database smoke \(OWN-86\): dc exec -T postgres psql .*SELECT/s);
});

test('the stop is not trusted when the running services cannot be listed', () => {
  const h = host([BREAKING]);
  writeFileSync(join(h.fake, 'ps-fails'), '');
  const r = h.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not list the running services/);
  assert.equal(h.at('run --rm -T migrate'), -1, 'migrate must not run');
  // The exit message describes what happened: migrate was never entered, and the stopped state
  // is unverified. It must not claim the services stopped or that migrate/up started.
  assert.match(r.stderr, /BEFORE migrate/);
  assert.match(r.stderr, /stopped state .*unverified/i);
  assert.doesNotMatch(r.stderr, /after migrate\/up started/);
  assert.doesNotMatch(r.stderr, /were stopped for/);
});

test('a refused migration because a service is still running says migrate was never entered', () => {
  const h = host([BREAKING]);
  writeFileSync(join(h.fake, 'running'), 'worker\nweb\n');
  const r = h.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /BEFORE migrate/);
  assert.doesNotMatch(r.stderr, /after migrate\/up started/);
  assert.equal(h.at('run --rm -T migrate'), -1, 'migrate must not run');
});

test('a failure after 0196 is applied never advises restarting the previous release', () => {
  const h = host([BREAKING]);
  writeFileSync(join(h.fake, 'fail-up'), '');
  const r = h.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /APPLIED, so the previous release .* is NOT safe to restart/);
  assert.match(r.stderr, /Fix forward/);
  assert.doesNotMatch(r.stderr, /git checkout [0-9a-f]{40}/);
});

test('a failed stop never lets migration run, and the script does not assume the services stopped', () => {
  const h = host([BREAKING]);
  writeFileSync(join(h.fake, 'stop-fails'), '');
  // `ps` reports nothing running, so only the failed stop itself can keep migrate from running: a
  // stop that failed is not trusted just because a later listing looks empty.
  const r = h.run();
  assert.notEqual(r.status, 0);
  assert.ok(h.at('stop api worker') >= 0);
  assert.equal(h.at('run --rm -T migrate'), -1, 'migrate must not run after a failed stop');
  assert.equal(h.at(' up '), -1, 'the new release must not start after a failed stop');
  assert.match(r.stderr, /BEFORE migrate/);
  assert.match(r.stderr, /stopped state .*unverified/i);
  // Nothing was migrated: it must not claim the guard is applied or that fix-forward is the only way.
  assert.doesNotMatch(r.stderr, /APPLIED, so the previous release/);
  assert.doesNotMatch(r.stderr, /MAY already be applied/);
});

test('SIGTERM during migrate: 0196 may be applied, so no rollback is offered and fix-forward is stated', async () => {
  const h = host([BREAKING]);
  writeFileSync(join(h.fake, 'hang-migrate'), '');
  const { code, stderr } = await h.runInterrupted('run --rm -T migrate');
  assert.notEqual(code, 0, 'an interrupted deploy must not look successful');
  assert.match(stderr, /MAY already be applied/);
  assert.match(stderr, /api and worker were stopped for 0196_plan_fields_guard/);
  assert.match(stderr, /Fix forward/);
  assert.match(stderr, /pg_trigger/);
  assert.match(stderr, /must never be restarted against a database holding 0196/);
  assert.match(stderr, /do NOT run `dc up` unless it prints t/);
  assert.match(stderr, /Pre-start database smoke \(OWN-86\): dc exec -T postgres psql .*SELECT/s);
  // The commands that restart the incompatible previous release are never printed.
  assert.doesNotMatch(stderr, /git checkout [0-9a-f]{40}/);
  assert.doesNotMatch(stderr, /To roll back/);
  assert.doesNotMatch(stderr, /dc start api worker.*safe/);
  assert.equal(h.at(' up '), -1, 'the new release must not start after an interrupted migrate');
});

test('SIGHUP during migrate (a dropped ssh session) is treated the same way', async () => {
  const h = host([BREAKING]);
  writeFileSync(join(h.fake, 'hang-migrate'), '');
  const { code, stderr } = await h.runInterrupted('run --rm -T migrate', 'SIGHUP');
  assert.notEqual(code, 0);
  assert.match(stderr, /MAY already be applied/);
  assert.doesNotMatch(stderr, /git checkout [0-9a-f]{40}/);
});

test('SIGTERM while the services are being stopped: migrate is never entered and the state is unverified', async () => {
  const h = host([BREAKING]);
  writeFileSync(join(h.fake, 'hang-stop'), '');
  const { code, stderr } = await h.runInterrupted('stop api worker');
  assert.notEqual(code, 0);
  assert.equal(h.at('run --rm -T migrate'), -1, 'migrate must not run');
  assert.match(stderr, /BEFORE migrate/);
  assert.match(stderr, /stopped state .*unverified/i);
  assert.match(stderr, /Migrate was never entered/);
  assert.doesNotMatch(stderr, /MAY already be applied/);
  // From 0217 the release also runs the operator and settlement processes: the restart advice
  // must name them, or following it leaves subscription payments unsettled.
  assert.match(stderr, /dc start api worker operator settlement/);
});

test('OWN-86: a release carrying 0196 runs the pre-start database smoke after migrate and before up', () => {
  const h = host([BREAKING]);
  const r = h.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const migrate = h.at('run --rm -T migrate');
  const smoke = h.at('exec -T postgres psql');
  const up = h.at(' up ');
  assert.ok(smoke >= 0, 'the pre-start database smoke never ran');
  assert.ok(migrate < smoke && smoke < up, h.calls().join('\n'));
  // The query spans several lines of the fake docker log: read every line up to `up`.
  const sql = h.calls().slice(smoke, up).join('\n');
  // The smoke checks the database objects, not only the ledger row.
  assert.match(sql, /rekoda_migrations/);
  assert.match(sql, /businesses_plan_fields_guard/);
  // OD-37 / owner review of #432 (item 4.3): the writer role owns EXACTLY the expected functions, each
  // by schema, name and argument types, each with EXACTLY its EXECUTE grantees; no count.
  assert.doesNotMatch(sql, /proowner = 'rekoda_plan_writer'::regrole\) = \d/);
  assert.match(sql, /aclexplode\(p\.proacl\)/);
  for (const entry of [
    'public.staging_move_date\\(uuid, text, timestamp with time zone, timestamp with time zone, text, text, uuid\\) => rekoda_app',
    'public.subscription_apply_paid_charge\\(uuid, text, timestamp with time zone\\) => rekoda_settlement',
    'public.subscription_expire_plan\\(uuid, text, text\\) => rekoda_app,rekoda_worker',
    'public.subscription_operator_set_plan\\(uuid, text, timestamp with time zone, text, text\\) => rekoda_billing_operator',
  ]) {
    assert.match(sql, new RegExp(entry));
  }
  // Every writer is SECURITY DEFINER with the pinned search_path.
  assert.match(
    sql,
    /NOT prosecdef OR proconfig IS DISTINCT FROM ARRAY\['search_path=pg_catalog, public, pg_temp'\]/,
  );
  // The removed general writer, the old operator signature and the test-only fixture writer are absent.
  assert.match(
    sql,
    /to_regprocedure\('public\.subscription_write_plan\(uuid,text,timestamptz\)'\) IS NULL/,
  );
  assert.match(
    sql,
    /to_regprocedure\('public\.subscription_operator_set_plan\(uuid,text,timestamptz,text\)'\) IS NULL/,
  );
  assert.match(
    sql,
    /to_regprocedure\('public\.test_fixture_set_plan\(uuid,text,timestamptz\)'\) IS NULL/,
  );
  for (const tag of [
    '0200_plan_writer_boundary',
    '0202_settlement_and_operator_principals',
    '0203_plan_duration_rules',
    '0204_external_events_worker_least_privilege',
  ]) {
    assert.match(sql, new RegExp(`'${tag}'`));
  }
  for (const trigger of [
    'businesses_plan_fields_insert_guard',
    'subscription_charges_applied_once_guard',
    'subscription_charges_settlement_guard',
    'usage_counters_bonus_guard',
  ]) {
    assert.match(sql, new RegExp(trigger));
  }
  // The principals exist, cannot bypass RLS, and no runtime role can become another.
  assert.match(sql, /rolcanlogin AND NOT rolsuper AND NOT rolbypassrls/);
  assert.match(sql, /\('rekoda_app', 'rekoda_settlement'\)/);
  assert.match(sql, /\('rekoda_worker', 'rekoda_billing_operator'\)/);
  assert.match(sql, /pg_has_role\(m\.member, m\.target, 'MEMBER'\)/);
  // The worker reads, but cannot write, other businesses' events (0204).
  assert.match(sql, /polname = 'worker_reads_the_estate'/);
  assert.match(
    sql,
    /NOT has_table_privilege\('rekoda_worker', 'public\.external_events', 'UPDATE'\)/,
  );
});

test('OWN-86: a failed pre-start smoke never starts the new release and states fix-forward', () => {
  const h = host([BREAKING]);
  writeFileSync(join(h.fake, 'smoke-fails'), '');
  const r = h.run();
  assert.notEqual(r.status, 0);
  assert.equal(h.at(' up '), -1, 'the new release must not start after a failed smoke');
  assert.match(r.stderr, /pre-start database smoke for 0196\/0200\/0202-0206 failed/);
  assert.match(r.stderr, /APPLIED, so the previous release .* is NOT safe to restart/);
  assert.match(r.stderr, /Fix forward/);
  assert.doesNotMatch(r.stderr, /git checkout [0-9a-f]{40}/);
  // Nothing was started, and the printed fix-forward never leads around the smoke: it says to
  // correct the cause, re-run the smoke and not start the release unless it passes, and gives the query.
  assert.match(
    r.stderr,
    /before the new release was started: the api and worker are still stopped/,
  );
  assert.doesNotMatch(r.stderr, /after migrate\/up started/);
  assert.match(r.stderr, /correct the cause first/);
  assert.match(r.stderr, /do NOT run `dc up` unless it prints t/);
  assert.match(r.stderr, /Pre-start database smoke \(OWN-86\): dc exec -T postgres psql .*SELECT/s);
  assert.match(r.stderr, /tgenabled IN \('O', 'A'\)/);
});

test('OWN-86: a smoke that cannot run is a failure, not a pass', () => {
  const h = host([BREAKING]);
  writeFileSync(join(h.fake, 'smoke-errors'), '');
  const r = h.run();
  assert.notEqual(r.status, 0);
  assert.equal(h.at(' up '), -1, 'the new release must not start when the smoke could not run');
  assert.match(r.stderr, /pre-start database smoke for 0196\/0200\/0202-0206 could not run/);
});

test('OD-37 (0200): a release bringing in 0200 is compatibility-breaking and runs the smoke too', () => {
  const h = host(['0200_plan_writer_boundary']);
  const r = h.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const stop = h.at('stop api worker');
  const migrate = h.at('run --rm -T migrate');
  const smoke = h.at('exec -T postgres psql');
  const up = h.at(' up ');
  assert.ok(stop >= 0 && stop < migrate, 'api and worker are stopped before migrating 0200');
  assert.ok(migrate < smoke && smoke < up, h.calls().join('\n'));
});

test('OD-37 (0202, 0203): a release bringing in the principals or the duration rules is compatibility-breaking and runs the smoke', () => {
  for (const tag of ['0202_settlement_and_operator_principals', '0203_plan_duration_rules']) {
    const h = host([tag]);
    const r = h.run();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const stop = h.at('stop api worker');
    const migrate = h.at('run --rm -T migrate');
    const smoke = h.at('exec -T postgres psql');
    const up = h.at(' up ');
    assert.ok(stop >= 0 && stop < migrate, `api and worker are stopped before migrating ${tag}`);
    assert.ok(migrate < smoke && smoke < up, h.calls().join('\n'));
  }
});

test('OD-37 (0202): a missing or wrong principal credential refuses the deploy before anything is stopped', () => {
  for (const env of [
    '',
    'SETTLEMENT_DATABASE_URL=postgres://rekoda_settlement:p@postgres:5432/rekoda\n',
    'SETTLEMENT_DATABASE_URL=postgres://rekoda_app:p@postgres:5432/rekoda\nOPERATOR_DATABASE_URL=postgres://rekoda_billing_operator:p@postgres:5432/rekoda\n',
  ]) {
    const h = host(['0202_settlement_and_operator_principals'], env);
    const r = h.run();
    assert.notEqual(r.status, 0);
    assert.match(
      r.stderr,
      /STAGING DEPLOY REFUSED: .*(has no (SETTLEMENT|OPERATOR)_DATABASE_URL|must connect as)/,
    );
    assert.match(r.stderr, /nothing has been changed/);
    assert.equal(h.at('stop api worker'), -1, 'the api and worker must not be stopped');
    assert.equal(h.at('run --rm -T migrate'), -1, 'nothing may be migrated');
    assert.doesNotMatch(r.stderr + r.stdout, /placeholder|:p@/, 'a password is never printed');
  }
});

test('a release without 0196 does not run the 0196 smoke', () => {
  const h = host(['0199_something_additive']);
  const r = h.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(h.at('exec -T postgres psql'), -1);
});

/* What a host holds once the OD-51 runbook step is done: the operator process's own audience. */
const PRIVILEGED_ENV =
  PRINCIPAL_ENV +
  `VAULT_KEY=${'a'.repeat(64)}\n` +
  'OPERATOR_OIDC_ISSUER=https://idp.example.com/\n' +
  'OPERATOR_OIDC_JWKS_URL=https://idp.example.com/jwks.json\n' +
  'OPERATOR_OIDC_AUDIENCE=rekoda-api\n';

test('OD-51 (0217): a release bringing in the operator and settlement processes stops all four writers, then migrates, smokes and starts', () => {
  const h = host(
    ['0217_settlement_isolation'],
    PRIVILEGED_ENV + 'OPERATOR_BILLING_OIDC_AUDIENCE=rekoda-billing\n',
  );
  const r = h.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const stop = h.at('stop api worker operator settlement');
  const migrate = h.at('run --rm -T migrate');
  const smoke = h.at('exec -T postgres psql');
  const up = h.at(' up ');
  assert.ok(stop >= 0 && stop < migrate, 'every writing process is stopped before migrating 0217');
  assert.ok(migrate < smoke && smoke < up, h.calls().join('\n'));
});

test('OD-51 (0217): an operator process with no audience of its own, or the API’s, refuses the deploy before anything is stopped', () => {
  for (const env of [
    PRIVILEGED_ENV,
    PRIVILEGED_ENV + 'OPERATOR_BILLING_OIDC_AUDIENCE=\n',
    PRIVILEGED_ENV + 'OPERATOR_BILLING_OIDC_AUDIENCE=rekoda-api\n',
    PRINCIPAL_ENV + 'OPERATOR_BILLING_OIDC_AUDIENCE=rekoda-billing\n',
  ]) {
    const h = host(['0217_settlement_isolation'], env);
    const r = h.run();
    assert.notEqual(r.status, 0);
    assert.match(
      r.stderr,
      /STAGING DEPLOY REFUSED: .*(has no (OPERATOR_BILLING_OIDC_AUDIENCE|OPERATOR_OIDC_ISSUER|VAULT_KEY)|must differ from OPERATOR_OIDC_AUDIENCE)/,
    );
    assert.match(r.stderr, /nothing has been changed/);
    assert.equal(h.at('stop api worker'), -1, 'nothing may be stopped');
    assert.equal(h.at('run --rm -T migrate'), -1, 'nothing may be migrated');
    assert.doesNotMatch(r.stderr + r.stdout, /placeholder|aaaaaaaa/, 'a value is never printed');
  }
});

test('OWN-70: a host whose Paystack key is missing, empty, live or malformed, or that sets the §47 flag, is refused before anything is built or stopped', () => {
  for (const paystackEnv of [
    '',
    'PAYSTACK_SECRET_KEY=\n',
    `PAYSTACK_SECRET_KEY=${LIVE_KEY}\n`,
    `PAYSTACK_SECRET_KEY="${LIVE_KEY}"\n`,
    'PAYSTACK_SECRET_KEY=pk_test_placeholderkey\n',
    'PAYSTACK_SECRET_KEY=sk_test_\n',
    `PAYSTACK_SECRET_KEY=${TEST_KEY}\nPAYSTACK_SECRET_KEY=${LIVE_KEY}\n`,
    PAYSTACK_ENV + 'REKODA_PAYSTACK_PLATFORM_CONFIRMED=1\n',
    /* Spellings compose also reads, which the plain-line check would not see. */
    PAYSTACK_ENV + `export PAYSTACK_SECRET_KEY=${LIVE_KEY}\n`,
    PAYSTACK_ENV + `  PAYSTACK_SECRET_KEY=${LIVE_KEY}\n`,
    PAYSTACK_ENV + `PAYSTACK_SECRET_KEY = ${LIVE_KEY}\n`,
    PAYSTACK_ENV + 'export REKODA_PAYSTACK_PLATFORM_CONFIRMED=1\n',
    /* compose's .env parser also takes YAML-style declarations. */
    PAYSTACK_ENV + `PAYSTACK_SECRET_KEY: ${LIVE_KEY}\n`,
    PAYSTACK_ENV + `PAYSTACK_SECRET_KEY : ${LIVE_KEY}\n`,
    PAYSTACK_ENV + 'REKODA_PAYSTACK_PLATFORM_CONFIRMED: 1\n',
  ]) {
    const h = host(
      ['0217_settlement_isolation'],
      PRIVILEGED_ENV + 'OPERATOR_BILLING_OIDC_AUDIENCE=rekoda-billing\n',
      paystackEnv,
    );
    const r = h.run();
    assert.notEqual(r.status, 0, paystackEnv);
    assert.match(
      r.stderr,
      /STAGING DEPLOY REFUSED: .*(Paystack TEST key|REKODA_PAYSTACK_PLATFORM_CONFIRMED=1|one plain line).*nothing has been changed/,
    );
    assert.equal(h.at(' build '), -1, 'nothing may be built');
    assert.equal(h.at('stop api worker'), -1, 'nothing may be stopped');
    assert.equal(h.at('run --rm -T migrate'), -1, 'nothing may be migrated');
    assert.doesNotMatch(r.stderr + r.stdout, /placeholderkey/, 'the key is never printed');
  }
});

test('OWN-70: a TEST key, quoted or not, lets the deploy through', () => {
  for (const paystackEnv of [
    PAYSTACK_ENV,
    `PAYSTACK_SECRET_KEY="${TEST_KEY}"\n`,
    `PAYSTACK_SECRET_KEY='${TEST_KEY}'\n`,
  ]) {
    const h = host(
      ['0217_settlement_isolation'],
      PRIVILEGED_ENV + 'OPERATOR_BILLING_OIDC_AUDIENCE=rekoda-billing\n',
      paystackEnv,
    );
    const r = h.run();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.doesNotMatch(r.stderr + r.stdout, /placeholderkey/, 'the key is never printed');
  }
});

test('OWN-70: a Paystack key or vault key exported in the deploy shell never reaches compose; .env is the only source', () => {
  /* Built at run time so no key-shaped literal sits in the source (secret scan). */
  const live = ['sk', 'live', 'exportedkey'].join('_');
  const h = host(
    ['0217_settlement_isolation'],
    PRIVILEGED_ENV + 'OPERATOR_BILLING_OIDC_AUDIENCE=rekoda-billing\n',
  );
  /* ONLY_IN_TARGET is interpolated only by the commit being deployed: the clear after the checkout
   * is what removes it. */
  const r = h.run({
    PAYSTACK_SECRET_KEY: live,
    VAULT_KEY: 'b'.repeat(64),
    ONLY_IN_TARGET: 'from-the-deploy-shell',
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const seen = h.shellEnvSeen();
  assert.ok(seen.length > 0, 'compose was called');
  for (const line of seen) {
    assert.equal(line, 'PAYSTACK_SECRET_KEY=unset VAULT_KEY=unset ONLY_IN_TARGET=unset');
  }
  assert.doesNotMatch(r.stderr + r.stdout, /exportedkey|bbbbbbbb/, 'a value is never printed');
});
