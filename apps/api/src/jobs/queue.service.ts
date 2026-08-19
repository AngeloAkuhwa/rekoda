import { Inject, Injectable } from '@nestjs/common';
import { jobsRepo, withBusiness, type Db, type TenantDb } from '@rekoda/db';
import { DB } from '../db/db.module.js';

/** The kinds this application knows how to run. */
export const JobKind = {
  /** An inbound WhatsApp message has been stored and needs understanding. */
  InboundMessage: 'inbound.message',
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
