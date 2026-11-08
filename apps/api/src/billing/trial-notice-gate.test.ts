/**
 * The worker's gate for the trial sweep (OD-41(b), OWN-80): a trial template with no usable
 * billing page is not configured, so the sweep claims nothing (trial-notice-sweep.integration.test.ts
 * proves a false gate claims nothing). jobs.module.ts passes exactly this.
 */
import { describe, expect, it } from 'vitest';
import { trialNoticeGate } from './trial-notice-sweep.js';

describe('the trial sweep gate the worker uses', () => {
  it('is closed when the template is set but there is no billing page to link to', () => {
    expect(trialNoticeGate({ metaTrialTemplate: 'rekoda_trial_ending', webUrl: null })).toEqual({
      templateConfigured: false,
      billingUrl: null,
    });
  });

  it('is closed when there is a billing page but no template', () => {
    expect(
      trialNoticeGate({ metaTrialTemplate: null, webUrl: 'https://staging.myrekoda.com' }),
    ).toMatchObject({ templateConfigured: false });
  });

  it('is open with both, and hands the sweep the billing page', () => {
    expect(
      trialNoticeGate({
        metaTrialTemplate: 'rekoda_trial_ending',
        webUrl: 'https://staging.myrekoda.com',
      }),
    ).toEqual({
      templateConfigured: true,
      billingUrl: 'https://staging.myrekoda.com/app/billing',
    });
  });
});
