/**
 * The plan catalogue (BL2, PR-099), against real PostgreSQL: version 1 is
 * the TypeScript constants verbatim, a price change appends and never
 * rewrites, a pinned business keeps the version it was sold, and the
 * application role cannot write any of it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PLAN_ALLOWANCES,
  PLAN_ENTITLEMENTS,
  PLAN_PRICES_K,
  SEATS_PER_PLAN,
  USAGE_UNITS,
  type PlanId,
} from '@rekoda/core';
import {
  createDb,
  identity,
  planCatalogueRepo,
  sql,
  subscriptionsRepo,
  withBusiness,
  type Db,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let ownerDb: Db;
let close: () => Promise<void>;
let closeOwner: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 4 }));
  ({ db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 2 }));
});

afterAll(async () => {
  await close?.();
  await closeOwner?.();
});

/**
 * The catalogue is deliberately NOT in truncateAll: it is reference data the
 * migration seeds once, like the entitlements catalogue. Tests that version
 * it therefore put it back: successor versions go, appended price rows go,
 * and every seed row reopens.
 */
async function resetCatalogue(): Promise<void> {
  await ownerDb.execute(sql`
    DELETE FROM plan_version_entitlements
    WHERE plan_version_id IN (SELECT id FROM plan_versions WHERE version > 1)
  `);
  await ownerDb.execute(sql`
    DELETE FROM allowance_versions
    WHERE plan_version_id IN (SELECT id FROM plan_versions WHERE version > 1)
  `);
  await ownerDb.execute(sql`
    DELETE FROM plan_prices
    WHERE plan_version_id IN (SELECT id FROM plan_versions WHERE version > 1)
  `);
  await ownerDb.execute(sql`DELETE FROM plan_versions WHERE version > 1`);
  await ownerDb.execute(sql`
    DELETE FROM plan_prices p
    USING plan_versions v
    WHERE v.id = p.plan_version_id AND p.effective_from <> v.effective_from
  `);
  await ownerDb.execute(sql`UPDATE plan_prices SET effective_to = NULL`);
  await ownerDb.execute(sql`UPDATE plan_versions SET effective_to = NULL`);
}

beforeEach(async () => {
  await truncateAll(urls);
  await resetCatalogue();
});

let seq = 0;
async function seedBusiness(plan: string): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481920${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  await ownerDb.execute(sql`
    UPDATE businesses SET plan = ${plan} WHERE id = ${business.id}::uuid
  `);
  return business.id;
}

/** Drizzle wraps the driver error; the Postgres code rides the cause chain. */
function pgCode(error: unknown): string | undefined {
  let cursor = error as { code?: string; cause?: unknown } | undefined;
  while (cursor) {
    if (cursor.code) return cursor.code;
    cursor = cursor.cause as { code?: string; cause?: unknown } | undefined;
  }
  return undefined;
}

const PLAN_IDS: PlanId[] = ['trial', 'expired', 'chat', 'integrate', 'complete'];

describe('the plan catalogue (BL2, PR-099)', () => {
  it('seeds version 1 as the constants, verbatim', async () => {
    const now = new Date();
    for (const planId of PLAN_IDS) {
      const version = await planCatalogueRepo.planVersionAt(db, planId, now);
      expect(version, planId).not.toBeNull();
      expect(version!.version, planId).toBe(1);
      expect(version!.effectiveTo, planId).toBeNull();
      expect(version!.seats, planId).toBe(SEATS_PER_PLAN[planId]);

      /* Entitlements: the PR-012 map, sorted. */
      const held = await planCatalogueRepo.entitlementsOf(db, version!.id);
      expect(held, planId).toEqual([...PLAN_ENTITLEMENTS[planId]].sort());

      /* Allowances: every one of the seventeen units agrees, with absence
       * reading as zero. This is the parity PR-100's cutover stands on. */
      const sold = await planCatalogueRepo.allowancesOf(db, version!.id);
      for (const unit of USAGE_UNITS) {
        expect(sold[unit] ?? 0, `${planId} ${unit}`).toBe(PLAN_ALLOWANCES[planId][unit]);
      }

      /* Prices: monthly is PLAN_PRICES_K; annual is pricing-model.md's ten
       * times monthly on the paid plans, and unpriced on the unbilled ones. */
      const monthly = await planCatalogueRepo.priceAt(db, version!.id, 'NGN', 'monthly', now);
      expect(monthly, planId).toBe(PLAN_PRICES_K[planId]);
      const annual = await planCatalogueRepo.priceAt(db, version!.id, 'NGN', 'annual', now);
      expect(annual, planId).toBe(PLAN_PRICES_K[planId] > 0 ? PLAN_PRICES_K[planId] * 10 : null);
    }
  });

  it('answers null, not zero, for a currency nobody priced', async () => {
    const version = await planCatalogueRepo.planVersionAt(db, 'complete', new Date());
    const usd = await planCatalogueRepo.priceAt(db, version!.id, 'USD', 'monthly', new Date());
    expect(usd).toBeNull();
  });

  it('a price change does not alter a historical charge', async () => {
    const businessId = await seedBusiness('chat');
    const soldAt = new Date('2026-08-15T09:00:00Z');
    const chatV1 = await planCatalogueRepo.planVersionAt(db, 'chat', soldAt);
    const soldPrice = await planCatalogueRepo.priceAt(db, chatV1!.id, 'NGN', 'monthly', soldAt);
    expect(soldPrice).toBe(990_000);

    /* The charge the merchant actually paid, at the price then in force. */
    await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.openCharge(tx, {
        businessId,
        kind: 'renewal',
        amountK: soldPrice!,
        reference: 'chg-grandfather-1',
        plan: 'chat',
      }),
    );

    /* Rekoda reprices Chat. Same version - what it sells is unchanged. */
    const repricedAt = new Date('2026-08-27T00:00:00Z');
    await planCatalogueRepo.changePlanPrice(ownerDb, {
      planVersionId: chatV1!.id,
      currency: 'NGN',
      billingInterval: 'monthly',
      amountMinor: 1_190_000,
      from: repricedAt,
    });

    /* The new price answers from the repricing moment forward... */
    expect(await planCatalogueRepo.priceAt(db, chatV1!.id, 'NGN', 'monthly', new Date())).toBe(
      1_190_000,
    );
    /* ...and the moment the charge was computed still answers what it did:
     * the old row was closed, never rewritten. */
    expect(await planCatalogueRepo.priceAt(db, chatV1!.id, 'NGN', 'monthly', soldAt)).toBe(990_000);

    const charge = await withBusiness(db, businessId, (tx) =>
      subscriptionsRepo.chargeByReference(tx, businessId, 'chg-grandfather-1'),
    );
    expect(charge!.amountK).toBe(990_000);
  });

  it('a grandfathered business keeps its pinned plan version', async () => {
    const grandfathered = await seedBusiness('chat');
    const floating = await seedBusiness('chat');
    const v1 = await planCatalogueRepo.planVersionAt(db, 'chat', new Date());

    /* The launch merchant is pinned to the version they were sold. */
    await withBusiness(db, grandfathered, (tx) =>
      planCatalogueRepo.pinPlanVersion(tx, grandfathered, v1!.id),
    );

    /* Chat v2: fewer AI actions, a higher price. */
    const v2From = new Date('2026-08-27T12:00:00Z');
    const v2Id = await planCatalogueRepo.publishPlanVersion(ownerDb, {
      planId: 'chat',
      name: 'Rekoda Chat',
      seats: 1,
      effectiveFrom: v2From,
      entitlements: ['REKODA_CHAT'],
      allowances: { AI_ACTIONS: 300, VOICE_MINUTES: 60, DOCUMENT_GENERATION: 100 },
      prices: [{ currency: 'NGN', billingInterval: 'monthly', amountMinor: 1_490_000 }],
    });

    /* The current version of chat is now v2, and v1 closed at v2's start. */
    const current = await planCatalogueRepo.planVersionAt(db, 'chat', new Date());
    expect(current!.id).toBe(v2Id);
    expect(current!.version).toBe(2);
    const closed = await planCatalogueRepo.planVersionById(db, v1!.id);
    expect(closed!.effectiveTo?.toISOString()).toBe(v2From.toISOString());

    /* The floating business follows the catalogue; the pinned one does not. */
    const floatingPin = await withBusiness(db, floating, (tx) =>
      planCatalogueRepo.pinnedPlanVersion(tx, floating),
    );
    expect(floatingPin).toBeNull();
    const pin = await withBusiness(db, grandfathered, (tx) =>
      planCatalogueRepo.pinnedPlanVersion(tx, grandfathered),
    );
    expect(pin).toBe(v1!.id);

    /* And the pinned version still sells what it sold: 400 AI actions at
     * ₦9,900, however many versions have been published since. */
    const pinned = await planCatalogueRepo.planVersionById(db, pin!);
    const sold = await planCatalogueRepo.allowancesOf(db, pinned!.id);
    expect(sold.AI_ACTIONS).toBe(400);
    expect(await planCatalogueRepo.priceAt(db, pinned!.id, 'NGN', 'monthly', new Date())).toBe(
      990_000,
    );
  });

  it('a moment before the catalogue answers no version, never a guess', async () => {
    const before = await planCatalogueRepo.planVersionAt(db, 'chat', new Date('2026-07-01'));
    expect(before).toBeNull();
    expect(await planCatalogueRepo.planVersionAt(db, 'gold', new Date())).toBeNull();
  });

  it('the application role cannot write the catalogue', async () => {
    const version = await planCatalogueRepo.planVersionAt(db, 'chat', new Date());
    const attempts = [
      () =>
        db.execute(sql`
          INSERT INTO plan_versions (plan_id, version, name, seats, effective_from)
          VALUES ('chat', 99, 'Rekoda Chat', 1, now())
        `),
      () =>
        db.execute(
          sql`UPDATE plan_prices SET amount_minor = 1 WHERE plan_version_id = ${version!.id}::uuid`,
        ),
      () =>
        db.execute(
          sql`DELETE FROM allowance_versions WHERE plan_version_id = ${version!.id}::uuid`,
        ),
      () =>
        db.execute(
          sql`DELETE FROM plan_version_entitlements WHERE plan_version_id = ${version!.id}::uuid`,
        ),
    ];
    for (const attempt of attempts) {
      const error = await attempt().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).not.toBeNull();
      expect(pgCode(error)).toBe('42501');
    }
  });
});
