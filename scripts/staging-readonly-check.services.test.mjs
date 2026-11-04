/**
 * The staging read-only check, part 2: the service, job, web, log and settings verdicts. Part 1
 * (staging-readonly-check.test.mjs) covers release identity, migrations, templates, Paystack and
 * secrecy. Both run the real script against the fake host in staging-readonly-check.fixtures.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HEALTHY_DOTENV, SLOTS, attention, healthy } from './staging-readonly-check.fixtures.mjs';

const BARE_ENV = 'REKODA_RELEASE=staging-{sha7}\nPAYSTACK_SECRET_KEY=sk_test_qqqqqqqqqqqqqqqq\n';
test('a broken web tier, an unhealthy or missing service, or a failed job can never read OK', () => {
  const svc = (over) =>
    [
      'postgres|running|healthy|0',
      'api|running|healthy|0',
      'worker|running|healthy|0',
      'web|running|healthy|0',
      'caddy|running||0',
      'migrate|exited||0',
      'edge-check|exited||0',
    ]
      .map((l) => over[l.split('|')[0]] ?? l)
      .filter((l) => l !== 'gone');
  const cases = [
    [{ webCode: '502' }, /web status\s+502\n/],
    [{ webCode: '000' }, /web status\s+unknown \(no answer\)\n/],
    [
      { webCode: '200', webExit: 28 },
      /web status\s+unknown \(transfer failed, curl exit 28, after code 200\)\n/,
    ],
    [
      { services: svc({ 'edge-check': 'edge-check|running||0' }) },
      /job edge-check\s+running \(not exited 0\)\n/,
    ],
    [
      { services: svc({ migrate: 'migrate|created||0' }) },
      /job migrate\s+created \(not exited 0\)\n/,
    ],
    ...['REKODA_WEB_URL', 'REKODA_EMAIL_PROVIDER', 'RESEND_API_KEY', 'REKODA_EMAIL_FROM']
      .concat(['RESEND_WEBHOOK_SECRET', 'WORKER_DATABASE_URL'])
      .map((k) => [{ dotenv: BARE_ENV }, new RegExp(`${k}\\s+UNSET \\(required on staging\\)\\n`)]),
    [
      { services: svc({ worker: 'worker|running|unhealthy|0' }) },
      /service worker\s+running, unhealthy\n/,
    ],
    [{ services: svc({ caddy: 'gone' }) }, /service caddy\s+MISSING\n/],
    [
      { services: svc({ worker: 'worker|running||0' }) },
      /service worker\s+running, no health result\n/,
    ],
    [
      {
        dotenv: HEALTHY_DOTENV.replace(
          'REKODA_EMAIL_PROVIDER=resend',
          'REKODA_EMAIL_PROVIDER=none',
        ),
      },
      /REKODA_EMAIL_PROVIDER\s+SET \(not resend; staging needs resend\)\n/,
    ],
    [{ services: svc({ api: 'api|restarting||1' }) }, /service api\s+restarting\n/],
    [{ services: svc({ migrate: 'migrate|exited||1' }) }, /job migrate\s+exited 1\n/],
    [{ services: [] }, /services\s+unknown \(compose ps failed\)\n/],
    [
      {
        images: {
          api: 'rekoda-app:staging-{sha7}',
          worker: 'rekoda-app:staging-{sha7}',
          web: 'rekoda-web:old',
        },
      },
      /web image is the \.env release\s+NO/,
    ],
    [
      { logs: '[Nest] 1  - 11/04/2026, 7:00:00 PM   \x1b[31mERROR\x1b[39m [JobRunner] job failed' },
      /error-level lines in api\s+1\n/,
    ],
    [
      { logs: '[Nest] 1  - 11/04/2026, 7:00:00 PM   FATAL [Main] boot' },
      /error-level lines in api\s+1\n/,
    ],
    [{ logs: 'fail' }, /error-level lines in api\s+unknown \(cannot read logs\)\n/],
  ];
  for (const [over, line] of cases) {
    const h = healthy(over);
    try {
      const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
      assert.match(r.stdout, line, JSON.stringify(over));
      assert.match(attention(r.stdout), line, `${JSON.stringify(over)} is under attention`);
      assert.equal(r.status, 1, JSON.stringify(over));
    } finally {
      h.done();
    }
  }
});

test('the healthy services and jobs read as expected and are not flagged', () => {
  const h = healthy();
  try {
    const out = h.go(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    for (const s of ['postgres', 'api', 'worker', 'web'])
      assert.match(out, new RegExp(`service ${s}\\s+running, healthy\\n`));
    assert.match(out, /service caddy\s+running\n/);
    assert.match(out, /job migrate\s+exited \(0\)\n/);
    assert.match(out, /REKODA_ANNUAL_BILLING\s+UNSET\n/);
    assert.doesNotMatch(attention(out), /REKODA_ANNUAL_BILLING|WORKER_DATABASE_URL/);
    assert.match(out, /web status\s+200\n/);
    assert.match(out, /web image is the \.env release\s+yes\n/);
    assert.match(out, /error-level lines in worker\s+0\n/);
  } finally {
    h.done();
  }
});

test('reminders on in one service and off in the other are flagged; both off or both on are not', () => {
  const mixed = healthy({
    workerEnv: { REKODA_CUSTOMER_REMINDERS: '0', REKODA_EMAIL_PROVIDER: 'resend' },
  });
  const off = healthy({
    env: {
      ...SLOTS,
      PAYSTACK_SECRET_KEY: 'sk_test_qqqqqqqqqqqqqqqq',
      REKODA_EMAIL_PROVIDER: 'resend',
    },
    workerEnv: { REKODA_EMAIL_PROVIDER: 'resend' },
  });
  try {
    const r = mixed.run2(undefined, { EXPECT_SHA: mixed.sha.slice(0, 7) });
    assert.match(r.stdout, /reminders api and worker\s+DIFFERENT \(api ON, worker OFF\)\n/);
    assert.match(attention(r.stdout), /reminders api and worker\s+DIFFERENT/);
    assert.equal(r.status, 1);
    const o = off.run2(undefined, { EXPECT_SHA: off.sha.slice(0, 7) });
    assert.match(o.stdout, /reminders api and worker\s+SAME \(OFF\)\n/);
    assert.equal(o.status, 0, o.stdout);
  } finally {
    mixed.done();
    off.done();
  }
});

test('ordinary Nest lines at LOG or WARN level are not counted as errors', () => {
  const h = healthy({
    logs: '[Nest] 1  - 11/04/2026, 7:00:00 PM     LOG [Bootstrap] Rekoda API listening',
  });
  try {
    const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    assert.match(r.stdout, /error-level lines in api\s+0\n/);
    assert.equal(r.status, 0, r.stdout);
  } finally {
    h.done();
  }
});

test('a platform flag set to anything is flagged, and a value other than 1 says the api ignores it', () => {
  const h = healthy({
    env: {
      ...SLOTS,
      PAYSTACK_SECRET_KEY: 'sk_test_qqqqqqqqqqqqqqqq',
      REKODA_PAYSTACK_PLATFORM_CONFIRMED: '0',
    },
  });
  try {
    const out = h.go(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    assert.match(out, /REKODA_PAYSTACK_PLATFORM_CONFIRMED\s+SET to a value other than 1/);
    assert.match(attention(out), /REKODA_PAYSTACK_PLATFORM_CONFIRMED/);
  } finally {
    h.done();
  }
});

test('the email provider the running containers use is judged, not only the .env line', () => {
  // .env says resend, but the containers were not recreated after an edit and still run another.
  const stale = healthy({
    env: {
      ...SLOTS,
      PAYSTACK_SECRET_KEY: 'sk_test_qqqqqqqqqqqqqqqq',
      REKODA_CUSTOMER_REMINDERS: '1',
      REKODA_EMAIL_PROVIDER: 'none',
    },
    workerEnv: { REKODA_CUSTOMER_REMINDERS: '1' },
  });
  try {
    const r = stale.run2(undefined, { EXPECT_SHA: stale.sha.slice(0, 7) });
    assert.match(r.stdout, /REKODA_EMAIL_PROVIDER\s+SET \(resend\)\n/);
    assert.match(r.stdout, /REKODA_EMAIL_PROVIDER \(api\)\s+not resend \(staging needs resend\)\n/);
    assert.match(r.stdout, /REKODA_EMAIL_PROVIDER \(worker\)\s+UNSET \(staging needs resend\)\n/);
    assert.match(attention(r.stdout), /REKODA_EMAIL_PROVIDER \(api\)/);
    assert.match(attention(r.stdout), /REKODA_EMAIL_PROVIDER \(worker\)/);
    assert.doesNotMatch(r.stdout, /REKODA_EMAIL_PROVIDER[^\n]*\bnone\b/);
    assert.equal(r.status, 1, r.stdout);
  } finally {
    stale.done();
  }
});

test('the web URL and annual billing are classified, never printed', () => {
  const h = healthy({
    dotenv: HEALTHY_DOTENV.replace(
      'REKODA_WEB_URL=https://staging.invalid',
      'REKODA_WEB_URL=https://user:pppppppp@staging.invalid',
    ).concat('REKODA_ANNUAL_BILLING=yes-please\n'),
  });
  try {
    const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    assert.match(r.stdout, /REKODA_WEB_URL\s+SET\n/);
    assert.match(
      r.stdout,
      /REKODA_ANNUAL_BILLING\s+SET \(not 0 or 1; the process refuses to boot with it\)\n/,
    );
    assert.match(attention(r.stdout), /REKODA_ANNUAL_BILLING/);
    assert.equal(r.status, 1, r.stdout);
    assert.doesNotMatch(r.stdout, /pppppppp|staging\.invalid|yes-please/);
  } finally {
    h.done();
  }
});

test('an empty annual-billing assignment is flagged, as the process refuses to boot with it', () => {
  const h = healthy({ dotenv: HEALTHY_DOTENV.concat('REKODA_ANNUAL_BILLING=\n') });
  try {
    const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    assert.match(
      r.stdout,
      /REKODA_ANNUAL_BILLING\s+SET but empty \(the process refuses to boot with it\)\n/,
    );
    assert.match(attention(r.stdout), /REKODA_ANNUAL_BILLING/);
    assert.equal(r.status, 1, r.stdout);
  } finally {
    h.done();
  }
});
