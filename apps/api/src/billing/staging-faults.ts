/**
 * One-shot staging send faults (G-119 / OWN-77), for the acceptance steps that need a reminder's
 * send to time out or the WhatsApp sender to refuse for one sweep (walkthrough 19).
 *
 * Called by the grace and trial-notice sweeps immediately before the provider call, ONLY when the
 * deployment's staging flag is on; otherwise it returns without touching the database, so
 * production carries no fault path at all. An armed fault is consumed by exactly one send for its
 * business (`stagingToolsRepo.consumeFault`, under SKIP LOCKED) and then behaves exactly as the real
 * failure would, so the sweep's own handling is what is exercised:
 *   send_timeout   -> SendFailed with an unknown outcome (as a dropped connection): never resent;
 *   sender_refused -> SendFailed definitely not sent, transient, sender-wide: retried next pass.
 */
import { stagingToolsRepo, withBusiness, type Db } from '@rekoda/db';
import { SendFailed } from '../channels/sender.js';

export async function applyStagingFault(
  appDb: Db,
  businessId: string,
  enabled: boolean | undefined,
): Promise<void> {
  if (!enabled) return;
  const kind = await withBusiness(appDb, businessId, (tx) =>
    stagingToolsRepo.consumeFault(tx, businessId),
  );
  if (kind === 'send_timeout') {
    throw new SendFailed('staging fault: the send timed out', null, false);
  }
  if (kind === 'sender_refused') {
    throw new SendFailed('staging fault: the WhatsApp sender refused', null, true, true, true);
  }
}
