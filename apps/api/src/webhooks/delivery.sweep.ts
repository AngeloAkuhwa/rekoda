/**
 * Sending what fan-out queued (PR-112).
 *
 * The same shape as every other sweep on the worker: claim a leased batch,
 * do the slow thing outside any transaction, write the outcome. What makes
 * this one different is that the slow thing is a request to an address a
 * merchant chose, so every attempt is bounded, every failure is recorded on
 * the delivery it belongs to, and one endpoint's outage cannot delay
 * another's facts.
 *
 * A failed attempt is never lost and never retried forever: the backoff is
 * `@rekoda/core`'s, the ceiling is the row's `max_attempts`, and past it the
 * delivery is DEAD and visible — the same discipline the outbox keeps for
 * events it cannot deliver.
 */
import { Logger } from '@nestjs/common';
import { decryptFacet } from '@rekoda/core/vault';
import { nextAttemptAt, signWebhook, WEBHOOK_SIGNATURE_HEADER } from '@rekoda/core/webhooks';
import { publicApi } from '@rekoda/contracts';
import { usagePeriod } from '@rekoda/core';
import { usageRepo, webhooksRepo, withBusiness, type Db } from '@rekoda/db';
import { redactForLog } from '@rekoda/core/privacy';
import { WebhookSendFailed, type WebhookSender } from './sender.js';
import { meterAllowance } from '../billing/plan-terms.js';

const log = new Logger('WebhookDelivery');

export interface SweepResult {
  sent: number;
  failed: number;
  dead: number;
}

export async function deliverWebhooks(deps: {
  worker: Db;
  vaultKey: string;
  sender: WebhookSender;
  planCatalogueReads: boolean;
  batchSize?: number;
  now?: Date;
}): Promise<SweepResult> {
  const now = deps.now ?? new Date();
  const due = await webhooksRepo.claimDue(deps.worker, deps.batchSize ?? 25, now);
  const result: SweepResult = { sent: 0, failed: 0, dead: 0 };

  for (const delivery of due) {
    /* Serialised ONCE and signed over those exact bytes. Re-serialising for
     * the signature and again for the body is how a signature comes to
     * cover something the receiver never saw (the same raw-bytes rule the
     * inbound verifiers keep). */
    const body = JSON.stringify(
      publicApi.v1.webhookEvent.parse({
        id: delivery.id,
        type: delivery.eventType,
        businessId: delivery.businessId,
        occurredAt: now.toISOString(),
        attempt: delivery.attempts + 1,
        data: delivery.payload,
      }),
    );

    /* The month's capacity, taken BEFORE the send (spec §27's
     * WEBHOOK_DELIVERIES) and OUTSIDE the try, so the refund below can
     * belong to sends that were attempted and this refusal can be its own
     * path. Refused, it is an ordinary failed attempt rather than a lost
     * fact: the backoff spreads six attempts over more than a day, so a
     * merchant who buys capacity in that window still receives it, and one
     * who does not sees why in their delivery log. Dropping the fact
     * silently at a ceiling would be the platform deciding which of their
     * own events they may hear about. */
    const capacity = await withBusiness(deps.worker, delivery.businessId, async (tx) =>
      usageRepo.consumeUnit(
        tx,
        delivery.businessId,
        usagePeriod(now),
        'WEBHOOK_DELIVERIES',
        await meterAllowance(
          { planCatalogueReads: deps.planCatalogueReads },
          tx,
          delivery.businessId,
          await usageRepo.planFor(tx, delivery.businessId),
          'WEBHOOK_DELIVERIES',
        ),
      ),
    );
    if (!capacity) {
      const outcome = await webhooksRepo.markAttemptFailed(deps.worker, {
        id: delivery.id,
        status: null,
        error: "the month's webhook capacity is spent",
        nextAttemptAt: nextAttemptAt(delivery.attempts + 1, now),
      });
      if (outcome === 'dead') result.dead += 1;
      else result.failed += 1;
      continue;
    }

    try {
      const secret = decryptFacet(delivery.encryptedSecret, deps.vaultKey, delivery.endpointId);
      const sent = await deps.sender.send({
        url: delivery.url,
        body,
        headers: {
          [WEBHOOK_SIGNATURE_HEADER]: signWebhook(body, secret, now),
          'rekoda-event-type': delivery.eventType,
          'rekoda-delivery-id': delivery.id,
        },
      });
      await webhooksRepo.markDelivered(deps.worker, delivery.id, sent.status, now);
      result.sent += 1;
    } catch (error) {
      /* The unit is given back, the same rule the chat capture keeps: the
       * merchant's meter moves when the product worked, and a send that
       * failed did not. Only reachable for an attempt that TOOK a unit —
       * the capacity refusal above never enters this block. */
      await withBusiness(deps.worker, delivery.businessId, (tx) =>
        usageRepo.refundUnit(tx, delivery.businessId, usagePeriod(now), 'WEBHOOK_DELIVERIES'),
      );
      const status = error instanceof WebhookSendFailed ? error.status : null;
      const reason = error instanceof Error ? error.message : 'delivery failed';
      const outcome = await webhooksRepo.markAttemptFailed(deps.worker, {
        id: delivery.id,
        status,
        error: reason,
        nextAttemptAt: nextAttemptAt(delivery.attempts + 1, now),
      });
      if (outcome === 'dead') {
        result.dead += 1;
        /* Worth a warning rather than a debug line: a dead delivery is a
         * fact a merchant asked for and will never receive, and the log is
         * where an operator finds it before the merchant asks. */
        log.warn(
          `webhook ${delivery.eventType} gave up after ${delivery.attempts + 1} attempts: ` +
            redactForLog(reason),
        );
      } else {
        result.failed += 1;
      }
    }
  }

  return result;
}
