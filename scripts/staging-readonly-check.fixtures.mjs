/**
 * The fake staging host the staging-readonly-check tests run the real script against: a throwaway
 * checkout with a fake `docker` and `curl` on PATH (see staging-readonly-check.test.mjs). Not a
 * test file; imported by it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SCRIPT = readFileSync(new URL('./staging-readonly-check.sh', import.meta.url), 'utf8');

/**
 * A host checkout plus fakes. The fake `docker compose` reads all of stdin, as
 * a real `compose exec` can, and logs what it saw. `failKey` makes the
 * per-slot query for that one variable fail, as an exec that dies would; with `failIn` set to
 * `api` or `worker`, only in that container.
 */
export function host({
  failKey = '',
  failIn = '',
  env = { META_TRIAL_TEMPLATE: 'rekoda_trial_ending' },
  workerEnv = {},
  migrations = 'applied',
  dotenv = 'REKODA_RELEASE=staging-test\n',
  images = {},
  health = null,
  journal = null,
  ledger = null,
  services = null,
  logs = '',
  webCode = '200',
  webExit = 0,
  healthExit = 0,
  // The api container refuses a container-side query (`exec -T api sh -c`), as a stopped or
  // restarting container does, so nothing it resolved can be read.
  apiQueryFails = false,
  // Container creation times later than any .env this fixture writes, unless a test says
  // otherwise. A missing service has no creation time. The start time is always new: a restart
  // resets it, and it must never be what decides.
  created = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'staging-check-'));
  const dir = join(root, 'rekoda');
  const fake = join(root, 'fake');
  mkdirSync(dir);
  mkdirSync(fake);
  const run = (cmd) => {
    const r = spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  run('git init -q -b main . && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m c');
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const fill = (text) => text.replaceAll('{sha7}', sha.slice(0, 7));
  writeFileSync(join(dir, '.env'), fill(dotenv));
  if (journal) {
    mkdirSync(join(dir, 'packages/db/migrations/meta'), { recursive: true });
    writeFileSync(
      join(dir, 'packages/db/migrations/meta/_journal.json'),
      JSON.stringify({ entries: journal.map((tag, idx) => ({ idx, tag })) }, null, 2),
    );
  }
  const envLine = (vars) =>
    Object.entries(vars)
      .map(([key, value]) => `${key}='${value}'`)
      .join(' ');
  const bin = (name, body) => {
    writeFileSync(join(fake, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(fake, name), 0o755);
  };
  bin(
    'docker',
    `
if [ "$1" = compose ]; then
  n="$(cat | wc -c)"
  echo "compose $* stdin=$n" >> "${join(fake, 'calls.log')}"
  case " $* " in
    *" exec -T api true "*) exit 0 ;;
    *" ps -a "*)
      ${services === null ? 'exit 0' : `printf '%s\\n' ${services.map((l) => `'${l}'`).join(' ')}; exit 0`} ;;
    *" logs "*)
      # Nest writes errors to stderr, which compose passes through on its own stderr.
      ${logs === 'fail' ? 'exit 1' : `printf '%s\\n' '${logs}' >&2; exit 0`} ;;
    *" exec -T api sh -c "*)
      ${apiQueryFails ? 'exit 1' : ':'}
      # A container-side query with no -e: run it against the api fixture environment.
      # argv: compose -f FILE exec -T api sh -c SNIPPET, so the snippet is the 9th argument.
      shift 8
      env -i ${envLine(env)} sh -c "$1"
      exit $? ;;
    *" ps -q "*)
      svc="\${@: -1}"
      case "$svc" in
${Object.keys(images)
  .map((svc) => `        ${svc}) echo id-${svc} ;;`)
  .join('\n')}
      esac
      exit 0 ;;
    *"select tag from rekoda_migrations"*)
      ${
        ledger === 'fail'
          ? 'echo "psql: FATAL: password authentication failed for user leakyuser" >&2; exit 2'
          : `printf '%s\\n' ${(ledger ?? []).map((t) => `'${t}'`).join(' ')}`
      }
      exit 0 ;;
    *" -e Q="*)
      # A migration query: answer from the fixture. "fail" writes a client error that names a
      # database user, as psql does, to prove it never reaches the output.
      case "${migrations}" in
        applied) echo t ;;
        missing) echo f ;;
        noledger) case "$*" in *rekoda_migrations*) echo f ;; *) echo t ;; esac ;;
        ledgeronly) case "$*" in *rekoda_migrations*) echo t ;; *) echo f ;; esac ;;
        noaddr) case "$*" in *billing_email_address_requests*|*rekoda_migrations*) echo f ;; *) echo t ;; esac ;;
        partial) case "$*" in *billing_interval*) echo f ;; *) echo t ;; esac ;;
        no0189) case "$*" in *reminder_batch*|*0189_reminder_batches*) echo f ;; *) echo t ;; esac ;;
        # 0187's constraint dropped while its ledger tag stays: objects f, tag t.
        broken0187) case "$*" in *rekoda_migrations*) echo t ;; *businesses_payment_instruction_all_or_nothing*) echo f ;; *) echo t ;; esac ;;
        # 0190's column constraint dropped while its ledger tag stays.
        broken0190) case "$*" in *rekoda_migrations*) echo t ;; *jobs_failure_category_ck*) echo f ;; *) echo t ;; esac ;;
        fail) echo "psql: FATAL: password authentication failed for user leakyuser" >&2; exit 2 ;;
      esac
      exit 0 ;;
    *" exec -T -e K=${failKey || '__none__'} "*${failIn ? `" ${failIn} sh -c "*` : ''}) exit 1 ;;
    *" exec -T -e K="*)
      # Run the container-side snippet for real, against the fixture environment.
      # argv: compose -f FILE exec -T (-e NAME=VALUE)... SERVICE sh -c SNIPPET
      shift 5; extra=()
      while [ "$1" = -e ]; do extra+=("$2"); shift 2; done
      svc="$1"; shift 3
      if [ "$svc" = worker ]; then env -i ${envLine(workerEnv)} "\${extra[@]}" sh -c "$1"
      else env -i ${envLine(env)} "\${extra[@]}" sh -c "$1"; fi
      exit $? ;;
  esac
  exit 0
fi
if [ "$1" = inspect ]; then
  case "$*" in *StartedAt*) echo '2999-06-01T00:00:00Z'; exit 0 ;; esac
  case "$*" in *Created*)
    case "\${@: -1}" in
${['api', 'worker']
  .map((svc) => `      id-${svc}) echo '${created[svc] ?? '2999-01-01T00:00:00.123456789Z'}' ;;`)
  .join('\n')}
    esac
    exit 0 ;;
  esac
  case "\${@: -1}" in
${Object.entries(images)
  .map(([svc, image]) => `    id-${svc}) echo '${fill(image)}' ;;`)
  .join('\n')}
  esac
  exit 0
fi
echo image:test`,
  );
  bin(
    'curl',
    health === null
      ? 'echo ok'
      : `case "$*" in *"/health"*) ${
          health === 'fail' ? 'exit 22' : `printf '%s' '${fill(health)}'; exit ${healthExit}`
        } ;; *) echo '${webCode}'; exit ${webExit} ;; esac`,
  );
  const script = SCRIPT.replaceAll('/opt/rekoda', dir);
  const run2 = (body = script, extra = {}) =>
    spawnSync('bash', ['-s'], {
      cwd: dir,
      input: body,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fake}:${process.env.PATH}`,
        API_URL: 'https://x.invalid',
        ...extra,
      },
    });
  const go = (body = script, extra = {}) => run2(body, extra).stdout;
  return {
    go,
    run2,
    sha,
    script,
    dir,
    /** Stage a new file in the checkout: a tracked change that `git status` reports. */
    dirty: () => run('echo changed > tracked-change && git add tracked-change'),
    calls: () => readFileSync(join(fake, 'calls.log'), 'utf8').split('\n'),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Every tag the script checks by objects, plus the first: the healthy ledger agrees with its own per-tag answers. */
export const TAGS = [
  '0000_init',
  '0171_billing_interval',
  '0172_billing_checkout',
  '0173_checkout_attempts',
  '0174_billing_email_verification',
  '0175_reserved_meters',
  '0181_sweep_trial_candidates',
  '0182_charge_applied_period',
  '0183_email_verification_send_outcome',
  '0185_billing_email_address_limit',
  '0186_trial_notice_undelivered',
  '0187_payment_instructions',
  '0188_validate_payment_instruction_check',
  '0189_reminder_batches',
  '0190_failed_inbound_and_failure_category',
];
/** The five agreed template names (OD-41(b)), as a healthy api and worker carry them. */
export const SLOTS = {
  META_OTP_TEMPLATE: 'rekoda_login_otp',
  META_BILLING_TEMPLATE: 'rekoda_billing_grace_notice',
  META_RETENTION_TEMPLATE: 'rekoda_retention_notice',
  META_DOCUMENT_TEMPLATE: 'rekoda_document_ready',
  META_TRIAL_TEMPLATE: 'rekoda_trial_ending',
  META_TRIAL_TEMPLATE_LOCALE: 'en',
  REKODA_WEB_URL: 'https://staging.invalid',
  // The reminder Reply-To (OD-42(b)); a healthy host with reminders on carries it.
  REKODA_SUPPORT_EMAIL: 'support@staging.invalid',
};
/** The healthy host's .env. Not a credential: low-entropy stand-ins whose only job is to be findable if printed. */
export const HEALTHY_DOTENV =
  'REKODA_RELEASE=staging-{sha7}\nPAYSTACK_SECRET_KEY=sk_test_qqqqqqqqqqqqqqqq\nRESEND_API_KEY=rrrrrrrrrrrrrrrr\nWORKER_DATABASE_URL=postgres://u:wwwwwwww@db/rekoda\n' +
  'REKODA_WEB_URL=https://staging.invalid\nREKODA_EMAIL_PROVIDER=resend\nREKODA_EMAIL_FROM=billing@staging.invalid\nRESEND_WEBHOOK_SECRET=whsec_vvvvvvvvvvvvvvvv\n';
/** The healthy host's /health body ({sha7} is filled in by `host`). */
export const HEALTHY_HEALTH = `{"status":"ok","database":"up","migrations":${TAGS.length},"release":"staging-{sha7}","commit":"{sha7}"}`;
/** A staging host where every check passes. */
export const healthy = (over = {}) =>
  host({
    dotenv: HEALTHY_DOTENV,
    images: {
      api: 'rekoda-app:staging-{sha7}',
      worker: 'rekoda-app:staging-{sha7}',
      web: 'rekoda-web:staging-{sha7}',
    },
    health: HEALTHY_HEALTH,
    journal: TAGS,
    ledger: TAGS,
    env: {
      ...SLOTS,
      REKODA_CUSTOMER_REMINDERS: '1',
      REKODA_EMAIL_PROVIDER: 'resend',
      // not a credential: a low-entropy stand-in, findable if printed.
      PAYSTACK_SECRET_KEY: 'sk_test_qqqqqqqqqqqqqqqq',
    },
    services: [
      'postgres|running|healthy|0',
      'api|running|healthy|0',
      'worker|running|healthy|0',
      'web|running|healthy|0',
      'settlement|running|healthy|0',
      'operator|running|healthy|0',
      'caddy|running||0',
      'migrate|exited||0',
      'edge-check|exited||0',
    ],
    workerEnv: { ...SLOTS, REKODA_CUSTOMER_REMINDERS: '1', REKODA_EMAIL_PROVIDER: 'resend' },
    ...over,
  });
/** The attention section of an output; fails when the script never printed it. */
export const attention = (out) => {
  const at = out.indexOf('== attention');
  assert.notEqual(at, -1, 'the output has no "== attention" section');
  return out.slice(at);
};
