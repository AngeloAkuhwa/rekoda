/**
 * The per-business ingress lane (OWN-74, PR #428): messages of one business are stored one at a
 * time in the order they reach the lane, other businesses never wait, every wait is bounded, and
 * no later message is stored ahead of an earlier one that failed.
 */
import { describe, expect, it } from 'vitest';
import {
  INGRESS_FENCE_MS,
  INGRESS_MAX_WAITING,
  INGRESS_WAIT_MS,
  IngressFenced,
  IngressRefused,
  IngressSequencer,
  IngressStoreFailed,
} from './ingress-sequencer.js';

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

function lane(
  over: Partial<{
    waitMs: number;
    maxWaiting: number;
    fenceMs: number;
    maxOutstanding: number;
  }> = {},
) {
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
    expect(sequencer.outstanding('b1')).toBeGreaterThan(0);
    /* Another business is not fenced. */
    expect(await sequencer.run('b2', 'x', async () => 'ok')).toBe('ok');

    /* The redelivered cancel goes first; the two refused after it stay ahead of anything new
     * until each is stored, in the order they first came. */
    expect(await sequencer.run('b1', 'cancel', async () => 'cancel stored')).toBe('cancel stored');
    expect(sequencer.outstanding('b1')).toBe(2);
    await expect(sequencer.run('b1', 'later-yes', async () => 1)).rejects.toBeInstanceOf(
      IngressFenced,
    );
    expect(await sequencer.run('b1', 'yes', async () => 'yes stored')).toBe('yes stored');
    expect(await sequencer.run('b1', 'later-yes', async () => 'stored')).toBe('stored');
    expect(sequencer.outstanding('b1')).toBe(0);
  });

  it('a store failure is reported with its business, so the caller can scope its response', async () => {
    const { sequencer } = lane();
    const failure = await sequencer
      .run('b1', 'cancel', () => Promise.reject(new Error('lock timeout')))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IngressStoreFailed);
    expect((failure as IngressStoreFailed).businessId).toBe('b1');
    const refused = await sequencer.run('b1', 'yes', async () => 1).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(IngressFenced);
    expect((refused as IngressFenced).businessId).toBe('b1');
  });

  it('messages refused behind a failure are stored in the order they first came, whatever order Meta redelivers them in', async () => {
    const { sequencer } = lane();
    const stored: string[] = [];
    const store = (id: string) =>
      sequencer.run('b1', id, async () => {
        stored.push(id);
      });
    await expect(
      sequencer.run('b1', 'sold', () => Promise.reject(new Error('lock timeout'))),
    ).rejects.toThrow('lock timeout');
    /* A cancel, then a yes, each in its own webhook: both refused. */
    await expect(store('cancel')).rejects.toBeInstanceOf(IngressFenced);
    await expect(store('yes')).rejects.toBeInstanceOf(IngressFenced);
    expect(sequencer.outstanding('b1')).toBe(3);

    await store('sold');
    /* Meta's retries come back reversed: the yes is still refused until the cancel is stored. */
    await expect(store('yes')).rejects.toBeInstanceOf(IngressFenced);
    await store('cancel');
    await store('yes');
    expect(stored).toEqual(['sold', 'cancel', 'yes']);
    expect(sequencer.outstanding('b1')).toBe(0);
    /* And a new message after them all is admitted. */
    await store('next');
  });

  it('a message failing again on redelivery does not extend the fence', async () => {
    const { sequencer, advance } = lane({ fenceMs: 120_000 });
    const poison = () => sequencer.run('b1', 'poison', () => Promise.reject(new Error('bad')));
    await expect(poison()).rejects.toThrow('bad');
    advance(100_000);
    await expect(poison()).rejects.toThrow('bad');
    await expect(sequencer.run('b1', 'yes', async () => 1)).rejects.toBeInstanceOf(IngressFenced);
    /* 120 s after the FIRST failure the fence ends, though the poison failed again at 100 s. */
    advance(20_000);
    expect(await sequencer.run('b1', 'yes', async () => 2)).toBe(2);
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
    expect(sequencer.outstanding('b1')).toBeGreaterThan(0);
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
    /* b is still outstanding once a is stored: nothing new passes it. */
    await expect(sequencer.run('b1', 'c', async () => 'c')).rejects.toBeInstanceOf(IngressFenced);
    expect(await sequencer.run('b1', 'b', async () => 'b stored')).toBe('b stored');
    expect(await sequencer.run('b1', 'c', async () => 'c stored')).toBe('c stored');
  });

  it('remembers at most maxOutstanding refused messages per business', async () => {
    const { sequencer } = lane({ maxOutstanding: 2 });
    await expect(sequencer.run('b1', 'a', () => Promise.reject(new Error('x')))).rejects.toThrow(
      'x',
    );
    await expect(sequencer.run('b1', 'b', async () => 1)).rejects.toBeInstanceOf(IngressFenced);
    await expect(sequencer.run('b1', 'c', async () => 1)).rejects.toBeInstanceOf(IngressFenced);
    expect(sequencer.outstanding('b1')).toBe(2);
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
    expect(sequencer.outstanding('b1')).toBe(0);
  });

  it('a message that fails late in a fence keeps its own full window, so nothing overtakes it when the first failure lapses', async () => {
    const { sequencer, advance } = lane({ fenceMs: 120_000 });
    await expect(
      sequencer.run('b1', 'poison', () => Promise.reject(new Error('x'))),
    ).rejects.toThrow('x');
    /* 110 s later the cancel arrives and is refused behind it: outstanding from 110 s. */
    advance(110_000);
    await expect(sequencer.run('b1', 'cancel', async () => 'cancel')).rejects.toBeInstanceOf(
      IngressFenced,
    );
    /* The poison's window has passed; the cancel's has not. A later "yes" must not overtake it. */
    advance(15_000);
    await expect(sequencer.run('b1', 'yes', async () => 'yes')).rejects.toBeInstanceOf(
      IngressFenced,
    );
    /* Meta redelivers the cancel inside its window: it is stored first, then the yes. */
    const stored: string[] = [];
    await sequencer.run('b1', 'cancel', async () => stored.push('cancel'));
    await sequencer.run('b1', 'yes', async () => stored.push('yes'));
    expect(stored).toEqual(['cancel', 'yes']);
    expect(sequencer.outstanding('b1')).toBe(0);
  });

  it('a late message still lapses 120 s after its own first failure', async () => {
    const { sequencer, advance } = lane({ fenceMs: 120_000 });
    await expect(
      sequencer.run('b1', 'first', () => Promise.reject(new Error('x'))),
    ).rejects.toThrow('x');
    advance(60_000);
    await expect(sequencer.run('b1', 'second', async () => 1)).rejects.toBeInstanceOf(
      IngressFenced,
    );
    advance(60_000); // first lapses at 120 s; second is held until 180 s
    expect(sequencer.outstanding('b1')).toBe(1);
    await expect(sequencer.run('b1', 'next', async () => 1)).rejects.toBeInstanceOf(IngressFenced);
    advance(60_000);
    /* Both lapsed. "next" was refused at 120 s, so it is outstanding itself, and is admitted. */
    expect(await sequencer.run('b1', 'next', async () => 2)).toBe(2);
    expect(sequencer.outstanding('b1')).toBe(0);
  });

  it('the production defaults fence for exactly 120 s: held at 119.999 s, lapsed at 120 s', async () => {
    expect(INGRESS_FENCE_MS).toBe(120_000);
    let now = 5_000;
    const sequencer = new IngressSequencer({
      waitMs: INGRESS_WAIT_MS,
      maxWaiting: INGRESS_MAX_WAITING,
      fenceMs: INGRESS_FENCE_MS,
      now: () => now,
    });
    await expect(sequencer.run('b1', 'lost', () => Promise.reject(new Error('x')))).rejects.toThrow(
      'x',
    );
    now += 119_999;
    await expect(sequencer.run('b1', 'yes', async () => 1)).rejects.toBeInstanceOf(IngressFenced);
    now += 1;
    /* "lost" lapsed; "yes" was refused at 119.999 s and is outstanding itself, so it goes. */
    expect(await sequencer.run('b1', 'yes', async () => 2)).toBe(2);
  });

  it('the fence is in memory only: a restarted process starts with no fence (documented limit)', async () => {
    const before = new IngressSequencer({ waitMs: 1_000, maxWaiting: 8, fenceMs: 120_000 });
    await expect(before.run('b1', 'lost', () => Promise.reject(new Error('x')))).rejects.toThrow(
      'x',
    );
    await expect(before.run('b1', 'yes', async () => 1)).rejects.toBeInstanceOf(IngressFenced);
    /* A restart or deploy builds a new sequencer: the outstanding set is gone, and a later
     * message is admitted. Ordering then rests on the database lock and arrival stamp alone. */
    const afterRestart = new IngressSequencer({ waitMs: 1_000, maxWaiting: 8, fenceMs: 120_000 });
    expect(afterRestart.outstanding('b1')).toBe(0);
    expect(await afterRestart.run('b1', 'yes', async () => 'admitted')).toBe('admitted');
  });

  it('a message stored once and redelivered is admitted, and leaves nothing outstanding', async () => {
    const { sequencer } = lane();
    expect(await sequencer.run('b1', 'sold', async () => ({ isNew: true }))).toEqual({
      isNew: true,
    });
    expect(await sequencer.run('b1', 'sold', async () => ({ isNew: false }))).toEqual({
      isNew: false,
    });
    expect(sequencer.outstanding('b1')).toBe(0);
    expect(await sequencer.run('b1', 'next', async () => 'next')).toBe('next');
  });

  it('a refused message the caller found already stored is settled and holds nothing back', async () => {
    const { sequencer } = lane();
    await expect(
      sequencer.run('b1', 'cancel', () => Promise.reject(new Error('x'))),
    ).rejects.toThrow('x');
    await expect(sequencer.run('b1', 'dup', async () => 1)).rejects.toBeInstanceOf(IngressFenced);
    sequencer.settle('b1', 'dup');
    expect(await sequencer.run('b1', 'cancel', async () => 'stored')).toBe('stored');
    expect(sequencer.outstanding('b1')).toBe(0);
    expect(await sequencer.run('b1', 'next', async () => 'next')).toBe('next');
  });

  it('refuses bounds that are not positive whole numbers', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new IngressSequencer({ waitMs: bad, maxWaiting: 1, fenceMs: 1 })).toThrow();
      expect(() => new IngressSequencer({ waitMs: 1, maxWaiting: bad, fenceMs: 1 })).toThrow();
      expect(() => new IngressSequencer({ waitMs: 1, maxWaiting: 1, fenceMs: bad })).toThrow();
      expect(
        () => new IngressSequencer({ waitMs: 1, maxWaiting: 1, fenceMs: 1, maxOutstanding: bad }),
      ).toThrow();
    }
  });
});
