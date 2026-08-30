/**
 * The retry schedule behind object deletion (PR-136).
 *
 * Pure arithmetic, and worth pinning because the property that matters is
 * one a plausible implementation gets wrong: this schedule must never run
 * out. A backoff table that returns undefined past its last entry, or a
 * caller that treats "out of attempts" as done, would drop a deletion the
 * merchant was told had happened.
 */
import { describe, expect, it } from 'vitest';
import { OBJECT_DELETION_BACKOFF_SECONDS, objectDeletionRetryAt } from './retention.js';

const AT = new Date('2026-06-01T12:00:00.000Z');
const secondsAfter = (date: Date) => (date.getTime() - AT.getTime()) / 1_000;

describe('when to try deleting an object again', () => {
  it('walks the schedule, one step per attempt already made', () => {
    expect(secondsAfter(objectDeletionRetryAt(0, AT))).toBe(60);
    expect(secondsAfter(objectDeletionRetryAt(1, AT))).toBe(300);
    expect(secondsAfter(objectDeletionRetryAt(2, AT))).toBe(1_800);
    expect(secondsAfter(objectDeletionRetryAt(3, AT))).toBe(7_200);
    expect(secondsAfter(objectDeletionRetryAt(4, AT))).toBe(21_600);
  });

  it('never runs out: past the last step it keeps the last interval, forever', () => {
    /* The property this file exists for. A merchant was told their documents
     * were deleted; a schedule that gave up would make that untrue quietly,
     * and the giving up would be invisible. */
    const last = OBJECT_DELETION_BACKOFF_SECONDS[OBJECT_DELETION_BACKOFF_SECONDS.length - 1]!;
    for (const attempts of [5, 12, 400, 100_000]) {
      expect(secondsAfter(objectDeletionRetryAt(attempts, AT))).toBe(last);
    }
  });

  it('treats a nonsensical attempt count as the first one, never as no delay', () => {
    /* A zero-delay retry would spin a failing job against the provider at
     * whatever rate the loop runs. Clamping down to the first step is the
     * conservative direction. */
    expect(secondsAfter(objectDeletionRetryAt(-1, AT))).toBe(60);
  });

  it('rises, and stays inside a day', () => {
    const steps = [...OBJECT_DELETION_BACKOFF_SECONDS];
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(new Set(steps).size).toBe(steps.length);
    /* Nothing in the tail should be so long that a stuck queue goes a whole
     * day without another look at it. */
    expect(Math.max(...steps)).toBeLessThanOrEqual(86_400);
  });
});
