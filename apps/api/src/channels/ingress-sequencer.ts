/**
 * Per-business admission order for inbound messages, in front of the database ingress lock
 * (OWN-74, PR #428).
 *
 * `jobsRepo.stampInboundArrival` serializes ingress per business with an advisory lock and stamps
 * the arrival under it, so a message stamped earlier is always committed before a later one is
 * stamped. On its own, though, every webhook waiting for that lock held a connection from the
 * shared application pool while it waited, and one that gave up (the 2 s lock bound) left no
 * record: a later message of the same business could then be stored, and processed, ahead of it
 * before Meta redelivered it (CodeRabbit and Codex on #428).
 *
 * This lane fixes both in the process that receives the webhook:
 *
 *  - **One connection per business.** Messages of one business are admitted one at a time, in the
 *    order they reach the lane. A message waits here, in memory, holding no database connection;
 *    only the message at the head opens a transaction and takes the database lock (which still
 *    serializes against any other process). Different businesses have different lanes and never
 *    wait for each other.
 *  - **Bounded.** A message waits at most `waitMs` for its turn, and at most `maxWaiting` messages
 *    may wait per business; past either bound it is refused at once (the controller answers Meta
 *    non-200 and Meta redelivers it).
 *  - **No overtaking after a failure.** When a message of a business fails to be stored (refused
 *    here, a database lock timeout, any error), the lane raises a fence naming that message. Until
 *    that message is stored again, or `fenceMs` passes, every LATER message of the business is
 *    refused too, including those already waiting behind it and those arriving in later webhooks.
 *    Meta redelivers them all; the fenced message goes first when it comes back, and the rest
 *    follow in their turn. A message that was already stored before the fence is not new work and
 *    may pass (the caller checks, see `IngressFenced`).
 *
 * What it cannot do: order two webhooks that reach the lane at the same time (Meta does not
 * order its separate webhook requests, and its message timestamps are whole seconds), or fence a
 * message whose business could not be resolved before it failed (that one is ordered only within
 * its own webhook body, by the controller). After `fenceMs` with no redelivery, later messages are
 * admitted again and the fenced one, if it ever returns, is stamped when it arrives.
 *
 * The lane is per process. Production runs one API process; a second one would still be ordered
 * by the database lock but would not share this lane's fence.
 */
export class IngressRefused extends Error {
  constructor(readonly reason: 'busy' | 'timeout' | 'fenced') {
    super(`inbound message not admitted (${reason})`);
    this.name = 'IngressRefused';
  }
}

/** Refused because an earlier message of the business has not been stored yet. */
export class IngressFenced extends IngressRefused {
  constructor() {
    super('fenced');
    this.name = 'IngressFenced';
  }
}

export interface IngressSequencerOptions {
  /** Longest a message waits for its turn, in milliseconds. */
  waitMs: number;
  /** Most messages that may wait per business at once. */
  maxWaiting: number;
  /** How long a failure fences later messages of the business, in milliseconds. */
  fenceMs: number;
  /** The clock, for tests. */
  now?: () => number;
}

export const INGRESS_WAIT_MS = 5_000;
export const INGRESS_MAX_WAITING = 32;
export const INGRESS_FENCE_MS = 120_000;

interface Lane {
  /** Settles once every message admitted so far has finished. */
  tail: Promise<void>;
  /** Messages admitted and not yet finished, the one running included. */
  size: number;
  /** The earliest message, by admission, that failed and has not been stored since. */
  fence: { head: string; seq: number; until: number } | null;
}

export class IngressSequencer {
  private readonly lanes = new Map<string, Lane>();
  /** Admission order across the process; only compared within one lane. */
  private seq = 0;
  private readonly options: Required<IngressSequencerOptions>;

  constructor(options?: IngressSequencerOptions) {
    const given = options ?? {
      waitMs: INGRESS_WAIT_MS,
      maxWaiting: INGRESS_MAX_WAITING,
      fenceMs: INGRESS_FENCE_MS,
    };
    for (const [name, value] of Object.entries({
      waitMs: given.waitMs,
      maxWaiting: given.maxWaiting,
      fenceMs: given.fenceMs,
    })) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`IngressSequencer: ${name} must be a positive integer`);
      }
    }
    this.options = { ...given, now: given.now ?? Date.now };
  }

  /**
   * Run `work` (store one message) in its turn for `businessId`. Throws `IngressRefused` when the
   * message is not admitted; anything `work` throws is passed on, after fencing the business.
   */
  async run<T>(businessId: string, externalId: string, work: () => Promise<T>): Promise<T> {
    const lane = this.laneFor(businessId);
    const seq = (this.seq += 1);
    this.checkFence(lane, externalId, seq);
    if (lane.size >= this.options.maxWaiting) {
      this.raiseFence(lane, externalId, seq);
      this.dropIfIdle(businessId, lane);
      throw new IngressRefused('busy');
    }

    lane.size += 1;
    const before = lane.tail;
    let finished!: () => void;
    const mine = new Promise<void>((resolve) => (finished = resolve));
    /* The next message starts only once the one before this AND this one have finished, so a
     * message that gave up waiting never lets the next one start while the one ahead still runs. */
    lane.tail = before.then(() => mine);
    try {
      if (!(await this.turnWithin(before))) {
        this.raiseFence(lane, externalId, seq);
        throw new IngressRefused('timeout');
      }
      /* A message ahead of this one may have failed while it waited. */
      this.checkFence(lane, externalId, seq);
      let result: T;
      try {
        result = await work();
      } catch (error) {
        this.raiseFence(lane, externalId, seq);
        throw error;
      }
      if (lane.fence?.head === externalId) lane.fence = null;
      return result;
    } finally {
      void before.then(finished);
      lane.size -= 1;
      this.dropIfIdle(businessId, lane);
    }
  }

  /** Waiting and running messages of a business, for tests and diagnostics. */
  depth(businessId: string): number {
    return this.lanes.get(businessId)?.size ?? 0;
  }

  /** Whether later messages of a business are fenced right now, for tests and diagnostics. */
  fenced(businessId: string): boolean {
    const lane = this.lanes.get(businessId);
    return Boolean(lane?.fence && this.options.now() < lane.fence.until);
  }

  private laneFor(businessId: string): Lane {
    let lane = this.lanes.get(businessId);
    if (!lane) {
      lane = { tail: Promise.resolve(), size: 0, fence: null };
      this.lanes.set(businessId, lane);
    }
    return lane;
  }

  /** Refuses a message admitted after the fenced one, unless it is the fenced one come back. */
  private checkFence(lane: Lane, externalId: string, seq: number): void {
    if (!lane.fence) return;
    if (this.options.now() >= lane.fence.until) {
      lane.fence = null;
      return;
    }
    if (lane.fence.head !== externalId && seq > lane.fence.seq) throw new IngressFenced();
  }

  /**
   * The earliest failure, by admission, names the fence. A message that gave up waiting can fail
   * before the message ahead of it does; if that one then fails too, it is the earlier of the two
   * and takes the fence over, so it is the one stored first when Meta redelivers them.
   */
  private raiseFence(lane: Lane, externalId: string, seq: number): void {
    const now = this.options.now();
    const active = lane.fence && now < lane.fence.until ? lane.fence : null;
    if (active?.head === externalId) {
      /* The fenced message itself failed again on its redelivery: it still goes first. */
      active.until = now + this.options.fenceMs;
      return;
    }
    if (active && active.seq <= seq) return;
    lane.fence = { head: externalId, seq, until: now + this.options.fenceMs };
  }

  private dropIfIdle(businessId: string, lane: Lane): void {
    if (lane.size === 0 && !lane.fence && this.lanes.get(businessId) === lane) {
      this.lanes.delete(businessId);
    }
  }

  private turnWithin(before: Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.options.waitMs);
    });
    return Promise.race([before.then(() => true), timedOut]).finally(() => clearTimeout(timer));
  }
}
