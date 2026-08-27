import { Logger } from '@nestjs/common';
import { replies } from '@rekoda/core';
import { contactKeyFor } from '@rekoda/core/vault';
import { normalisePhone } from '@rekoda/core/identity';
import { extractInboundEvents, metaWebhookBody } from '@rekoda/contracts';
import { events, type Db } from '@rekoda/db';
import { openPayload } from '../privacy/payload-vault.js';
import type { MessageSender } from './sender.js';

export interface StrangerSweepDeps {
  /** `rekoda_worker` — unattributed events belong to no tenant by definition. */
  workerDb: Db;
  sender: MessageSender;
  vaultKey: string;
  matchKey: string;
  /** Rekoda's own Chat number id; '' when the deployment has not pinned one. */
  metaPhoneNumberId: string;
}

/**
 * Answer someone who messaged Rekoda and is not a merchant yet.
 *
 * An unattributed message cannot become a job: `jobs.business_id` is NOT NULL
 * precisely so that "run this for nobody" is unrepresentable. So it becomes a
 * sweep instead, riding the worker beside the attribution pump.
 *
 * Silence was the alternative and it is the wrong one. Somebody messaging a
 * business number expects an answer, and this is the first impression of a
 * product whose whole pitch is "it replies like a person".
 *
 * Two guards keep it from becoming spam:
 *   - one reply per number per day, claimed with a conditional UPDATE so two
 *     workers racing produce one message;
 *   - the event is marked processed either way, so a backlog is worked
 *     through once and never re-answered.
 */
export async function sweepUnknownSenders(deps: StrangerSweepDeps, limit = 25): Promise<number> {
  const log = new Logger('StrangerSweep');
  let answered = 0;

  /* Pages until drained. Every handled event is marked processed and leaves
   * the set; a page whose FIRST row is the same one as last time means
   * something in it will not mark (an unopenable seal, say) and looping on
   * it would spin, so the pass stops and the next tick tries again. */
  let lastFirstId: string | null = null;
  for (;;) {
    const pending = await events.unattributedEvents(deps.workerDb, 'meta', limit);
    if (pending.length === 0) break;
    if (pending[0]!.id === lastFirstId) break;
    lastFirstId = pending[0]!.id;

    for (const event of pending) {
      /* Status callbacks carry nobody to answer. Marked handled with NO reason:
       * `error` is what the ops health surface counts as the exception queue,
       * and an ordinary delivery receipt is not an exception. */
      if (!event.eventType.startsWith('message.')) {
        await events.markProcessed(deps.workerDb, event.id);
        continue;
      }

      const opened = senderOf(event.payload, deps.vaultKey, event.externalId);
      if (!opened) {
        await events.markProcessed(deps.workerDb, event.id, 'no_sender');
        continue;
      }
      const { from, phoneNumberId } = opened;

      /**
       * A message that arrived on somebody's WABA is NOT a stranger writing
       * to Rekoda — it is a customer of a merchant whose connection we do
       * not hold (PR-059 refused to route it). Greeting them with a Rekoda
       * signup pitch, from a number they never messaged, would be spam
       * wearing the wrong relationship. Marked with a reason so the
       * exception queue counts what the refusal left behind.
       */
      if (phoneNumberId && deps.metaPhoneNumberId && phoneNumberId !== deps.metaPhoneNumberId) {
        await events.markProcessed(deps.workerDb, event.id, 'foreign_waba');
        continue;
      }

      /* Marked BEFORE the send: a Meta outage must not leave the event pending
       * for the next pass to answer again. A stranger who hears nothing because
       * we were down can message again; one who gets the same greeting every
       * twenty seconds cannot make it stop.
       *
       * No reason recorded, again: somebody without an account messaging the
       * number is the ordinary case this sweep exists for, and counting it as
       * an exception would bury the real ones under it. */
      await events.markProcessed(deps.workerDb, event.id);

      const claimed = await events.claimStrangerReply(
        deps.workerDb,
        contactKeyFor(from, deps.matchKey),
      );
      if (!claimed) continue;

      try {
        await deps.sender.send({ to: from, text: replies.noAccount().text });
        answered += 1;
      } catch {
        // The number is not ours to retry against and the event is already
        // marked. Logged without the number, like everything else here.
        log.warn('could not answer an unknown sender');
      }
    }

    if (pending.length < limit) break;
  }

  return answered;
}

/** The sender and receiving number from a sealed payload, or null. */
function senderOf(
  payload: unknown,
  vaultKey: string,
  externalId: string,
): { from: string; phoneNumberId: string | null } | null {
  let opened: unknown;
  try {
    opened = openPayload(payload, vaultKey, 'meta', externalId);
  } catch {
    return null;
  }
  const parsed = metaWebhookBody.safeParse(opened);
  if (!parsed.success) return null;
  const [inbound] = extractInboundEvents(parsed.data);
  if (!inbound || inbound.kind !== 'message') return null;
  try {
    return { from: normalisePhone(inbound.from), phoneNumberId: inbound.phoneNumberId };
  } catch {
    return null;
  }
}
