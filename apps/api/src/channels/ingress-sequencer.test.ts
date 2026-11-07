/**
 * The per-business ingress lane (OWN-74, PR #428): messages of one business are stored one at a
 * time in the order they reach the lane, other businesses never wait, every wait is bounded, and
 * no later message is stored ahead of an earlier one that failed.
 */
import { describe, expect, it } from 'vitest';
import { IngressFenced, IngressRefused, IngressSequencer } from './ingress-sequencer.js';

function gate() {
  let open!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function lane(over: Partial<{ waitMs: number; maxWaiting: number; fenceMs: number }> = {}) {
  let now = 1_000;
  const sequencer = new IngressSequencer({
    waitMs: 1_000,
    maxWaiting: 8,
    fenceMs: 60_000,
    now: () => now,
    ...over,
  });
  return { sequencer, advance: (ms: number) => (now += ms) };
}

describe('IngressSequencer', () => {
  it('stores one business’s messages one at a time, in the order they arrived', async () => {
    const { sequencer } = lane();
    const order: string[] = [];
    let running = 0;
    let most = 0;
    const first = gate();
    const store = (id: string, wait?: Promise<void>) =>
      sequencer.run('b1', id, async () => {
        running += 1;
        most = Math.max(most, running);
        await wait;
        order.push(id);
        running -= 1;
        return id;
      });
    const a = store('a', first.promise);
    const b = store('b');
    const c = store('c');
    await tick();
    expect(sequencer.depth('b1')).toBe(3);
    expect(order).toEqual([]);
    first.open();
    expect(await Promise.all([a, b, c])).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(most).toBe(1);
    expect(sequencer.depth('b1')).toBe(0);
  });

  it('never makes another business wait', async () => {
    const { sequencer } = lane();
    const held = gate();
    const slow = sequencer.run('b1', 'a', () => held.promise);
    expect(await sequencer.run('b2', 'x', async () => 'other')).toBe('other');
    held.open();
    await slow;
  });

  it('a failure refuses every later message of the business until the failed one is stored', async () => {
    const { sequencer } = lane();
    const first = gate();
    const a = sequencer.run('b1', 'cancel', () => first.promise);
    let laterRan = false;
    const b = sequencer.run('b1', 'yes', async () => {
      laterRan = true;
    });
    await tick();
    first.fail(new Error('lock timeout'));
    await expect(a).rejects.toThrow('lock timeout');
    /* The one waiting behind it, and one arriving in a later webhook, are both refused. */
    await expect(b).rejects.toBeInstanceOf(IngressFenced);
    await expect(sequencer.run('b1', 'later-yes', async () => 'stored')).rejects.toBeInstanceOf(
      IngressFenced,
    );
    expect(laterRan).toBe(false);
    expect(sequencer.fenced('b1')).toBe(true);
    /* Another business is not fenced. */
    expect(await sequencer.run('b2', 'x', async () => 'ok')).toBe('ok');

    /* The redelivered cancel goes first and lifts the fence; the rest follow. */
    expect(await sequencer.run('b1', 'cancel', async () => 'cancel stored')).toBe('cancel stored');
    expect(sequencer.fenced('b1')).toBe(false);
    expect(await sequencer.run('b1', 'yes', async () => 'yes stored')).toBe('yes stored');
  });

  it('a redelivered fenced message that fails again keeps the fence', async () => {
    const { sequencer } = lane();
    await expect(
      sequencer.run('b1', 'cancel', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    await expect(
      sequencer.run('b1', 'cancel', () => Promise.reject(new Error('boom again'))),
    ).rejects.toThrow('boom again');
    await expect(sequencer.run('b1', 'yes', async () => 1)).rejects.toBeInstanceOf(IngressFenced);
  });

  it('bounds the wait: a message that cannot get its turn in time is refused and fences the later ones', async () => {
    const { sequencer } = lane({ waitMs: 30 });
    const held = gate();
    const a = sequencer.run('b1', 'a', () => held.promise);
    const b = sequencer.run('b1', 'b', async () => 'b');
    await expect(b).rejects.toMatchObject({ reason: 'timeout' });
    /* A later message may not pass the one that gave up, even though the head is still fine. */
    const c = sequencer.run('b1', 'c', async () => 'c');
    await expect(c).rejects.toBeInstanceOf(IngressFenced);
    held.open();
    await a;
    expect(sequencer.fenced('b1')).toBe(true);
    expect(await sequencer.run('b1', 'b', async () => 'b stored')).toBe('b stored');
    expect(await sequencer.run('b1', 'c', async () => 'c stored')).toBe('c stored');
  });

  it('the next message never starts while the one ahead still runs, even when the one between gave up', async () => {
    const { sequencer, advance } = lane({ waitMs: 30, fenceMs: 1 });
    const held = gate();
    let running = 0;
    let overlapped = false;
    const work = (wait?: Promise<void>) => async () => {
      running += 1;
      if (running > 1) overlapped = true;
      await wait;
      running -= 1;
    };
    const a = sequencer.run('b1', 'a', work(held.promise));
    const b = sequencer.run('b1', 'b', work());
    await expect(b).rejects.toMatchObject({ reason: 'timeout' });
    advance(1);
    /* The fence has lapsed (1 ms), so c is admitted; it must still wait for a. */
    const c = sequencer.run('b1', 'c', work());
    await tick();
    expect(overlapped).toBe(false);
    held.open();
    await a;
    await c;
    expect(overlapped).toBe(false);
  });

  it('an earlier message that fails after a later one gave up takes the fence over', async () => {
    const { sequencer } = lane({ waitMs: 30 });
    const held = gate();
    const a = sequencer.run('b1', 'a', () => held.promise);
    const b = sequencer.run('b1', 'b', async () => 'b');
    await expect(b).rejects.toMatchObject({ reason: 'timeout' });
    held.fail(new Error('a failed'));
    await expect(a).rejects.toThrow('a failed');
    /* b gave up first, but a is earlier: b may not be stored before a is. */
    await expect(sequencer.run('b1', 'b', async () => 'b')).rejects.toBeInstanceOf(IngressFenced);
    expect(await sequencer.run('b1', 'a', async () => 'a stored')).toBe('a stored');
    expect(await sequencer.run('b1', 'b', async () => 'b stored')).toBe('b stored');
  });

  it('bounds how many may wait per business', async () => {
    const { sequencer } = lane({ maxWaiting: 2 });
    const held = gate();
    const a = sequencer.run('b1', 'a', () => held.promise);
    const b = sequencer.run('b1', 'b', async () => 'b');
    await expect(sequencer.run('b1', 'c', async () => 'c')).rejects.toMatchObject({
      reason: 'busy',
    });
    held.open();
    await a;
    await b;
    /* c was refused, so it fences what follows it until it is stored. */
    await expect(sequencer.run('b1', 'd', async () => 'd')).rejects.toBeInstanceOf(IngressFenced);
    expect(await sequencer.run('b1', 'c', async () => 'c')).toBe('c');
  });

  it('a fence lapses after its window, and later messages are admitted again', async () => {
    const { sequencer, advance } = lane({ fenceMs: 120_000 });
    await expect(sequencer.run('b1', 'lost', () => Promise.reject(new Error('x')))).rejects.toThrow(
      'x',
    );
    await expect(sequencer.run('b1', 'next', async () => 1)).rejects.toBeInstanceOf(IngressRefused);
    advance(120_000);
    expect(await sequencer.run('b1', 'next', async () => 2)).toBe(2);
    expect(sequencer.fenced('b1')).toBe(false);
  });

  it('refuses bounds that are not positive whole numbers', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new IngressSequencer({ waitMs: bad, maxWaiting: 1, fenceMs: 1 })).toThrow();
      expect(() => new IngressSequencer({ waitMs: 1, maxWaiting: bad, fenceMs: 1 })).toThrow();
      expect(() => new IngressSequencer({ waitMs: 1, maxWaiting: 1, fenceMs: bad })).toThrow();
    }
  });
});
