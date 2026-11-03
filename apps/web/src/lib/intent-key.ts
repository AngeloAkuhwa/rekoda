/**
 * One idempotency key per intention, held across a remount of the form that uses it.
 *
 * A key kept only in component state is lost when the dashboard's error boundary remounts a form,
 * which happens when the browser loses a server action's answer (a dropped mobile connection, a
 * timeout) after the API had already acted. The next press would then carry a new key and could
 * message a customer twice. Kept here in session storage, a remounted form for the same intention
 * picks up the same key and the API replays instead of acting again.
 *
 * Session storage can be missing or throw (private windows, blocked site data); every access is
 * guarded and a fresh key is the fallback, which is no worse than component state alone.
 */

export interface KeyStore {
  readonly length?: number;
  key?(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'rk:intent:';
const KEY = /^[0-9a-f-]{36}$/i;

/** How long a held key counts as the same intention: a retry, not a new reminder days later. */
export const INTENT_KEY_TTL_MS = 30 * 60_000;

/** The browser's session storage, or null where there is none or it refuses access. */
export function browserKeyStore(): KeyStore | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The key held for this intention, or a fresh one (held from now on) when none is usable. */
export function heldIntentKey(
  store: KeyStore | null,
  scope: string,
  now: number,
  ttlMs: number,
  fresh: () => string,
): string {
  try {
    const raw = store?.getItem(PREFIX + scope);
    if (raw) {
      const held = JSON.parse(raw) as { key?: unknown; at?: unknown };
      if (
        typeof held.key === 'string' &&
        KEY.test(held.key) &&
        typeof held.at === 'number' &&
        now - held.at <= ttlMs
      ) {
        return held.key;
      }
    }
  } catch {
    /* Unreadable or damaged: replaced below. */
  }
  const key = fresh();
  try {
    store?.setItem(PREFIX + scope, JSON.stringify({ key, at: now }));
  } catch {
    /* Not held; this render still has a usable key. */
  }
  return key;
}

/**
 * Restarts the hold at the moment of a press. The hold otherwise counts from when the form first
 * drew the key, so a form left open past the TTL would lose the key of the press whose answer was
 * lost. Anything that is not a key is never held.
 */
export function touchIntentKey(
  store: KeyStore | null,
  scope: string,
  key: string,
  now: number,
  /** What the press asked for (a channel choice), so a remounted form can show it again. */
  meta?: string,
): void {
  if (!KEY.test(key)) return;
  try {
    store?.setItem(
      PREFIX + scope,
      JSON.stringify(meta === undefined ? { key, at: now } : { key, at: now, meta }),
    );
  } catch {
    /* Not held; the press still carries its key. */
  }
}

/** The intention is settled: the next press is a new one and gets a new key. */
export function releaseIntentKey(store: KeyStore | null, scope: string): void {
  try {
    store?.removeItem(PREFIX + scope);
  } catch {
    /* Nothing held, or storage refused: the TTL ends it anyway. */
  }
}

/**
 * What the last press under this scope asked for, while its key is still held; null otherwise.
 * A form remounted after a lost answer restores it, so the retry repeats the same request under
 * the same key instead of a different one (a channel choice reset to its default).
 */
export function heldIntentMeta(
  store: KeyStore | null,
  scope: string,
  now: number,
  ttlMs: number,
): string | null {
  try {
    const raw = store?.getItem(PREFIX + scope);
    if (!raw) return null;
    const held = JSON.parse(raw) as { key?: unknown; at?: unknown; meta?: unknown };
    if (typeof held.key !== 'string' || !KEY.test(held.key)) return null;
    if (typeof held.at !== 'number' || now - held.at > ttlMs) return null;
    return typeof held.meta === 'string' ? held.meta : null;
  } catch {
    return null;
  }
}

/**
 * The batch page reached from a Confirm names the key that Confirm carried. The batch exists, so
 * whichever selection holds exactly that key is released and the same selection made again later
 * is a new batch. A key is matched, never a slot: a landing revisited later (Back to a cached
 * page) names a key that is already gone and releases nothing, so it cannot release the key of a
 * different Confirm still waiting for its answer.
 */
export function releaseHeldKey(store: KeyStore | null, key: string): void {
  if (!KEY.test(key)) return;
  try {
    const length = store?.length;
    if (!store || typeof length !== 'number' || !store.key) return;
    const names: string[] = [];
    for (let i = 0; i < length; i += 1) {
      const name = store.key(i);
      if (name?.startsWith(PREFIX)) names.push(name);
    }
    for (const name of names) {
      const raw = store.getItem(name);
      if (!raw) continue;
      try {
        if ((JSON.parse(raw) as { key?: unknown }).key === key) store.removeItem(name);
      } catch {
        /* Damaged entry: left to its TTL. */
      }
    }
  } catch {
    /* Storage refused: the TTL ends the held key anyway. */
  }
}

/** Whether a string is shaped like one of our idempotency keys (the landing's address carries it). */
export function isIntentKey(value: string): boolean {
  return KEY.test(value);
}

/** A batch's intention is its exact selection: which invoices (in any order), how and when. */
export function batchIntentScope(invoiceNumbers: string[], choice: string, at: string): string {
  return `batch:${[...invoiceNumbers].sort().join(',')}|${choice}|${at || 'now'}`;
}
