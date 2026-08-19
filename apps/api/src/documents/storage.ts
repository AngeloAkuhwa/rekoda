import { randomBytes } from 'node:crypto';

/**
 * Where a rendered document lives (MASTER-PLAN §5.3.6, ADR 0006).
 *
 * The database holds the KEY, never the blob. A 40 kB PDF per invoice would
 * turn an append-heavy financial database into a file server: every backup,
 * every replica and every `pg_dump` would carry every document a merchant has
 * ever issued, and none of that is what PostgreSQL is good at.
 */
export interface StoredObject {
  key: string;
  bytes: number;
}

export interface DocumentStorage {
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  /** For the authorised download path, and for tests to prove what was stored. */
  get(key: string): Promise<Buffer | null>;
}

/**
 * An unguessable key, scoped to a business.
 *
 * The business id prefix is for operations — expiring one merchant's documents,
 * or answering an erasure request — and it is NOT what makes the key secret.
 * That is the 128 random bits after it.
 *
 * Sequential or derivable keys (`invoices/INV-2026-000001.pdf`) would let
 * anyone holding one document's URL walk a merchant's entire sales history by
 * counting, which is the same mistake as a bare-sequential lookup on the public
 * `/verify` page (ADR 0014).
 */
export function documentKey(businessId: string, kind: string, extension = 'pdf'): string {
  return `documents/${businessId}/${kind}/${randomBytes(16).toString('hex')}.${extension}`;
}

export class StorageUnavailable extends Error {
  override readonly name = 'StorageUnavailable';
}
