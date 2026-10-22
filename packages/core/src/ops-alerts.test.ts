import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPS_ALERT_THRESHOLDS,
  evaluateOpsAlerts,
  planAlertDelivery,
  type OpsSnapshot,
} from './ops-alerts.js';

const healthy: OpsSnapshot = {
  queue: {
    dead: 0,
    deadRecent: 0,
    pending: 3,
    running: 1,
    oldestDueSeconds: 2,
    oldestQueuedSeconds: 5,
  },
  meta: { unprocessed: 0, unprocessedStale: 0, flagged: 0, deliveryFailures: 0 },
  paystack: { unprocessed: 0, unprocessedStale: 0, flagged: 0, deliveryFailures: 0 },
};

const keys = (snapshot: OpsSnapshot): string[] =>
  evaluateOpsAlerts(snapshot, DEFAULT_OPS_ALERT_THRESHOLDS).map((a) => a.key);

describe('evaluateOpsAlerts (G-26)', () => {
  it('raises nothing for a healthy platform', () => {
    expect(keys(healthy)).toEqual([]);
  });

  it('raises nothing, rather than guessing, when the worker credential is absent', () => {
    expect(keys({ queue: null, meta: null, paystack: null })).toEqual([]);
  });

  it('pages on a job that died recently: nothing retries it again', () => {
    const alerts = evaluateOpsAlerts(
      { ...healthy, queue: { ...healthy.queue!, dead: 1, deadRecent: 1 } },
      DEFAULT_OPS_ALERT_THRESHOLDS,
    );
    expect(alerts).toEqual([expect.objectContaining({ key: 'jobs.dead', severity: 'critical' })]);
  });

  it('does not page forever on old dead jobs: nothing ever clears the dead state', () => {
    // Dead rows are kept for diagnosis and never leave `dead`. Alerting on the
    // total would page every cooldown for ever after the first death.
    expect(keys({ ...healthy, queue: { ...healthy.queue!, dead: 7, deadRecent: 0 } })).toEqual([]);
  });

  it('ignores a burst of webhooks still being processed; pages only on stale ones', () => {
    const limit = DEFAULT_OPS_ALERT_THRESHOLDS.unprocessedEvents;
    const fresh = {
      ...healthy,
      paystack: { ...healthy.paystack!, unprocessed: limit + 40, unprocessedStale: 0 },
      meta: { ...healthy.meta!, unprocessed: limit + 40, unprocessedStale: 0 },
    };
    expect(keys(fresh)).toEqual([]);
    expect(
      keys({
        ...healthy,
        paystack: { ...healthy.paystack!, unprocessed: limit + 1, unprocessedStale: limit + 1 },
      }),
    ).toEqual(['webhooks.paystack.unprocessed']);
  });

  it('pages when due work is not being claimed (worker down or starved)', () => {
    const limit = DEFAULT_OPS_ALERT_THRESHOLDS.overdueSeconds;
    expect(keys({ ...healthy, queue: { ...healthy.queue!, oldestDueSeconds: limit } })).toEqual([]);
    expect(keys({ ...healthy, queue: { ...healthy.queue!, oldestDueSeconds: limit + 1 } })).toEqual(
      ['jobs.overdue'],
    );
  });

  it('warns on a retry backlog that never drains even though nothing is due yet (G-63)', () => {
    // Rows rescheduled into the future are not "due", so the overdue check is
    // quiet; the age since they were queued is what shows the backlog.
    const stuck = {
      ...healthy,
      queue: { ...healthy.queue!, oldestDueSeconds: 0, oldestQueuedSeconds: 7_200 },
    };
    expect(evaluateOpsAlerts(stuck, DEFAULT_OPS_ALERT_THRESHOLDS)).toEqual([
      expect.objectContaining({ key: 'jobs.backlog', severity: 'warning' }),
    ]);
  });

  it('treats a flagged Paystack event as critical: money is involved', () => {
    const alerts = evaluateOpsAlerts(
      { ...healthy, paystack: { ...healthy.paystack!, flagged: 2 } },
      DEFAULT_OPS_ALERT_THRESHOLDS,
    );
    expect(alerts).toEqual([
      expect.objectContaining({ key: 'webhooks.paystack.flagged', severity: 'critical' }),
    ]);
  });

  it('warns on a flagged Meta event and on a pile of unprocessed events', () => {
    const limit = DEFAULT_OPS_ALERT_THRESHOLDS.unprocessedEvents;
    expect(
      keys({
        ...healthy,
        meta: { ...healthy.meta!, flagged: 1, unprocessed: limit + 1, unprocessedStale: limit + 1 },
      }),
    ).toEqual(['webhooks.meta.flagged', 'webhooks.meta.unprocessed']);
  });

  it('warns when WhatsApp delivery failures in the window reach the threshold', () => {
    const limit = DEFAULT_OPS_ALERT_THRESHOLDS.deliveryFailures;
    expect(keys({ ...healthy, meta: { ...healthy.meta!, deliveryFailures: limit - 1 } })).toEqual(
      [],
    );
    expect(keys({ ...healthy, meta: { ...healthy.meta!, deliveryFailures: limit } })).toEqual([
      'whatsapp.delivery_failures',
    ]);
  });

  it('carries only numbers and fixed words: no tenant, customer or payload data', () => {
    const alerts = evaluateOpsAlerts(
      {
        queue: {
          dead: 4,
          pending: 9,
          running: 1,
          oldestDueSeconds: 999,
          oldestQueuedSeconds: 9_999,
        },
        meta: { unprocessed: 99, unprocessedStale: 99, flagged: 3, deliveryFailures: 50 },
        paystack: { unprocessed: 99, unprocessedStale: 99, flagged: 3, deliveryFailures: 0 },
      },
      DEFAULT_OPS_ALERT_THRESHOLDS,
    );
    expect(alerts.length).toBeGreaterThan(4);
    for (const alert of alerts) expect(alert.summary).toMatch(/^[A-Za-z0-9 ,.:()/-]+$/);
  });
});

describe('planAlertDelivery (G-26)', () => {
  const dead = { key: 'jobs.dead', severity: 'critical' as const, summary: '1 job is dead' };
  const COOLDOWN = 30 * 60_000;

  it('sends a new alert once, then stays quiet inside the cooldown', () => {
    const first = planAlertDelivery([dead], {}, 1_000, COOLDOWN);
    expect(first.send).toEqual([dead]);
    const again = planAlertDelivery([dead], first.next, 1_000 + COOLDOWN - 1, COOLDOWN);
    expect(again.send).toEqual([]);
  });

  it('repeats a still-active alert after the cooldown so it cannot be forgotten', () => {
    const first = planAlertDelivery([dead], {}, 1_000, COOLDOWN);
    const later = planAlertDelivery([dead], first.next, 1_000 + COOLDOWN, COOLDOWN);
    expect(later.send).toEqual([dead]);
  });

  it('reports a cleared alert as resolved once, and re-sends it if it comes back', () => {
    const first = planAlertDelivery([dead], {}, 1_000, COOLDOWN);
    const cleared = planAlertDelivery([], first.next, 2_000, COOLDOWN);
    expect(cleared.resolved).toEqual(['jobs.dead']);
    expect(cleared.next).toEqual({});
    const quiet = planAlertDelivery([], cleared.next, 3_000, COOLDOWN);
    expect(quiet.resolved).toEqual([]);
    const back = planAlertDelivery([dead], cleared.next, 4_000, COOLDOWN);
    expect(back.send).toEqual([dead]);
  });
});
