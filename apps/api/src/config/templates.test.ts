/**
 * WhatsApp template settings at boot (OD-41(b), OWN-93). The configured name and language are used
 * exactly as given, with no default for either; a template set without its language, or a name or
 * language Meta cannot have approved, is refused everywhere, without echoing the value; in production a grace or trial template needs an
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

/* Synthetic settings (OWN-93): arbitrary names and languages, never the owner's real templates. */
const ALL_FIVE = {
  META_OTP_TEMPLATE: 'shop_login_code_2027',
  META_OTP_TEMPLATE_LOCALE: 'en_US',
  META_BILLING_TEMPLATE: 'grace_period_heads_up',
  META_BILLING_TEMPLATE_LOCALE: 'ha',
  META_RETENTION_TEMPLATE: 'account_cleanup_warning',
  META_RETENTION_TEMPLATE_LOCALE: 'fr',
  META_DOCUMENT_TEMPLATE: 'paperwork_ready_v7',
  META_DOCUMENT_TEMPLATE_LOCALE: 'en',
  META_TRIAL_TEMPLATE: 'my_custom_trial_template',
  META_TRIAL_TEMPLATE_LOCALE: 'pt_BR',
};

describe('template names and languages', () => {
  it('loads each slot with exactly the configured name and language', () => {
    const config = loadConfig({ ...BASE, ...ALL_FIVE });
    expect(config.metaTemplates).toEqual({
      otp: { name: 'shop_login_code_2027', locale: 'en_US' },
      billing: { name: 'grace_period_heads_up', locale: 'ha' },
      retention: { name: 'account_cleanup_warning', locale: 'fr' },
      document: { name: 'paperwork_ready_v7', locale: 'en' },
      trial: { name: 'my_custom_trial_template', locale: 'pt_BR' },
    });
  });

  it('boots with every slot unset or empty, and configures none (no default name or language)', () => {
    for (const env of [
      { ...BASE },
      {
        ...BASE,
        META_TRIAL_TEMPLATE: '',
        META_TRIAL_TEMPLATE_LOCALE: '',
        META_OTP_TEMPLATE: '',
        META_OTP_TEMPLATE_LOCALE: '',
      },
    ]) {
      expect(loadConfig(env).metaTemplates).toEqual({
        otp: null,
        billing: null,
        retention: null,
        document: null,
        trial: null,
      });
    }
  });

  it.each([
    'META_OTP_TEMPLATE',
    'META_BILLING_TEMPLATE',
    'META_RETENTION_TEMPLATE',
    'META_DOCUMENT_TEMPLATE',
    'META_TRIAL_TEMPLATE',
  ])('refuses %s without its language instead of assuming one', (key) => {
    const env = { ...BASE, ...ALL_FIVE } as NodeJS.ProcessEnv;
    delete env[`${key}_LOCALE`];
    expect(() => loadConfig(env)).toThrow(
      new RegExp(`^${key}_LOCALE must be set when ${key} is set`),
    );
    expect(() => loadConfig({ ...env, [`${key}_LOCALE`]: '' })).toThrow(
      new RegExp(`^${key}_LOCALE must be set`),
    );
  });

  it('boots with a language set for an unset template (inert; the staging check reports it)', () => {
    expect(
      loadConfig({ ...BASE, META_RETENTION_TEMPLATE_LOCALE: 'fr' }).metaTemplates.retention,
    ).toBeNull();
  });

  it.each([
    ['META_TRIAL_TEMPLATE', 'Trial Ending Soon'],
    ['META_BILLING_TEMPLATE', 'grace-notice'],
    ['META_DOCUMENT_TEMPLATE', 'paperwork_ready '],
    ['META_OTP_TEMPLATE', 'signin_code;drop'],
  ])('refuses a malformed %s and does not echo it', (key, value) => {
    const env = { ...BASE, [key]: value, [`${key}_LOCALE`]: 'en' };
    expect(() => loadConfig(env)).toThrow(new RegExp(`^${key} must be`));
    try {
      loadConfig(env);
    } catch (e) {
      expect(String(e)).not.toContain(value);
    }
  });

  it.each([
    ['META_TRIAL_TEMPLATE_LOCALE', 'english'],
    ['META_TRIAL_TEMPLATE_LOCALE', ' en'],
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
        const env = {
          ...PROD,
          [key]: 'any_template',
          [`${key}_LOCALE`]: 'en',
        } as NodeJS.ProcessEnv;
        if (web !== undefined) env['REKODA_WEB_URL'] = web;
        expect(() => loadConfig(env)).toThrow(/REKODA_WEB_URL is not an https:\/\/ origin/);
      }
    }
  });

  it('in production, boots with both templates and the staging origin', () => {
    const config = loadConfig({
      ...PROD,
      META_TRIAL_TEMPLATE: 'any_trial_template',
      META_TRIAL_TEMPLATE_LOCALE: 'en',
      META_BILLING_TEMPLATE: 'any_grace_template',
      META_BILLING_TEMPLATE_LOCALE: 'en',
      REKODA_WEB_URL: 'https://app.example.test',
    });
    expect(config.webUrl).toBe('https://app.example.test');
  });

  it('outside production, boots without an origin (the sender refuses those notices as not sent)', () => {
    expect(() =>
      loadConfig({
        ...BASE,
        META_TRIAL_TEMPLATE: 'any_trial_template',
        META_TRIAL_TEMPLATE_LOCALE: 'en',
      }),
    ).not.toThrow();
  });
});
