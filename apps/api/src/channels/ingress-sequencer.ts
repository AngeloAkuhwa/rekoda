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
 *  - **The fence ends.** Each outstanding message is remembered for `fenceMs` (120 s in
 *    production) from the moment it FIRST failed or was refused; failing again on a redelivery does
 *    not extend it. Within that window nothing that reached the lane after it is stored ahead of it.
 *    When its window passes it is forgotten and holds nothing back. Messages refused behind it are
 *    outstanding on their own windows and are admitted on their own redelivery once nothing earlier
 *    is outstanding, so the windows can chain: while a merchant keeps writing faster than Meta
 *    redelivers, each new message can be refused behind the last, and the fence clears when the
 *    redeliveries catch up or 120 s pass with no new refusal. Nothing is lost meanwhile, and no
 *    single message fences anything for more than 120 s after its own first failure. At most `maxOutstanding` are remembered per business; a refusal past
 *    the cap is not remembered, so its order against the others is not kept.
 *
 * The guarantee is ADMISSION order: the order messages of one business reach this lane, after
 * sender resolution. It is not Meta's send order. What it cannot do:
 *  - order two webhooks that are in flight at the same time: they reach the lane in the order their
 *    sender resolution finishes. Meta does not order its separate webhook requests, and its message
 *    timestamps are whole seconds, so Rekoda has no source for the send order and none is used;
 *  - fence a message whose business could not be resolved before it failed: its business is
 *    unknown, so a later webhook of that business may be stored before it. The controller holds
 *    back the rest of its webhook body instead, for every business, until Meta redelivers it, and
 *    reserves the failed message's order (`reserve`) so the redelivery stores it before them;
 *  - keep the set across a restart or deploy (it is in memory), or share it with a second API
 *    process (production runs one; a second would still be ordered by the database lock alone);
 *  - hold a message past its window: if Meta redelivers it more than 120 s after it first failed,
 *    it is stamped when it is redelivered, and later messages may already have been stored.
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
  /** How long each outstanding message is remembered, from its first failure, in milliseconds. */
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
   * admission order it first had and when it is forgotten (fixed when it first failed). External
   * ids are Meta's wamids, unique across Meta.
   */
  outstanding: Map<string, { seq: number; until: number }>;
}

export class IngressSequencer {
  private readonly lanes = new Map<string, Lane>();
  /**
   * Admission orders reserved for messages that failed before their business was known (see
   * `reserve`), by external id, each forgotten `fenceMs` after it was reserved.
   */
  private readonly reserved = new Map<string, { seq: number; until: number }>();
  /** Admission order across the process; only compared within one lane. */
  private seq = 0;
  private readonly options: Required<IngressSequencerOptions>;

  constructor(given: Partial<IngressSequencerOptions> = {}) {
    const resolved = {
      waitMs: given.waitMs ?? INGRESS_WAIT_MS,
      maxWaiting: given.maxWaiting ?? INGRESS_MAX_WAITING,
      fenceMs: given.fenceMs ?? INGRESS_FENCE_MS,
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
    const seq = this.takeReserved(externalId) ?? (this.seq += 1);
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

  /**
   * The caller found a refused message already stored (a duplicate, or a redelivered body that
   * also carries a failed message): it will never be stored again, so it stops being outstanding
   * and holds nothing back.
   */
  settle(businessId: string, externalId: string): void {
    const lane = this.lanes.get(businessId);
    if (!lane) return;
    lane.outstanding.delete(externalId);
    this.dropIfIdle(businessId, lane);
  }

  /**
   * Reserves an admission order for a message that failed before its business was known, so that
   * when it comes back it is ordered as it first came: ahead of the messages after it in its body
   * that were held back meanwhile (`hold`), which would otherwise fence it and be stored first.
   * Kept for `fenceMs` and for at most `maxOutstanding` messages; a reservation is used once.
   */
  reserve(externalId: string): void {
    this.pruneReserved();
    if (this.reserved.has(externalId) || this.reserved.size >= this.options.maxOutstanding) return;
    this.reserved.set(externalId, {
      seq: (this.seq += 1),
      until: this.options.now() + this.options.fenceMs,
    });
  }

  /**
   * Holds back a message the caller could not try at all (an earlier message of its webhook body
   * failed before that message's business was known): it becomes outstanding, ordered as it
   * reached the lane, so no later message of its business is stored ahead of it before Meta
   * redelivers the body. It leaves the set when it is stored, like any refused message.
   */
  hold(businessId: string, externalId: string): void {
    const lane = this.laneFor(businessId);
    this.remember(lane, externalId, (this.seq += 1));
    this.dropIfIdle(businessId, lane);
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
      lane = { tail: Promise.resolve(), size: 0, outstanding: new Map() };
      this.lanes.set(businessId, lane);
    }
    /* Pruned here without dropping the lane: the caller is about to use it, and a lane removed
     * from the map while in use would let a second lane of the business run beside it. */
    this.prune(lane);
    return lane;
  }

  private takeReserved(externalId: string): number | undefined {
    this.pruneReserved();
    const entry = this.reserved.get(externalId);
    if (!entry) return undefined;
    this.reserved.delete(externalId);
    return entry.seq;
  }

  private pruneReserved(): void {
    if (this.reserved.size === 0) return;
    const now = this.options.now();
    for (const [id, entry] of this.reserved) if (now >= entry.until) this.reserved.delete(id);
  }

  /** Forgets outstanding messages whose own window has passed. */
  private prune(lane: Lane): void {
    if (lane.outstanding.size === 0) return;
    const now = this.options.now();
    for (const [id, entry] of lane.outstanding) {
      if (now >= entry.until) lane.outstanding.delete(id);
    }
  }

  /** Drops outstanding messages whose window has passed, and the lane if that leaves it idle. */
  private expire(businessId: string, lane: Lane): void {
    this.prune(lane);
    this.dropIfIdle(businessId, lane);
  }

  /**
   * A message is admitted only when no outstanding message of its business came before it. One
   * that is itself outstanding is ordered by when it first came; any other by now.
   */
  private admitOrRefuse(lane: Lane, businessId: string, externalId: string, seq: number): void {
    this.prune(lane);
    if (lane.outstanding.size === 0) return;
    const mine = lane.outstanding.get(externalId)?.seq ?? seq;
    for (const [other, entry] of lane.outstanding) {
      if (other !== externalId && entry.seq < mine) {
        this.remember(lane, externalId, seq);
        throw new IngressFenced(businessId);
      }
    }
  }

  /**
   * Remembers a message that was not stored, keeping the earliest order it ever had and the window
   * its first failure opened (a later failure of the same message extends neither).
   */
  private remember(lane: Lane, externalId: string, seq: number): void {
    this.prune(lane);
    if (lane.outstanding.has(externalId)) return;
    if (lane.outstanding.size >= this.options.maxOutstanding) return;
    lane.outstanding.set(externalId, { seq, until: this.options.now() + this.options.fenceMs });
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
