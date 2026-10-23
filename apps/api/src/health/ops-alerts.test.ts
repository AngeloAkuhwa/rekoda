import { describe, expect, it } from 'vitest';
import type { OpsSnapshot } from '@rekoda/core';
import {
  WebhookAlertSink,
  runOpsAlertPass,
  type AlertNotice,
  type AlertSink,
} from './ops-alerts.js';

const quiet: OpsSnapshot = {
  queue: {
    dead: 0,
    deadRecent: 0,
    pending: 0,
    running: 0,
    oldestDueSeconds: 0,
    oldestQueuedSeconds: 0,
  },
  meta: { unprocessed: 0, unprocessedStale: 0, flagged: 0, deliveryFailures: 0 },
  paystack: { unprocessed: 0, unprocessedStale: 0, flagged: 0, deliveryFailures: 0 },
};
const dead: OpsSnapshot = { ...quiet, queue: { ...quiet.queue!, dead: 2, deadRecent: 2 } };

function harness(snapshot: () => OpsSnapshot, sink: AlertSink | null) {
  const lines: string[] = [];
  let clock = 1_000_000;
  const deps = {
    collect: async () => snapshot(),
    sink,
    log: {
      error: (m: string) => lines.push(`error ${m}`),
      warn: (m: string) => lines.push(`warn ${m}`),
    },
    build: { release: 'r1', commit: 'abc1234' },
    now: () => new Date(clock),
    cooldownMs: 60_000,
  };
  return { deps, lines, tick: (ms: number) => (clock += ms) };
}

describe('runOpsAlertPass (G-26)', () => {
  it('delivers a new alert once, with build identity and no tenant data', async () => {
    const sent: AlertNotice[] = [];
    const h = harness(() => dead, { deliver: async (n) => void sent.push(n) });
    let state = {};
    state = (await runOpsAlertPass(h.deps, state)).next;
    state = (await runOpsAlertPass(h.deps, state)).next;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'alert',
      key: 'jobs.dead',
      severity: 'critical',
      release: 'r1',
      commit: 'abc1234',
    });
    expect(Object.keys(sent[0]!).sort()).toEqual(
      ['at', 'commit', 'key', 'kind', 'release', 'service', 'severity', 'summary'].sort(),
    );
  });

  it('still logs the alert at error level when no destination is configured', async () => {
    const h = harness(() => dead, null);
    const { active } = await runOpsAlertPass(h.deps, {});
    expect(active.map((a) => a.key)).toEqual(['jobs.dead']);
    expect(h.lines.some((l) => l.startsWith('error ALERT critical jobs.dead'))).toBe(true);
  });

  it('retries on the next pass when the destination was down, instead of dropping the page', async () => {
    let up = false;
    const sent: AlertNotice[] = [];
    const h = harness(() => dead, {
      deliver: async (n) => {
        if (!up) throw new Error('alert destination answered 503');
        sent.push(n);
      },
    });
    const first = await runOpsAlertPass(h.deps, {});
    expect(sent).toHaveLength(0);
    expect(first.next).toEqual({});
    up = true;
    h.tick(1_000);
    await runOpsAlertPass(h.deps, first.next);
    expect(sent).toHaveLength(1);
  });

  it('sends one recovery notice when the condition clears', async () => {
    let snapshot = dead;
    const sent: AlertNotice[] = [];
    const h = harness(() => snapshot, { deliver: async (n) => void sent.push(n) });
    const first = await runOpsAlertPass(h.deps, {});
    snapshot = quiet;
    h.tick(1_000);
    const second = await runOpsAlertPass(h.deps, first.next);
    await runOpsAlertPass(h.deps, second.next);
    expect(sent.map((n) => n.kind)).toEqual(['alert', 'resolved']);
  });

  it('still sends the recovery notice when a re-send failed and the condition then cleared', async () => {
    // The alert was shown at T0. The re-send after the cooldown fails. The
    // condition clears before the next pass. The destination still shows an
    // open alert, so it must be told it cleared.
    let snapshot = dead;
    let up = true;
    const sent: AlertNotice[] = [];
    const h = harness(() => snapshot, {
      deliver: async (n) => {
        if (!up) throw new Error('alert destination answered 503');
        sent.push(n);
      },
    });
    const first = await runOpsAlertPass(h.deps, {});
    up = false;
    h.tick(61_000);
    const failedResend = await runOpsAlertPass(h.deps, first.next);
    expect(failedResend.next).toEqual(first.next);
    up = true;
    snapshot = quiet;
    h.tick(1_000);
    await runOpsAlertPass(h.deps, failedResend.next);
    expect(sent.map((n) => n.kind)).toEqual(['alert', 'resolved']);
  });

  it('retries a recovery notice that failed to deliver, until it lands', async () => {
    let snapshot = dead;
    let up = true;
    const sent: AlertNotice[] = [];
    const h = harness(() => snapshot, {
      deliver: async (n) => {
        if (!up) throw new Error('alert destination answered 503');
        sent.push(n);
      },
    });
    const first = await runOpsAlertPass(h.deps, {});
    snapshot = quiet;
    up = false;
    h.tick(1_000);
    const failedRecovery = await runOpsAlertPass(h.deps, first.next);
    expect(Object.keys(failedRecovery.next)).toEqual(['jobs.dead']);
    up = true;
    h.tick(1_000);
    const retried = await runOpsAlertPass(h.deps, failedRecovery.next);
    expect(sent.map((n) => n.kind)).toEqual(['alert', 'resolved']);
    expect(retried.next).toEqual({});
  });

  it('judges nothing, and says nothing, without the worker credential', async () => {
    const h = harness(() => ({ queue: null, meta: null, paystack: null }), {
      deliver: async () => {
        throw new Error('must not be called');
      },
    });
    expect((await runOpsAlertPass(h.deps, {})).active).toEqual([]);
  });
});

describe('WebhookAlertSink', () => {
  const notice: AlertNotice = {
    service: 'rekoda',
    kind: 'alert',
    key: 'jobs.dead',
    severity: 'critical',
    summary: '2 background job(s) exhausted their retries and will not run again',
    release: 'r1',
    commit: 'abc1234',
    at: '2026-10-22T00:00:00.000Z',
  };

  it('posts JSON, refuses redirects and applies a timeout', async () => {
    let seen: RequestInit | undefined;
    const sink = new WebhookAlertSink('https://hooks.example.com/x', (async (
      _url: unknown,
      init?: RequestInit,
    ) => {
      seen = init;
      return new Response('ok', { status: 200 });
    }) as typeof fetch);
    await sink.deliver(notice);
    expect(seen?.method).toBe('POST');
    expect(seen?.redirect).toBe('error');
    expect(seen?.signal).toBeDefined();
    expect(JSON.parse(String(seen?.body))).toMatchObject({
      key: 'jobs.dead',
      text: expect.stringContaining('[critical]'),
    });
  });

  it('gives up on a destination that never answers, so one hung webhook cannot stall the pass', async () => {
    const hanging = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;
    const sink = new WebhookAlertSink('https://hooks.example.com/x', hanging, 20);
    await expect(sink.deliver(notice)).rejects.toThrow();
  });

  it('throws on a non-2xx answer so the pass retries', async () => {
    const sink = new WebhookAlertSink(
      'https://hooks.example.com/x',
      (async () => new Response('no', { status: 500 })) as typeof fetch,
    );
    await expect(sink.deliver(notice)).rejects.toThrow(/500/);
  });
});
