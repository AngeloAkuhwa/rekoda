/**
 * The replies to "my email is X" (OWN-83) when no confirmation link goes out. A new address is
 * saved before the link is asked for, so a confirmed address it replaced no longer counts and email
 * reminders pause; a reply must never say nothing changed when it did. Only `email_not_configured`
 * is refused before the address is saved. Split from replies.test.ts, which is over the layout
 * limit.
 */
import { describe, expect, it } from 'vitest';
import * as replies from './replies.js';

const PAUSED = /saved as your business email but not confirmed, so email reminders are paused/;

describe('business email replies when no link was sent', () => {
  it('a failed send does not say nothing changed, and says email reminders are paused', () => {
    const text = replies.businessEmailUnavailable('send_failed').text;
    expect(text).not.toMatch(/nothing was changed/i);
    expect(text).toMatch(PAUSED);
    expect(text).toContain('billing page');
  });

  it('with no email sender, nothing was saved, and it says so', () => {
    const text = replies.businessEmailUnavailable('email_not_configured').text;
    expect(text).toContain('nothing was changed');
    expect(text).not.toMatch(PAUSED);
    expect(text).not.toContain('billing page');
  });

  it('a refusal for too many requests says none was sent and that reminders are paused', () => {
    const text = replies.businessEmailTryLater(2).text;
    expect(text).toContain('so none was sent');
    expect(text).toContain('2 minutes');
    expect(text).toMatch(PAUSED);
  });

  it('an address that cannot take mail also says reminders are paused', () => {
    expect(replies.businessEmailUndeliverable().text).toMatch(PAUSED);
  });
});
