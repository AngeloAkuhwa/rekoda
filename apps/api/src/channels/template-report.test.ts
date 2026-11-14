/**
 * The template report the staging scripts read (OWN-93): one line per slot in the table's order,
 * states only, a digest that changes with any setting, and the boot refusals by variable name.
 * No configured value is ever printed.
 */
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

/* The built entry point (`dist/template-check.js`) is exercised end to end by the staging script
 * suites, which run it inside their fake containers after CI's build step
 * (scripts/staging-readonly-check.templates.test.mjs). */
