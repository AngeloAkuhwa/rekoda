import { describe, expect, it } from 'vitest';
import { forgetMessage, releaseMessage } from './bank-release';

describe('what the bank page says after a release (G-95)', () => {
  it('says a classification was reversed, not that its entry is back where it was', () => {
    const said = releaseMessage({ outcome: 'released_classification', released: 1 });
    expect(said).toEqual({
      done: 'Released. Rekoda reversed the classification entry and left the bank line unmatched so you can classify it again.',
    });
  });

  it('says an ordinary entry is untouched', () => {
    expect(releaseMessage({ outcome: 'released_match', released: 1 })).toEqual({
      done: 'Released. The bank line and the existing entry are unmatched again.',
    });
  });

  it('keeps the old answer for a line that was not matched', () => {
    expect(releaseMessage({ outcome: 'not_matched', released: 0 })).toEqual({
      done: 'That line was not matched to anything.',
    });
  });

  it('refuses honestly when the correction cannot be dated today', () => {
    const said = releaseMessage({
      outcome: 'period_closed',
      released: 0,
      closedThrough: '2026-10',
    });
    expect('error' in said && said.error).toMatch(
      /^Your books are closed through .+Nothing was changed\.$/,
    );
  });

  it('never claims an entry was deleted', () => {
    for (const outcome of [
      { outcome: 'released_classification', released: 1 },
      { outcome: 'released_match', released: 1 },
    ] as const) {
      const said = releaseMessage(outcome);
      expect('done' in said && said.done).not.toMatch(/delet|remov|gone/i);
    }
  });
});

describe('what the bank page says after a day is forgotten (G-97)', () => {
  it('keeps the old sentence when nothing was classified', () => {
    expect(forgetMessage({ outcome: 'forgotten', removed: 2, reversedClassifications: 0 })).toEqual(
      { done: 'Removed 2 lines from that day. You can import them again at any time.' },
    );
  });

  it('says how many classification entries were reversed, and that nothing else moved', () => {
    expect(forgetMessage({ outcome: 'forgotten', removed: 5, reversedClassifications: 2 })).toEqual(
      {
        done: 'Removed 5 lines from that day, and Rekoda reversed the 2 classification entries created from those lines. Other entries in your books are unchanged. You can import the day again at any time.',
      },
    );
    expect(forgetMessage({ outcome: 'forgotten', removed: 1, reversedClassifications: 1 })).toEqual(
      {
        done: 'Removed 1 line from that day, and Rekoda reversed the 1 classification entry created from that line. Other entries in your books are unchanged. You can import the day again at any time.',
      },
    );
  });

  it('says there was nothing to remove', () => {
    expect(forgetMessage({ outcome: 'forgotten', removed: 0, reversedClassifications: 0 })).toEqual(
      { done: 'There was nothing from that day to remove.' },
    );
  });

  it('refuses honestly when the reversals cannot be dated today', () => {
    const said = forgetMessage({
      outcome: 'period_closed',
      removed: 0,
      reversedClassifications: 0,
      closedThrough: '2026-10',
    });
    expect('error' in said && said.error).toMatch(
      /^Your books are closed through .+Nothing was removed\.$/,
    );
  });

  it('never claims a sale, payment or other entry was reversed or deleted', () => {
    const said = forgetMessage({ outcome: 'forgotten', removed: 3, reversedClassifications: 1 });
    expect('done' in said && said.done).not.toMatch(/sale|payment|deleted/i);
  });
});
