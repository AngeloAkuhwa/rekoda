import { describe, expect, it } from 'vitest';
import {
  browsingInterval,
  canOfferSwitch,
  chargeIntervalSuffix,
  emptyMeterCopy,
  firstPurchaseTerm,
  graceStripCopy,
  partlyRefunded,
  pendingIntervalCopy,
  perInterval,
  soldPrice,
  switchIntervalOffer,
  undoIntervalLabel,
  undoPendingLabel,
} from './billing-copy';

describe('billing copy that used to be false (G-107)', () => {
  it('never tells a stopped subscription that nothing will be refused', () => {
    const copy = emptyMeterCopy('expired', true);
    expect(copy).not.toMatch(/nothing you do will be refused/i);
    expect(copy).toMatch(/paused/);
    expect(copy).toMatch(/Settings has a full data export/);
  });

  it('does not send a non-owner to a Settings card they cannot see', () => {
    const copy = emptyMeterCopy('expired', false);
    expect(copy).not.toMatch(/Settings has/);
    expect(copy).toMatch(/owner can download/);
  });

  it('keeps the plain sentence for a plan that simply meters nothing', () => {
    for (const state of ['active', 'trial', 'grace'] as const) {
      expect(emptyMeterCopy(state, true)).toBe('This plan includes nothing to meter right now.');
    }
  });

  it('labels the undo for a cancellation and for a downgrade differently', () => {
    expect(undoPendingLabel('expired', 'Complete')).toBe('Keep my subscription');
    expect(undoPendingLabel('chat', 'Complete')).toBe('Stay on Complete');
  });
});

describe('the renewal-overdue strip (G-16)', () => {
  it('does not say a payment failed, because no payment was attempted', () => {
    for (const daysLeft of [1, 5]) {
      const copy = graceStripCopy('30 Oct 2026', daysLeft);
      expect(copy).not.toMatch(/did not go through|failed|declined/i);
      expect(copy).toMatch(/renewal/i);
      expect(copy).toMatch(/not (yet )?(received|paid)/i);
    }
  });

  it('says what keeps working, until when, and the next step', () => {
    const copy = graceStripCopy('30 Oct 2026', 3);
    expect(copy).toMatch(/keeps working until 30 Oct 2026, 3 days from now/);
    expect(copy).toMatch(/records are safe/i);
    expect(copy).toMatch(/upgrade/i);
  });

  it('reads one day in the singular', () => {
    expect(graceStripCopy('30 Oct 2026', 1)).toMatch(/one day from now/);
  });
});

describe('a partly refunded charge (G-111)', () => {
  it('shows no note for a charge with no refund', () => {
    expect(partlyRefunded(0, 'paid')).toBe(false);
  });

  it('notes a refund on a charge that is still Paid', () => {
    expect(partlyRefunded(100_000, 'paid')).toBe(true);
  });

  it('adds nothing to a fully refunded row, whose status already says so', () => {
    expect(partlyRefunded(250_000, 'refunded')).toBe(false);
  });
});

describe('yearly billing copy (OWN-40)', () => {
  it('names the unit of a price', () => {
    expect(perInterval('monthly')).toBe('a month');
    expect(perInterval('annual')).toBe('a year');
  });

  it('a switch never claims money moves now: the paid month or year is kept', () => {
    for (const pending of ['monthly', 'annual'] as const) {
      const copy = pendingIntervalCopy(pending);
      expect(copy).toMatch(/next renewal/);
      expect(copy).toMatch(/nothing is (refunded or )?charged now/i);
    }
    expect(pendingIntervalCopy('monthly')).toMatch(/keep the year you paid for/);
  });

  it('states the saving as ten months for twelve, and invents no urgency', () => {
    const offer = switchIntervalOffer('monthly');
    expect(offer).toMatch(/twelve months of service for the price of ten/);
    expect(offer).not.toMatch(/hurry|limited|today only|last chance|expires/i);
    expect(switchIntervalOffer('annual')).toMatch(/after the year you paid for/);
  });

  it('the undo and the confirmation say what is kept and what is bought', () => {
    expect(undoIntervalLabel('annual')).toBe('Stay on yearly billing');
    expect(undoIntervalLabel('monthly')).toBe('Stay on monthly billing');
    expect(firstPurchaseTerm('annual')).toBe('twelve months of service');
    expect(firstPurchaseTerm('monthly')).toBe('one month of service');
  });

  it('marks only yearly plan charges in the history', () => {
    expect(chargeIntervalSuffix('first_purchase', 'annual')).toBe(' · Yearly');
    expect(chargeIntervalSuffix('renewal', 'annual')).toBe(' · Yearly');
    expect(chargeIntervalSuffix('renewal', 'monthly')).toBe('');
    expect(chargeIntervalSuffix('add_on', 'annual')).toBe('');
    expect(chargeIntervalSuffix('upgrade', 'annual')).toBe('');
  });
});

describe('yearly billing gating', () => {
  it('browses yearly prices only when a year can be chosen', () => {
    expect(browsingInterval('annual', true)).toBe('annual');
    expect(browsingInterval('annual', false)).toBe('monthly');
    expect(browsingInterval(undefined, true)).toBe('monthly');
  });

  it('offers a monthly subscriber a year only when yearly billing is on, and a yearly one a way back always', () => {
    expect(canOfferSwitch('monthly', false)).toBe(false);
    expect(canOfferSwitch('monthly', true)).toBe(true);
    expect(canOfferSwitch('annual', false)).toBe(true);
  });
});

describe('the price a plan is sold at', () => {
  it('is the API row for that plan, and nothing for a plan the API does not list', () => {
    const overview = { planPrices: [{ plan: 'chat', monthlyK: 1_490_000, annualK: 14_900_000 }] };
    expect(soldPrice(overview, 'chat')).toMatchObject({
      monthlyK: 1_490_000,
      annualK: 14_900_000,
    });
    expect(soldPrice(overview, 'complete')).toBeUndefined();
  });
});
