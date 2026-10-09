import { describe, expect, it } from 'vitest';
import { releaseMessage } from './bank-release';

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
