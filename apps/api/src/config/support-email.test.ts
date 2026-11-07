/**
 * REKODA_SUPPORT_EMAIL: Rekoda's separate support contact (OWN-83: not the reminder Reply-To). One
 * bare address or nothing; nothing needs it to boot, reminders included; a bad value refuses to
 * boot and is never echoed.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { BASE } from './env.fixtures.js';

const REMINDERS_ON = {
  ...BASE,
  REKODA_CUSTOMER_REMINDERS: '1',
  REKODA_WEB_URL: 'https://app.rekoda.test',
} as NodeJS.ProcessEnv;

describe('REKODA_SUPPORT_EMAIL', () => {
  it('loads one bare address, trimmed', () => {
    expect(
      loadConfig({ ...BASE, REKODA_SUPPORT_EMAIL: ' support@myrekoda.com ' }).supportEmail,
    ).toBe('support@myrekoda.com');
  });

  it('is null when unset, and reminders still boot: the support address is not their Reply-To', () => {
    expect(loadConfig({ ...BASE }).supportEmail).toBeNull();
    const reminders = loadConfig(REMINDERS_ON);
    expect(reminders.customerReminders).toBe(true);
    expect(reminders.supportEmail).toBeNull();
    expect(
      loadConfig({ ...REMINDERS_ON, REKODA_SUPPORT_EMAIL: 'support@myrekoda.com' }).supportEmail,
    ).toBe('support@myrekoda.com');
  });

  it('treats an empty value as unset, as a copied .env.example has it', () => {
    expect(loadConfig({ ...BASE, REKODA_SUPPORT_EMAIL: '' }).supportEmail).toBeNull();
    expect(loadConfig({ ...BASE, REKODA_SUPPORT_EMAIL: '  ' }).supportEmail).toBeNull();
    expect(loadConfig({ ...REMINDERS_ON, REKODA_SUPPORT_EMAIL: '' }).supportEmail).toBeNull();
  });

  it.each([
    'support',
    'support@',
    '@myrekoda.com',
    'Rekoda Support <support@myrekoda.com>',
    'a@myrekoda.com, b@myrekoda.com',
    'support@myrekoda.com\r\nBcc: x@evil.test',
    'support @myrekoda.com',
    `${'a'.repeat(250)}@x.co`,
  ])('refuses %j at boot, in every environment, without echoing it', (value) => {
    for (const env of [BASE, { ...BASE, NODE_ENV: 'development' }]) {
      let message = '';
      try {
        loadConfig({ ...env, REKODA_SUPPORT_EMAIL: value });
      } catch (e) {
        message = String(e);
      }
      expect(message).toMatch(/REKODA_SUPPORT_EMAIL must be one email address/);
      expect(message).not.toContain(value.trim());
    }
  });
});
