'use client';

import { useEffect } from 'react';
import { browserKeyStore, releaseHeldKey } from '@/lib/intent-key';

/**
 * Renders nothing. Shown only when the batch page is reached from a Confirm redirect, which names
 * the key that Confirm carried. The batch exists, so the selection holding exactly that key is
 * released, and picking the same invoices, channels and time again makes a new batch. Opening a
 * batch from the list, or going Back to an earlier landing, releases nothing that belongs to a
 * different Confirm, because a key is matched, not a shared slot.
 */
export function ReleaseHeldBatchKeys({ confirmedKey }: { confirmedKey: string }) {
  useEffect(() => {
    releaseHeldKey(browserKeyStore(), confirmedKey);
    /* Take the key out of the address too, so a shared or bookmarked link carries nothing. */
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('new');
      /* `null`, as Next documents: the router then adopts the new address. */
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch {
      /* The address keeps the key; releasing it again is harmless. */
    }
  }, [confirmedKey]);
  return null;
}
