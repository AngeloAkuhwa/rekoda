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

/** The intention is settled: the next press is a new one and gets a new key. */
export function releaseIntentKey(store: KeyStore | null, scope: string): void {
  try {
    store?.removeItem(PREFIX + scope);
  } catch {
    /* Nothing held, or storage refused: the TTL ends it anyway. */
  }
}

/**
 * Releases every held key whose scope starts with `prefix`. A batch page calls it for `batch:`:
 * Confirm redirects there once a batch exists, and a merchant reaches it to cancel one, so the
 * same selection made again afterwards is a new batch rather than a replay of the old one.
 * A lost answer leaves the merchant on the form, where the held key still protects the retry.
 */
export function releaseIntentScopes(store: KeyStore | null, prefix: string): void {
  try {
    if (!store || typeof store.length !== 'number' || !store.key) return;
    const held: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const name = store.key(i);
      if (name?.startsWith(PREFIX + prefix)) held.push(name);
    }
    for (const name of held) store.removeItem(name);
  } catch {
    /* Storage refused: the TTL ends the held keys anyway. */
  }
}

/** A batch's intention is its exact selection: which invoices (in any order), how and when. */
export function batchIntentScope(invoiceNumbers: string[], choice: string, at: string): string {
  return `batch:${[...invoiceNumbers].sort().join(',')}|${choice}|${at || 'now'}`;
}
