import { Inject, Injectable } from '@nestjs/common';
import { jobsRepo, withBusiness, type Db, type TenantDb } from '@rekoda/db';
import { DB } from '../db/db.module.js';

/** The kinds this application knows how to run. */
export const JobKind = {
  /** An inbound WhatsApp message has been stored and needs understanding. */
  InboundMessage: 'inbound.message',
  /** An issued invoice needs its PDF rendered and stored. */
  RenderDocument: 'document.render',
  /** A stored PDF needs to reach the merchant. */
  DeliverDocument: 'document.deliver',
  /** An attributed provider event needs verifying and (maybe) booking. */
  ProcessPaymentEvent: 'payment.process',
  /**
   * A merchant paid REKODA, not their customer.
   *
   * Its own kind rather than a branch inside `payment.process`, because the
   * two must never share a code path: one books into the merchant's ledger
   * and the other must never touch it.
   */
  ProcessBillingCharge: 'billing.process',
  /**
   * An invoice that has just been raised needs a payable link.
   *
   * A job rather than part of the confirmation, because minting one reads an
   * invoice that the confirming transaction has not committed yet and talks
   * to a provider over HTTP. Same reason `document.render` is a job.
   */
  PaymentLink: 'payment.link',
} as const;

export type JobKindName = (typeof JobKind)[keyof typeof JobKind];

export interface EnqueueRequest {
  businessId: string;
  kind: JobKindName;
  payload?: Record<string, unknown>;
  singletonKey?: string | null;
  delayMs?: number;
}

/**
 * Enqueueing runs under the ordinary application role and an ordinary tenant
 * pin — the `jobs` table's `tenant_isolation` policy applies to the API
 * exactly as it does to `invoices`. Only the runner's claim path is
 * privileged, and only for reading.
 */
@Injectable()
export class JobQueue {
  constructor(@Inject(DB) private readonly db: Db) {}

  async enqueue(request: EnqueueRequest): Promise<{ id: string } | null> {
    return withBusiness(this.db, request.businessId, (tx) => jobsRepo.enqueue(tx, request));
  }

  /**
   * Enqueue inside a transaction the caller already owns.
   *
   * This is the form the transaction engine will use: the document, its ledger
   * entries and "render and deliver this" become one atomic unit, so there is
   * no window where a document exists that nothing will ever send.
   */
  async enqueueWithin(tx: TenantDb, request: EnqueueRequest): Promise<{ id: string } | null> {
    return jobsRepo.enqueue(tx, request);
  }
}
