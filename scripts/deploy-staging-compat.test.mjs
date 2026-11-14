/**
 * OD-48 (OWN-86): scripts/deploy-staging.sh stops the api and worker before it applies a migration
 * the running release cannot work against (0196), proves they stopped, and never advises restarting
 * the previous release once such a migration is applied. The real script runs against a throwaway
 * git checkout with a fake `docker` and `curl`. Run with
 * `node --test scripts/deploy-staging-compat.test.mjs` (CI does).
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  BREAKING,
  host,
  LIVE_KEY,
  PAYSTACK_ENV,
  PRINCIPAL_ENV,
  TEST_KEY,
} from './deploy-staging.fixtures.mjs';

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

/** A host fully set up for the 0217 release, with the given Paystack lines in its .env. */
const od51Host = (paystackEnv = PAYSTACK_ENV) =>
  host(
    ['0217_settlement_isolation'],
    PRIVILEGED_ENV + 'OPERATOR_BILLING_OIDC_AUDIENCE=rekoda-billing\n',
    paystackEnv,
  );

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
    /* Spellings compose also reads: export, indents, spaces, YAML style, a statement after a
     * closing quote, a no-break space. */
    PAYSTACK_ENV + `export PAYSTACK_SECRET_KEY=${LIVE_KEY}\n`,
    PAYSTACK_ENV + `  PAYSTACK_SECRET_KEY=${LIVE_KEY}\n`,
    PAYSTACK_ENV + `PAYSTACK_SECRET_KEY = ${LIVE_KEY}\n`,
    PAYSTACK_ENV + 'export REKODA_PAYSTACK_PLATFORM_CONFIRMED=1\n',
    PAYSTACK_ENV + `PAYSTACK_SECRET_KEY: ${LIVE_KEY}\n`,
    PAYSTACK_ENV + `PAYSTACK_SECRET_KEY : ${LIVE_KEY}\n`,
    PAYSTACK_ENV + 'REKODA_PAYSTACK_PLATFORM_CONFIRMED: 1\n',
    PAYSTACK_ENV + `OTHER="v"PAYSTACK_SECRET_KEY=${LIVE_KEY}\n`,
    `PAYSTACK_SECRET_KEY="${TEST_KEY}"PAYSTACK_SECRET_KEY="${LIVE_KEY}"\n`,
    PAYSTACK_ENV + `PAYSTACK_SECRET_KEY\u00a0=${LIVE_KEY}\n`,
    PAYSTACK_ENV + `\u00a0PAYSTACK_SECRET_KEY=${LIVE_KEY}\n`,
    PAYSTACK_ENV + 'REKODA_PAYSTACK_PLATFORM_CONFIRMED="0"REKODA_PAYSTACK_PLATFORM_CONFIRMED=1\n',
    PAYSTACK_ENV + 'REKODA_PAYSTACK_PLATFORM_CONFIRMED=true\n',
    /* A second plain line inside another value's multi-line quotes: compose reads the first. */
    `PAYSTACK_SECRET_KEY=${LIVE_KEY}\nNOTE="\nPAYSTACK_SECRET_KEY=${TEST_KEY}\n"\n`,
    PAYSTACK_ENV +
      'REKODA_PAYSTACK_PLATFORM_CONFIRMED=1\nNOTE="\nREKODA_PAYSTACK_PLATFORM_CONFIRMED=0\n"\n',
  ]) {
    const h = od51Host(paystackEnv);
    const r = h.run();
    assert.notEqual(r.status, 0, paystackEnv);
    assert.match(
      r.stderr,
      /STAGING DEPLOY REFUSED: .*(Paystack TEST key|REKODA_PAYSTACK_PLATFORM_CONFIRMED must be|one plain line).*nothing has been changed/,
    );
    assert.equal(h.at(' build '), -1, 'nothing may be built');
    assert.equal(h.at('stop api worker'), -1, 'nothing may be stopped');
    assert.equal(h.at('run --rm -T migrate'), -1, 'nothing may be migrated');
    assert.doesNotMatch(r.stderr + r.stdout, /placeholderkey/, 'the key is never printed');
  }
});

test('a .env that sets a COMPOSE_ variable is refused before anything is built or stopped', () => {
  for (const line of [
    'COMPOSE_PROJECT_NAME=someone-elses-project\n',
    'export COMPOSE_PROJECT_NAME=x\n',
    '  COMPOSE_PROFILES=migrate\n',
    'COMPOSE_FILE: other.yml\n',
    'COMPOSE_ENV_FILES = other.env\n',
  ]) {
    const h = od51Host(PAYSTACK_ENV + line);
    const r = h.run();
    assert.notEqual(r.status, 0, line);
    assert.match(
      r.stderr,
      /STAGING DEPLOY REFUSED: \.env sets a COMPOSE_ variable.*nothing has been changed/,
    );
    assert.equal(h.at(' build '), -1, 'nothing may be built');
    assert.equal(h.at('stop api worker'), -1, 'nothing may be stopped');
  }
  // A comment that mentions one is fine.
  const ok = od51Host(PAYSTACK_ENV + '# COMPOSE_PROJECT_NAME is never set here\n');
  assert.equal(ok.run().status, 0);
});

test('Compose itself must resolve the project to rekoda-prod, whatever spelling .env uses', () => {
  for (const answer of ['name: someone-elses-project\n', '', 'services: {}\n']) {
    const h = od51Host();
    writeFileSync(join(h.fake, 'project-name'), answer);
    const r = h.run();
    assert.notEqual(r.status, 0, answer);
    assert.match(
      r.stderr,
      /STAGING DEPLOY REFUSED: Compose resolves this deployment to project '.*', not rekoda-prod.*nothing live has been changed/,
    );
    assert.match(r.stderr, /STAGING DEPLOY FAILED before anything live changed/);
    assert.equal(h.at(' build '), -1, 'nothing may be built');
    assert.equal(h.at('stop api worker'), -1, 'nothing may be stopped');
  }
});

test('OWN-70: the key Compose resolves for settlement must be a TEST key, whatever the .env lines say', () => {
  for (const resolved of [LIVE_KEY, '""', '', 'pk_test_placeholderkey', `${TEST_KEY} trailing`]) {
    const h = od51Host();
    writeFileSync(join(h.fake, 'settlement-key'), resolved);
    const r = h.run();
    assert.notEqual(r.status, 0, resolved);
    assert.match(
      r.stderr,
      /STAGING DEPLOY REFUSED: Compose does not resolve a Paystack TEST key .*nothing live has been changed/,
    );
    assert.equal(h.at(' build '), -1, 'nothing may be built');
    assert.doesNotMatch(r.stderr + r.stdout, /placeholderkey/, 'the key is never printed');
  }
});

test('OWN-70: a TEST key, quoted or not, lets the deploy through', () => {
  for (const paystackEnv of [
    PAYSTACK_ENV,
    `PAYSTACK_SECRET_KEY="${TEST_KEY}"\n`,
    `PAYSTACK_SECRET_KEY='${TEST_KEY}'\n`,
    `# PAYSTACK_SECRET_KEY rotated in November\n${PAYSTACK_ENV}REKODA_PAYSTACK_PLATFORM_CONFIRMED=0\n`,
    `${PAYSTACK_ENV}REKODA_PAYSTACK_PLATFORM_CONFIRMED=\n`,
  ]) {
    const h = od51Host(paystackEnv);
    const r = h.run();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.doesNotMatch(r.stderr + r.stdout, /placeholderkey/, 'the key is never printed');
  }
});

test('OWN-70: a Paystack key or vault key exported in the deploy shell never reaches compose; .env is the only source', () => {
  /* Built at run time so no key-shaped literal sits in the source (secret scan). */
  const live = ['sk', 'live', 'exportedkey'].join('_');
  const h = od51Host();
  /* ONLY_IN_TARGET is interpolated only by the commit being deployed: the clear after the checkout
   * is what removes it. */
  const r = h.run({
    PAYSTACK_SECRET_KEY: live,
    VAULT_KEY: 'b'.repeat(64),
    ONLY_IN_TARGET: 'from-the-deploy-shell',
    /* Compose's own variables: an exported project name would point every call at another,
     * empty project (the stop check would pass with nothing stopped). */
    COMPOSE_PROJECT_NAME: 'someone-elses-project',
    COMPOSE_PROFILES: 'everything',
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const seen = h.shellEnvSeen();
  assert.ok(seen.length > 0, 'compose was called');
  for (const line of seen) {
    assert.equal(
      line,
      'PAYSTACK_SECRET_KEY=unset VAULT_KEY=unset ONLY_IN_TARGET=unset COMPOSE_PROJECT_NAME=unset COMPOSE_PROFILES=unset',
    );
  }
  assert.doesNotMatch(r.stderr + r.stdout, /exportedkey|bbbbbbbb/, 'a value is never printed');
});

test('OWN-93: template settings the new image would refuse to boot with refuse the deploy before anything is stopped or migrated', () => {
  const h = host([BREAKING]);
  writeFileSync(join(h.fake, 'template-check-fails'), '');
  const r = h.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /META_TRIAL_TEMPLATE_LOCALE must be set when META_TRIAL_TEMPLATE is set/);
  assert.match(r.stderr, /would refuse to boot with the WhatsApp template settings in \.env/);
  assert.match(r.stderr, /STAGING DEPLOY FAILED before anything live changed/);
  const check = h.at('run --rm -T --no-deps api node dist/template-check.js');
  assert.ok(check > h.at('build --build-arg'), 'checked in the image just built');
  assert.equal(h.at('stop api worker'), -1, 'nothing may be stopped');
  assert.equal(h.at('run --rm -T migrate'), -1, 'migrate must not run');
  assert.equal(h.at(' up '), -1);
});

test('OWN-93: settings the new image accepts let the deploy through, checked once, before the stop', () => {
  const h = host([BREAKING]);
  const r = h.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const check = h.at('run --rm -T --no-deps api node dist/template-check.js');
  assert.ok(check >= 0 && check < h.at('stop api worker'), h.calls().join('\n'));
  assert.doesNotMatch(r.stdout + r.stderr, /SLOT META_/, 'the report is never printed');
  assert.equal(
    h.calls().filter((c) => c.includes('dist/template-check.js')).length,
    1,
    'checked exactly once',
  );
});

test('OWN-93: a template check that cannot run refuses the deploy as such, not as a template problem', () => {
  const h = host([BREAKING]);
  writeFileSync(join(h.fake, 'template-check-cannot-run'), '');
  const r = h.run();
  assert.notEqual(r.status, 0);
  assert.match(
    r.stderr,
    /could not run the template check in the new image \(exit 125, no report\)/,
  );
  assert.doesNotMatch(r.stderr, /would refuse to boot/);
  assert.equal(h.at('stop api worker'), -1, 'nothing may be stopped');
  // The report itself is never printed.
  assert.doesNotMatch(r.stdout + r.stderr, /SLOT META_/);
});
