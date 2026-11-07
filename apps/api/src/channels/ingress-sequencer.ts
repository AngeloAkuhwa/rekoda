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
 *  - **No overtaking after a failure.** A message of a business that fails to be stored (refused
 *    here, a database lock timeout, any error) is remembered as OUTSTANDING with its admission
 *    order. A message is admitted only when no outstanding message of its business is earlier than
 *    it; any other message is refused and becomes outstanding itself, behind the ones already
 *    there. So whatever order Meta redelivers them in, they are stored in the order they first
 *    reached the lane, and nothing new is stored ahead of any of them. An outstanding message
 *    leaves the set when it is stored. A message that was already stored before it was refused is
 *    not new work and may be acknowledged (the caller checks, see `IngressFenced`).
 *  - **The fence ends.** The outstanding set of a business lives at most `fenceMs` from the moment
 *    it first held a message, whatever happens after (a message failing again does not extend it),
 *    and holds at most `maxOutstanding` messages. When the lifetime passes the set is dropped and
 *    messages are admitted again, so one message that keeps failing cannot hold a merchant's
 *    messages back for longer than that. A refusal past the size cap is not remembered, so its order
 *    against the others is not kept.
 *
 * What it cannot do: order two webhooks that reach the lane at the same time (Meta does not
 * order its separate webhook requests, and its message timestamps are whole seconds); fence a
 * message whose business could not be resolved before it failed (the controller orders that one
 * within its own webhook body only); keep the set across a restart or deploy (it is in memory),
 * or share it with a second API process (production runs one; a second would still be ordered by
 * the database lock). After the lifetime, a message still outstanding is stamped when it arrives.
 */
export class IngressRefused extends Error {
  constructor(
    readonly reason: 'busy' | 'timeout' | 'fenced',
    /** The business the message was refused for, so the caller can scope its own response. */
    readonly businessId: string,
  ) {
    super(`inbound message not admitted (${reason})`);
    this.name = 'IngressRefused';
  }
}

/** Refused because an earlier message of the business has not been stored yet. */
export class IngressFenced extends IngressRefused {
  constructor(businessId: string) {
    super('fenced', businessId);
    this.name = 'IngressFenced';
  }
}

/** Storing the message failed after it was admitted; the business is known. */
export class IngressStoreFailed extends Error {
  constructor(
    readonly businessId: string,
    override readonly cause: unknown,
  ) {
    super(`inbound message not stored: ${String((cause as Error)?.message ?? cause)}`);
    this.name = 'IngressStoreFailed';
  }
}

export interface IngressSequencerOptions {
  /** Longest a message waits for its turn, in milliseconds. */
  waitMs: number;
  /** Most messages that may wait per business at once. */
  maxWaiting: number;
  /** Longest a business's outstanding set lives, from its first message, in milliseconds. */
  fenceMs: number;
  /** Most refused messages remembered per business. */
  maxOutstanding?: number;
  /** The clock, for tests. */
  now?: () => number;
}

export const INGRESS_WAIT_MS = 5_000;
export const INGRESS_MAX_WAITING = 32;
export const INGRESS_FENCE_MS = 120_000;
export const INGRESS_MAX_OUTSTANDING = 256;

interface Lane {
  /** Settles once every message admitted so far has finished. */
  tail: Promise<void>;
  /** Messages admitted and not yet finished, the one running included. */
  size: number;
  /**
   * Messages that failed or were refused and are not stored yet, by external id, each with the
   * admission order it first had. External ids are Meta's wamids, unique across Meta.
   */
  outstanding: Map<string, number>;
  /** When `outstanding` is dropped, fixed when it first held a message. */
  until: number;
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
    const resolved = {
      waitMs: given.waitMs,
      maxWaiting: given.maxWaiting,
      fenceMs: given.fenceMs,
      maxOutstanding: given.maxOutstanding ?? INGRESS_MAX_OUTSTANDING,
    };
    for (const [name, value] of Object.entries(resolved)) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`IngressSequencer: ${name} must be a positive integer`);
      }
    }
    this.options = { ...resolved, now: given.now ?? Date.now };
  }

  /**
   * Run `work` (store one message) in its turn for `businessId`. Throws `IngressRefused` when the
   * message is not admitted, and `IngressStoreFailed` (carrying the business and the cause) when
   * `work` throws.
   */
  async run<T>(businessId: string, externalId: string, work: () => Promise<T>): Promise<T> {
    const lane = this.laneFor(businessId);
    const seq = (this.seq += 1);
    this.admitOrRefuse(lane, businessId, externalId, seq);
    if (lane.size >= this.options.maxWaiting) {
      this.remember(lane, externalId, seq);
      this.dropIfIdle(businessId, lane);
      throw new IngressRefused('busy', businessId);
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
        this.remember(lane, externalId, seq);
        throw new IngressRefused('timeout', businessId);
      }
      /* A message ahead of this one may have failed while it waited. */
      this.admitOrRefuse(lane, businessId, externalId, seq);
      let result: T;
      try {
        result = await work();
      } catch (error) {
        this.remember(lane, externalId, seq);
        throw new IngressStoreFailed(businessId, error);
      }
      lane.outstanding.delete(externalId);
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

  /** Messages of a business that failed and are not stored yet, for tests and diagnostics. */
  outstanding(businessId: string): number {
    const lane = this.lanes.get(businessId);
    if (!lane) return 0;
    this.expire(businessId, lane);
    return lane.outstanding.size;
  }

  private laneFor(businessId: string): Lane {
    let lane = this.lanes.get(businessId);
    if (!lane) {
      lane = { tail: Promise.resolve(), size: 0, outstanding: new Map(), until: 0 };
      this.lanes.set(businessId, lane);
    }
    /* Expired here without dropping the lane: the caller is about to use it, and a lane removed
     * from the map while in use would let a second lane of the business run beside it. */
    if (lane.outstanding.size > 0 && this.options.now() >= lane.until) lane.outstanding.clear();
    return lane;
  }

  /** Drops an outstanding set whose lifetime has passed. */
  private expire(businessId: string, lane: Lane): void {
    if (lane.outstanding.size > 0 && this.options.now() >= lane.until) {
      lane.outstanding.clear();
      this.dropIfIdle(businessId, lane);
    }
  }

  /**
   * A message is admitted only when no outstanding message of its business came before it. One
   * that is itself outstanding is ordered by when it first came; any other by now.
   */
  private admitOrRefuse(lane: Lane, businessId: string, externalId: string, seq: number): void {
    if (lane.outstanding.size === 0) return;
    if (this.options.now() >= lane.until) {
      lane.outstanding.clear();
      return;
    }
    const mine = lane.outstanding.get(externalId) ?? seq;
    for (const [other, at] of lane.outstanding) {
      if (other !== externalId && at < mine) {
        this.remember(lane, externalId, seq);
        throw new IngressFenced(businessId);
      }
    }
  }

  /** Remembers a message that was not stored, keeping the earliest order it ever had. */
  private remember(lane: Lane, externalId: string, seq: number): void {
    const now = this.options.now();
    if (lane.outstanding.size > 0 && now >= lane.until) lane.outstanding.clear();
    if (lane.outstanding.has(externalId)) return;
    if (lane.outstanding.size >= this.options.maxOutstanding) return;
    if (lane.outstanding.size === 0) lane.until = now + this.options.fenceMs;
    lane.outstanding.set(externalId, seq);
  }

  private dropIfIdle(businessId: string, lane: Lane): void {
    if (lane.size === 0 && lane.outstanding.size === 0 && this.lanes.get(businessId) === lane) {
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
