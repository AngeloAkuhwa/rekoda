import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SWEEP_FIRST_PASS_MS, scheduleSweep } from './sweep-schedule.js';

const SIX_HOURS = 21_600_000;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('scheduleSweep (G-10)', () => {
  /**
   * The defect: a six-hour sweep first ran six hours after boot, so a worker
   * restarted every hour never ran it. It now runs once shortly after boot.
   */
  it('runs a six-hour sweep once shortly after boot, not six hours later', () => {
    const run = vi.fn();
    scheduleSweep({ run, intervalMs: SIX_HOURS });

    vi.advanceTimersByTime(SWEEP_FIRST_PASS_MS - 1);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('then settles onto its interval, counted from boot', () => {
    const run = vi.fn();
    scheduleSweep({ run, intervalMs: SIX_HOURS });

    vi.advanceTimersByTime(SIX_HOURS - 1);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(SIX_HOURS);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('a worker restarted hourly still runs the sweep on every start', () => {
    const run = vi.fn();
    for (let boot = 0; boot < 4; boot += 1) {
      const schedule = scheduleSweep({ run, intervalMs: SIX_HOURS });
      vi.advanceTimersByTime(3_600_000);
      schedule.stop();
    }
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('stop() cancels both the first pass and the interval', () => {
    const run = vi.fn();
    const schedule = scheduleSweep({ run, intervalMs: SIX_HOURS });
    schedule.stop();
    vi.advanceTimersByTime(SIX_HOURS * 2);
    expect(run).not.toHaveBeenCalled();
  });

  it('honours an explicit first-pass delay', () => {
    const run = vi.fn();
    scheduleSweep({ run, intervalMs: SIX_HOURS, firstPassMs: 5_000 });
    vi.advanceTimersByTime(5_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
