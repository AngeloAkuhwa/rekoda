/**
 * The object-deletion drain's account of itself (R13, PR-136): it says what it did and stops when it
 * should. Split from retention-sweep.integration.test.ts, which pins the sweep's stages.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, objectDeletionsRepo, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { drainObjectDeletions } from './retention-sweep.js';
import type { DocumentStorage, StoredObject } from '../documents/storage.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 4 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

/** A business whose objects are queued for deletion. */
async function aBusiness(): Promise<{ businessId: string }> {
  const user = await identity.upsertUserByPhone(appDb, '+2348170000001');
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return { businessId: business.id };
}

/** A storage port that remembers which keys the drain asked to delete. */
class RecordingStorage implements DocumentStorage {
  readonly deleted: string[] = [];

  put(): Promise<StoredObject> {
    throw new Error('not used');
  }

  get(): Promise<Buffer | null> {
    return Promise.resolve(null);
  }

  delete(key: string): Promise<void> {
    this.deleted.push(key);
    return Promise.resolve();
  }
}

describe('the drain says what it did, and stops when it should (R13)', () => {
  const queue = (businessId: string, keys: string[]) =>
    withBusiness(appDb, businessId, (tx) =>
      objectDeletionsRepo.enqueueObjectDeletions(tx, businessId, keys, 'business_deleted'),
    );

  it('keeps going past one batch until the queue is empty', async () => {
    /* The drain used to take exactly 200 and stop. A merchant deleting an
     * account with more objects than that waited SIX HOURS per batch for the
     * rest, while the privacy page says the objects go with the records.
     * 250 is the smallest number that proves the loop: one batch of 200
     * would leave 50 behind. */
    const { businessId } = await aBusiness();
    const keys = Array.from({ length: 250 }, (_, i) => `documents/x/invoice_pdf/${i}.pdf`);
    await queue(businessId, keys);
    const storage = new RecordingStorage();

    const result = await drainObjectDeletions({ workerDb, storage });

    expect(result.deleted).toBe(250);
    expect(result.batches).toBe(2);
    expect(result.stoppedBecause).toBe('drained');
    expect(result.outstanding).toBe(0);
    expect(storage.deleted).toHaveLength(250);
  });

  it('counts an object that IS gone as deleted, even when its row survives', async () => {
    /* The dishonest case. The provider deleted the object; only the
     * bookkeeping failed. Reporting that as `failed` tells an operator the
     * promise is unkept when it has been kept, and makes `outstanding` wrong
     * in the reassuring direction. */
    const { businessId } = await aBusiness();
    await queue(businessId, ['documents/x/invoice_pdf/gone.pdf']);
    const storage = new RecordingStorage();

    /* A worker connection whose row DELETE fails while everything else on it
     * works: the narrowest way to produce the split the item describes. */
    const brittle = new Proxy(workerDb, {
      get(target, prop, receiver) {
        if (prop !== 'execute') return Reflect.get(target, prop, receiver);
        return (query: unknown) => {
          const text = JSON.stringify(query);
          if (text.includes('DELETE FROM pending_object_deletions')) {
            return Promise.reject(new Error('row delete refused'));
          }
          return (target as Db).execute(query as never);
        };
      },
    });

    const result = await drainObjectDeletions({ workerDb: brittle as Db, storage });

    /* The object went. That is the fact the count must carry. */
    expect(storage.deleted).toEqual(['documents/x/invoice_pdf/gone.pdf']);
    expect({
      deleted: result.deleted,
      failed: result.failed,
      rowsLeftBehind: result.rowsLeftBehind,
    }).toEqual({ deleted: 1, failed: 0, rowsLeftBehind: 1 });
  });

  it('does not re-count a row it already handled in the same pass', async () => {
    /* The trap in the batching. A row whose object went but whose row delete
     * failed keeps its past `run_at`, so the next batch reads it straight
     * back. Without the pass remembering what it handled, the drain would
     * re-delete an absent object and count it again every batch, reporting
     * deletions that never happened. */
    const { businessId } = await aBusiness();
    await queue(businessId, ['documents/x/invoice_pdf/sticky.pdf']);
    const storage = new RecordingStorage();
    const brittle = new Proxy(workerDb, {
      get(target, prop, receiver) {
        if (prop !== 'execute') return Reflect.get(target, prop, receiver);
        return (query: unknown) => {
          const text = JSON.stringify(query);
          if (text.includes('DELETE FROM pending_object_deletions')) {
            return Promise.reject(new Error('row delete refused'));
          }
          return (target as Db).execute(query as never);
        };
      },
    });

    const result = await drainObjectDeletions({ workerDb: brittle as Db, storage });

    /* Once. Not twenty-five times, which is what maxBatches would have
     * allowed if the pass had no memory. */
    expect(result.deleted).toBe(1);
    expect(result.batches).toBe(1);
    expect(storage.deleted).toEqual(['documents/x/invoice_pdf/sticky.pdf']);
  });
});
