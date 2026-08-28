/**
 * What Rekoda signs, and what a merchant's verifier must check (PR-112).
 *
 * The inbound verifiers are tested in `webhooks.test.ts`; this is the other
 * direction, and the property that matters most is the one a receiver can
 * get wrong: a signature that covers the body alone is replayable forever,
 * so the timestamp is inside the signed material and out-of-window is a
 * refusal even when the digest is perfect.
 */
import { describe, expect, it } from 'vitest';
import {
  nextAttemptAt,
  signWebhook,
  verifyRekodaSignature,
  wantsEvent,
  WEBHOOK_BACKOFF_SECONDS,
  WEBHOOK_REPLAY_WINDOW_SECONDS,
} from './webhooks.js';

const SECRET = 'a'.repeat(64);
const BODY = '{"id":"e1","type":"sale.recorded"}';
const NOW = new Date('2026-08-28T10:00:00Z');

describe('signing', () => {
  it('produces a header a verifier accepts', () => {
    const header = signWebhook(BODY, SECRET, NOW);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyRekodaSignature(BODY, header, SECRET, NOW)).toBe(true);
  });

  it('refuses a body that changed by one byte', () => {
    const header = signWebhook(BODY, SECRET, NOW);
    expect(verifyRekodaSignature(`${BODY} `, header, SECRET, NOW)).toBe(false);
  });

  it('refuses the wrong secret, which is the whole point', () => {
    const header = signWebhook(BODY, SECRET, NOW);
    expect(verifyRekodaSignature(BODY, header, 'b'.repeat(64), NOW)).toBe(false);
  });

  it('refuses a replay once the window has passed', () => {
    const header = signWebhook(BODY, SECRET, NOW);
    const inside = new Date(NOW.getTime() + (WEBHOOK_REPLAY_WINDOW_SECONDS - 1) * 1_000);
    const outside = new Date(NOW.getTime() + (WEBHOOK_REPLAY_WINDOW_SECONDS + 1) * 1_000);
    expect(verifyRekodaSignature(BODY, header, SECRET, inside)).toBe(true);
    expect(verifyRekodaSignature(BODY, header, SECRET, outside)).toBe(false);
  });

  it('refuses a timestamp moved to dodge the window, because it is signed', () => {
    const header = signWebhook(BODY, SECRET, NOW);
    const later = Math.floor(NOW.getTime() / 1000) + 10_000;
    const forged = header.replace(/^t=\d+/, `t=${later}`);
    expect(verifyRekodaSignature(BODY, forged, SECRET, new Date(later * 1000))).toBe(false);
  });

  it('refuses a missing header, a missing secret and a malformed header', () => {
    expect(verifyRekodaSignature(BODY, undefined, SECRET, NOW)).toBe(false);
    expect(verifyRekodaSignature(BODY, signWebhook(BODY, SECRET, NOW), '', NOW)).toBe(false);
    expect(verifyRekodaSignature(BODY, 'v1=deadbeef', SECRET, NOW)).toBe(false);
    expect(verifyRekodaSignature(BODY, 't=notanumber,v1=deadbeef', SECRET, NOW)).toBe(false);
  });
});

describe('the retry schedule', () => {
  it('backs off and then holds at a day', () => {
    const seconds = [1, 2, 3, 4, 5, 6].map(
      (attempt) => (nextAttemptAt(attempt, NOW).getTime() - NOW.getTime()) / 1_000,
    );
    expect(seconds).toEqual([...WEBHOOK_BACKOFF_SECONDS]);
  });

  it('never reaches past the end of the table, however many attempts happened', () => {
    expect(nextAttemptAt(99, NOW)).toEqual(nextAttemptAt(WEBHOOK_BACKOFF_SECONDS.length, NOW));
    /* Attempt zero cannot happen — the caller counts the attempt it just
     * made — but a schedule that returns "now" for it would hot-loop. */
    expect(nextAttemptAt(0, NOW).getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe('subscriptions', () => {
  it('treats an empty subscription as everything', () => {
    expect(wantsEvent([], 'sale.recorded')).toBe(true);
    expect(wantsEvent([], 'anything.at.all')).toBe(true);
  });

  it('sends only what was asked for once something was asked for', () => {
    expect(wantsEvent(['sale.recorded'], 'sale.recorded')).toBe(true);
    expect(wantsEvent(['sale.recorded'], 'payment.recorded')).toBe(false);
  });
});
