/**
 * Addresses Rekoda must not mail (N7 slice 2, migration 0179).
 *
 * Pins: a suppression is found by its hash and by nothing else; recording the same address
 * twice keeps the first row (idempotent, so a replayed webhook changes nothing); the API
 * role may insert and read but not rewrite or delete; the worker role has no access; and the
 * table keeps no address, only a 64-hex hash.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emailSuppressionKey } from '@rekoda/core';
import postgres from 'postgres';
import { createDb, emailSuppressionsRepo, type Db } from '../index.js';
import { migrate, requireUrls, truncateAll, type Urls } from '../testing.js';

let urls: Urls;
let app: Db;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  const asApp = createDb(urls.app, { max: 2 });
  app = asApp.db;
  closeApp = asApp.close;
});

afterAll(async () => {
  await closeApp();
});

beforeEach(async () => {
  await truncateAll(urls);
});

describe('email suppressions', () => {
  it('finds a suppressed address by its normalised hash and no other', async () => {
    const hash = emailSuppressionKey('  Owner@Example.COM ');
    await emailSuppressionsRepo.suppress(app, {
      addressHash: hash,
      reason: 'bounced',
      providerEventId: 'msg_1',
    });
    expect(
      await emailSuppressionsRepo.isSuppressed(app, emailSuppressionKey('owner@example.com')),
    ).toBe(true);
    expect(
      await emailSuppressionsRepo.isSuppressed(app, emailSuppressionKey('other@example.com')),
    ).toBe(false);
  });

  it('keeps the first row when the same address is recorded again', async () => {
    const addressHash = emailSuppressionKey('a@example.com');
    await emailSuppressionsRepo.suppress(app, {
      addressHash,
      reason: 'bounced',
      providerEventId: 'msg_1',
    });
    await emailSuppressionsRepo.suppress(app, {
      addressHash,
      reason: 'complained',
      providerEventId: 'msg_2',
    });
    const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
    try {
      const rows = await owner`SELECT reason, provider_event_id FROM email_suppressions`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ reason: 'bounced', provider_event_id: 'msg_1' });
    } finally {
      await owner.end();
    }
  });

  it('refuses anything but a 64-hex hash, so an address cannot be stored here', async () => {
    await expect(
      emailSuppressionsRepo.suppress(app, {
        addressHash: 'owner@example.com',
        reason: 'bounced',
        providerEventId: null,
      }),
    ).rejects.toThrow();
  });

  it('lets the API role insert and read but not rewrite or delete, and shuts the worker out', async () => {
    const addressHash = emailSuppressionKey('a@example.com');
    await emailSuppressionsRepo.suppress(app, {
      addressHash,
      reason: 'bounced',
      providerEventId: null,
    });
    const asApp = postgres(urls.app, { max: 1, onnotice: () => {} });
    const asWorker = postgres(urls.worker, { max: 1, onnotice: () => {} });
    try {
      await expect(asApp`UPDATE email_suppressions SET reason = 'complained'`).rejects.toThrow(
        /permission denied/,
      );
      await expect(asApp`DELETE FROM email_suppressions`).rejects.toThrow(/permission denied/);
      await expect(asWorker`SELECT 1 FROM email_suppressions`).rejects.toThrow(/permission denied/);
    } finally {
      await asApp.end();
      await asWorker.end();
    }
  });
});
