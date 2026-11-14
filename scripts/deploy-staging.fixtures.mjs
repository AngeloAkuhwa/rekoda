/**
 * The throwaway staging host the deploy-staging script tests run against: a bare origin with two
 * commits, a checkout at the first, a .env, and fake `docker`, `curl` and `df` on PATH. Shared by
 * scripts/deploy-staging-compat.test.mjs and scripts/deploy-staging-envfile.test.mjs.
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

const SCRIPT = readFileSync(new URL('./deploy-staging.sh', import.meta.url), 'utf8');
export const API = 'https://staging-api.test.invalid';
export const BREAKING = '0196_plan_fields_guard';

const sh = (cwd, cmd) => {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd}\n${r.stderr}`);
  return r.stdout.trim();
};

/** A host whose second commit adds the given migration tags to the journal. */
/* The OD-37 principals' URLs a host has once runbook step 1 is done (placeholder passwords). */
export const PRINCIPAL_ENV =
  'SETTLEMENT_DATABASE_URL=postgres://rekoda_settlement:placeholder@postgres:5432/rekoda\n' +
  'OPERATOR_DATABASE_URL=postgres://rekoda_billing_operator:placeholder@postgres:5432/rekoda\n';

/* Staging always holds a Paystack TEST key (OWN-70); the deploy refuses a host without one. The
 * placeholder keys are built at run time so no key-shaped literal sits in the source (secret scan). */
export const TEST_KEY = ['sk', 'test', 'placeholderkey'].join('_');
export const LIVE_KEY = ['sk', 'live', 'placeholderkey'].join('_');
export const PAYSTACK_ENV = `PAYSTACK_SECRET_KEY=${TEST_KEY}\n`;

/**
 * With `realDocker` (the path of a real docker binary with the compose plugin), the compose file is
 * a real one and every call the script makes that reads it is also resolved by real Compose with the
 * same leading arguments (`docker compose ... -f docker-compose.prod.yml config`), in the script's
 * environment. Only the class of the PAYSTACK_SECRET_KEY settlement would get is recorded (test,
 * live, other or error), never the value: `resolvedKeys()` returns one class per call.
 */
export function host(
  extraTags,
  extraEnv = PRINCIPAL_ENV,
  paystackEnv = PAYSTACK_ENV,
  { realDocker } = {},
) {
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
      realDocker
        ? `# ${n}\nservices:\n  settlement:\n    image: busybox\n    environment:\n      PAYSTACK_SECRET_KEY: \${PAYSTACK_SECRET_KEY:-}\n`
        : `# ${n}\n# A comment naming the script's own \${API_URL} and \${REKODA_DIR}, which no clear may touch.\nx-interpolated: ['\${PAYSTACK_SECRET_KEY:-}', '\${VAULT_KEY:?}', '\${REKODA_RELEASE:?}'${
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
${realDocker ? resolveWithRealCompose(realDocker, fake) : ''}
case "$*" in *"-f docker-compose.prod.yml"*) echo "PAYSTACK_SECRET_KEY=\${PAYSTACK_SECRET_KEY-unset} VAULT_KEY=\${VAULT_KEY-unset} ONLY_IN_TARGET=\${ONLY_IN_TARGET-unset}" >> "${fake}/shell-env.log" ;; esac
case "$*" in
  *"stop api worker"*) [ -e "${fake}/stop-fails" ] && exit 1; [ -e "${fake}/hang-stop" ] && sleep 60 ;;
  *"ps --status running --services"*) [ -e "${fake}/ps-fails" ] && exit 1; cat "${fake}/running" 2>/dev/null ;;
  *"info --format"*) echo "${fake}" ;;
  *"run --rm -T migrate"*) [ -e "${fake}/hang-migrate" ] && sleep 60; [ -e "${fake}/fail-migrate" ] && exit 1 ;;
  *"run --rm -T --no-deps api node dist/template-check.js"*)
    [ -e "${fake}/template-check-fails" ] && { echo 'META_TRIAL_TEMPLATE_LOCALE must be set when META_TRIAL_TEMPLATE is set' >&2; echo 'RESULT REFUSED'; exit 1; }
    [ -e "${fake}/template-check-cannot-run" ] && exit 125
    echo 'SLOT META_OTP_TEMPLATE required set set'; echo 'RESULT BOOTS' ;;
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
  const resolvedKeys = () =>
    existsSync(join(fake, 'resolved.log'))
      ? readFileSync(join(fake, 'resolved.log'), 'utf8').trim().split('\n')
      : [];
  return { dir, fake, run, runInterrupted, calls, at, shellEnvSeen, resolvedKeys };
}

/* The fake docker's prelude in real-Compose mode: the arguments up to and including the compose
 * file, handed to real Compose's `config`, and the resolved key reduced to its class. */
const resolveWithRealCompose = (realDocker, fake) => `pre=()
for a in "$@"; do pre+=("$a"); [ "$a" = docker-compose.prod.yml ] && break; done
if [ "\${pre[0]-}" = compose ] && [ "\${pre[-1]}" = docker-compose.prod.yml ]; then
  out=$("${realDocker}" "\${pre[@]}" config --format json 2>/dev/null) || out=ERROR
  case "$out" in
    ERROR) c=error ;;
    *'"PAYSTACK_SECRET_KEY": "sk_test_'*) c=test ;;
    *'"PAYSTACK_SECRET_KEY": "sk_live_'*) c=live ;;
    *) c=other ;;
  esac
  echo "$c" >> "${fake}/resolved.log"
fi`;
