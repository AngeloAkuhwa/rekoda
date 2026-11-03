/**
 * One idempotency key per intention that survives a remount (REM-06).
 *
 * The dashboard's error boundary remounts a form when the browser loses the server action's
 * answer. A key held only in component state is then redrawn, and a reminder the API already sent
 * could go to the customer again. The key is kept in session storage per intention instead.
 */
import { describe, expect, it } from 'vitest';
import {
  batchIntentScope,
  heldIntentKey,
  releaseIntentKey,
  heldIntentMeta,
  releaseHeldKey,
  touchIntentKey,
  type KeyStore,
} from './intent-key';

function memoryStore(): KeyStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const TTL = 30 * 60_000;
let n = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

describe('a reminder key held across a remount', () => {
  it('a remounted form for the same invoice gets the key the lost press used', () => {
    const store = memoryStore();
    const first = heldIntentKey(store, 'remind:INV-1', 1_000, TTL, fresh);
    /* The boundary remounts the form: a new render asks again. */
    const again = heldIntentKey(store, 'remind:INV-1', 5_000, TTL, fresh);
    expect(again).toBe(first);
  });

  it('a different invoice is a different intention', () => {
    const store = memoryStore();
    const a = heldIntentKey(store, 'remind:INV-1', 1_000, TTL, fresh);
    const b = heldIntentKey(store, 'remind:INV-2', 1_000, TTL, fresh);
    expect(b).not.toBe(a);
  });

  it('once the answer settles, the next press is a new reminder with a new key', () => {
    const store = memoryStore();
    const first = heldIntentKey(store, 'remind:INV-1', 1_000, TTL, fresh);
    releaseIntentKey(store, 'remind:INV-1');
    expect(heldIntentKey(store, 'remind:INV-1', 2_000, TTL, fresh)).not.toBe(first);
  });

  it('an old held key expires, so a reminder days later is not mistaken for a retry', () => {
    const store = memoryStore();
    const first = heldIntentKey(store, 'remind:INV-1', 1_000, TTL, fresh);
    expect(heldIntentKey(store, 'remind:INV-1', 1_000 + TTL + 1, TTL, fresh)).not.toBe(first);
  });

  it('a damaged or foreign stored value is replaced, never sent', () => {
    const store = memoryStore();
    store.setItem('rk:intent:remind:INV-1', '{"key":"not-a-uuid","at":1000}');
    const key = heldIntentKey(store, 'remind:INV-1', 2_000, TTL, fresh);
    expect(key).toMatch(/^[0-9a-f-]{36}$/i);
    store.setItem('rk:intent:remind:INV-2', 'garbage');
    expect(heldIntentKey(store, 'remind:INV-2', 2_000, TTL, fresh)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('with no storage (private window, blocked), it still answers with a fresh key', () => {
    expect(heldIntentKey(null, 'remind:INV-1', 1_000, TTL, fresh)).toMatch(/^[0-9a-f-]{36}$/i);
    const throwing: KeyStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(heldIntentKey(throwing, 'remind:INV-1', 1_000, TTL, fresh)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(() => releaseIntentKey(throwing, 'remind:INV-1')).not.toThrow();
  });

  it('a batch intention is the exact selection, in any picking order', () => {
    expect(batchIntentScope(['INV-2', 'INV-1'], 'auto', '')).toBe(
      batchIntentScope(['INV-1', 'INV-2'], 'auto', ''),
    );
    expect(batchIntentScope(['INV-1'], 'auto', '')).not.toBe(
      batchIntentScope(['INV-1'], 'email', ''),
    );
    expect(batchIntentScope(['INV-1'], 'auto', '2026-11-10T09:30')).not.toBe(
      batchIntentScope(['INV-1'], 'auto', ''),
    );
  });

  it('a landing releases the selection holding the key it names, and nothing else', () => {
    const store = memoryStore();
    const confirmed = batchIntentScope(['INV-1'], 'whatsapp', '2026-11-10T18:00');
    const unresolved = batchIntentScope(['INV-2'], 'email', '');
    const confirmedKey = heldIntentKey(store, confirmed, 1_000, TTL, fresh);
    const unresolvedKey = heldIntentKey(store, unresolved, 1_000, TTL, fresh);
    releaseHeldKey(store, confirmedKey);
    expect(heldIntentKey(store, confirmed, 3_000, TTL, fresh)).not.toBe(confirmedKey);
    expect(heldIntentKey(store, unresolved, 3_000, TTL, fresh)).toBe(unresolvedKey);
  });

  it('Back to an earlier landing cannot release the key of a later Confirm whose answer was lost', () => {
    const store = memoryStore();
    const landed = batchIntentScope(['INV-1'], 'whatsapp', '');
    const lost = batchIntentScope(['INV-2'], 'whatsapp', '');
    const landedKey = heldIntentKey(store, landed, 1_000, TTL, fresh);
    releaseHeldKey(store, landedKey); /* the first landing */
    const lostKey = heldIntentKey(
      store,
      lost,
      2_000,
      TTL,
      fresh,
    ); /* Confirm pressed, answer lost */
    releaseHeldKey(store, landedKey); /* Back to the cached first landing re-runs its release */
    /* The same selection again carries the same key, so the API replays the batch it made. */
    expect(heldIntentKey(store, lost, 3_000, TTL, fresh)).toBe(lostKey);
  });

  it('a value that is not a key releases nothing, and a store that cannot list is left to its TTL', () => {
    const store = memoryStore();
    const scope = batchIntentScope(['INV-1'], 'auto', '');
    const key = heldIntentKey(store, scope, 1_000, TTL, fresh);
    releaseHeldKey(store, '1');
    releaseHeldKey(store, 'not-a-key');
    releaseHeldKey(null, key);
    const noList: KeyStore = {
      getItem: store.getItem,
      setItem: store.setItem,
      removeItem: store.removeItem,
    };
    releaseHeldKey(noList, key);
    expect(heldIntentKey(store, scope, 2_000, TTL, fresh)).toBe(key);
  });

  it('a press holds what was asked for with its key, so a remounted form can restore it', () => {
    const store = memoryStore();
    const key = heldIntentKey(store, 'remind:INV-1', 1_000, TTL, fresh);
    touchIntentKey(store, 'remind:INV-1', key, 2_000, 'whatsapp');
    expect(heldIntentKey(store, 'remind:INV-1', 3_000, TTL, fresh)).toBe(key);
    expect(heldIntentMeta(store, 'remind:INV-1', 3_000, TTL)).toBe('whatsapp');
    /* Nothing pressed yet, or the hold has lapsed: nothing to restore. */
    expect(heldIntentMeta(store, 'remind:INV-2', 3_000, TTL)).toBeNull();
    expect(heldIntentMeta(store, 'remind:INV-1', 2_000 + TTL + 1, TTL)).toBeNull();
  });

  it('a press long after the form opened restarts the hold, so its retry keeps the key', () => {
    const store = memoryStore();
    /* The form mounted at t=0 and sat open for longer than the hold. */
    const key = heldIntentKey(store, 'remind:INV-1', 0, TTL, fresh);
    const pressedAt = TTL + 60_000;
    touchIntentKey(store, 'remind:INV-1', key, pressedAt);
    /* The answer is lost; the boundary remounts the form a moment later. */
    expect(heldIntentKey(store, 'remind:INV-1', pressedAt + 5_000, TTL, fresh)).toBe(key);
  });

  it('touching never holds a value that is not a key', () => {
    const store = memoryStore();
    touchIntentKey(store, 'remind:INV-1', '', 1_000);
    expect(store.data.size).toBe(0);
  });
});
