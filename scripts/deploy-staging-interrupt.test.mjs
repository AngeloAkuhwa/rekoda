/**
 * Behaviour of scripts/deploy-staging.sh when a run is interrupted. The real
 * script runs against a throwaway git checkout, with a fake `docker` and
 * `curl` standing in for the host: only the two host paths and the public
 * URL are substituted in a copy. Run with
 * `node --test scripts/deploy-staging-interrupt.test.mjs` (CI does).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SCRIPT = readFileSync(new URL('./deploy-staging.sh', import.meta.url), 'utf8');
const API = 'https://staging-api.test.invalid';

const sh = (cwd, cmd, env = {}) => {
  const r = spawnSync('bash', ['-c', cmd], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, `${cmd}\n${r.stderr}`);
  return r.stdout.trim();
};

/** A host: origin with two commits on main, a checkout at the first, fakes. */
function host({ buildSeconds = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-staging-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const dir = join(root, 'rekoda');
  const fake = join(root, 'fake');
  mkdirSync(fake);
  sh(root, `git init -q --bare -b main ${origin} && git init -q -b main ${work}`);
  const commit = (n) => {
    mkdirSync(join(work, 'packages/db/migrations/meta'), { recursive: true });
    writeFileSync(join(work, 'docker-compose.prod.yml'), `# ${n}\n`);
    writeFileSync(
      join(work, 'packages/db/migrations/meta/_journal.json'),
      JSON.stringify({ entries: [{ tag: '0000_init' }] }),
    );
    sh(
      work,
      `git add -A && git -c user.name=t -c user.email=t@t commit -q -m c${n} && git push -q ${origin} main`,
    );
    return sh(work, 'git rev-parse HEAD');
  };
  const prev = commit(1);
  const next = commit(2);
  sh(root, `git clone -q ${origin} ${dir}`);
  sh(dir, `git checkout -q --detach ${prev}`);
  writeFileSync(
    join(dir, '.env'),
    `REKODA_API_PUBLIC_URL=${API}\nREKODA_RELEASE=staging-${prev.slice(0, 7)}\n`,
  );
  mkdirSync(join(dir, 'secrets'));
  const health = (sha) =>
    JSON.stringify({
      status: 'ok',
      database: 'up',
      release: `staging-${sha.slice(0, 7)}`,
      commit: sha.slice(0, 7),
      migrations: 1,
    });
  writeFileSync(join(fake, 'health.json'), health(prev));
  writeFileSync(join(fake, 'next-health.json'), health(next));
  const bin = (name, body) => {
    writeFileSync(join(fake, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(fake, name), 0o755);
  };
  bin('curl', `cat "${fake}/health.json"`);
  // `docker compose ... up` makes the next release the running one.
  bin(
    'docker',
    `case "$*" in
  *build*) sleep ${buildSeconds} ;;
  *" up "*) cp "${fake}/next-health.json" "${fake}/health.json" ;;
  *network\\ inspect*) echo '172.30.10.1 false' ;;
esac
exit 0`,
  );
  const script = join(root, 'deploy.sh');
  writeFileSync(
    script,
    SCRIPT.replaceAll('/opt/rekoda', dir).replaceAll('https://staging-api.myrekoda.com', API),
  );
  const env = { PATH: `${fake}:${process.env.PATH}` };
  const read = {
    head: () => sh(dir, 'git rev-parse HEAD'),
    release: () => sh(dir, "sed -n 's/^REKODA_RELEASE=//p' .env"),
    marker: () => existsSync(join(dir, '.git/rekoda-deploy-staging.state')),
  };
  const run = (...args) =>
    spawnSync('bash', [script, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  /** The state a SIGKILLed run leaves: the new commit prepared, a marker. */
  const killedWhilePrepared = (phase = 'prepared') => {
    sh(dir, `git checkout -q --detach ${next}`);
    sh(dir, `sed -i 's/^REKODA_RELEASE=.*/REKODA_RELEASE=staging-${next.slice(0, 7)}/' .env`);
    writeFileSync(
      join(dir, '.git/rekoda-deploy-staging.state'),
      `phase=${phase}\nprev_sha=${prev}\nprev_release=staging-${prev.slice(0, 7)}\nsha=${next}\nrelease=staging-${next.slice(0, 7)}\n`,
    );
  };
  return { dir, fake, script, env, prev, next, read, run, killedWhilePrepared };
}

test('a deploy runs end to end and leaves no marker', () => {
  const h = host();
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(h.read.head(), h.next);
  assert.equal(h.read.release(), `staging-${h.next.slice(0, 7)}`);
  assert.equal(h.read.marker(), false);
});

test('SIGTERM during the build restores the checkout and release', async () => {
  const h = host({ buildSeconds: 3 });
  const child = spawn('bash', [h.script, h.next], {
    cwd: h.dir,
    env: { ...process.env, ...h.env },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  // Wait until the run has prepared the checkout (the marker exists).
  for (let i = 0; i < 100 && !(h.read.marker() && h.read.head() === h.next); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(h.read.head(), h.next, `never prepared:\n${out}`);
  child.kill('SIGTERM');
  const code = await new Promise((r) => child.on('close', r));
  assert.notEqual(code, 0);
  assert.equal(h.read.head(), h.prev, out);
  assert.equal(h.read.release(), `staging-${h.prev.slice(0, 7)}`);
  assert.equal(h.read.marker(), false);
});

test('a run killed while prepared (no trap) is restored by the next run, then deploys', () => {
  const h = host();
  h.killedWhilePrepared();
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /was interrupted before anything live changed/);
  assert.equal(h.read.head(), h.next);
  assert.equal(h.read.marker(), false);
});

test('a prepared marker is not restored while /health does not report its baseline', () => {
  const h = host();
  h.killedWhilePrepared();
  writeFileSync(
    join(h.fake, 'health.json'),
    '{"status":"ok","database":"up","release":"staging-0000000","commit":"0000000"}',
  );
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not restoring, reconcile by hand/);
  assert.equal(h.read.head(), h.next, 'the checkout must be left as found');
  assert.equal(h.read.marker(), true);
});

test('a prepared marker whose checkout was changed by hand is refused', () => {
  const h = host();
  h.killedWhilePrepared();
  sh(h.dir, `sed -i 's/^REKODA_RELEASE=.*/REKODA_RELEASE=staging-abcdef0/' .env`);
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /neither its baseline nor what it prepared/);
  assert.equal(h.read.marker(), true);
});

test('a marker whose host was already restored by hand is dropped', () => {
  const h = host();
  writeFileSync(
    join(h.dir, '.git/rekoda-deploy-staging.state'),
    `phase=prepared\nprev_sha=${h.prev}\nprev_release=staging-${h.prev.slice(0, 7)}\nsha=${h.next}\nrelease=staging-${h.next.slice(0, 7)}\n`,
  );
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(h.read.marker(), false);
});

test('a live-phase marker restores nothing: the baseline check refuses a disagreeing host', () => {
  const h = host();
  h.killedWhilePrepared('live');
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /as this checkout and \.env say/);
  assert.equal(h.read.head(), h.next, 'a live-phase host is never rewritten');
  assert.equal(h.read.release(), `staging-${h.next.slice(0, 7)}`);
  assert.equal(h.read.marker(), true);
});

test('a live-phase marker is cleared once checkout, .env and /health agree', () => {
  const h = host();
  h.killedWhilePrepared('live');
  writeFileSync(join(h.fake, 'health.json'), readFileSync(join(h.fake, 'next-health.json')));
  const r = h.run('--newer-only', h.prev);
  assert.equal(r.status, 75, r.stderr + r.stdout);
  assert.equal(h.read.marker(), false);
});

test('an unreadable marker is refused', () => {
  const h = host();
  writeFileSync(join(h.dir, '.git/rekoda-deploy-staging.state'), 'phase=prepared\nsha=nonsense\n');
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is unreadable/);
});

test('a second deployment is refused while one holds the lock', () => {
  const h = host();
  const r = spawnSync(
    'bash',
    ['-c', `exec 8>.git/rekoda-deploy-staging.lock; flock -n 8; bash ${h.script} ${h.next}`],
    { cwd: h.dir, encoding: 'utf8', env: { ...process.env, ...h.env } },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /another staging deployment is running/);
});
