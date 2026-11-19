/**
 * The outbound-webhook delivery meter (PR-112, spec §27's WEBHOOK_DELIVERIES): a delivery that
 * arrived is counted, a refused one is given back, and a fact is held rather than dropped when the
 * month is spent. Split from webhooks.integration.test.ts; setup is in webhooks.fixtures.ts.
 */
import { describe, expect, it } from 'vitest';
import { usageRepo, webhooksRepo, withBusiness } from '@rekoda/db';
import { usagePeriod } from '@rekoda/core';
import { settlementDb, creditBonusForTest } from '@rekoda/db/testing';
import { deliverWebhooks } from './delivery.sweep.js';
import { WebhookSendFailed } from './sender.js';
import {
  RecordingSender,
  VAULT_KEY,
  db,
  emit,
  fanOutOnce,
  onboard,
  post,
  useWebhooksHarness,
  workerDb,
} from './webhooks.fixtures.js';

useWebhooksHarness();

describe('the delivery meter', () => {
  /** Spend the endpoint's whole month, leaving nothing for the next fact. */
  async function drain(businessId: string): Promise<void> {
    await withBusiness(db, businessId, (tx) =>
      usageRepo.consumeUnit(
        tx,
        businessId,
        usagePeriod(new Date()),
        'WEBHOOK_DELIVERIES',
        100,
        100,
      ),
    );
  }

  it('counts a delivery that arrived (spec §27)', async () => {
    const shop = await onboard('+2348193000030', 'Counted Co');
    await post('/v1/webhooks', { url: 'https://metered.test/hook' }, shop.auth);
    await emit(shop.businessId, 'sale.recorded', {});
    await fanOutOnce();

    await deliverWebhooks({
      worker: workerDb,
      vaultKey: VAULT_KEY,
      sender: new RecordingSender(),
      planCatalogueReads: true,
    });

    const rows = await withBusiness(db, shop.businessId, (tx) =>
      usageRepo.usageFor(tx, shop.businessId, usagePeriod(new Date())),
    );
    expect(rows.find((row) => row.unit === 'WEBHOOK_DELIVERIES')?.used).toBe(1);
  });

  it('gives the unit back when the endpoint refused, so an outage is not billed', async () => {
    const shop = await onboard('+2348193000031', 'Refunded Co');
    await post('/v1/webhooks', { url: 'https://refunded.test/hook' }, shop.auth);
    await emit(shop.businessId, 'sale.recorded', {});
    await fanOutOnce();

    await deliverWebhooks({
      worker: workerDb,
      vaultKey: VAULT_KEY,
      planCatalogueReads: true,
      sender: new RecordingSender(() => new WebhookSendFailed('endpoint answered 500', 500)),
    });

    const rows = await withBusiness(db, shop.businessId, (tx) =>
      usageRepo.usageFor(tx, shop.businessId, usagePeriod(new Date())),
    );
    expect(rows.find((row) => row.unit === 'WEBHOOK_DELIVERIES')?.used).toBe(0);
  });

  it('holds the fact rather than dropping it when the month is spent', async () => {
    const shop = await onboard('+2348193000032', 'Spent Co');
    await post('/v1/webhooks', { url: 'https://spent.test/hook' }, shop.auth);
    await emit(shop.businessId, 'sale.recorded', {});
    await fanOutOnce();
    await drain(shop.businessId);

    const sender = new RecordingSender();
    const refused = await deliverWebhooks({
      worker: workerDb,
      vaultKey: VAULT_KEY,
      sender,
      planCatalogueReads: true,
    });
    expect(refused).toEqual({ sent: 0, failed: 1, dead: 0 });
    expect(sender.sent).toHaveLength(0);

    const log = await withBusiness(db, shop.businessId, (tx) =>
      webhooksRepo.deliveriesFor(tx, shop.businessId),
    );
    /* Still pending, with the reason readable: the merchant who buys
     * capacity inside the backoff still receives the fact. */
    expect(log[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(log[0]!.lastError).toContain('capacity');

    await withBusiness(settlementDb(), shop.businessId, (tx) =>
      creditBonusForTest(tx, shop.businessId, usagePeriod(new Date()), 'WEBHOOK_DELIVERIES', 10),
    );
    const after = await deliverWebhooks({
      worker: workerDb,
      vaultKey: VAULT_KEY,
      sender,
      planCatalogueReads: true,
      now: new Date(log[0]!.nextAttemptAt.getTime() + 1_000),
    });
    expect(after.sent).toBe(1);
  });
});
