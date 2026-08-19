/**
 * Attribution (docs/payments-v1.md §20, step "resolve intent").
 *
 * Paystack events land UNATTRIBUTED — the webhook endpoint deliberately
 * cannot answer "whose money is this", because the answer is a cross-tenant
 * read (`worker_resolve`, migration 0010) that only the worker role holds.
 * This pump is that role doing that job, and nothing else:
 *
 *   read unattributed events → open the seal → find the reference
 *   → resolve it to an intent → stamp the business → enqueue processing
 *
 * No verification, no booking, no judgement here. An event that resolves gets
 * a `payment.process` job pinned to its business, where every later step runs
 * under the same row-level security as a request. An event that cannot
 * resolve is marked with WHY — those marks are the admin exception queue.
 *
 * Attribution is write-once (`attributeEvent`'s NULL predicate) and the job
 * is singleton-keyed on the event id, so two pumps racing produce one job.
 */
import { Logger } from '@nestjs/common';
import { PAYMENT_REFERENCE_PATTERN } from '@rekoda/core';
import { paystackWebhookBody, summarisePaystackEvent } from '@rekoda/contracts';
import { events, jobsRepo, paymentsHub, withBusiness, type Db } from '@rekoda/db';
import { openPayload } from '../privacy/payload-vault.js';
import { JobKind } from '../jobs/queue.service.js';

export interface PumpDeps {
  /** `rekoda_worker` — the only role that can resolve across tenants. */
  workerDb: Db;
  /** `rekoda_app` — jobs are enqueued under an ordinary tenant pin. */
  appDb: Db;
  vaultKey: string;
}

const log = new Logger('PaystackPump');

/** One pass. Returns how many events became jobs. */
export async function pumpPaystackEvents(deps: PumpDeps, limit = 50): Promise<number> {
  const pending = await events.unattributedEvents(deps.workerDb, 'paystack', limit);
  let enqueued = 0;

  for (const event of pending) {
    const reference = referenceOf(event.payload, deps.vaultKey);

    if (!reference) {
      // Signed, stored, and carrying no payment reference — a transfer
      // notification, a subscription event. Not this pipeline's work.
      await events.markProcessed(deps.workerDb, event.id, 'no_payment_reference');
      continue;
    }
    if (!PAYMENT_REFERENCE_PATTERN.test(reference)) {
      // A reference, but not OURS — somebody else's traffic on a shared
      // Paystack account, or a manual dashboard charge. Recorded, not ours.
      await events.markProcessed(deps.workerDb, event.id, 'foreign_reference');
      continue;
    }

    const intent = await paymentsHub.resolveIntentByReference(deps.workerDb, reference);
    if (!intent) {
      // Shaped like ours, resolving to nothing. The §37 "unknown reference"
      // case, and the one that most deserves a human's eyes.
      await events.markProcessed(deps.workerDb, event.id, 'unknown_reference');
      log.warn('a Paystack event carried a Rekoda-shaped reference with no intent');
      continue;
    }

    const attributed = await events.attributeEvent(deps.workerDb, event.id, intent.businessId);
    if (!attributed) continue; // another pump won this event

    await withBusiness(deps.appDb, intent.businessId, (tx) =>
      jobsRepo.enqueue(tx, {
        businessId: intent.businessId,
        kind: JobKind.ProcessPaymentEvent,
        payload: { eventId: event.id },
        singletonKey: `payevent:${event.id}`,
      }),
    );
    enqueued += 1;
  }

  return enqueued;
}

function referenceOf(payload: unknown, vaultKey: string): string | null {
  try {
    const parsed = paystackWebhookBody.safeParse(openPayload(payload, vaultKey));
    if (!parsed.success) return null;
    return summarisePaystackEvent(parsed.data).reference;
  } catch {
    // A seal that will not open is a configuration problem, not this event's.
    return null;
  }
}
