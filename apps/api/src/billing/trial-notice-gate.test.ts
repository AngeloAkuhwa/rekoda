/**
 * The worker's gate for the trial sweep (OD-41(b), OWN-80): a trial template with no usable
 * billing page is not configured, so the sweep claims nothing (trial-notice-sweep.integration.test.ts
 * proves a false gate claims nothing). jobs.module.ts passes exactly this.
 */
import { describe, expect, it } from 'vitest';
import { trialNoticeGate } from './trial-notice-sweep.js';

describe('the trial sweep gate the worker uses', () => {
  it('is closed when the template is set but there is no billing page to link to', () => {
    expect(
      trialNoticeGate({
        metaTemplates: { trial: { name: 'any_trial_template', locale: 'en' } },
        webUrl: null,
      }),
    ).toEqual({
      templateConfigured: false,
      billingUrl: null,
    });
  });

  it('is closed when there is a billing page but no template', () => {
    expect(
      trialNoticeGate({ metaTemplates: { trial: null }, webUrl: 'https://app.example.test' }),
    ).toMatchObject({ templateConfigured: false });
  });

  it('is open with both, and hands the sweep the billing page', () => {
    expect(
      trialNoticeGate({
        metaTemplates: { trial: { name: 'any_trial_template', locale: 'en' } },
        webUrl: 'https://app.example.test',
      }),
    ).toEqual({
      templateConfigured: true,
      billingUrl: 'https://app.example.test/app/billing',
    });
  });
});
