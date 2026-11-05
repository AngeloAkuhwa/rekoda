/**
 * The staging read-only check, part 2: the service, job, web, log and settings verdicts. Part 1
 * (staging-readonly-check.test.mjs) covers release identity, migrations, templates, Paystack and
 * secrecy. Both run the real script against the fake host in staging-readonly-check.fixtures.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import {
  HEALTHY_DOTENV,
  HEALTHY_HEALTH,
  SLOTS,
  attention,
  healthy,
} from './staging-readonly-check.fixtures.mjs';

const BARE_ENV = 'REKODA_RELEASE=staging-{sha7}\nPAYSTACK_SECRET_KEY=sk_test_qqqqqqqqqqqqqqqq\n';
test('a broken web tier, an unhealthy or missing service, or a failed job can never read OK', () => {
  /** The healthy service table with rows replaced by name from `over`; the value 'gone' drops a row. */
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

const envLine = (c) => new RegExp(`\\.env older than the ${c} container\\s+(\\S.*)\\n`);

test('an .env written after the containers were created is flagged, even when they restarted since', () => {
  // Created long before this .env; the fake's start time is new, as after `docker compose
  // restart`, which does not re-read .env. The creation time decides.
  const old = '2000-01-01T00:00:00Z';
  const h = healthy({ created: { api: old, worker: old } });
  try {
    const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    for (const c of ['api', 'worker']) {
      assert.match(r.stdout.match(envLine(c))[1], /^NO \(\.env written after \w+ was created/);
      assert.match(attention(r.stdout), new RegExp(`\\.env older than the ${c} container`));
    }
    assert.doesNotMatch(r.stdout, /rrrrrrrr|pppppppp|whsec_/);
    assert.equal(r.status, 1, r.stdout);
  } finally {
    h.done();
  }
});

test('only the stale container is flagged, an unreadable creation time is unknown, and a fresh one reads yes', () => {
  const stale = healthy({ created: { worker: '2000-01-01T00:00:00Z' } });
  try {
    const r = stale.run2(undefined, { EXPECT_SHA: stale.sha.slice(0, 7) });
    assert.equal(r.stdout.match(envLine('api'))[1], 'yes');
    assert.match(r.stdout.match(envLine('worker'))[1], /^NO /);
    assert.doesNotMatch(attention(r.stdout), /\.env older than the api container/);
    assert.equal(r.status, 1, r.stdout);
  } finally {
    stale.done();
  }
  const unreadable = healthy({ created: { api: 'not a time' } });
  try {
    const r = unreadable.run2(undefined, { EXPECT_SHA: unreadable.sha.slice(0, 7) });
    assert.match(r.stdout.match(envLine('api'))[1], /^unknown /);
    assert.equal(r.stdout.match(envLine('worker'))[1], 'yes');
    assert.equal(r.status, 1, r.stdout);
  } finally {
    unreadable.done();
  }
});

test('an .env written in the same second its container was created reads unknown, never yes', () => {
  // Whole seconds cannot order an edit made in the creation's own second, so it is not a pass.
  const h = healthy({ created: { api: '2001-01-01T00:00:00.900Z' } });
  try {
    const second = new Date('2001-01-01T00:00:00Z');
    utimesSync(join(h.dir, '.env'), second, second);
    const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    assert.match(r.stdout.match(envLine('api'))[1], /^unknown \(\.env written in the same second/);
    assert.equal(r.stdout.match(envLine('worker'))[1], 'yes');
    assert.equal(r.status, 1, r.stdout);
  } finally {
    h.done();
  }
});

/* Each release-identity and /health check below must be able to fail the run: a branch that only
 * printed would leave a dirty checkout, a degraded database, a release that is not the served
 * commit or an unusable EXPECT_SHA reading as a pass (independent review of #428). */
test('release identity and /health problems each need attention and exit 1', () => {
  const cases = [
    { what: 'a tracked change', line: /tracked modifications\s+1\n/, dirty: true },
    {
      what: '.env without a release',
      over: { dotenv: HEALTHY_DOTENV.replace(/^REKODA_RELEASE=[^\n]*\n/, '') },
      line: /\.env REKODA_RELEASE\s+UNSET\n/,
    },
    {
      what: 'an uppercase EXPECT_SHA',
      expect: 'ABCDEF0',
      line: /EXPECT_SHA\s+not a lowercase hex commit/,
    },
    {
      what: 'a six-character EXPECT_SHA',
      expect: 'abcdef',
      line: /EXPECT_SHA\s+must be 7 to 40 characters/,
    },
    {
      what: 'a database that is not up',
      over: { health: HEALTHY_HEALTH.replace('"database":"up"', '"database":"down"') },
      line: /served database\s+down\n/,
    },
    {
      what: 'a release that is not the served commit',
      over: {
        health: HEALTHY_HEALTH.replace('"release":"staging-{sha7}"', '"release":"staging-0000000"'),
      },
      line: /served release is staging-<commit>\s+NO\n/,
    },
  ];
  for (const { what, over = {}, expect, line, dirty = false } of cases) {
    const h = healthy(over);
    try {
      if (dirty) h.dirty();
      const r = h.run2(undefined, { EXPECT_SHA: expect ?? h.sha.slice(0, 7) });
      assert.match(attention(r.stdout), line, what);
      assert.equal(r.status, 1, what);
      assert.doesNotMatch(r.stdout, /RESULT: OK/, what);
    } finally {
      h.done();
    }
  }
});

test('a quoted-empty or comment-only .env value reads UNSET, as compose resolves it', () => {
  for (const line of [
    'RESEND_API_KEY=""',
    "RESEND_API_KEY=''",
    'RESEND_API_KEY= # set later',
    'RESEND_API_KEY="" # set later',
    "RESEND_API_KEY='' # set later",
    'RESEND_API_KEY=""#set later',
    "RESEND_API_KEY=''#set later",
    'RESEND_API_KEY="" ',
    'RESEND_API_KEY=""\r',
    'RESEND_API_KEY=   ',
    'RESEND_API_KEY= ""',
    "RESEND_API_KEY=  '' # set later",
  ]) {
    const h = healthy({ dotenv: HEALTHY_DOTENV.replace(/^RESEND_API_KEY=[^\n]*$/m, line) });
    try {
      const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
      assert.match(attention(r.stdout), /RESEND_API_KEY\s+UNSET \(required on staging\)/, line);
      assert.equal(r.status, 1, line);
    } finally {
      h.done();
    }
  }
  /* A quoted value that is set still reads SET, and its value is never printed. */
  const h = healthy({
    dotenv: HEALTHY_DOTENV.replace(/^RESEND_API_KEY=([^\n]*)$/m, 'RESEND_API_KEY="$1" # rotated'),
  });
  try {
    const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    assert.match(r.stdout, /RESEND_API_KEY\s+SET\n/);
    assert.doesNotMatch(r.stdout, /rrrrrrrrrrrrrrrr/);
    assert.equal(r.status, 0, r.stdout);
  } finally {
    h.done();
  }
});
