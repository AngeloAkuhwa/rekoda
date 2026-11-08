/**
 * OD-48 (OWN-86): scripts/deploy-staging.sh stops the api and worker before it applies a migration
 * the running release cannot work against (0196), proves they stopped, and never advises restarting
 * the previous release once such a migration is applied. The real script runs against a throwaway
 * git checkout with a fake `docker` and `curl`. Run with
 * `node --test scripts/deploy-staging-compat.test.mjs` (CI does).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
function host(extraTags) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-compat-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const dir = join(root, 'rekoda');
  const fake = join(root, 'fake');
  mkdirSync(fake);
  sh(root, `git init -q --bare -b main ${origin} && git init -q -b main ${work}`);
  const commit = (n, tags) => {
    mkdirSync(join(work, 'packages/db/migrations/meta'), { recursive: true });
    writeFileSync(join(work, 'docker-compose.prod.yml'), `# ${n}\n`);
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
    `REKODA_API_PUBLIC_URL=${API}\nREKODA_RELEASE=staging-${prev.slice(0, 7)}\n`,
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
case "$*" in
  *"ps --status running --services"*) [ -e "${fake}/ps-fails" ] && exit 1; cat "${fake}/running" 2>/dev/null ;;
  *"info --format"*) echo "${fake}" ;;
  *"run --rm -T migrate"*) [ -e "${fake}/fail-migrate" ] && exit 1 ;;
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
  const run = () =>
    spawnSync('bash', [script, next], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fake}:${process.env.PATH}` },
    });
  const calls = () =>
    existsSync(join(fake, 'docker.log'))
      ? readFileSync(join(fake, 'docker.log'), 'utf8').split('\n').filter(Boolean)
      : [];
  const at = (needle) => calls().findIndex((c) => c.includes(needle));
  return { fake, run, calls, at };
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
