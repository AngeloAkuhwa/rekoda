/**
 * The pricing page and the server must not be able to disagree.
 *
 * They already did once. After the owner decision of 26 August 2026 removed
 * `REKODA_CHAT` from the Integrate plan, `pricing-model.md` was corrected and
 * this file was not: the public page went on promising Integrate merchants
 * "Everything in Chat", 800 processed messages and 60 voice minutes, all
 * three of which the entitlement gate refuses. Nobody noticed, because copy
 * has no compiler.
 *
 * These tests are that compiler. They read the same capability matrix and the
 * same allowance table the server enforces, and fail when the page starts
 * selling something the gate would refuse.
 */
import { describe, expect, it } from 'vitest';
import { allowanceFor, capabilitiesFor, entitlementsForPlan } from '@rekoda/core';
import { PLANS, SHARED_ACROSS_PLANS, TRIAL } from './plans';

/**
 * A line that genuinely sells voice bookkeeping.
 *
 * Narrow on purpose. `/voice/i` also matches "Invoices", which is on every
 * plan card, and a matcher that reads an invoice line as a voice promise
 * fails on arithmetic nobody wrote.
 */
const SPEAKS_OF_VOICE = /voice[- ]note|voice minutes?/i;

/** Words that only ever describe the conversational interface. */
const CHAT_WORDS = [
  /voice[- ]note/i,
  /\bvoice minutes?\b/i,
  /messages? processed/i,
  /talking to rekoda/i,
  /ask rekoda/i,
];

describe('what each plan promises', () => {
  /**
   * The exact regression. An Integrate plan holds REKODA_INTEGRATE and
   * nothing else, so nothing on its card may describe the Chat interface.
   */
  it('never sells the Chat interface inside Integrate', () => {
    const integrate = PLANS.find((plan) => plan.id === 'integrate');
    expect(integrate).toBeDefined();
    const sold = [...(integrate?.includes ?? []), ...(integrate?.coming ?? [])].join(' · ');
    for (const word of CHAT_WORDS) {
      expect(sold, `Integrate must not promise ${word}`).not.toMatch(word);
    }
    expect(sold).not.toMatch(/everything in chat/i);
  });

  /** And it says plainly what is missing, rather than leaving it to be found. */
  it('names what Integrate does not include', () => {
    const integrate = PLANS.find((plan) => plan.id === 'integrate');
    expect(integrate?.excludes?.join(' ')).toMatch(/needs Chat/i);
  });

  /**
   * Chat holds no REKODA_INTEGRATE, so its card must not promise a shop link,
   * a catalogue or automatic order capture. The mirror of the bug above,
   * asserted so the correction cannot be made in only one direction.
   */
  it('never sells customer commerce inside Chat', () => {
    const chat = PLANS.find((plan) => plan.id === 'chat');
    const sold = [...(chat?.includes ?? []), ...(chat?.coming ?? [])].join(' · ');
    for (const word of [/shop link/i, /catalogue/i, /orders captured/i]) {
      expect(sold, `Chat must not promise ${word}`).not.toMatch(word);
    }
  });

  /**
   * Every plan card that quotes a number of voice minutes must quote the
   * number the meter actually enforces. `allowanceFor` returns seconds; the
   * page speaks minutes.
   */
  it.each(['chat', 'complete'])('quotes %s voice minutes the meter would honour', (id) => {
    const plan = PLANS.find((candidate) => candidate.id === id);
    const quoted = plan?.includes.find((line) => SPEAKS_OF_VOICE.test(line));
    expect(quoted, `${id} says how much voice it sells`).toBeDefined();
    const minutes = Number(quoted?.match(/(\d+)\s*(?:voice\s+)?minutes?/i)?.[1]);
    expect(minutes, `${id} quotes a number of minutes`).not.toBeNaN();
    expect(minutes * 60).toBe(allowanceFor(id, 'VOICE_MINUTES'));
  });

  /**
   * And a plan the meter gives no voice to must not mention it at all.
   *
   * The matcher below is deliberately narrow, because the obvious one is not:
   * "Invoices" contains the letters of "voice", and a looser pattern read the
   * trial's invoice line as a voice promise and then failed on arithmetic
   * that was never there.
   */
  it('never mentions voice on a plan that has none', () => {
    for (const plan of PLANS) {
      if (allowanceFor(plan.id, 'VOICE_MINUTES') > 0) continue;
      const sold = [...plan.includes, ...(plan.coming ?? [])];
      expect(
        sold.filter((line) => SPEAKS_OF_VOICE.test(line)),
        plan.id,
      ).toEqual([]);
    }
  });

  /* The trial mentions no voice, which is an omission rather than a lie: it
   * carries ten minutes. What it must never do is quote a wrong figure. */
  it('quotes the trial nothing it cannot honour', () => {
    const quoted = TRIAL.includes.find((line) => SPEAKS_OF_VOICE.test(line));
    if (!quoted) {
      expect(allowanceFor('trial', 'VOICE_MINUTES')).toBeGreaterThanOrEqual(0);
      return;
    }
    const minutes = Number(quoted.match(/(\d+)\s*(?:voice\s+)?minutes?/i)?.[1]);
    expect(minutes * 60).toBe(allowanceFor('trial', 'VOICE_MINUTES'));
  });
});

/**
 * The dashboard is shared. Every paid plan carries it, and the page has to
 * say so somewhere a reader will find, or the natural assumption is that the
 * cheapest plan is the one with the books in it.
 */
describe('the shared dashboard', () => {
  it('is stated once, for every plan', () => {
    expect(SHARED_ACROSS_PLANS.join(' ')).toMatch(/dashboard/i);
    expect(SHARED_ACROSS_PLANS.join(' ')).toMatch(/by hand/i);
  });

  it('is true of the capability matrix, not just of the copy', () => {
    for (const id of ['chat', 'integrate', 'complete']) {
      const held = capabilitiesFor(id, entitlementsForPlan(id));
      expect(held, `${id} keeps the dashboard`).toContain('DASHBOARD_READ');
      expect(held, `${id} keeps manual bookkeeping`).toContain('MANUAL_BOOKKEEPING');
      expect(held, `${id} keeps reporting`).toContain('REPORTING');
    }
  });
});
