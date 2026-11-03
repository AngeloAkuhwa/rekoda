'use client';

import { useEffect } from 'react';
import { browserKeyStore, releaseConfirmedBatch } from '@/lib/intent-key';

/**
 * Renders nothing. Shown only when the batch page is reached from a Confirm redirect: the batch
 * exists, so the key held for the confirmed selection is released, and picking the same invoices,
 * channels and time again makes a new batch. Opening a batch from the list releases nothing, so a
 * lost Confirm answer for another selection keeps its key for the retry.
 */
export function ReleaseHeldBatchKeys() {
  useEffect(() => {
    releaseConfirmedBatch(browserKeyStore());
    /* Spend the marker in the address too: going Back to this entry later must not release the
     * key of a Confirm still waiting for its answer. */
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('new');
      /* `null`, as Next documents: the router then adopts the new address. Passing its own
       * history state back would bypass it, and a later refresh could restore new=1. */
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch {
      /* The address keeps `new=1`; the marker is already spent, so a revisit releases nothing. */
    }
  }, []);
  return null;
}
