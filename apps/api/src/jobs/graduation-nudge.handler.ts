import { Logger } from '@nestjs/common';
import { replies, STARTER_CAP_K } from '@rekoda/core';
import { identity, type Db } from '@rekoda/db';
import type { ReplySender } from '../replies/reply.service.js';
import type { JobContext, JobHandler } from './runner.js';

export interface GraduationNudgeDeps {
  replySender: ReplySender;
  /** For the owner's WhatsApp number, a question that lives above the tenant. */
  db: Db;
}

/**
 * The one-time approaching-the-cap message (ADR 0019, fix-plan 6 M5d).
 *
 * By the time this runs the claim is already made: `claimGraduationNudge`
 * won inside the transaction that booked the crossing payment, so a retry
 * of this job can re-send at most THIS message, never mint a second
 * milestone. STOP is honoured the same conservative way the payment link
 * honours it — a milestone the merchant did not ask for is exactly what
 * that instruction covers, and the payments page carries the same fact.
 */
export function graduationNudgeHandler(deps: GraduationNudgeDeps): JobHandler {
  const log = new Logger('GraduationNudgeJob');

  return async ({ tx, payload, businessId }: JobContext): Promise<void> => {
    const collectedK = typeof payload['collectedK'] === 'number' ? payload['collectedK'] : null;
    if (!collectedK) throw new Error('graduation.nudge: payload is missing collectedK');

    const to = await identity.ownerPhoneFor(deps.db, businessId);
    if (!to) throw new Error('graduation.nudge: business has no owner to send to');
    if (await identity.optedOutAt(deps.db, to)) {
      log.log('graduation nudge suppressed: the owner has opted out of messages');
      return;
    }

    await deps.replySender.send(tx, {
      businessId,
      to,
      reply: replies.graduationNudge(collectedK, STARTER_CAP_K),
    });
  };
}
