/**
 * The WhatsApp template section of scripts/staging-readonly-check.sh (OD-41(b), OWN-93): the
 * running api and worker each classify their own settings with the application's slot table (the
 * real `dist/template-check.js`, run by the fake containers against their fixture environment),
 * required against optional, the language each template needs, api and worker compared by digest,
 * and the billing link origin. No template name or language is ever printed. The script is run as
 * in staging-readonly-check.test.mjs (a throwaway checkout with a fake `docker` and `curl`). Run
 * with `node --test scripts/staging-readonly-check.templates.test.mjs` (CI does, after the build).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCRIPT, SLOTS, attention, healthy } from './staging-readonly-check.fixtures.mjs';

/** The configured values, none of which may appear in the output. */
/* Every configured name, and the languages distinctive enough to find (en_GB, pt_BR). */
const VALUES = Object.values(SLOTS).filter((v) => v.includes('_') && !v.includes('.'));
const TEMPLATE_VARS = Object.keys(SLOTS).filter((k) => k.endsWith('_TEMPLATE'));
const OK_ENV = { REKODA_CUSTOMER_REMINDERS: '1', REKODA_EMAIL_PROVIDER: 'resend' };
const API_ENV = { ...OK_ENV, PAYSTACK_SECRET_KEY: 'sk_test_qqqqqqqqqqqqqqqq' };

test('the script carries no slot list, template name or language of its own', () => {
  assert.doesNotMatch(SCRIPT, /TEMPLATE_SLOTS=/);
  assert.doesNotMatch(SCRIPT, /META_(OTP|BILLING|RETENTION|DOCUMENT|TRIAL)_TEMPLATE/);
  assert.doesNotMatch(SCRIPT, /\brekoda_(login|billing|retention|document|trial)_\w+/);
  assert.match(SCRIPT, /dc exec -T "\$c" node dist\/template-check\.js/);
});

test('a healthy host reads every slot SET in api and worker, the same in both, and the billing link', () => {
  const h = healthy();
  try {
    const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    for (const c of ['api', 'worker']) {
      for (const k of TEMPLATE_VARS) {
        assert.match(
          r.stdout,
          new RegExp(`${k} \\(${c}\\)\\s+SET \\(approval is checked in WhatsApp Manager\\)\\n`),
        );
        assert.match(
          r.stdout,
          new RegExp(`${k}_LOCALE \\(${c}\\)\\s+SET \\(confirm it is the template's language`),
        );
      }
      assert.match(
        r.stdout,
        new RegExp(
          `billing link in templates \\(${c}\\)\\s+https origin/app/billing \\(pass EXPECT_WEB_URL to compare\\)\\n`,
        ),
      );
    }
    assert.match(r.stdout, /Meta template settings, api and worker\s+SAME\n/);
    assert.match(r.stdout, /configuration only, not Meta approval/);
    // No configured name or language, no digest, and no origin is printed.
    for (const v of VALUES) assert.ok(!r.stdout.includes(v), `printed ${v}`);
    assert.doesNotMatch(r.stdout, /[0-9a-f]{64}/);
    assert.doesNotMatch(r.stdout, /staging\.invalid/);
    assert.equal(r.status, 0, r.stdout);
  } finally {
    h.done();
  }
});

test('EXPECT_WEB_URL is compared inside each container: the agreed origin passes, another is ATTENTION', () => {
  const h = healthy({
    workerEnv: { ...SLOTS, ...OK_ENV, REKODA_WEB_URL: 'https://other.invalid/' },
  });
  try {
    const r = h.run2(undefined, {
      EXPECT_SHA: h.sha.slice(0, 7),
      EXPECT_WEB_URL: 'https://staging.invalid',
    });
    assert.match(r.stdout, /billing link in templates \(api\)\s+EXPECT_WEB_URL\/app\/billing\n/);
    assert.match(
      r.stdout,
      /billing link in templates \(worker\)\s+REKODA_WEB_URL is not EXPECT_WEB_URL\n/,
    );
    assert.ok(attention(r.stdout).includes('billing link in templates (worker)'));
    assert.doesNotMatch(r.stdout, /other\.invalid/);
    // A malformed EXPECT_WEB_URL is refused, never placed in the container command.
    const bad = h.run2(undefined, { EXPECT_WEB_URL: 'https://x.invalid/"; rm -rf /' });
    // A value whose FIRST line is a valid origin is refused too, never spliced into the command.
    const multi = h.run2(undefined, { EXPECT_WEB_URL: 'https://x.invalid\n"; touch /tmp/pwned' });
    assert.match(
      multi.stdout,
      /EXPECT_WEB_URL\s+not an https origin with no path; comparison skipped/,
    );
    assert.match(
      bad.stdout,
      /EXPECT_WEB_URL\s+not an https origin with no path; comparison skipped/,
    );
    assert.doesNotMatch(h.calls().join('\n'), /rm -rf|pwned/);
  } finally {
    h.done();
  }
});

test('EXPECT_WEB_URL may be an internationalised or underscore host, and is still compared', () => {
  const h = healthy({
    env: { ...SLOTS, REKODA_WEB_URL: 'https://bücher_shop.invalid' },
    workerEnv: { ...SLOTS, REKODA_WEB_URL: 'https://bücher_shop.invalid' },
  });
  try {
    const r = h.run2(undefined, {
      EXPECT_SHA: h.sha.slice(0, 7),
      EXPECT_WEB_URL: 'https://bücher_shop.invalid',
    });
    assert.match(r.stdout, /billing link in templates \(api\)\s+EXPECT_WEB_URL\/app\/billing\n/);
    assert.match(r.stdout, /billing link in templates \(worker\)\s+EXPECT_WEB_URL\/app\/billing\n/);
    assert.doesNotMatch(r.stdout, /comparison skipped/);
  } finally {
    h.done();
  }
});

test('an unset required slot is ATTENTION; an unset optional slot is information and keeps RESULT: OK', () => {
  const noRetention = { ...SLOTS };
  delete noRetention.META_RETENTION_TEMPLATE;
  const optional = healthy({
    env: {
      ...noRetention,
      REKODA_CUSTOMER_REMINDERS: '1',
      REKODA_EMAIL_PROVIDER: 'resend',
      PAYSTACK_SECRET_KEY: 'sk_test_qqqqqqqqqqqqqqqq',
    },
    workerEnv: { ...noRetention, REKODA_CUSTOMER_REMINDERS: '1', REKODA_EMAIL_PROVIDER: 'resend' },
  });
  try {
    const r = optional.run2(undefined, { EXPECT_SHA: optional.sha.slice(0, 7) });
    assert.match(
      r.stdout,
      /META_RETENTION_TEMPLATE \(worker\)\s+UNSET \(optional; information only\)\n/,
    );
    assert.ok(!attention(r.stdout).includes('META_RETENTION_TEMPLATE'));
    assert.match(r.stdout, /RESULT: OK/);
    assert.equal(r.status, 0, r.stdout);
  } finally {
    optional.done();
  }

  const noTrial = { ...SLOTS };
  delete noTrial.META_TRIAL_TEMPLATE;
  const required = healthy({
    env: {
      ...noTrial,
      REKODA_CUSTOMER_REMINDERS: '1',
      REKODA_EMAIL_PROVIDER: 'resend',
      PAYSTACK_SECRET_KEY: 'sk_test_qqqqqqqqqqqqqqqq',
    },
    // The worker alone has it: the api's copy still reads ATTENTION.
    workerEnv: { ...SLOTS, REKODA_CUSTOMER_REMINDERS: '1', REKODA_EMAIL_PROVIDER: 'resend' },
  });
  try {
    const r = required.run2(undefined, { EXPECT_SHA: required.sha.slice(0, 7) });
    const a = attention(r.stdout);
    assert.ok(a.includes('META_TRIAL_TEMPLATE (api)'));
    assert.ok(!a.includes('META_TRIAL_TEMPLATE (worker)'));
    assert.match(r.stdout, /RESULT: ATTENTION/);
    assert.equal(r.status, 1);
  } finally {
    required.done();
  }
});

test('a non-https or missing REKODA_WEB_URL is ATTENTION in the container that has it', () => {
  const h = healthy({
    workerEnv: { ...SLOTS, ...OK_ENV, REKODA_WEB_URL: 'http://staging.invalid' },
  });
  try {
    const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    const a = attention(r.stdout);
    assert.ok(a.includes('billing link in templates (worker)'));
    assert.match(
      r.stdout,
      /billing link in templates \(worker\)\s+REKODA_WEB_URL is not https:\/\/\n/,
    );
    assert.ok(!a.includes('(api)'), a);
  } finally {
    h.done();
  }
  const none = healthy({ workerEnv: { ...SLOTS, ...OK_ENV, REKODA_WEB_URL: '' } });
  try {
    const out = none.go();
    assert.match(out, /billing link in templates \(worker\)\s+UNSET \(REKODA_WEB_URL/);
  } finally {
    none.done();
  }
});

test('a template without its language, or a malformed name or language, is ATTENTION and REFUSED, never printed', () => {
  const broken = {
    ...SLOTS,
    META_DOCUMENT_TEMPLATE: 'Not A Name',
    META_BILLING_TEMPLATE_LOCALE: 'english',
  };
  delete broken.META_TRIAL_TEMPLATE_LOCALE;
  const h = healthy({ workerEnv: { ...broken, ...OK_ENV } });
  try {
    const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    const a = attention(r.stdout);
    assert.match(
      r.stdout,
      /META_TRIAL_TEMPLATE_LOCALE \(worker\)\s+UNSET \(required with META_TRIAL_TEMPLATE; the api refuses to boot without it\)\n/,
    );
    assert.match(r.stdout, /META_DOCUMENT_TEMPLATE \(worker\)\s+SET but not a Meta template name/);
    // The malformed template's language is its own, not "unused".
    assert.match(
      r.stdout,
      /META_DOCUMENT_TEMPLATE_LOCALE \(worker\)\s+SET \(confirm it is the template's language/,
    );
    assert.match(
      r.stdout,
      /META_BILLING_TEMPLATE_LOCALE \(worker\)\s+SET but not a Meta language code/,
    );
    assert.match(r.stdout, /Meta template settings \(worker\)\s+REFUSED/);
    for (const k of [
      'META_TRIAL_TEMPLATE_LOCALE',
      'META_DOCUMENT_TEMPLATE',
      'META_BILLING_TEMPLATE_LOCALE',
    ])
      assert.ok(a.includes(`${k} (worker)`), a);
    assert.ok(!a.includes('Meta template settings (api)'), a);
    assert.doesNotMatch(r.stdout, /Not A Name|english/);
    assert.match(r.stdout, /RESULT: ATTENTION/);
    assert.equal(r.status, 1);
  } finally {
    h.done();
  }
});

test('api and worker on different templates is ATTENTION, without printing either', () => {
  const h = healthy({
    workerEnv: { ...SLOTS, ...OK_ENV, META_TRIAL_TEMPLATE: 'another_trial_template' },
  });
  try {
    const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    assert.match(r.stdout, /Meta template settings, api and worker\s+DIFFERENT/);
    assert.ok(attention(r.stdout).includes('Meta template settings, api and worker'));
    assert.doesNotMatch(r.stdout, /another_trial_template|synthetic_trial_reminder/);
    assert.equal(r.status, 1);
  } finally {
    h.done();
  }
});

test('a language set for an unset template is reported as unused, and is not ATTENTION', () => {
  const env = { ...SLOTS };
  delete env.META_RETENTION_TEMPLATE;
  const h = healthy({ env: { ...env, ...API_ENV }, workerEnv: { ...env, ...OK_ENV } });
  try {
    const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
    assert.match(
      r.stdout,
      /META_RETENTION_TEMPLATE_LOCALE \(api\)\s+SET without a template \(unused\)\n/,
    );
    assert.ok(!attention(r.stdout).includes('META_RETENTION'));
    assert.equal(r.status, 0, r.stdout);
  } finally {
    h.done();
  }
});

test('a container whose report fails, or whose image has none, reads unknown, never UNSET or a pass', () => {
  for (const mode of ['fail', 'absent']) {
    const h = healthy({ templateReport: { worker: mode } });
    try {
      const r = h.run2(undefined, { EXPECT_SHA: h.sha.slice(0, 7) });
      assert.match(
        r.stdout,
        /Meta template slots \(worker\)\s+unknown \(no template report from worker: an image older than PR B, or the query failed\)\n/,
      );
      assert.doesNotMatch(r.stdout, /\(worker\)\s+UNSET \(required\)/);
      assert.match(r.stdout, /Meta template settings, api and worker\s+unknown \(not compared/);
      // The worker's billing link is still checked.
      assert.match(r.stdout, /billing link in templates \(worker\)\s+https origin/);
      assert.doesNotMatch(r.stdout, /Cannot find module/);
      assert.match(r.stdout, /RESULT: ATTENTION/);
      assert.equal(r.status, 1);
    } finally {
      h.done();
    }
  }
});
