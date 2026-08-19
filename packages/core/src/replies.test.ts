/**
 * What Rekoda says back (MASTER-PLAN §5.3.4).
 *
 * Copy is a product surface and a bug in a string is still a bug. These assert
 * the three rules the file is built on: short enough to read on a phone, never
 * claiming something that has not happened, and naming what to do next.
 */
import { describe, expect, it } from 'vitest';
import * as replies from './replies.js';

const ALL = [
  replies.greeting(),
  replies.help(),
  replies.optedOut(),
  replies.optedIn(),
  replies.cancelled(),
  replies.confirmErasure(),
  replies.strayNumber(),
  replies.quotaReachedForBusiness(),
  replies.busyRightNow(),
  replies.couldNotRead(),
  replies.notYet('Your debtor list'),
  replies.noAccount(),
];

describe('every reply', () => {
  it('is short enough to read without tapping "Read more"', () => {
    for (const reply of ALL) {
      expect(replies.isSendable(reply)).toBe(true);
      expect(reply.text.length).toBeLessThanOrEqual(replies.MAX_REPLY_CHARS);
    }
  });

  it('never claims a record was saved', () => {
    /**
     * The single worst thing a bookkeeping assistant can say is "Saved!" about
     * something that was not. Nothing in this file has issued a document, so
     * nothing in this file may imply one.
     */
    for (const reply of ALL) {
      // Affirmative claims only. "Cancelled. Nothing was saved." is the
      // opposite of the failure this guards, and an earlier version of this
      // test flagged it — a regex looking for the word rather than the claim.
      expect(reply.text).not.toMatch(
        /\b(?:saved!|i(?:'ve| have)? saved|has been saved|recorded it|invoice sent|receipt sent)\b/i,
      );
    }
  });

  it('does not apologise its way through a failure', () => {
    // "Something went wrong" wastes the one message a merchant will read.
    for (const reply of [replies.busyRightNow(), replies.couldNotRead()]) {
      expect(reply.text).not.toMatch(/something went wrong|an error occurred|try again later\.$/i);
    }
  });
});

describe('the failures each say something different', () => {
  it('tells a merchant at their own limit when it resets', () => {
    const text = replies.quotaReachedForBusiness().text;
    expect(text).toMatch(/limit/i);
    expect(text).toMatch(/midnight/i);
    // And what still works, so the message is not a dead end.
    expect(text).toMatch(/who owes me|records/i);
  });

  it('does not blame the merchant when the platform is busy', () => {
    const text = replies.busyRightNow().text;
    expect(text).toMatch(/busy/i);
    expect(text).toMatch(/nothing was lost/i);
    expect(text).not.toMatch(/you (?:sent|typed|wrote) .*(?:wrong|incorrectly)/i);
  });

  it('shows the shape of a message that works when it could not read one', () => {
    // Cheaper than an explanation, and it is what the merchant needs.
    expect(replies.couldNotRead().text).toMatch(/sold .* for .*k/i);
  });
});

describe('erasure', () => {
  it('asks for confirmation and says plainly what is lost', () => {
    const text = replies.confirmErasure().text;
    expect(text).toMatch(/cannot be undone/i);
    expect(text).toMatch(/DELETE MY DATA/);
    // The one place a second message is worth the friction: an accidental
    // deletion cannot be undone by any amount of apology.
    expect(text).toMatch(/again to confirm/i);
  });
});

describe('a capability that is not built', () => {
  it('says so, and says what does work', () => {
    const text = replies.notYet('Your debtor list').text;
    expect(text).toContain('Your debtor list');
    expect(text).toMatch(/not ready yet/i);
    expect(text).toMatch(/sales, payments and expenses/i);
  });
});

describe('sending guards', () => {
  it('refuses an empty reply', () => {
    expect(replies.isSendable({ text: '' })).toBe(false);
    expect(replies.isSendable({ text: '   ' })).toBe(false);
  });

  it('truncates rather than sending nothing', () => {
    // A model's clarification is interpolated verbatim, so the length ceiling
    // has to survive one that runs long.
    const long = { text: 'x'.repeat(5_000) };
    const trimmed = replies.truncateForSending(long);
    expect(trimmed.text.length).toBe(replies.MAX_REPLY_CHARS);
    expect(trimmed.text.endsWith('…')).toBe(true);
    expect(replies.isSendable(trimmed)).toBe(true);
  });

  it('leaves an ordinary reply untouched', () => {
    expect(replies.truncateForSending(replies.greeting()).text).toBe(replies.greeting().text);
  });

  it('passes a clarification through as the model wrote it', () => {
    expect(replies.clarification('  How many wigs?  ').text).toBe('How many wigs?');
  });
});
