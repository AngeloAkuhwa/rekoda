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
  /**
   * Delete an object, for the erasure and retention paths (PR-136).
   *
   * MUST be idempotent: a key that is already gone is a success, not an
   * error. The queue that drives this retries on failure, so a provider that
   * reported "no such key" as a failure would keep a promise permanently
   * unkeepable, and an operator would be staring at a backlog of work that
   * was in fact already done.
   *
   * The bytes do not come back. Callers reach this only after the row that
   * named the object has been deleted and committed.
   */
  delete(key: string): Promise<void>;
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

/**
 * Write, read back, compare and delete one object (G-40).
 *
 * The only thing that proves a bucket, its credentials and the delete
 * permission work TOGETHER is doing all three against it; every other check
 * (the config parser, the SDK constructing a client) passes with a revoked key.
 * Run it from the staging checklist before J3's receipt is expected to be
 * stored. The key is under `probe/`, unguessable, and removed again; a failure
 * names the step so an operator knows whether to look at the key, the bucket
 * policy or the network.
 */
export async function probeStorage(storage: DocumentStorage): Promise<void> {
  const key = `probe/${randomBytes(16).toString('hex')}.txt`;
  const body = Buffer.from(`rekoda storage probe ${randomBytes(8).toString('hex')}`);

  try {
    await storage.put(key, body, 'text/plain');
  } catch (error) {
    throw new StorageUnavailable(`storage probe: write failed (${errorName(error)})`);
  }

  let readBack: Buffer | null;
  try {
    readBack = await storage.get(key);
  } catch (error) {
    await bestEffortDelete(storage, key);
    throw new StorageUnavailable(`storage probe: read failed (${errorName(error)})`);
  }
  if (!readBack || !readBack.equals(body)) {
    await bestEffortDelete(storage, key);
    throw new StorageUnavailable('storage probe: the object read back is not the object written');
  }

  try {
    await storage.delete(key);
  } catch (error) {
    throw new StorageUnavailable(`storage probe: delete failed (${errorName(error)})`);
  }
  let afterDelete: Buffer | null;
  try {
    afterDelete = await storage.get(key);
  } catch (error) {
    throw new StorageUnavailable(
      `storage probe: confirming the delete failed (${errorName(error)})`,
    );
  }
  if (afterDelete !== null) {
    throw new StorageUnavailable('storage probe: the object is still readable after delete');
  }
}

/** The class of failure, never its message, which a provider may fill with request detail. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

async function bestEffortDelete(storage: DocumentStorage, key: string): Promise<void> {
  try {
    await storage.delete(key);
  } catch {
    /* The probe is already failing; a leftover probe object is the lesser harm. */
  }
}
