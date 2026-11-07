/**
 * WhatsApp template settings at boot (OD-41(b)). A name or language Meta cannot have approved is
 * refused everywhere, without echoing the value; in production a grace or trial template needs an
 * https billing page to link to. Unset slots do not stop a boot (the sender refuses those messages
 * as not sent, and the read-only staging check reports them).
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { BASE } from './env.fixtures.js';

const PROD = {
  ...BASE,
  NODE_ENV: 'production',
  META_APP_SECRET: 'm'.repeat(40),
  META_VERIFY_TOKEN: 'v'.repeat(40),
  OPERATOR_OIDC_ISSUER: 'https://issuer.example.com',
  OPERATOR_OIDC_AUDIENCE: 'rekoda-ops',
  OPERATOR_OIDC_JWKS_URL: 'https://issuer.example.com/jwks',
  REKODA_TRUSTED_PROXIES: '172.30.10.10',
  REKODA_TRUSTED_WEB: '172.30.10.11',
} as NodeJS.ProcessEnv;

const ALL_FIVE = {
  META_OTP_TEMPLATE: 'rekoda_login_otp',
  META_BILLING_TEMPLATE: 'rekoda_billing_grace_notice',
  META_RETENTION_TEMPLATE: 'rekoda_retention_notice',
  META_DOCUMENT_TEMPLATE: 'rekoda_document_ready',
  META_TRIAL_TEMPLATE: 'rekoda_trial_ending',
  META_TRIAL_TEMPLATE_LOCALE: 'en',
};

describe('template names and languages', () => {
  it('loads the five agreed templates with their languages', () => {
    const config = loadConfig({ ...BASE, ...ALL_FIVE, META_OTP_TEMPLATE_LOCALE: 'en_US' });
    expect(config.metaOtpTemplate).toBe('rekoda_login_otp');
    expect(config.metaOtpTemplateLocale).toBe('en_US');
    expect(config.metaBillingTemplate).toBe('rekoda_billing_grace_notice');
    expect(config.metaRetentionTemplate).toBe('rekoda_retention_notice');
    expect(config.metaDocumentTemplate).toBe('rekoda_document_ready');
    expect(config.metaTrialTemplate).toBe('rekoda_trial_ending');
    expect(config.metaTrialTemplateLocale).toBe('en');
    // An unset language is English, as before.
    expect(config.metaBillingTemplateLocale).toBe('en');
  });

  it('boots with every slot unset (the sender refuses those messages, it never sends free text)', () => {
    const config = loadConfig({ ...BASE });
    expect(config.metaTrialTemplate).toBeNull();
    expect(config.metaBillingTemplate).toBeNull();
  });

  it.each([
    ['META_TRIAL_TEMPLATE', 'Rekoda Trial Ending'],
    ['META_BILLING_TEMPLATE', 'rekoda-billing'],
    ['META_DOCUMENT_TEMPLATE', 'rekoda_document_ready '],
    ['META_OTP_TEMPLATE', 'rekoda_login_otp;drop'],
  ])('refuses a malformed %s and does not echo it', (key, value) => {
    expect(() => loadConfig({ ...BASE, [key]: value })).toThrow(new RegExp(`^${key} must be`));
    try {
      loadConfig({ ...BASE, [key]: value });
    } catch (e) {
      expect(String(e)).not.toContain(value);
    }
  });

  it.each([
    ['META_TRIAL_TEMPLATE_LOCALE', 'english'],
    ['META_TRIAL_TEMPLATE_LOCALE', ''],
    ['META_OTP_TEMPLATE_LOCALE', 'en-US'],
    ['META_RETENTION_TEMPLATE_LOCALE', 'EN'],
  ])('refuses a malformed %s (%j)', (key, value) => {
    expect(() => loadConfig({ ...BASE, [key]: value })).toThrow(new RegExp(`^${key} must be`));
  });
});

describe('the billing link in the grace and trial templates', () => {
  it('in production, refuses a trial or billing template with no https REKODA_WEB_URL', () => {
    for (const key of ['META_TRIAL_TEMPLATE', 'META_BILLING_TEMPLATE']) {
      for (const web of [undefined, 'http://staging.myrekoda.com', 'not a url']) {
        const env = { ...PROD, [key]: 'rekoda_trial_ending' } as NodeJS.ProcessEnv;
        if (web !== undefined) env['REKODA_WEB_URL'] = web;
        expect(() => loadConfig(env)).toThrow(/REKODA_WEB_URL is not an https:\/\/ origin/);
      }
    }
  });

  it('in production, boots with both templates and the staging origin', () => {
    const config = loadConfig({
      ...PROD,
      META_TRIAL_TEMPLATE: 'rekoda_trial_ending',
      META_BILLING_TEMPLATE: 'rekoda_billing_grace_notice',
      REKODA_WEB_URL: 'https://staging.myrekoda.com',
    });
    expect(config.webUrl).toBe('https://staging.myrekoda.com');
  });

  it('outside production, boots without an origin (the sender refuses those notices as not sent)', () => {
    expect(() => loadConfig({ ...BASE, META_TRIAL_TEMPLATE: 'rekoda_trial_ending' })).not.toThrow();
  });
});
