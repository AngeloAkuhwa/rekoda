/**
 * What deserves a page (G-26).
 *
 * `/v1/ops/health` has reported queue depth, dead jobs and webhook backlogs
 * since the first release and nobody was ever told when a number crossed a
 * line: an operator had to be looking. This is the judgement that turns those
 * numbers into alerts, kept pure (no clock, no IO) so every threshold is a
 * tested fact rather than a constant buried in a sweep.
 *
 * Alerts carry fixed words and numbers only. Never a tenant, a customer, a
 * phone number, a message or a payload: the destination is a chat channel or
 * a mail relay, and nothing sent there is under the privacy gateway.
 */

export interface OpsSnapshot {
  /** Null when the process holds no worker credential: nothing can be judged. */
  queue: {
    /** All dead jobs. Kept for diagnosis; nothing ever moves a job out of `dead`. */
    dead: number;
    /** Jobs that died in the health window (24 hours): what an alert can act on. */
    deadRecent: number;
    pending: number;
    running: number;
    /** Seconds the oldest job that is DUE now has waited unclaimed. */
    oldestDueSeconds: number;
    /** Seconds since the oldest still-pending job was QUEUED, due or not (G-63). */
    oldestQueuedSeconds: number;
  } | null;
  meta: EventCounts | null;
  paystack: EventCounts | null;
}

export interface EventCounts {
  unprocessed: number;
  /** Unprocessed and older than the processing grace period: actually stuck. */
  unprocessedStale: number;
  flagged: number;
  deliveryFailures: number;
}

export interface OpsAlertThresholds {
  /** A due job unclaimed for longer than this: the worker is down or starved. */
  overdueSeconds: number;
  /** A job queued for longer than this and still pending: a retry backlog. */
  backlogSeconds: number;
  /** Provider events unprocessed for more than 10 minutes, above this count. */
  unprocessedEvents: number;
  /** WhatsApp `status.failed` receipts in the health window at or above this. */
  deliveryFailures: number;
}

export const DEFAULT_OPS_ALERT_THRESHOLDS: OpsAlertThresholds = {
  overdueSeconds: 300,
  backlogSeconds: 3_600,
  unprocessedEvents: 50,
  deliveryFailures: 10,
};

export type OpsAlertSeverity = 'critical' | 'warning';

export interface OpsAlert {
  /** Stable identity: what deduplication and resolution key on. */
  key: string;
  severity: OpsAlertSeverity;
  summary: string;
}

export function evaluateOpsAlerts(
  snapshot: OpsSnapshot,
  limits: OpsAlertThresholds = DEFAULT_OPS_ALERT_THRESHOLDS,
): OpsAlert[] {
  const alerts: OpsAlert[] = [];
  const { queue, meta, paystack } = snapshot;

  if (queue) {
    /* On recent deaths only. Dead rows stay dead for diagnosis, so alerting on
     * the total would page every cooldown for ever after the first one. */
    if (queue.deadRecent > 0) {
      alerts.push({
        key: 'jobs.dead',
        severity: 'critical',
        summary: `${queue.deadRecent} background job(s) exhausted their retries in the last 24 hours and will not run again (${queue.dead} dead in total)`,
      });
    }
    if (queue.oldestDueSeconds > limits.overdueSeconds) {
      alerts.push({
        key: 'jobs.overdue',
        severity: 'critical',
        summary: `Due work has waited ${queue.oldestDueSeconds} s unclaimed (limit ${limits.overdueSeconds} s): the worker is down or not keeping up`,
      });
    }
    if (queue.oldestQueuedSeconds > limits.backlogSeconds) {
      alerts.push({
        key: 'jobs.backlog',
        severity: 'warning',
        summary: `A job has been pending for ${queue.oldestQueuedSeconds} s (limit ${limits.backlogSeconds} s): a retry backlog is not draining`,
      });
    }
  }

  /* Money first: a Paystack event that was stored and flagged is a payment the
   * books may not reflect. */
  if (paystack) {
    if (paystack.flagged > 0) {
      alerts.push({
        key: 'webhooks.paystack.flagged',
        severity: 'critical',
        summary: `${paystack.flagged} Paystack event(s) were flagged and need an operator`,
      });
    }
    if (paystack.unprocessedStale > limits.unprocessedEvents) {
      alerts.push({
        key: 'webhooks.paystack.unprocessed',
        severity: 'critical',
        summary: `${paystack.unprocessedStale} Paystack event(s) have waited more than 10 minutes unprocessed (limit ${limits.unprocessedEvents})`,
      });
    }
  }

  if (meta) {
    if (meta.flagged > 0) {
      alerts.push({
        key: 'webhooks.meta.flagged',
        severity: 'warning',
        summary: `${meta.flagged} Meta event(s) were flagged and need an operator`,
      });
    }
    if (meta.unprocessedStale > limits.unprocessedEvents) {
      alerts.push({
        key: 'webhooks.meta.unprocessed',
        severity: 'warning',
        summary: `${meta.unprocessedStale} Meta event(s) have waited more than 10 minutes unprocessed (limit ${limits.unprocessedEvents})`,
      });
    }
    if (meta.deliveryFailures >= limits.deliveryFailures) {
      alerts.push({
        key: 'whatsapp.delivery_failures',
        severity: 'warning',
        summary: `${meta.deliveryFailures} WhatsApp delivery failure(s) in the last 24 hours (limit ${limits.deliveryFailures})`,
      });
    }
  }

  return alerts;
}

/** When each active alert key was last sent, in epoch milliseconds. */
export type AlertState = Record<string, number>;

export interface AlertDeliveryPlan {
  /** Alerts to send now: new, or still active and past the cooldown. */
  send: OpsAlert[];
  /** Keys that were active and no longer are: send one recovery notice. */
  resolved: string[];
  next: AlertState;
}

/**
 * Deduplication. A condition that stays true is announced once, repeated after
 * `cooldownMs` so it cannot be forgotten, and reported cleared once.
 */
export function planAlertDelivery(
  active: readonly OpsAlert[],
  state: AlertState,
  nowMs: number,
  cooldownMs: number,
): AlertDeliveryPlan {
  const next: AlertState = {};
  const send: OpsAlert[] = [];
  for (const alert of active) {
    const last = state[alert.key];
    if (last === undefined || nowMs - last >= cooldownMs) {
      send.push(alert);
      next[alert.key] = nowMs;
    } else {
      next[alert.key] = last;
    }
  }
  const stillActive = new Set(active.map((a) => a.key));
  const resolved = Object.keys(state).filter((key) => !stillActive.has(key));
  return { send, resolved, next };
}
