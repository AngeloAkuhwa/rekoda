/**
 * Launch feature switches that are off unless set to exactly `1`: annual
 * billing sales and customer payment reminders.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { BASE } from './env.fixtures.js';

describe('REKODA_ANNUAL_BILLING', () => {
  it('is off when absent or 0, on for 1, and refuses to boot on anything else', () => {
    expect(loadConfig({ ...BASE }).annualBillingSales).toBe(false);
    expect(loadConfig({ ...BASE, REKODA_ANNUAL_BILLING: '0' }).annualBillingSales).toBe(false);
    expect(loadConfig({ ...BASE, REKODA_ANNUAL_BILLING: '1' }).annualBillingSales).toBe(true);
    expect(() => loadConfig({ ...BASE, REKODA_ANNUAL_BILLING: '' })).toThrow(
      /REKODA_ANNUAL_BILLING/,
    );
    expect(() => loadConfig({ ...BASE, REKODA_ANNUAL_BILLING: 'true' })).toThrow(
      /REKODA_ANNUAL_BILLING/,
    );
  });
});

describe('REKODA_CUSTOMER_REMINDERS', () => {
  it('is off unless set to 1, and refuses anything else', () => {
    expect(loadConfig({ ...BASE }).customerReminders).toBe(false);
    expect(loadConfig({ ...BASE, REKODA_CUSTOMER_REMINDERS: '0' }).customerReminders).toBe(false);
    expect(() => loadConfig({ ...BASE, REKODA_CUSTOMER_REMINDERS: 'yes' })).toThrow(
      'REKODA_CUSTOMER_REMINDERS',
    );
  });

  it('refuses to boot when on without an https web URL', () => {
    const on = { ...BASE, REKODA_CUSTOMER_REMINDERS: '1' };
    expect(() => loadConfig(on)).toThrow('https://');
    expect(() => loadConfig({ ...on, REKODA_WEB_URL: 'http://app.rekoda.test' })).toThrow(
      'https://',
    );
    for (const bad of [
      'https://app.rekoda.test/#top',
      'https://app.rekoda.test/?a=1',
      'https://app.rekoda.test/?',
      'https://app.rekoda.test/#',
      'https://app.rekoda.test/sign-in',
      'https://user:pass@app.rekoda.test',
      'https://user@app.rekoda.test',
    ]) {
      expect(() => loadConfig({ ...on, REKODA_WEB_URL: bad })).toThrow(
        'no credentials, path, query or fragment',
      );
    }
    expect(
      loadConfig({
        ...on,
        REKODA_WEB_URL: 'https://app.rekoda.test',
      }).customerReminders,
    ).toBe(true);
  });
});
