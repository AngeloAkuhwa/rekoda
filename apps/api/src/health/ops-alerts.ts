/**
 * The alert pass (G-26): look at the platform's numbers, decide what deserves a
 * page (`@rekoda/core` owns the judgement), and tell somebody once.
 *
 * Runs on the worker, on a short clock, because it needs the worker credential
 * to see across tenants. A process without one cannot judge the platform and
 * does not pretend to.
 */
import type { Logger } from '@nestjs/common';
import {
  DEFAULT_OPS_ALERT_THRESHOLDS,
  evaluateOpsAlerts,
  planAlertDelivery,
  type AlertState,
  type OpsAlert,
  type OpsSnapshot,
} from '@rekoda/core';
import { events, jobsRepo, type Db } from '@rekoda/db';

export const ALERT_COOLDOWN_MS = 30 * 60_000;

/** What leaves the process. Fixed fields and numbers: nothing tenant-shaped. */
export interface AlertNotice {
  service: 'rekoda';
  kind: 'alert' | 'resolved';
  key: string;
  severity: 'critical' | 'warning' | 'info';
  summary: string;
  release: string;
  commit: string;
  at: string;
}

export interface AlertSink {
  deliver(notice: AlertNotice): Promise<void>;
}

/** POSTs the notice as JSON. https only (checked at boot), short timeout, no redirects. */
export class WebhookAlertSink implements AlertSink {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5_000,
  ) {}

  async deliver(notice: AlertNotice): Promise<void> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...notice, text: `[${notice.severity}] ${notice.summary}` }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`alert destination answered ${response.status}`);
  }
}

/** Read the platform's numbers. Null parts mean this process cannot see them. */
export async function collectOpsSnapshot(workerDb: Db | null): Promise<OpsSnapshot> {
  if (!workerDb) return { queue: null, meta: null, paystack: null };
  const [queue, meta, paystack] = await Promise.all([
    jobsRepo.queueHealth(workerDb),
    events.eventHealth(workerDb, 'meta'),
    events.eventHealth(workerDb, 'paystack'),
  ]);
  return {
    queue: {
      dead: queue.dead,
      pending: queue.pending,
      running: queue.running,
      oldestDueSeconds: queue.oldestPendingSeconds,
      oldestQueuedSeconds: queue.oldestQueuedSeconds,
    },
    meta,
    paystack,
  };
}

export interface AlertPassDeps {
  collect: () => Promise<OpsSnapshot>;
  sink: AlertSink | null;
  log: Pick<Logger, 'error' | 'warn'>;
  build: { release: string; commit: string };
  now: () => Date;
  cooldownMs?: number;
}

/**
 * One pass. `state` is the caller's memory of what it already announced, so a
 * condition that stays true is sent once per cooldown rather than every pass.
 * A delivery that fails is NOT recorded as sent: it is retried on the next pass.
 */
export async function runOpsAlertPass(
  deps: AlertPassDeps,
  state: AlertState,
): Promise<{ active: OpsAlert[]; next: AlertState }> {
  const snapshot = await deps.collect();
  const active = evaluateOpsAlerts(snapshot, DEFAULT_OPS_ALERT_THRESHOLDS);
  const nowMs = deps.now().getTime();
  const plan = planAlertDelivery(active, state, nowMs, deps.cooldownMs ?? ALERT_COOLDOWN_MS);
  const next: AlertState = { ...plan.next };
  const at = deps.now().toISOString();

  for (const alert of plan.send) {
    /* The log line is the floor: with no destination configured it is the only
     * record, and it carries the same fixed words as the notice. */
    deps.log.error(`ALERT ${alert.severity} ${alert.key}: ${alert.summary}`);
    if (!deps.sink) continue;
    try {
      await deps.sink.deliver({
        service: 'rekoda',
        kind: 'alert',
        key: alert.key,
        severity: alert.severity,
        summary: alert.summary,
        ...deps.build,
        at,
      });
    } catch (error) {
      delete next[alert.key];
      deps.log.warn(`alert ${alert.key} not delivered: ${(error as Error).message}`);
    }
  }
  for (const key of plan.resolved) {
    deps.log.warn(`ALERT cleared ${key}`);
    if (!deps.sink) continue;
    try {
      await deps.sink.deliver({
        service: 'rekoda',
        kind: 'resolved',
        key,
        severity: 'info',
        summary: `${key} has cleared`,
        ...deps.build,
        at,
      });
    } catch (error) {
      deps.log.warn(`recovery notice ${key} not delivered: ${(error as Error).message}`);
    }
  }
  return { active, next };
}
