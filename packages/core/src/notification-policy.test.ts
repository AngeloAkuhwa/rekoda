import { describe, expect, it } from 'vitest';
import { PURPOSE_POLICY, planChannels } from './notification-policy.js';

describe('planChannels', () => {
  it('tries WhatsApp first and adds email when both are on file', () => {
    expect(planChannels('debt_reminder', 'auto', { whatsapp: true, email: true })).toEqual([
      'whatsapp',
      'email',
    ]);
  });

  it('uses WhatsApp alone for a phone-only customer and email alone for an email-only one', () => {
    expect(planChannels('debt_reminder', 'auto', { whatsapp: true, email: false })).toEqual([
      'whatsapp',
    ]);
    expect(planChannels('debt_reminder', 'auto', { whatsapp: false, email: true })).toEqual([
      'email',
    ]);
  });

  it('returns nothing when neither channel can be tried', () => {
    expect(planChannels('debt_reminder', 'auto', { whatsapp: false, email: false })).toEqual([]);
  });

  it('honours an explicit choice even for a channel with no address, so the refusal has a reason', () => {
    expect(planChannels('debt_reminder', ['email'], { whatsapp: true, email: false })).toEqual([
      'email',
    ]);
    expect(
      planChannels('debt_reminder', ['email', 'whatsapp'], { whatsapp: true, email: true }),
    ).toEqual(['whatsapp', 'email']);
  });

  it('does not duplicate a one-time security message across channels', () => {
    expect(planChannels('security_verification', 'auto', { whatsapp: true, email: true })).toEqual([
      'whatsapp',
    ]);
    expect(planChannels('security_verification', 'auto', { whatsapp: false, email: true })).toEqual(
      ['email'],
    );
  });

  it('never lets a merchant switch off billing or security notices', () => {
    expect(PURPOSE_POLICY.billing_notice.optional).toBe(false);
    expect(PURPOSE_POLICY.security_verification.optional).toBe(false);
    expect(PURPOSE_POLICY.debt_reminder.optional).toBe(true);
  });
});
