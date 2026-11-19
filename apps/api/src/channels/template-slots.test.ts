/**
 * The authoritative template-slot table (OD-41(b), OWN-93): its variables, its required/optional
 * split, its parameter lists, the validation of the configured names and languages (the table holds
 * no template name and no default language), and the billing link it builds from REKODA_WEB_URL.
 */
import { describe, expect, it } from 'vitest';
import {
  NO_TEMPLATES,
  TEMPLATE_SLOTS,
  billingPageUrl,
  configuredTemplates,
  missingTemplateSlots,
  templateConfigProblems,
  templateSlotStatus,
} from './template-slots.js';

/** Synthetic settings for all five slots: arbitrary names, explicit languages. */
const ALL = Object.fromEntries(
  TEMPLATE_SLOTS.flatMap((s, i) => [
    [s.env, `custom_${s.slot}_template_${i}`],
    [s.localeEnv, ['en', 'fr', 'ha', 'en_US', 'pt_BR'][i]!],
  ]),
);

describe('the five slots', () => {
  it('gives each slot its own template and language variable', () => {
    expect(TEMPLATE_SLOTS.map((s) => [s.slot, s.env, s.localeEnv])).toEqual([
      ['otp', 'META_OTP_TEMPLATE', 'META_OTP_TEMPLATE_LOCALE'],
      ['billing', 'META_BILLING_TEMPLATE', 'META_BILLING_TEMPLATE_LOCALE'],
      ['retention', 'META_RETENTION_TEMPLATE', 'META_RETENTION_TEMPLATE_LOCALE'],
      ['document', 'META_DOCUMENT_TEMPLATE', 'META_DOCUMENT_TEMPLATE_LOCALE'],
      ['trial', 'META_TRIAL_TEMPLATE', 'META_TRIAL_TEMPLATE_LOCALE'],
    ]);
  });

  it('holds no template name and no language of its own (OWN-93)', () => {
    for (const slot of TEMPLATE_SLOTS) {
      expect(Object.keys(slot).sort()).toEqual(
        ['body', 'button', 'category', 'env', 'localeEnv', 'purpose', 'required', 'slot'].sort(),
      );
    }
    // Nothing is configured from an empty environment: no default name, no default language.
    expect(configuredTemplates({})).toEqual(NO_TEMPLATES);
  });

  it('marks only the retention slot optional', () => {
    expect(TEMPLATE_SLOTS.filter((s) => !s.required).map((s) => s.slot)).toEqual(['retention']);
  });

  it('declares the message contract: the trial template takes days left, end date and billing link', () => {
    const bySlot = Object.fromEntries(TEMPLATE_SLOTS.map((s) => [s.slot, s]));
    expect(bySlot['trial']).toMatchObject({
      body: ['daysLeft', 'endsOn', 'billingUrl'],
      button: null,
    });
    expect(bySlot['billing']!.body).toEqual(['daysLeft', 'endsOn', 'billingUrl']);
    expect(bySlot['retention']!.body).toEqual(['daysLeft', 'deletesOn']);
    expect(bySlot['document']!.body).toEqual(['documentLabel', 'reference']);
    expect(bySlot['otp']).toMatchObject({
      category: 'AUTHENTICATION',
      body: ['code'],
      button: 'code',
    });
  });
});

describe('configured templates', () => {
  it('pairs each slot with exactly the name and language the environment gives', () => {
    expect(configuredTemplates(ALL)).toEqual({
      otp: { name: 'custom_otp_template_0', locale: 'en' },
      billing: { name: 'custom_billing_template_1', locale: 'fr' },
      retention: { name: 'custom_retention_template_2', locale: 'ha' },
      document: { name: 'custom_document_template_3', locale: 'en_US' },
      trial: { name: 'custom_trial_template_4', locale: 'pt_BR' },
    });
  });

  it('accepts any well-formed name, including one the repository has never seen', () => {
    const env = {
      META_TRIAL_TEMPLATE: 'my_custom_trial_template',
      META_TRIAL_TEMPLATE_LOCALE: 'en',
    };
    expect(templateConfigProblems(env)).toEqual([]);
    expect(configuredTemplates(env).trial).toEqual({
      name: 'my_custom_trial_template',
      locale: 'en',
    });
  });

  it('leaves an unset or empty slot unconfigured, and ignores a language set without a template', () => {
    const t = configuredTemplates({
      META_OTP_TEMPLATE: '',
      META_OTP_TEMPLATE_LOCALE: '',
      META_RETENTION_TEMPLATE_LOCALE: 'fr',
    });
    expect(t).toEqual(NO_TEMPLATES);
  });

  it('refuses a template set without its language rather than guessing one', () => {
    for (const locale of [undefined, '']) {
      const env = {
        META_DOCUMENT_TEMPLATE: 'paperwork_ready',
        META_DOCUMENT_TEMPLATE_LOCALE: locale,
      };
      expect(templateConfigProblems(env)).toEqual([
        {
          env: 'META_DOCUMENT_TEMPLATE_LOCALE',
          problem: expect.stringMatching(/must be set when META_DOCUMENT_TEMPLATE is set/),
        },
      ]);
      expect(() => configuredTemplates(env)).toThrow(/META_DOCUMENT_TEMPLATE_LOCALE/);
    }
  });
});

describe('configuration problems', () => {
  it('finds nothing wrong with arbitrary well-formed names and languages', () => {
    expect(templateConfigProblems(ALL)).toEqual([]);
    expect(missingTemplateSlots(ALL)).toEqual([]);
  });

  it('lists unset and empty slots as missing, required and optional alike', () => {
    const missing = missingTemplateSlots({
      META_OTP_TEMPLATE: 'any_signin_template',
      META_TRIAL_TEMPLATE: '',
    });
    expect(missing.map((s) => [s.slot, s.required])).toEqual([
      ['billing', true],
      ['retention', false],
      ['document', true],
      ['trial', true],
    ]);
  });

  it('names the variable, never the value', () => {
    const problems = templateConfigProblems({
      META_DOCUMENT_TEMPLATE: 'Secret Name!',
      META_DOCUMENT_TEMPLATE_LOCALE: 'en',
    });
    expect(problems).toHaveLength(1);
    expect(JSON.stringify(problems)).not.toContain('Secret Name');
    expect(problems[0]!.env).toBe('META_DOCUMENT_TEMPLATE');
  });

  it('classifies each setting as unset, set or invalid, without its value', () => {
    const status = templateSlotStatus({
      META_OTP_TEMPLATE: 'signin_code',
      META_OTP_TEMPLATE_LOCALE: 'en',
      META_BILLING_TEMPLATE: 'Bad Name',
      META_BILLING_TEMPLATE_LOCALE: 'english',
      META_TRIAL_TEMPLATE: 'trial_reminder',
    });
    expect(status.map((s) => [s.slot, s.required, s.name, s.locale])).toEqual([
      ['otp', true, 'set', 'set'],
      ['billing', true, 'invalid', 'invalid'],
      ['retention', false, 'unset', 'unset'],
      ['document', true, 'unset', 'unset'],
      ['trial', true, 'set', 'unset'],
    ]);
    expect(JSON.stringify(status)).not.toMatch(/signin_code|Bad Name|english|trial_reminder/);
  });
});

describe('billingPageUrl', () => {
  it('builds the billing page of the configured origin', () => {
    expect(billingPageUrl('https://staging.myrekoda.com')).toBe(
      'https://staging.myrekoda.com/app/billing',
    );
    expect(billingPageUrl('https://app.myrekoda.com')).toBe('https://app.myrekoda.com/app/billing');
  });

  it('never carries credentials, a path, a query or a fragment from the configured value', () => {
    expect(billingPageUrl('https://user:secret@app.myrekoda.com')).toBeNull();
    expect(billingPageUrl('https://user@app.myrekoda.com')).toBeNull();
    expect(billingPageUrl('https://app.myrekoda.com/ignored?x=1#frag')).toBe(
      'https://app.myrekoda.com/app/billing',
    );
  });

  it('is null with no origin', () => {
    expect(billingPageUrl(null)).toBeNull();
    expect(billingPageUrl('')).toBeNull();
  });
});
