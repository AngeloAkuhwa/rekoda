/**
 * When a slow sweep runs (G-10).
 *
 * A bare `setInterval(fn, 6h)` first fires six hours after the process
 * starts. A worker that is redeployed or restarted more often than that never
 * runs the sweep at all, and retention, renewals and grace are exactly the
 * sweeps whose unit is hours or days. So every slow sweep also gets one pass
 * shortly after boot, then settles onto its interval.
 *
 * The first pass is delayed, not immediate: a deploy restarts every replica
 * together, and the database and pools should be settled before several
 * sweeps start at once. Running a sweep earlier or more often than its
 * interval is safe: each one claims its own due work under the per-sweep
 * advisory lock and the `sweeping*` guards, and finds nothing when nothing is
 * due.
 */
export const SWEEP_FIRST_PASS_MS = 30_000;

export interface SweepSchedule {
  stop(): void;
}

export function scheduleSweep(options: {
  run: () => void;
  intervalMs: number;
  firstPassMs?: number;
}): SweepSchedule {
  const first = setTimeout(options.run, options.firstPassMs ?? SWEEP_FIRST_PASS_MS);
  const every = setInterval(options.run, options.intervalMs);
  /* Neither timer may hold a shutting-down process open. */
  first.unref();
  every.unref();
  return {
    stop(): void {
      clearTimeout(first);
      clearInterval(every);
    },
  };
}
