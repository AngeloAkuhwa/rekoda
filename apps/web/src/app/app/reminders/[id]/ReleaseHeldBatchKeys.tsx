'use client';

import { useEffect } from 'react';
import { browserKeyStore, releaseIntentScopes } from '@/lib/intent-key';

/**
 * Renders nothing. On a batch page the batch exists (Confirm redirected here, or the merchant came
 * to view or cancel it), so the keys held for new-batch selections are released: picking the same
 * invoices, channels and time again makes a new batch instead of replaying this one.
 */
export function ReleaseHeldBatchKeys() {
  useEffect(() => {
    releaseIntentScopes(browserKeyStore(), 'batch:');
  }, []);
  return null;
}
