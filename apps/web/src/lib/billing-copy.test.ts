import { describe, expect, it } from 'vitest';
import { emptyMeterCopy, undoPendingLabel } from './billing-copy';

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
