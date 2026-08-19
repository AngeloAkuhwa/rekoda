/**
 * Payment Hub storage (docs/payments-v1.md §3–9), against real PostgreSQL.
 *
 * The claims here are about constraints and policies, not code paths: one
 * connection per provider per business, a globally unique reference decided
 * under concurrency, terminal intents that stay terminal against racing
 * updates, and a cross-tenant resolution that works for exactly one role.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paymentReference } from '@rekoda/core';
import { createDb, withBusiness, type Db } from './client.js';
import { identity, paymentsHub } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let appDb: Db;
let workerDb: Db;
let closeApp: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 8 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 4 }));
});

afterAll(async () => {
  await closeApp?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(name: string, phone: string): Promise<string> {
  const user = await identity.upsertUserByPhone(appDb, phone);
  const business = await identity.createBusinessWithOwner(appDb, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const ref = () => paymentReference(new Date(), (n) => randomBytes(n));

function intentInput(businessId: string, overrides: Partial<paymentsHub.IntentInput> = {}) {
  return {
    businessId,
    reference: ref(),
    expectedAmountK: 15_000_000,
    providerType: 'paystack',
    ...overrides,
  };
}

describe('connections', () => {
  it('keeps ONE connection per provider — reconnecting is a transition, not a second row', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348110000001');

    await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.upsertConnection(tx, {
        businessId,
        providerType: 'paystack',
        settlementBankCode: '058',
        settlementAccountLast4: '4821',
      }),
    );
    // Second attempt with a corrected account: same row, new details.
    const second = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.upsertConnection(tx, {
        businessId,
        providerType: 'paystack',
        settlementBankCode: '058',
        settlementAccountLast4: '7733',
      }),
    );

    expect(second.settlementAccountLast4).toBe('7733');
    const found = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.connectionFor(tx, businessId, 'paystack'),
    );
    // Two rows would be two settlement destinations with nobody able to say
    // which is live. The unique index makes that inexpressible.
    expect(found?.settlementAccountLast4).toBe('7733');
  });

  it('never shows one business another`s connection', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348110000001');
    const bola = await seedBusiness('Bola Electronics', '+2348110000002');
    await withBusiness(appDb, ada, (tx) =>
      paymentsHub.upsertConnection(tx, { businessId: ada, providerType: 'paystack' }),
    );

    expect(
      await withBusiness(appDb, bola, (tx) => paymentsHub.connectionFor(tx, bola, 'paystack')),
    ).toBeNull();
  });

  it('walks the §5 state machine and attaches provider identifiers', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348110000001');
    const connection = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.upsertConnection(tx, { businessId, providerType: 'paystack' }),
    );

    await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.setConnectionState(tx, connection.id, {
        status: 'active',
        kycStatus: 'verified',
        externalSubaccountId: 'ACCT_stub_1',
      }),
    );

    const found = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.connectionFor(tx, businessId, 'paystack'),
    );
    expect(found).toMatchObject({ status: 'active', externalSubaccountId: 'ACCT_stub_1' });
  });
});

describe('the reference is globally unique', () => {
  it('rejects the same reference even for a DIFFERENT business', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348110000001');
    const bola = await seedBusiness('Bola Electronics', '+2348110000002');
    const shared = ref();

    await withBusiness(appDb, ada, (tx) =>
      paymentsHub.createIntent(tx, intentInput(ada, { reference: shared })),
    );

    /**
     * Deliberately global, not per-business: the reference is what an
     * incoming transfer is matched BY, before its tenant is known. Two
     * businesses sharing one reference would make that resolution ambiguous
     * — which is the exact ambiguity references exist to remove.
     */
    await expect(
      withBusiness(appDb, bola, (tx) =>
        paymentsHub.createIntent(tx, intentInput(bola, { reference: shared })),
      ),
    ).rejects.toThrow(paymentsHub.ReferenceCollision);
  });

  it('lets exactly ONE of six concurrent mints win a colliding reference', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348110000001');
    const shared = ref();

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        withBusiness(appDb, businessId, (tx) =>
          paymentsHub.createIntent(tx, intentInput(businessId, { reference: shared })),
        ),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // And every loser gets the retryable error, not a generic crash.
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(paymentsHub.ReferenceCollision);
    }
  });
});

describe('terminal intents stay terminal', () => {
  it('refuses to resurrect an expired intent — a late webhook changes nothing', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348110000001');
    const intent = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.createIntent(tx, intentInput(businessId)),
    );

    expect(
      await withBusiness(appDb, businessId, (tx) =>
        paymentsHub.advanceIntent(tx, intent.id, 'expired'),
      ),
    ).toBe(true);

    // The same conditional-update shape as CG3: the WHERE clause is the
    // guard, so the loser learns it lost instead of overwriting the winner.
    expect(
      await withBusiness(appDb, businessId, (tx) =>
        paymentsHub.advanceIntent(tx, intent.id, 'succeeded'),
      ),
    ).toBe(false);

    const found = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.intentByReference(tx, businessId, intent.reference),
    );
    expect(found?.status).toBe('expired');
  });

  it('lets exactly one of six racing transitions take a live intent', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348110000001');
    const intent = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.createIntent(tx, intentInput(businessId)),
    );

    const wins = await Promise.all(
      Array.from({ length: 6 }, () =>
        withBusiness(appDb, businessId, (tx) =>
          paymentsHub.advanceIntent(tx, intent.id, 'succeeded'),
        ),
      ),
    );
    // Every racer moves live→succeeded; after the first lands the rest find a
    // terminal row. Exactly one duplicate-delivered webhook gets to be "the"
    // confirmation, which is what keeps receipts and postings single.
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it('expires overdue live intents and leaves the rest alone', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348110000001');
    const stale = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.createIntent(
        tx,
        intentInput(businessId, { expiresAt: new Date(Date.now() - 60_000) }),
      ),
    );
    const fresh = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.createIntent(
        tx,
        intentInput(businessId, { expiresAt: new Date(Date.now() + 3_600_000) }),
      ),
    );

    const expired = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.expireOverdueIntents(tx, businessId),
    );
    expect(expired).toBe(1);

    const staleRow = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.intentByReference(tx, businessId, stale.reference),
    );
    const freshRow = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.intentByReference(tx, businessId, fresh.reference),
    );
    expect(staleRow?.status).toBe('expired');
    expect(freshRow?.status).toBe('created');
  });
});

describe('cross-tenant resolution is a ROLE, not a code path', () => {
  it('resolves a reference on the worker connection', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348110000001');
    const intent = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.createIntent(tx, intentInput(businessId)),
    );

    const resolved = await paymentsHub.resolveIntentByReference(workerDb, intent.reference);
    expect(resolved).toMatchObject({ id: intent.id, businessId });
  });

  it('resolves NOTHING on the API connection — by policy, not by discipline', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348110000001');
    const intent = await withBusiness(appDb, businessId, (tx) =>
      paymentsHub.createIntent(tx, intentInput(businessId)),
    );

    /**
     * The load-bearing assertion. `worker_resolve` is a SELECT policy on the
     * worker ROLE; the API role, unpinned, matches no policy and sees no
     * rows. If this ever returns the intent, a request handler has gained a
     * cross-tenant read and every payment lookup in the API is suspect.
     */
    expect(await paymentsHub.resolveIntentByReference(appDb, intent.reference)).toBeNull();
  });
});
