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
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SCRIPT = readFileSync(new URL('./deploy-staging.sh', import.meta.url), 'utf8');
const API = 'https://staging-api.test.invalid';
// A made-up stand-in for a Paystack key, joined at run time so no key-shaped
// literal is in the source (gitleaks). Never issued; not a credential.
const FAKE_KEY = 'placeholderkey';

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
  const third = commit(3);
  sh(root, `git clone -q ${origin} ${dir}`);
  sh(dir, `git checkout -q --detach ${prev}`);
  writeFileSync(
    join(dir, '.env'),
    `REKODA_API_PUBLIC_URL=${API}\nREKODA_RELEASE=staging-${prev.slice(0, 7)}\nPAYSTACK_SECRET_KEY=sk_test_${FAKE_KEY}\n`,
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
  // Free space is whatever the test says; a removal or cache prune may free more.
  writeFileSync(join(fake, 'free-kb'), '20000000');
  bin(
    'df',
    `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nfake 1 1 %s 1%% /\\n' "$(cat "${fake}/free-kb")"`,
  );
  // Memory available is whatever the test says (the script reads /proc/meminfo;
  // the copy under test reads this file instead).
  writeFileSync(join(fake, 'meminfo'), 'MemTotal: 4000000 kB\nMemAvailable: 3000000 kB\n');
  const real = sh(root, 'command -v git');
  // A full disk can cut a file short while git still reports success: after the
  // checkout of the next commit, empty one tracked file when asked to.
  bin(
    'git',
    `"${real}" "$@"; rc=$?
if [ -e "${fake}/truncate-on-checkout" ] && [[ "$*" == *"--detach ${next}"* ]]; then : > docker-compose.prod.yml; fi
exit $rc`,
  );
  // `docker compose ... up` makes the next release the running one.
  bin(
    'docker',
    `echo "$*" >> "${fake}/docker.log"
freed() { [ -e "${fake}/free-kb-after-prune" ] && cp "${fake}/free-kb-after-prune" "${fake}/free-kb"; return 0; }
case "$*" in
  *"info --format"*) echo "${fake}" ;;
  *"ps -aq"*) [ -e "${fake}/ps-fails" ] && exit 1; cat "${fake}/container-ids" 2>/dev/null ;;
  *"inspect --format"*) cat "${fake}/container-image-ids" 2>/dev/null ;;
  *"image ls"*) [ -e "${fake}/image-ls-fails" ] && exit 1; cat "${fake}/images" 2>/dev/null ;;
  *"image rm"*) [ -e "${fake}/image-rm-fails" ] && exit 1; echo "$3" >> "${fake}/removed"; freed ;;
  *"image prune"*|*"builder prune"*) freed ;;
  *"ps -a --format"*) [ -e "${fake}/ps-fails" ] && exit 1; cat "${fake}/containers" 2>/dev/null ;;
  *"run --rm -T migrate"*) [ -e "${fake}/fail-migrate" ] && exit 1 ;;
  *build*) if [ -e "${fake}/oom-api-build" ] && [[ "$*" == *" api" ]]; then echo 'Killed' >&2; exit 137; fi
    if [ -e "${fake}/oom-web-build" ] && [[ "$*" == *" web" ]]; then echo 'Killed' >&2; exit 137; fi
    if [ -e "${fake}/slow-web-build" ] && [[ "$*" == *" web" ]]; then sleep 3; fi
    if [ -e "${fake}/mem-low-after-api" ] && [[ "$*" == *" api" ]]; then printf 'MemAvailable: 1000 kB\\n' > "${fake}/meminfo"; fi
    if [ -e "${fake}/fail-build" ]; then echo 1000 > "${fake}/free-kb"; echo 'no space left on device' >&2; exit 1; fi; sleep ${buildSeconds} ;;
  *" up "*) cp "${fake}/next-health.json" "${fake}/health.json" ;;
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
  const env = { PATH: `${fake}:${process.env.PATH}` };
  const read = {
    head: () => sh(dir, 'git rev-parse HEAD'),
    release: () => sh(dir, "sed -n 's/^REKODA_RELEASE=//p' .env"),
    marker: () => existsSync(join(dir, '.git/rekoda-deploy-staging.state')),
  };
  const images = (...list) => writeFileSync(join(fake, 'images'), list.join('\n') + '\n');
  const removed = () =>
    existsSync(join(fake, 'removed'))
      ? readFileSync(join(fake, 'removed'), 'utf8').split('\n').filter(Boolean)
      : [];
  const dockerCalls = () => readFileSync(join(fake, 'docker.log'), 'utf8');
  const runWith = (extra, ...args) =>
    spawnSync('bash', [script, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...env, ...extra },
    });
  const run = (...args) => runWith({}, ...args);
  /** The state a SIGKILLed run leaves: the new commit prepared, a marker. */
  const killedWhilePrepared = (phase = 'prepared') => {
    sh(dir, `git checkout -q --detach ${next}`);
    sh(dir, `sed -i 's/^REKODA_RELEASE=.*/REKODA_RELEASE=staging-${next.slice(0, 7)}/' .env`);
    writeFileSync(
      join(dir, '.git/rekoda-deploy-staging.state'),
      `phase=${phase}\nprev_sha=${prev}\nprev_release=staging-${prev.slice(0, 7)}\nsha=${next}\nrelease=staging-${next.slice(0, 7)}\n`,
    );
  };
  return {
    dir,
    fake,
    script,
    env,
    runWith,
    prev,
    next,
    third,
    read,
    run,
    killedWhilePrepared,
    images,
    removed,
    dockerCalls,
  };
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

test('a live-phase marker is not skipped past, even when checkout, .env and /health agree', () => {
  const h = host();
  h.killedWhilePrepared('live');
  writeFileSync(join(h.fake, 'health.json'), readFileSync(join(h.fake, 'next-health.json')));
  const r = h.run('--newer-only', h.prev);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stderr, /killed after migrate or up began/);
  assert.equal(h.read.marker(), true);
});

test('a live-phase marker is cleared only once a deploy runs to the end', () => {
  const h = host();
  h.killedWhilePrepared('live');
  writeFileSync(join(h.fake, 'health.json'), readFileSync(join(h.fake, 'next-health.json')));
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(h.read.marker(), false);
});

test('a forward deploy that fails before going live keeps an earlier live-phase marker', () => {
  const h = host();
  h.killedWhilePrepared('live');
  writeFileSync(join(h.fake, 'health.json'), readFileSync(join(h.fake, 'next-health.json')));
  writeFileSync(join(h.fake, 'fail-build'), '');
  const r = h.run(h.third);
  assert.notEqual(r.status, 0);
  assert.equal(h.read.head(), h.next, 'the checkout goes back to the half-rolled-out release');
  assert.equal(h.read.release(), `staging-${h.next.slice(0, 7)}`);
  assert.equal(h.read.marker(), true, 'the half-finished live deploy must stay on record');
  const state = readFileSync(join(h.dir, '.git/rekoda-deploy-staging.state'), 'utf8');
  assert.match(state, /^phase=live$/m);
});

test('the marker is written whole: a leftover temporary file never counts', () => {
  const h = host();
  writeFileSync(join(h.dir, '.git/rekoda-deploy-staging.state.tmp'), 'phase=pre');
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
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

/* ---- disk exhaustion, image retention and safe recovery ---- */

const app = (sha) => `rekoda-app:staging-${sha.slice(0, 7)}`;
const web = (sha) => `rekoda-web:staging-${sha.slice(0, 7)}`;
const OLD = [
  'rekoda-app:staging-0ld0ld0'.replace('0ld0ld0', 'aaaaaaa'),
  'rekoda-web:staging-aaaaaaa',
];
const NOT_OURS = [
  'postgres:16-alpine',
  'caddy:2.11.4-alpine',
  'rekoda-app:v1.0.0',
  'rekoda-app:latest',
];

test('after a deploy, only older staging images go: the running release and its rollback stay', () => {
  const h = host();
  h.images(app(h.next), web(h.next), app(h.prev), web(h.prev), ...OLD, ...NOT_OURS);
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(h.removed().sort(), [...OLD].sort());
});

test('an image a container still uses is kept even when no release names it', () => {
  const h = host();
  h.images(app(h.next), app(h.prev), ...OLD);
  writeFileSync(join(h.fake, 'containers'), 'rekoda-app:staging-aaaaaaa\n');
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // A release is kept whole: its web image goes with its app image.
  assert.deepEqual(h.removed(), []);
});

test('cleanup never touches a volume, a container or the database', () => {
  const h = host();
  h.images(app(h.prev), ...OLD);
  writeFileSync(join(h.fake, 'free-kb'), '1000');
  writeFileSync(join(h.fake, 'free-kb-after-prune'), '20000000');
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const calls = h.dockerCalls();
  assert.doesNotMatch(
    calls,
    /volume|system prune|container prune|\bdown\b|rmi|--volumes|image prune -a|image rm -f/,
  );
  assert.match(calls, /builder prune/);
});

test('a host below the free-space floor is cleaned, then deploys if that was enough', () => {
  const h = host();
  h.images(app(h.prev), ...OLD);
  writeFileSync(join(h.fake, 'free-kb'), '1000');
  writeFileSync(join(h.fake, 'free-kb-after-prune'), '20000000');
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /only 1000 KiB free/);
  assert.ok(h.removed().includes('rekoda-app:staging-aaaaaaa'));
  assert.ok(!h.removed().includes(app(h.prev)), 'the running release is never removed');
});

test('a host that cleanup cannot free is refused before anything changes', () => {
  const h = host();
  h.images(app(h.prev), ...OLD);
  writeFileSync(join(h.fake, 'free-kb'), '1000');
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Free space by hand first/);
  assert.match(r.stderr, /No volume, database file or backup is ever removed/);
  assert.equal(h.read.head(), h.prev);
  assert.equal(h.read.release(), `staging-${h.prev.slice(0, 7)}`);
  assert.equal(h.read.marker(), false);
  assert.ok(!existsSync(join(h.fake, 'built')));
  assert.doesNotMatch(h.dockerCalls(), /compose.* (build|up|run)/);
});

test('cleanup under pressure keeps the releases an unfinished marker names', () => {
  const h = host();
  h.killedWhilePrepared('live');
  writeFileSync(join(h.fake, 'health.json'), readFileSync(join(h.fake, 'next-health.json')));
  h.images(app(h.prev), web(h.prev), app(h.next), web(h.next), ...OLD);
  writeFileSync(join(h.fake, 'free-kb'), '1000');
  writeFileSync(join(h.fake, 'free-kb-after-prune'), '20000000');
  // Refused after the cleanup (a live marker is not skipped past), so no routine
  // cleanup follows and the marker still stands.
  const r = h.run('--newer-only', h.prev);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.equal(h.read.marker(), true);
  assert.deepEqual(h.removed().sort(), [...OLD].sort());
});

test('an unreadable marker is refused before any cleanup can run', () => {
  const h = host();
  writeFileSync(join(h.dir, '.git/rekoda-deploy-staging.state'), 'phase=live\nrelease=;rm -rf\n');
  h.images(app(h.prev), ...OLD);
  writeFileSync(join(h.fake, 'free-kb'), '1000');
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is unreadable/);
  assert.deepEqual(h.removed(), []);
});

test('when Docker cannot say what containers exist, nothing is removed and the deploy still succeeds', () => {
  const h = host();
  h.images(app(h.next), app(h.prev), ...OLD);
  writeFileSync(join(h.fake, 'ps-fails'), '');
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr, /image cleanup skipped/);
  assert.deepEqual(h.removed(), []);
});

test('missing image metadata skips cleanup and the deploy still succeeds', () => {
  const h = host();
  writeFileSync(join(h.fake, 'image-ls-fails'), '');
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr, /the image list could not be read/);
  assert.deepEqual(h.removed(), []);
});

test('a failing image removal never fails the deploy', () => {
  const h = host();
  h.images(app(h.next), app(h.prev), ...OLD);
  writeFileSync(join(h.fake, 'image-rm-fails'), '');
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(h.read.head(), h.next);
  assert.equal(h.read.marker(), false);
});

test('an old tag that names the same image as a kept release is kept', () => {
  const h = host();
  h.images(
    `${app(h.next)} sha256:same`,
    `${app(h.prev)} sha256:prev`,
    `${OLD[0]} sha256:same`,
    `${OLD[1]} sha256:gone`,
  );
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(h.removed(), [OLD[1]]);
});

test('an image behind a stopped container is kept by its ID even when its tag is old', () => {
  const h = host();
  h.images(
    `${app(h.next)} sha256:n`,
    `${app(h.prev)} sha256:p`,
    `${OLD[0]} sha256:stopped`,
    `${OLD[1]} sha256:gone`,
  );
  writeFileSync(join(h.fake, 'container-ids'), 'abc123\n');
  writeFileSync(join(h.fake, 'container-image-ids'), 'sha256:stopped\n');
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(h.removed(), [OLD[1]]);
});

test('tracked files left empty by a full disk are named and the run refuses', () => {
  const h = host();
  writeFileSync(join(h.dir, 'docker-compose.prod.yml'), '');
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /empty here but not in the commit.*docker-compose\.prod\.yml/);
  assert.match(r.stderr, /tracked local modifications/);
  assert.equal(
    readFileSync(join(h.dir, 'docker-compose.prod.yml'), 'utf8'),
    '',
    'refuses, never discards',
  );
});

test('a checkout that git reports done but left a file empty is refused and kept as evidence', () => {
  const h = host();
  writeFileSync(join(h.fake, 'truncate-on-checkout'), '');
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /empty or cut short/);
  assert.match(r.stderr, /not restoring/);
  assert.match(r.stderr, /evidence kept in/);
  // Nothing is forced or discarded: the damaged file, the checkout and the
  // marker stay for a person to reconcile.
  assert.equal(h.read.head(), h.next);
  assert.equal(readFileSync(join(h.dir, 'docker-compose.prod.yml'), 'utf8'), '');
  assert.equal(h.read.marker(), true);
  const evidence = readdirSync(join(h.dir, '.git')).filter((f) =>
    f.startsWith('rekoda-deploy-evidence-'),
  );
  assert.equal(evidence.length, 1);
  assert.match(readFileSync(join(h.dir, '.git', evidence[0]), 'utf8'), /docker-compose\.prod\.yml/);
  // The next run does not clear it silently either.
  rmSync(join(h.fake, 'truncate-on-checkout'));
  const again = h.run(h.next);
  assert.notEqual(again.status, 0);
  assert.equal(h.read.marker(), true);
  assert.equal(readFileSync(join(h.dir, 'docker-compose.prod.yml'), 'utf8'), '');
});

test('a prepared marker whose files were edited by hand is not restored over the edit', () => {
  const h = host();
  h.killedWhilePrepared();
  writeFileSync(join(h.dir, 'docker-compose.prod.yml'), '# my local work\n');
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /tracked local modifications/);
  assert.equal(readFileSync(join(h.dir, 'docker-compose.prod.yml'), 'utf8'), '# my local work\n');
  assert.equal(h.read.marker(), true);
});

test('a build that runs out of space restores the baseline and removes nothing in the failure path', () => {
  const h = host();
  h.images(app(h.prev), ...OLD);
  writeFileSync(join(h.fake, 'fail-build'), '');
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /STAGING DEPLOY FAILED before anything live changed/);
  assert.equal(h.read.head(), h.prev);
  assert.equal(h.read.release(), `staging-${h.prev.slice(0, 7)}`);
  assert.equal(h.read.marker(), false);
  assert.deepEqual(h.removed(), [], 'cleanup waits for a verified deploy');
});

test('a run killed while prepared is restored even when the next run deploys a different commit', () => {
  const h = host();
  h.killedWhilePrepared();
  // Once `up` runs, /health must name the commit this run deploys.
  writeFileSync(
    join(h.fake, 'next-health.json'),
    JSON.stringify({
      status: 'ok',
      database: 'up',
      release: `staging-${h.third.slice(0, 7)}`,
      commit: h.third.slice(0, 7),
      migrations: 1,
    }),
  );
  const r = h.run(h.third);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /was interrupted before anything live changed/);
  assert.equal(h.read.head(), h.third);
  assert.equal(h.read.marker(), false);
});

test('many emptied files still produce the full-disk diagnostic and a refusal', () => {
  const h = host();
  for (let i = 0; i < 40; i++) {
    const f = join(h.dir, `a-long-tracked-file-name-number-${i}.txt`);
    writeFileSync(f, 'x\n');
    sh(h.dir, `git add -A && git -c user.name=t -c user.email=t@t commit -q -m f${i}`);
    writeFileSync(f, '');
  }
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /empty here but not in the commit/);
  assert.match(r.stderr, /tracked local modifications/);
});

test('a cancelled build on a full disk still restores the baseline', async () => {
  const h = host({ buildSeconds: 3 });
  const child = spawn('bash', [h.script, h.next], {
    cwd: h.dir,
    env: { ...process.env, ...h.env },
  });
  for (let i = 0; i < 100 && !(h.read.marker() && h.read.head() === h.next); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  writeFileSync(join(h.fake, 'free-kb'), '1000');
  child.kill('SIGTERM');
  await new Promise((r) => child.on('close', r));
  assert.equal(h.read.head(), h.prev);
  assert.equal(h.read.release(), `staging-${h.prev.slice(0, 7)}`);
  assert.equal(h.read.marker(), false);
});

test('a kill between the checkout and the .env edit leaves a marker the next run reconciles', () => {
  const h = host();
  h.killedWhilePrepared();
  sh(h.dir, `sed -i 's/^REKODA_RELEASE=.*/REKODA_RELEASE=staging-${h.prev.slice(0, 7)}/' .env`);
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /was interrupted before anything live changed/);
  assert.equal(h.read.head(), h.next);
  assert.equal(h.read.marker(), false);
});

test('a kill between the two halves of a restore leaves a marker the next run reconciles', () => {
  const h = host();
  h.killedWhilePrepared();
  sh(h.dir, `git checkout -q --detach ${h.prev}`);
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(h.read.head(), h.next);
  assert.equal(h.read.release(), `staging-${h.next.slice(0, 7)}`);
  assert.equal(h.read.marker(), false);
});

test('a marker that cannot be written (full disk) ends as a refusal, not a failed restore', () => {
  const h = host();
  mkdirSync(join(h.dir, '.git/rekoda-deploy-staging.state.tmp'));
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /restore did not complete/);
  assert.equal(h.read.head(), h.prev);
  assert.equal(h.read.release(), `staging-${h.prev.slice(0, 7)}`);
  assert.equal(h.read.marker(), false);
});

test('a cancelled run that restores keeps its signal exit status even with an earlier live marker', async () => {
  const h = host({ buildSeconds: 3 });
  h.killedWhilePrepared('live');
  writeFileSync(join(h.fake, 'health.json'), readFileSync(join(h.fake, 'next-health.json')));
  const child = spawn('bash', [h.script, h.third], {
    cwd: h.dir,
    env: { ...process.env, ...h.env },
  });
  for (let i = 0; i < 100 && h.read.head() !== h.third; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(h.read.head(), h.third);
  child.kill('SIGTERM');
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 143);
  assert.equal(h.read.head(), h.next);
  assert.equal(h.read.marker(), true);
});

test('a failed build after recovering an interrupted deploy of another commit restores the baseline', () => {
  const h = host();
  h.killedWhilePrepared();
  writeFileSync(join(h.fake, 'fail-build'), '');
  const r = h.run(h.third);
  assert.notEqual(r.status, 0);
  assert.equal(h.read.head(), h.prev);
  assert.equal(h.read.release(), `staging-${h.prev.slice(0, 7)}`);
  assert.equal(h.read.marker(), false);
});

test('a verified deploy records the release it replaced, and a later urgent cleanup keeps it', () => {
  const h = host();
  h.images(app(h.next), app(h.prev), ...OLD);
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(
    readFileSync(join(h.dir, '.git/rekoda-deploy-staging.rollback'), 'utf8').trim(),
    `staging-${h.prev.slice(0, 7)}`,
  );
  // The next deploy finds the disk short and cannot recover it: the release
  // before the running one (as recorded above) must survive the cleanup.
  const g = host();
  writeFileSync(join(g.dir, '.git/rekoda-deploy-staging.rollback'), 'staging-aaaaaaa\n');
  g.images(app(g.prev), ...OLD, 'rekoda-app:staging-bbbbbbb', 'rekoda-web:staging-bbbbbbb');
  writeFileSync(join(g.fake, 'free-kb'), '1000');
  const refused = g.run(g.next);
  assert.notEqual(refused.status, 0);
  assert.deepEqual(g.removed().sort(), [
    'rekoda-app:staging-bbbbbbb',
    'rekoda-web:staging-bbbbbbb',
  ]);
});

test('finishing an interrupted live deploy keeps the release it started from as the rollback', () => {
  const h = host();
  h.killedWhilePrepared('live');
  writeFileSync(join(h.fake, 'health.json'), readFileSync(join(h.fake, 'next-health.json')));
  h.images(app(h.next), app(h.prev), ...OLD);
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(h.read.marker(), false);
  assert.equal(
    readFileSync(join(h.dir, '.git/rekoda-deploy-staging.rollback'), 'utf8').trim(),
    `staging-${h.prev.slice(0, 7)}`,
  );
  assert.deepEqual(h.removed().sort(), [...OLD].sort());
});

test('repeated retries of an interrupted live deploy still keep the original rollback', () => {
  const h = host();
  h.killedWhilePrepared('live');
  writeFileSync(join(h.fake, 'health.json'), readFileSync(join(h.fake, 'next-health.json')));
  h.images(app(h.next), app(h.prev), ...OLD);
  writeFileSync(join(h.fake, 'fail-migrate'), '');
  const second = h.run(h.next);
  assert.notEqual(second.status, 0);
  const state = readFileSync(join(h.dir, '.git/rekoda-deploy-staging.state'), 'utf8');
  assert.match(state, new RegExp(`^prev_release=staging-${h.prev.slice(0, 7)}$`, 'm'));
  rmSync(join(h.fake, 'fail-migrate'));
  const third = h.run(h.next);
  assert.equal(third.status, 0, third.stderr + third.stdout);
  assert.equal(
    readFileSync(join(h.dir, '.git/rekoda-deploy-staging.rollback'), 'utf8').trim(),
    `staging-${h.prev.slice(0, 7)}`,
  );
  assert.deepEqual(h.removed().sort(), [...OLD].sort());
});

test('a rollback record that cannot be written keeps the marker and removes nothing', () => {
  const h = host();
  h.images(app(h.next), app(h.prev), ...OLD);
  mkdirSync(join(h.dir, '.git/rekoda-deploy-staging.rollback.tmp'));
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not be recorded/);
  assert.equal(h.read.marker(), true);
  assert.deepEqual(h.removed(), []);
});

/* ---- memory: one build at a time, and none on a host too short of memory ---- */

const builds = (log) => log.split('\n').filter((line) => / build /.test(line));

test('the images are built one after the other, api then web, never a bare build', () => {
  const h = host();
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const calls = builds(h.dockerCalls());
  assert.equal(calls.length, 2, calls.join('\n'));
  assert.match(calls[0], / build --build-arg REKODA_COMMIT=\w+ api$/);
  assert.match(calls[1], / build --build-arg REKODA_COMMIT=\w+ web$/);
});

test('a host short of memory is refused before anything changes', () => {
  const h = host();
  writeFileSync(join(h.fake, 'meminfo'), 'MemAvailable: 500000 kB\n');
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /only 500000 KiB of memory available before any build/);
  assert.match(r.stderr, /Nothing live was changed/);
  /* Refused BEFORE the checkout and the prepared marker, not restored after them. */
  assert.doesNotMatch(r.stdout, /== check out the commit/);
  assert.doesNotMatch(r.stderr, /restor/i);
  assert.equal(h.read.head(), h.prev);
  assert.equal(h.read.release(), `staging-${h.prev.slice(0, 7)}`);
  assert.equal(h.read.marker(), false);
  assert.doesNotMatch(h.dockerCalls(), /compose.* (build|up|run)/);
});

test('a host that cannot say how much memory it has is refused, not trusted', () => {
  const h = host();
  writeFileSync(join(h.fake, 'meminfo'), 'MemTotal: 4000000 kB\n');
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /only unknown KiB of memory available before any build/);
  assert.doesNotMatch(h.dockerCalls(), /compose.* (build|up|run)/);
});

test('a host may raise the memory floor, never lower it', () => {
  const h = host();
  /* Below the default floor: lowering it must not let this deploy through. */
  writeFileSync(join(h.fake, 'meminfo'), 'MemAvailable: 500000 kB\n');
  const lowered = h.runWith({ REKODA_DEPLOY_MIN_MEM_KB: '1' }, h.next);
  assert.notEqual(lowered.status, 0, 'a lower floor than the default is ignored');
  assert.match(lowered.stderr, /needs at least 1048576/);
  const h2 = host();
  writeFileSync(join(h2.fake, 'meminfo'), 'MemAvailable: 1500000 kB\n');
  const raised = h2.runWith({ REKODA_DEPLOY_MIN_MEM_KB: '2000000' }, h2.next);
  assert.notEqual(raised.status, 0);
  assert.match(raised.stderr, /needs at least 2000000/);
});

test('memory that runs out after the api build stops the web build and migrates nothing', () => {
  const h = host();
  writeFileSync(join(h.fake, 'mem-low-after-api'), '');
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /memory available before the web build/);
  const log = h.dockerCalls();
  assert.equal(builds(log).length, 1, 'only the api image was built');
  assert.doesNotMatch(log, /run --rm -T migrate| up /);
  /* Still in the prepared phase, so the refusal restores the baseline itself. */
  assert.equal(h.read.head(), h.prev);
  assert.equal(h.read.release(), `staging-${h.prev.slice(0, 7)}`);
  assert.equal(h.read.marker(), false);
});

test('an api build the kernel kills for memory restores the baseline and builds nothing more', () => {
  const h = host();
  writeFileSync(join(h.fake, 'oom-api-build'), '');
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  const log = h.dockerCalls();
  assert.equal(builds(log).length, 1, 'the web build never started');
  assert.doesNotMatch(log, /run --rm -T migrate| up /);
  assert.equal(h.read.head(), h.prev);
  assert.equal(h.read.release(), `staging-${h.prev.slice(0, 7)}`);
  assert.equal(h.read.marker(), false);
});

test('a web build the kernel kills for memory restores the baseline and migrates nothing', () => {
  const h = host();
  writeFileSync(join(h.fake, 'oom-web-build'), '');
  const r = h.run(h.next);
  assert.notEqual(r.status, 0);
  const log = h.dockerCalls();
  assert.equal(builds(log).length, 2, 'the api image was built, then the web build was killed');
  assert.doesNotMatch(log, /run --rm -T migrate| up /);
  assert.equal(h.read.head(), h.prev);
  assert.equal(h.read.release(), `staging-${h.prev.slice(0, 7)}`);
  assert.equal(h.read.marker(), false);
  /* Nothing live changed: /health still names the baseline release. */
  assert.match(readFileSync(join(h.fake, 'health.json'), 'utf8'), new RegExp(h.prev.slice(0, 7)));
});

test('a cancel during the web build, after the api image was built, restores the baseline', async () => {
  const h = host();
  writeFileSync(join(h.fake, 'slow-web-build'), '');
  const child = spawn('bash', [h.script, h.next], {
    cwd: h.dir,
    env: { ...process.env, ...h.env },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const webStarted = () =>
    existsSync(join(h.fake, 'docker.log')) &&
    / build .* web$/m.test(readFileSync(join(h.fake, 'docker.log'), 'utf8'));
  for (let i = 0; i < 100 && !webStarted(); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(webStarted(), `the web build never started:\n${out}`);
  child.kill('SIGTERM');
  const code = await new Promise((r) => child.on('close', r));
  assert.notEqual(code, 0);
  assert.equal(h.read.head(), h.prev, out);
  assert.equal(h.read.release(), `staging-${h.prev.slice(0, 7)}`);
  assert.equal(h.read.marker(), false);
  assert.doesNotMatch(h.dockerCalls(), /run --rm -T migrate| up /);
});

test('the deploy output shows the memory each build left', () => {
  const h = host();
  const r = h.run(h.next);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const when of ['before the api build', 'after the api build', 'after the web build']) {
    assert.match(r.stdout, new RegExp(`memory available ${when}: \\d+ KiB`));
  }
});
