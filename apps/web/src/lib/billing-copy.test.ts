import { describe, expect, it } from 'vitest';
import { graceStripCopy, emptyMeterCopy, partlyRefunded, undoPendingLabel } from './billing-copy';

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
