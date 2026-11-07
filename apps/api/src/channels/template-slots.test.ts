/**
 * The authoritative template-slot table (OD-41(b)): its names, its required/optional split, its
 * parameter lists, and the billing link it builds from REKODA_WEB_URL.
 */
import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_SLOTS,
  billingPageUrl,
  missingTemplateSlots,
  templateConfigProblems,
} from './template-slots.js';

describe('the five slots', () => {
  it('names the five agreed templates, each on its own variable', () => {
    expect(TEMPLATE_SLOTS.map((s) => [s.env, s.agreedName])).toEqual([
      ['META_OTP_TEMPLATE', 'rekoda_login_otp'],
      ['META_BILLING_TEMPLATE', 'rekoda_billing_grace_notice'],
      ['META_RETENTION_TEMPLATE', 'rekoda_retention_notice'],
      ['META_DOCUMENT_TEMPLATE', 'rekoda_document_ready'],
      ['META_TRIAL_TEMPLATE', 'rekoda_trial_ending'],
    ]);
    expect(TEMPLATE_SLOTS.every((s) => s.localeEnv === `${s.env}_LOCALE`)).toBe(true);
  });

  it('marks only the retention slot optional', () => {
    expect(TEMPLATE_SLOTS.filter((s) => !s.required).map((s) => s.slot)).toEqual(['retention']);
  });

  it('declares the agreed parameters: the trial template takes days left, end date and billing link', () => {
    const bySlot = Object.fromEntries(TEMPLATE_SLOTS.map((s) => [s.slot, s]));
    expect(bySlot['trial']).toMatchObject({
      agreedLocale: 'en',
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

describe('configuration problems', () => {
  it('finds nothing wrong with the agreed names and an unset or valid language', () => {
    const env = Object.fromEntries(TEMPLATE_SLOTS.map((s) => [s.env, s.agreedName]));
    expect(templateConfigProblems({ ...env, META_TRIAL_TEMPLATE_LOCALE: 'en' })).toEqual([]);
    expect(missingTemplateSlots(env)).toEqual([]);
  });

  it('lists unset and empty slots as missing, required and optional alike', () => {
    const missing = missingTemplateSlots({
      META_OTP_TEMPLATE: 'rekoda_login_otp',
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
    const problems = templateConfigProblems({ META_DOCUMENT_TEMPLATE: 'Secret Name!' });
    expect(problems).toHaveLength(1);
    expect(JSON.stringify(problems)).not.toContain('Secret Name');
    expect(problems[0]!.env).toBe('META_DOCUMENT_TEMPLATE');
  });
});

describe('billingPageUrl', () => {
  it('builds the billing page of the configured origin', () => {
    expect(billingPageUrl('https://staging.myrekoda.com')).toBe(
      'https://staging.myrekoda.com/app/billing',
    );
    expect(billingPageUrl('https://app.myrekoda.com')).toBe('https://app.myrekoda.com/app/billing');
  });

  it('is null with no origin', () => {
    expect(billingPageUrl(null)).toBeNull();
    expect(billingPageUrl('')).toBeNull();
  });
});
