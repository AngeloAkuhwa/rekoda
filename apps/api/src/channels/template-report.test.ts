/**
 * The template report the staging scripts read (OWN-93): one line per slot in the table's order,
 * states only, a digest that changes with any setting, and the boot refusals by variable name.
 * No configured value is ever printed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { templateReport } from './template-report.js';
import { TEMPLATE_SLOTS } from './template-slots.js';

const CONFIGURED = {
  META_OTP_TEMPLATE: 'signin_code_abc',
  META_OTP_TEMPLATE_LOCALE: 'en',
  META_BILLING_TEMPLATE: 'grace_notice_abc',
  META_BILLING_TEMPLATE_LOCALE: 'fr',
  META_DOCUMENT_TEMPLATE: 'doc_ready_abc',
  META_DOCUMENT_TEMPLATE_LOCALE: 'en_US',
  META_TRIAL_TEMPLATE: 'trial_soon_abc',
  META_TRIAL_TEMPLATE_LOCALE: 'pt_BR',
};

describe('templateReport', () => {
  it('reports each slot from the table, with states only', () => {
    const r = templateReport(CONFIGURED);
    expect(r.lines.slice(0, TEMPLATE_SLOTS.length)).toEqual([
      'SLOT META_OTP_TEMPLATE required set set',
      'SLOT META_BILLING_TEMPLATE required set set',
      'SLOT META_RETENTION_TEMPLATE optional unset unset',
      'SLOT META_DOCUMENT_TEMPLATE required set set',
      'SLOT META_TRIAL_TEMPLATE required set set',
    ]);
    expect(r.lines.at(-1)).toMatch(/^DIGEST [0-9a-f]{64}$/);
    expect(r.refused).toEqual([]);
    expect(r.lines.join('\n')).not.toMatch(/_abc|pt_BR|en_US|\bfr\b/);
  });

  it('gives the same digest for the same settings and a different one when any value changes', () => {
    const digest = (env: NodeJS.ProcessEnv) => templateReport(env).lines.at(-1);
    expect(digest({ ...CONFIGURED })).toBe(digest({ ...CONFIGURED }));
    expect(digest({ ...CONFIGURED, META_TRIAL_TEMPLATE: 'trial_soon_abd' })).not.toBe(
      digest(CONFIGURED),
    );
    expect(digest({ ...CONFIGURED, META_OTP_TEMPLATE_LOCALE: 'en_GB' })).not.toBe(
      digest(CONFIGURED),
    );
    // A variable outside the table does not move it.
    expect(digest({ ...CONFIGURED, UNRELATED: 'x' })).toBe(digest(CONFIGURED));
  });

  it('lists what would refuse a boot by variable, without the value', () => {
    const r = templateReport({
      ...CONFIGURED,
      META_TRIAL_TEMPLATE_LOCALE: '',
      META_DOCUMENT_TEMPLATE: 'Not A Name',
    });
    expect(r.refused.map((p) => p.env)).toEqual([
      'META_DOCUMENT_TEMPLATE',
      'META_TRIAL_TEMPLATE_LOCALE',
    ]);
    expect(r.lines).toContain('SLOT META_DOCUMENT_TEMPLATE required invalid set');
    expect(r.lines).toContain('SLOT META_TRIAL_TEMPLATE required set unset');
    expect(JSON.stringify(r)).not.toContain('Not A Name');
  });
});

/* The built entry point the scripts run, when the package has been built (CI builds before it
 * tests; a plain `vitest run` on a fresh checkout skips this block rather than failing). */
const built = fileURLToPath(new URL('../../dist/template-check.js', import.meta.url));
describe.skipIf(!existsSync(built))('dist/template-check.js', () => {
  const run = (env: NodeJS.ProcessEnv) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [built], { env, encoding: 'utf8' }) };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { code: err.status, out: err.stdout, err: err.stderr };
    }
  };

  it('exits 0 with RESULT BOOTS on settings that boot', () => {
    const r = run({ PATH: process.env['PATH'], ...CONFIGURED });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^SLOT META_OTP_TEMPLATE required set set$/m);
    expect(r.out).toMatch(/^RESULT BOOTS$/m);
    expect(r.out).not.toContain('_abc');
  });

  it('exits 1 with RESULT REFUSED, naming the variable on stderr', () => {
    const r = run({ PATH: process.env['PATH'], ...CONFIGURED, META_OTP_TEMPLATE_LOCALE: '' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^RESULT REFUSED$/m);
    expect(r.err).toMatch(/^META_OTP_TEMPLATE_LOCALE must be set when META_OTP_TEMPLATE is set/m);
    expect(`${r.out}${r.err}`).not.toContain('_abc');
  });
});
